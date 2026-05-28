/**
 * Kwabz Store Online — Global State Manager (v2)
 * Features: Real-time listeners, Firebase Auth, User-specific Cart
 */

const KwabzStore = (() => {
  // ─── Storage Keys ──────────────────────────────────────────
  let lastRefreshTime = 0;
  const KEYS = {
    CART: 'kwabz_cart',
    WISHLIST: 'kwabz_wishlist',
    ADMIN_AUTH: 'kwabz_admin_auth',
    LOCAL_DATA_MIGRATED: 'kwabz_data_migrated_to_firestore',
    CACHE_PRODUCTS: 'kwabz_cache_products',
    CACHE_CATEGORIES: 'kwabz_cache_categories',
    CACHE_ORDERS: 'kwabz_cache_orders',
    CACHE_TIMESTAMP: 'kwabz_cache_ts',
    SETTINGS: 'kwabz_settings',
    CACHE_SELLERS: 'kwabz_cache_sellers',
    USER_ORDERS: 'kwabz_my_orders',   // Per-user order history (local)
  };

  // ─── Safe localStorage helper (handles QuotaExceededError) ──
  function _safeSetItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) {
        console.warn('[KwabzStore] localStorage quota exceeded. Clearing old caches...');
        // Free up space by removing the largest caches first
        try {
          localStorage.removeItem(KEYS.CACHE_PRODUCTS);
          localStorage.removeItem(KEYS.CACHE_CATEGORIES);
          localStorage.removeItem(KEYS.CACHE_ORDERS);
          localStorage.removeItem(KEYS.CACHE_SELLERS);
          // Retry once
          localStorage.setItem(key, value);
        } catch (e2) {
          console.warn('[KwabzStore] Could not write to localStorage even after cleanup. Running from memory only.');
        }
      } else {
        console.warn('[KwabzStore] localStorage write failed:', e);
      }
    }
  }

  const CACHE_TTL = 15 * 60 * 1000; // 15 minutes in ms

  // ─── State ────────────────────────────────────────────────
  let localProducts = [];
  let localCategories = [];
  let localOrders = [];
  let localCart = [];
  let localWishlist = [];
  let currentUser = null;
  let isFirestoreInitialized = false;
  let isInitializing = false;
  let localSellers = [];
  let localSettings = { newTagDuration: 7 };
  let localRole = null; // 'admin' or null
  let syncStatus = (typeof navigator !== 'undefined' && !navigator.onLine) ? 'offline' : 'syncing'; // Always start syncing — only go 'online' when Firestore actually responds (not from stale cache)
  let presenceInterval = null;
  let isAuthResolved = false;
  let isConnectionOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

  // Per-user local order history (guest + logged-in)
  let userOrders = [];
  let previousUserOrderStatuses = null;

  // Real-time listener unsubscribers
  const unsubscribers = {
    products: null,
    categories: null,
    orders: null,
    cart: null,
    wishlist: null,
    settings: null,
    sellers: null,
    userOrders: null,   // User-specific order listener
    presence: null,     // Listener for admin presence
    sync: {
      products: false,
      categories: false,
      sellers: false
    }
  };

  const BACKEND_URL = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) 
    ? 'http://localhost:5000' 
    : 'https://nodejs-backend-1-ucbq.onrender.com';

  const strictNodeJs = typeof localStorage !== 'undefined' && localStorage.getItem('kwabz_strict_nodejs') === 'true';

  let socket = null;
  let useBackend = true;
  let backendStatus = 'offline';
  let _visitorCountCallback = null;


  // ─── Event System ──────────────────────────────────────────
  const listeners = {};

  function on(event, callback) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(callback);
    // Replay current state immediately so late-registering listeners (e.g. admin badge)
    // always get the correct value even if the event already fired before they registered.
    if (event === 'backend_status') {
      try { callback(backendStatus); } catch(e) {}
    } else if (event === 'sync_status') {
      try { callback(syncStatus); } catch(e) {}
    }
  }

  function emit(event, data) {
    if (event === 'firestore_read' && typeof data === 'number' && data > 0) {
      try {
        const todayKey = 'kwabz_fb_reads_' + new Date().toISOString().slice(0, 10);
        // Clean up reads counters from previous days to keep localStorage tidy
        Object.keys(localStorage).forEach(k => {
          if (k.startsWith('kwabz_fb_reads_') && k !== todayKey) {
            localStorage.removeItem(k);
          }
        });
        let dailyReadCount = parseInt(localStorage.getItem(todayKey) || '0', 10);
        dailyReadCount += data;
        localStorage.setItem(todayKey, String(dailyReadCount));
      } catch (e) {
        console.warn('[KwabzStore] Failed to write reads to localStorage:', e);
      }
    }

    if (listeners[event]) {
      listeners[event].forEach(cb => {
        try {
          cb(data);
        } catch (err) {
          console.error(`[KwabzStore] Error in listener for "${event}":`, err);
        }
      });
    }
  }

  // ─── ID Generator ──────────────────────────────────────────
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  function isAdminLoggedIn() {
    // Treat as a regular customer if User mode is active
    if (localStorage.getItem('kwabz_user_mode') === 'true') {
      return false;
    }
    if (localRole === 'admin') return true;

    // Strict alignment check if auth state has resolved
    if (isAuthResolved) {
      const user = firebase.auth().currentUser;
      const ADMIN_EMAILS = ['admin@kwabzstore.com', 'admin@kwabz.com', 'kelvin@kwabz.com'];
      if (user && (ADMIN_EMAILS.includes(user.email) || localRole === 'admin')) {
        localRole = 'admin';
        return true;
      }
      // Since the Auth has fully resolved and we are NOT an authenticated admin user,
      // clean up stale optimistic role/localStorage.
      if (localStorage.getItem(KEYS.ADMIN_AUTH) === 'true') {
        localStorage.removeItem(KEYS.ADMIN_AUTH);
        localRole = null;
      }
      return false;
    }

    // Optimistic fallback before auth is resolved
    if (localStorage.getItem(KEYS.ADMIN_AUTH) === 'true') {
      return true;
    }
    return false;
  }

  // ─── Firebase Auth ────────────────────────────────────────
  function setupAuthListener() {
    firebase.auth().onAuthStateChanged(async user => {
      currentUser = user;
      if (user) {
        // Enforce 24-hour session limit
        const now = Date.now();
        const loginTimeStr = localStorage.getItem('kwabz_login_time');
        if (loginTimeStr) {
          const loginTime = parseInt(loginTimeStr, 10);
          if (now - loginTime > 24 * 60 * 60 * 1000) {
            console.log('[KwabzStore] User session expired (24 hours limit). Logging out...');
            await logout();
            const isAdminPage = window.location.pathname.includes('admin-') || window.location.pathname.includes('sellers.html');
            if (isAdminPage) {
              const inAdminFolder = window.location.pathname.includes('/admin/');
              window.location.href = inAdminFolder ? 'admin-login.html' : 'admin/admin-login.html';
            } else {
              window.location.reload();
            }
            return;
          }
        } else {
          localStorage.setItem('kwabz_login_time', now.toString());
        }

        localStorage.setItem('kwabz_auth_cache', user.uid);

        const isUserMode = localStorage.getItem('kwabz_user_mode') === 'true';
        const ADMIN_EMAILS = ['admin@kwabzstore.com', 'admin@kwabz.com', 'kelvin@kwabz.com'];
        if (ADMIN_EMAILS.includes(user.email)) {
          localRole = isUserMode ? null : 'admin';
          if (!isUserMode) {
            localStorage.setItem(KEYS.ADMIN_AUTH, 'true');
          }
          isAuthResolved = true; // Resolve early for known admins
          emit('user_changed', user);
        }

        // Run user document fetch asynchronously in the background to prevent blocking auth resolution
        const fetchUserRole = async () => {
          try {
            const doc = await firebase.firestore().collection('users').doc(user.uid).get();
            if (doc.exists) {
              const freshRole = isUserMode ? null : (ADMIN_EMAILS.includes(user.email) ? 'admin' : (doc.data().role || localRole));
              if (freshRole !== localRole) {
                localRole = freshRole;
                if (localRole === 'admin') {
                  localStorage.setItem(KEYS.ADMIN_AUTH, 'true');
                  _startPresence(user.uid);
                  if (!useBackend || backendStatus === 'offline') {
                    _setupOrdersListener();
                  }
                  emit('admin_ready', currentUser);
                }
                emit('user_changed', currentUser);
              }
              // Also ensure Firestore document role is aligned for designated admins
              if (ADMIN_EMAILS.includes(user.email) && doc.data().role !== 'admin') {
                firebase.firestore().collection('users').doc(user.uid).set({
                  email: user.email,
                  role: 'admin',
                  displayName: user.displayName || 'Master Admin'
                }, { merge: true }).catch(e => { });
              }
            } else if (localRole === 'admin') {
              firebase.firestore().collection('users').doc(user.uid).set({
                email: user.email,
                role: 'admin',
                displayName: user.displayName || 'Master Admin'
              }, { merge: true }).catch(e => { });
            }
          } catch (e) {}
        };
        fetchUserRole();

        _setupCartListener();
        _setupWishlistListener();
        _setupUserOrdersListener(user.uid);
        if (localRole === 'admin') {
          _startPresence(user.uid);
          if (!useBackend || backendStatus === 'offline') {
            _setupOrdersListener();
          }
        }
      } else {
        localStorage.removeItem('kwabz_auth_cache');
        localStorage.removeItem(KEYS.ADMIN_AUTH);
        localRole = null;
        _stopPresence();
        if (unsubscribers.cart) { unsubscribers.cart(); unsubscribers.cart = null; }
        if (unsubscribers.wishlist) { unsubscribers.wishlist(); unsubscribers.wishlist = null; }
        if (unsubscribers.orders) { unsubscribers.orders(); unsubscribers.orders = null; }
        if (unsubscribers.userOrders) { unsubscribers.userOrders(); unsubscribers.userOrders = null; }
        localCart = [];
        localWishlist = [];
        localOrders = [];
        localStorage.removeItem(KEYS.CART);
        localStorage.removeItem(KEYS.WISHLIST);
        emit('cart_changed', []);
        emit('wishlist_changed', []);
        emit('orders_changed', []);
      }

      if (!isAuthResolved) {
        isAuthResolved = true;
        emit('user_changed', currentUser);
      }
      if (localRole === 'admin') emit('admin_ready', currentUser);
    });
  }

  function _startPresence(uid) {
    _stopPresence();
    const update = async () => {
      if (!uid) return;
      try {
        // Try to get freshest name from Auth or Firestore
        let name = currentUser?.displayName;
        if (!name) {
          const doc = await firebase.firestore().collection('users').doc(uid).get();
          name = doc.data()?.displayName;
        }

        await firebase.firestore().collection('presence').doc(uid).set({
          uid: uid,
          email: currentUser?.email,
          displayName: name || 'Admin',
          last_active: new Date().toISOString(),
          status: 'online'
        }, { merge: true });
      } catch (e) { }
    };
    update();
    presenceInterval = setInterval(update, 60000); // Heartbeat every 60s
  }

  function _stopPresence() {
    if (presenceInterval) clearInterval(presenceInterval);
    presenceInterval = null;
  }

  function refreshPresence() {
    if (currentUser && localRole === 'admin') {
      _startPresence(currentUser.uid);
    }
  }

  /**
   * trackVisitor()
   * Records a lightweight visitor document in the 'visitors' Firestore collection.
   * - Uses a persistent localStorage 'kwabz_vid' as the document ID (device fingerprint).
   * - Works for both registered users (uid linked) and guests.
   * - Uses { merge: true } so it's an efficient upsert, not a duplicate write.
   * - Skipped entirely on admin pages to avoid polluting the count.
   */
  async function trackVisitor() {
    try {
      if (window.location.pathname.includes('admin-')) return; // Never count admins

      // Get or create a persistent visitor ID for this device
      let vid = localStorage.getItem('kwabz_vid');
      if (!vid) {
        vid = 'v_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('kwabz_vid', vid);
      }

      const user = firebase.auth().currentUser;
      const docId = user ? user.uid : vid; // Registered users own their doc by UID

      // ─── Backend Heartbeat Mode ───
      if (useBackend) {
        try {
          await fetch(`${BACKEND_URL}/api/visitors/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              visitorId: docId,
              uid: user ? user.uid : null,
              page: window.location.pathname.split('/').pop() || 'index.html',
              displayName: user ? (user.displayName || user.email?.split('@')[0] || null) : null
            })
          });
          return;
        } catch (e) {
          // Fall back to Firestore below if backend request fails
        }
      }

      await firebase.firestore().collection('visitors').doc(docId).set({
        visitor_id: vid,
        uid: user ? user.uid : null,
        is_registered: !!user,
        display_name: user ? (user.displayName || user.email?.split('@')[0] || null) : null,
        last_seen: firebase.firestore.FieldValue.serverTimestamp(),
        page: window.location.pathname.split('/').pop() || 'index.html',
      }, { merge: true });
    } catch (e) {
      // Silent — visitor tracking is non-critical
    }
  }

  /**
   * onVisitorCount(callback)
   * Subscribes to the live count of unique visitors (both guests + registered).
   * Calls callback(count) immediately and on every change.
   * Returns an unsubscribe function.
   */
  function onVisitorCount(callback) {
    _visitorCountCallback = callback;
    if (unsubscribers.visitors) unsubscribers.visitors();

    if (useBackend) {
      // Fetch initial active count
      fetch(`${BACKEND_URL}/api/visitor-count`)
        .then(res => res.json())
        .then(data => callback(data.count || 0))
        .catch(() => callback(0));

      // Real-time updates will be pushed via socket.io client handler
      return () => {
        _visitorCountCallback = null;
      };
    }
    
    // OPTIMIZATION: Only listen to visitors active in the last 15 minutes.
    // This ignores thousands of historic visitor documents and cuts reads by >99.9%.
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    
    unsubscribers.visitors = firebase.firestore()
      .collection('visitors')
      .where('last_seen', '>=', fifteenMinsAgo)
      .onSnapshot(snap => callback(snap.size), () => callback(0));
      
    return () => { if (unsubscribers.visitors) { unsubscribers.visitors(); unsubscribers.visitors = null; } };
  }


  /**
   * deleteAdmin(uid)
   * Revokes admin access by setting role to 'user' in Firestore
   * and removing their presence document.
   * NOTE: Cannot delete the Firebase Auth account from client-side—that requires Admin SDK.
   * The user is demoted so they can no longer access the admin panel.
   */
  async function deleteAdmin(uid) {
    if (!uid) throw new Error('No UID provided');
    const currentUid = firebase.auth().currentUser?.uid;
    if (uid === currentUid) throw new Error('You cannot delete your own admin account.');
    const db = firebase.firestore();
    try {
      await db.collection('users').doc(uid).update({ role: 'user' });
      await db.collection('presence').doc(uid).delete().catch(() => {});
      console.log('[KwabzStore] Admin demoted:', uid);
    } catch (err) {
      console.error('[KwabzStore] deleteAdmin error:', err);
      throw err;
    }
  }

  // Presence cache: throttle the inner .get() to once per 60s max
  let _presenceCache = null;
  let _presenceCacheTs = 0;
  const _PRESENCE_CACHE_TTL = 60 * 1000; // 60 seconds

  let _adminPresenceCallback = null;

  function onAdminsPresence(callback) {
    _adminPresenceCallback = callback;
    if (unsubscribers.presence) unsubscribers.presence();

    if (useBackend) {
      // Dummy array mapping so the existing admin HTML count logic works 100% untouched
      const triggerCallback = (count) => {
        const dummyAdmins = Array.from({ length: count }, (_, i) => ({
          id: `admin_${i}`,
          presence: { last_active: new Date().toISOString() }
        }));
        callback(dummyAdmins);
      };
      
      // Default to 1 (current session admin) initially
      triggerCallback(1);
      
      return () => {
        _adminPresenceCallback = null;
      };
    }

    _setupAdminsPresenceListener(callback);
  }

  function _setupAdminsPresenceListener(callback) {
    const cb = callback || _adminPresenceCallback;
    if (!cb) return;

    unsubscribers.presence = firebase.firestore().collection('users')
      .where('role', '==', 'admin')
      .onSnapshot(async snapshot => {
        const admins = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // THROTTLE: Only re-fetch presence docs if cache is stale (> 60s old).
        const now = Date.now();
        if (!_presenceCache || (now - _presenceCacheTs) > _PRESENCE_CACHE_TTL) {
          try {
            const fifteenMinsAgoIso = new Date(now - 15 * 60 * 1000).toISOString();
            const presenceSnap = await firebase.firestore().collection('presence')
              .where('last_active', '>=', fifteenMinsAgoIso)
              .get();
            _presenceCache = {};
            presenceSnap.forEach(doc => { _presenceCache[doc.id] = doc.data(); });
            _presenceCacheTs = now;
          } catch (e) {
            console.warn('[KwabzStore] Presence fetch failed, using cached value:', e);
            _presenceCache = _presenceCache || {};
          }
        }

        // Merge cached presence into admin data
        const merged = admins.map(a => ({
          ...a,
          presence: _presenceCache[a.id] || null
        }));

        cb(merged);
      });
  }

  async function emailSignUp(email, password) {
    try {
      const res = await firebase.auth().createUserWithEmailAndPassword(email, password);
      if (res.user) {
        localStorage.setItem('kwabz_auth_cache', res.user.uid);
        localStorage.setItem('kwabz_login_time', Date.now().toString());
      }
      return res.user;
    } catch (err) {
      console.error('[KwabzStore] Sign up error:', err.message);
      throw err;
    }
  }

  async function adminLogin(email, pw) {
    try {
      const res = await firebase.auth().signInWithEmailAndPassword(email, pw);
      const user = res.user;

      const ADMIN_EMAILS = ['admin@kwabzstore.com', 'admin@kwabz.com', 'kelvin@kwabz.com'];
      const isDesignatedAdmin = ADMIN_EMAILS.includes(user.email);

      // Check Firestore for role
      const doc = await firebase.firestore().collection('users').doc(user.uid).get();
      if ((doc.exists && doc.data().role === 'admin') || isDesignatedAdmin) {
        localRole = 'admin';
        localStorage.setItem(KEYS.ADMIN_AUTH, 'true');
        localStorage.setItem('kwabz_auth_cache', user.uid);
        localStorage.setItem('kwabz_login_time', Date.now().toString());

        // Make sure the user document has role: 'admin' if they are a designated admin
        if (isDesignatedAdmin && (!doc.exists || doc.data().role !== 'admin')) {
          await firebase.firestore().collection('users').doc(user.uid).set({
            email: user.email,
            role: 'admin',
            displayName: user.displayName || 'Master Admin'
          }, { merge: true });
        }

        return user;
      } else {
        await firebase.auth().signOut();
        localStorage.removeItem(KEYS.ADMIN_AUTH);
        localStorage.removeItem('kwabz_auth_cache');
        localStorage.removeItem('kwabz_login_time');
        throw new Error('Access denied. You do not have administrator privileges.');
      }
    } catch (err) {
      console.error('[KwabzStore] Admin login error:', err);
      throw err;
    }
  }

  async function emailLogin(email, password) {
    try {
      const res = await firebase.auth().signInWithEmailAndPassword(email, password);
      if (res.user) {
        localStorage.setItem('kwabz_auth_cache', res.user.uid);
        localStorage.setItem('kwabz_login_time', Date.now().toString());
      }
      return res.user;
    } catch (err) {
      console.error('[KwabzStore] Login error:', err.message);
      throw err;
    }
  }

  async function logout() {
    try {
      localStorage.removeItem('kwabz_auth_cache');
      localStorage.removeItem('kwabz_user_mode');
      localStorage.removeItem('kwabz_login_time');
      await firebase.auth().signOut();
    } catch (err) {
      console.error('[KwabzStore] Logout error:', err);
      throw err;
    }
  }

  function getCurrentUser() {
    return currentUser;
  }

  function getIsAuthResolved() {
    return isAuthResolved;
  }

  // ─── Firestore Initialization ──────────────────────────────
  async function init() {
    if (isFirestoreInitialized || isInitializing) return;
    isInitializing = true;

    console.log('[KwabzStore] Initializing Offline-First Store v2...');

    // 1. Check if Firebase SDK is ready and initialize if needed
    if (typeof firebase === 'undefined' || !firebase.firestore) {
      console.warn('[KwabzStore] Firebase SDK not found... Waiting or staying offline.');
      syncStatus = 'offline';
      emit('sync_status', syncStatus);
      isInitializing = false;
      isFirestoreInitialized = true;
      setTimeout(() => emit('store_initialized', true), 0);
      return;
    }


    if (!firebase.apps.length) {
      try {
        firebase.initializeApp({
          apiKey: "AIzaSyAt6xHMVvJ82iJSb8XO_bYGfxLKncG8oUE",
          authDomain: "mr-rager.firebaseapp.com",
          projectId: "mr-rager",
          storageBucket: "mr-rager.firebasestorage.app",
          messagingSenderId: "731077938078",
          appId: "1:731077938078:web:878fc483d6e1921bcca48f"
        });
        console.log('[KwabzStore] Firebase initialized inside store.js');
      } catch (e) {
        console.error('[KwabzStore] Firebase Init inside store.js Error:', e);
      }
    }

    // Network status handlers — Firestore SDK reconnects internally
    window.addEventListener('offline', () => {
      console.warn('[KwabzStore] Network lost.');
      if (syncStatus !== 'offline') {
        syncStatus = 'offline';
        emit('sync_status', syncStatus);
      }
    });

    window.addEventListener('online', () => {
      console.log('[KwabzStore] Network restored. Re-syncing with Firestore...');
      if (syncStatus !== 'syncing' && syncStatus !== 'online') {
        syncStatus = 'syncing';
        emit('sync_status', syncStatus);
      }
      refreshAll().catch(() => {});
    });

    try {
      const db = firebase.firestore();

      // 1. Enable Offline Persistence first
      try {
        await db.enablePersistence({ synchronizeTabs: true });
        console.log('[KwabzStore] Persistence Enabled');
      } catch (err) {
        if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
          console.warn('[KwabzStore] Persistence Warning:', err.code);
        }
      }

      // 2. Setup public real-time listeners or use custom Node.js backend
      let loadedFromBackend = false;
      if (useBackend) {
        loadedFromBackend = await _fetchInitialBackendData();
      }

      if (loadedFromBackend) {
        // Connected to backend REST. Let's also connect WebSockets for real-time push!
        _setupBackendSocket();
      } else {
        // Fallback to native Firestore direct collection listeners if backend is down
        console.log('[KwabzStore] Using native direct Firestore listeners fallback.');
        _setupProductsListener();
        _setupCategoriesListener();
        _setupSellersListener();
        _setupSettingsListener();
      }


      // 3. Setup Auth listener
      setupAuthListener();

      // 4. Start watchdog to prevent permanently-stuck 'syncing' state
      _startSyncWatchdog();

      console.log('[KwabzStore] Initialized. Waiting for data...');

      await _migrateLocalStorageToFirestore();
    } catch (err) {
      console.error('[KwabzStore] Init Error:', err);
      syncStatus = 'offline';
      emit('sync_status', syncStatus, err.message);
    } finally {
      isFirestoreInitialized = true;
      isInitializing = false;
      // 6. Always signal pages to bind their listeners — even if an error occurred.
      // Use setTimeout(0) so Firestore's synchronous cache snapshots fire FIRST,
      // populating localProducts/localOrders etc., before the page renders.
      setTimeout(() => {
        emit('store_initialized', true);
        // Re-emit current state so newly-registered page listeners get fresh data
        // without waiting for the next network snapshot cycle.
        emit('products_changed', localProducts);
        emit('categories_changed', localCategories);
        emit('orders_changed', localOrders);
        emit('sellers_changed', localSellers);
        emit('settings_changed', localSettings);
        emit('sync_status', syncStatus);
      }, 0);
    }

  }

  // Helper to extract safe numeric timestamp from Firestore Timestamp, Date strings, or numbers
  function _getSafeTime(val) {
    if (!val) return 0;
    if (typeof val.toDate === 'function') {
      try {
        return val.toDate().getTime();
      } catch (e) {
        return 0;
      }
    }
    if (typeof val === 'number') return val;
    if (val.seconds) return val.seconds * 1000;
    const t = new Date(val).getTime();
    return isNaN(t) ? 0 : t;
  }

  // ─── Backend Service Integrations (Node.js optimization proxy) ───
  async function _fetchInitialBackendData() {
    if (!useBackend) return false;
    try {
      console.log('[KwabzStore] Fetching initial storefront datasets from backend REST API...');
      
      const fetchPromise = async (path) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60-second timeout for Render Cold Starts
        
        try {
          const res = await fetch(`${BACKEND_URL}/api/${path}`, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
          return await res.json();
        } catch (e) {
          clearTimeout(timeoutId);
          throw e; // Pass error up to trigger Firebase fallback
        }
      };

      const [products, categories, sellers, settings] = await Promise.all([
        fetchPromise('products'),
        fetchPromise('categories'),
        fetchPromise('sellers'),
        fetchPromise('settings')
      ]);

      localProducts = products;
      localCategories = categories;
      localSellers = sellers;
      localSettings = { ...localSettings, ...settings };

      _saveToDiskCache();
      
      emit('products_changed', localProducts);
      emit('categories_changed', localCategories);
      emit('sellers_changed', localSellers);
      emit('settings_changed', localSettings);

      unsubscribers.sync.products = true;
      unsubscribers.sync.categories = true;
      unsubscribers.sync.sellers = true;
      _checkSyncFinished();
      
      syncStatus = 'online';
      emit('sync_status', syncStatus);
      backendStatus = 'online';
      emit('backend_status', backendStatus);
      return true;
    } catch (err) {
      console.warn('[KwabzStore] Backend fetch failed. Falling back to native Firestore.', err.message);
      backendStatus = navigator.onLine ? 'online' : 'offline';
      emit('backend_status', backendStatus);
      return false;
    }
  }

  function _loadSocketIoScript() {
    return new Promise((resolve) => {
      if (typeof io !== 'undefined') {
        resolve(true);
        return;
      }
      console.log('[KwabzStore] Socket.io client script not found. Loading dynamically from CDN...');
      const script = document.createElement('script');
      script.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
      script.onload = () => {
        console.log('[KwabzStore] Socket.io client script loaded dynamically successfully.');
        resolve(true);
      };
      script.onerror = () => {
        console.warn('[KwabzStore] Failed to load Socket.io client script dynamically from CDN.');
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  // Track whether Firebase fallback listeners are already running during a socket outage
  let _firebaseFallbackActive = false;
  let _socketKeepAliveInterval = null;

  function _activateFirebaseFallback() {
    if (_firebaseFallbackActive) return;
    _firebaseFallbackActive = true;
    console.log('[KwabzStore] Socket offline — activating Firebase fallback listeners.');
    _setupProductsListener();
    _setupCategoriesListener();
    _setupSellersListener();
    _setupSettingsListener();
    if (isAdminLoggedIn()) {
      _setupOrdersListener();
      _setupAdminsPresenceListener();
    }
  }

  function _deactivateFirebaseFallback() {
    if (!_firebaseFallbackActive) return;
    _firebaseFallbackActive = false;
    console.log('[KwabzStore] Socket reconnected — tearing down Firebase fallback listeners.');
    if (unsubscribers.products) { unsubscribers.products(); unsubscribers.products = null; }
    if (unsubscribers.categories) { unsubscribers.categories(); unsubscribers.categories = null; }
    if (unsubscribers.sellers) { unsubscribers.sellers(); unsubscribers.sellers = null; }
    if (unsubscribers.settings) { unsubscribers.settings(); unsubscribers.settings = null; }
    if (unsubscribers.orders) { unsubscribers.orders(); unsubscribers.orders = null; }
    if (unsubscribers.presence) { unsubscribers.presence(); unsubscribers.presence = null; }
  }

  async function _setupBackendSocket() {
    if (!useBackend) return;

    // Load Socket.io script dynamically if needed
    const ok = await _loadSocketIoScript();
    if (!ok || typeof io === 'undefined') {
      console.warn('[KwabzStore] Socket.io client script failed to load. Running HTTP polling mode only.');
      return;
    }

    try {
      // Configure with robust auto-reconnect so Render cold starts don't kill the indicators
      socket = io(BACKEND_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,   // keep trying forever
        reconnectionDelay: 2000,          // start at 2 s
        reconnectionDelayMax: 30000,      // cap at 30 s
        randomizationFactor: 0.3,
        timeout: 20000                    // connection attempt timeout
      });
      console.log('[KwabzStore] Connecting Socket.io client to backend:', BACKEND_URL);

      socket.on('connect', () => {
        console.log('[KwabzStore] Socket.io connected.');
        backendStatus = 'online';
        emit('backend_status', backendStatus);
        // Only upgrade syncStatus if Firebase isn't already reporting online
        if (syncStatus !== 'online') {
          syncStatus = 'online';
          emit('sync_status', syncStatus);
        }
        // Tear down Firebase fallback — socket will push data from here
        _deactivateFirebaseFallback();

        // Keep-alive ping every 25 s to prevent Render free-tier sleep
        if (_socketKeepAliveInterval) clearInterval(_socketKeepAliveInterval);
        _socketKeepAliveInterval = setInterval(() => {
          if (socket && socket.connected) {
            socket.emit('ping_keepalive');
          }
        }, 25000);
      });

      socket.on('disconnect', (reason) => {
        console.warn('[KwabzStore] Socket.io disconnected. Reason:', reason);
        if (_socketKeepAliveInterval) { clearInterval(_socketKeepAliveInterval); _socketKeepAliveInterval = null; }
        // Keep backend indicator green if browser is online and syncing via Firebase fallback
        backendStatus = navigator.onLine ? 'online' : 'offline';
        emit('backend_status', backendStatus);
        // Activate Firebase fallback to keep data and Firebase indicator alive
        _activateFirebaseFallback();
        // Note: socket.io will automatically attempt to reconnect per the config above
      });

      socket.on('connect_error', (err) => {
        console.warn('[KwabzStore] Socket connect error:', err.message);
        backendStatus = navigator.onLine ? 'online' : 'offline';
        emit('backend_status', backendStatus);
        _activateFirebaseFallback();
      });

      socket.on('products_changed', (products) => {
        console.log('[Socket Push] Received products update from server.');
        localProducts = products;
        _saveToDiskCache();
        emit('products_changed', localProducts);
        unsubscribers.sync.products = true;
        _checkSyncFinished();
      });

      socket.on('categories_changed', (categories) => {
        console.log('[Socket Push] Received categories update from server.');
        localCategories = categories;
        _saveToDiskCache();
        emit('categories_changed', localCategories);
        unsubscribers.sync.categories = true;
        _checkSyncFinished();
      });

      socket.on('sellers_changed', (sellers) => {
        console.log('[Socket Push] Received sellers update from server.');
        localSellers = sellers;
        _saveToDiskCache();
        emit('sellers_changed', localSellers);
        unsubscribers.sync.sellers = true;
        _checkSyncFinished();
      });

      socket.on('orders_changed', (orders) => {
        console.log('[Socket Push] Received orders update from server. Count:', orders ? orders.length : 0);
        
        // Detect entirely NEW orders for push notification
        if (localOrders && localOrders.length > 0) {
          const oldIds = new Set(localOrders.map(o => o.id));
          const newOrders = orders.filter(o => !oldIds.has(o.id));
          
          if (newOrders.length > 0 && typeof KwabzUtils !== 'undefined' && typeof KwabzUtils.showNotification === 'function') {
            newOrders.forEach(order => {
              KwabzUtils.showNotification(
                'New Order Received! 🛒',
                `Order ${order.order_label || order.order_number || ''} placed by ${order.customer?.name || 'Guest'} for GH₵ ${(order.total_price || 0).toFixed(2)}`
              );
            });
          }
        }

        localOrders = orders;
        _saveToDiskCache();
        emit('orders_changed', localOrders);
      });

      socket.on('settings_changed', (settings) => {
        console.log('[Socket Push] Received settings update from server.');
        localSettings = { ...localSettings, ...settings };
        _safeSetItem(KEYS.SETTINGS, JSON.stringify(_stripHeavyFields(localSettings)));
        emit('settings_changed', localSettings);
      });

      socket.on('visitor_count_updated', (count) => {
        if (typeof _visitorCountCallback === 'function') {
          _visitorCountCallback(count);
        }
      });

      socket.on('admin_presence_updated', (count) => {
        if (typeof _adminPresenceCallback === 'function') {
          const dummyAdmins = Array.from({ length: count }, (_, i) => ({
            id: `admin_${i}`,
            presence: { last_active: new Date().toISOString() }
          }));
          _adminPresenceCallback(dummyAdmins);
        }
      });
    } catch (e) {
      console.warn('[KwabzStore] Socket.io initialization failed:', e);
    }
  }

  // ─── Real-Time Listeners ───
  function _setupProductsListener() {
    const db = firebase.firestore();
    if (unsubscribers.products) unsubscribers.products();

    unsubscribers.products = db.collection('products')
      .onSnapshot(
        snapshot => {
          try {
            localProducts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            // Client-side in-memory sort by created_at desc
            localProducts.sort((a, b) => _getSafeTime(b.created_at) - _getSafeTime(a.created_at));
            _saveToDiskCache();
            emit('products_changed', localProducts);

            // Mark products as synced if cache has data or if it's a live server snapshot
            if (localProducts.length > 0 || !snapshot.metadata.fromCache) {
              unsubscribers.sync.products = true;
              _checkSyncFinished();
            }

            // proof of live database connection
            if (!snapshot.metadata.fromCache) {
              // Emit billing-accurate read count (cache hits are free — only server reads cost)
              emit('firestore_read', snapshot.docs.length);
              if (syncStatus !== 'online') {
                syncStatus = 'online';
                emit('sync_status', syncStatus);
                console.log('[KwabzStore] Live Firestore Products feed connected.');
              }
            }
          } catch (err) {
            console.error('[KwabzStore] Products fetch processing error:', err);
          }
        },
        err => {
          console.error('[KwabzStore] Products snapshot failed:', err);
          unsubscribers.sync.products = false;
          if (syncStatus !== 'offline') {
            syncStatus = 'offline';
            let errMsg = err.message || String(err);
            if (errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('resource-exhausted') || errMsg.toLowerCase().includes('limit')) {
              errMsg = 'Firebase daily read/write quota exceeded (Free Spark Tier limit reached). Please check Firebase Console.';
            }
            emit('sync_status', 'offline', errMsg);
          }
          _checkSyncFinished();
          _scheduleReconnect('products_listener_error');
        }
      );
  }

  function _setupCategoriesListener() {
    const db = firebase.firestore();
    if (unsubscribers.categories) unsubscribers.categories();

    // ── Admin: real-time listener so edits appear instantly across tabs ──────
    if (isAdminLoggedIn()) {
      unsubscribers.categories = db.collection('categories')
        .onSnapshot(
          snapshot => {
            try {
              localCategories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
              _saveToDiskCache();
              emit('categories_changed', localCategories);
              if (localCategories.length > 0 || !snapshot.metadata.fromCache) {
                unsubscribers.sync.categories = true;
                _checkSyncFinished();
              }
              if (!snapshot.metadata.fromCache) {
                emit('firestore_read', snapshot.docs.length);
                if (syncStatus !== 'online') { syncStatus = 'online'; emit('sync_status', syncStatus); }
              }
            } catch (err) { console.error('[KwabzStore] Categories processing error:', err); }
          },
          err => {
            console.error('[KwabzStore] Categories snapshot failed:', err);
            unsubscribers.sync.categories = false;
            _checkSyncFinished();
            _scheduleReconnect('categories_listener_error');
          }
        );
      return;
    }

    // ── Public user: TTL-gated one-shot .get() ───────────────────────────────
    // If localStorage cache is still fresh, data is already in memory —
    // skip Firestore entirely. Only fetch when the TTL has expired.
    const cacheAge = Date.now() - parseInt(localStorage.getItem(KEYS.CACHE_TIMESTAMP) || '0', 10);
    if (cacheAge <= CACHE_TTL && localCategories.length > 0) {
      console.log('[KwabzStore] Categories: fresh cache — skipping network read.');
      unsubscribers.sync.categories = true;
      _checkSyncFinished();
      return;
    }

    db.collection('categories').get()
      .then(snapshot => {
        localCategories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        _saveToDiskCache();
        emit('categories_changed', localCategories);
        if (!snapshot.metadata.fromCache) {
          emit('firestore_read', snapshot.docs.length);
          if (syncStatus !== 'online') { syncStatus = 'online'; emit('sync_status', syncStatus); }
        }
        unsubscribers.sync.categories = true;
        _checkSyncFinished();
      })
      .catch(err => {
        console.error('[KwabzStore] Categories fetch failed:', err);
        let errMsg = err.message || String(err);
        if (errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('resource-exhausted') || errMsg.toLowerCase().includes('limit')) {
          errMsg = 'Firebase daily read/write quota exceeded (Free Spark Tier limit reached). Please check Firebase Console.';
        }
        if (syncStatus !== 'offline') { syncStatus = 'offline'; emit('sync_status', 'offline', errMsg); }
        unsubscribers.sync.categories = true; // Don't block sync gate
        _checkSyncFinished();
        _scheduleReconnect('categories_fetch_error');
      });
  }

  function _setupSellersListener() {
    const db = firebase.firestore();
    if (unsubscribers.sellers) unsubscribers.sellers();

    // ── Real-time onSnapshot for ALL users ───────────────────────────────────
    // Sellers need live updates so mini-store changes (new sellers, logo/name
    // edits, availability toggles) reflect on the storefront without a reload.
    // The read cost is ~5-10 docs per session — acceptable for this feature.
    unsubscribers.sellers = db.collection('sellers')
      .onSnapshot(
        snapshot => {
          try {
            localSellers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            _saveToDiskCache();
            emit('sellers_changed', localSellers);

            if (localSellers.length > 0 || !snapshot.metadata.fromCache) {
              unsubscribers.sync.sellers = true;
              _checkSyncFinished();
            }

            if (!snapshot.metadata.fromCache) {
              emit('firestore_read', snapshot.docs.length);
              if (syncStatus !== 'online') {
                syncStatus = 'online';
                emit('sync_status', syncStatus);
                console.log('[KwabzStore] Live Firestore Sellers feed connected.');
              }
            }
          } catch (err) {
            console.error('[KwabzStore] Sellers processing error:', err);
          }
        },
        err => {
          console.error('[KwabzStore] Sellers snapshot failed:', err);
          unsubscribers.sync.sellers = false;
          if (syncStatus !== 'offline') {
            syncStatus = 'offline';
            let errMsg = err.message || String(err);
            if (errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('resource-exhausted') || errMsg.toLowerCase().includes('limit')) {
              errMsg = 'Firebase daily read/write quota exceeded (Free Spark Tier limit reached). Please check Firebase Console.';
            }
            emit('sync_status', 'offline', errMsg);
          }
          _checkSyncFinished();
          _scheduleReconnect('sellers_listener_error');
        }
      );
  }

  function _setupCartListener() {
    const db = firebase.firestore();
    if (!currentUser) return;
    if (unsubscribers.cart) unsubscribers.cart();

    unsubscribers.cart = db.collection('users').doc(currentUser.uid)
      .collection('cart').doc('items')
      .onSnapshot(
        doc => {
          try {
            localCart = doc.exists ? (doc.data().items || []) : [];
            emit('cart_changed', localCart);
          } catch (err) {
            console.error('[KwabzStore] Cart listener error:', err);
          }
        },
        err => {
          console.error('[KwabzStore] Cart listener failed:', err);
        }
      );
  }

  function _setupWishlistListener() {
    const db = firebase.firestore();
    if (!currentUser) return;
    if (unsubscribers.wishlist) unsubscribers.wishlist();

    unsubscribers.wishlist = db.collection('users').doc(currentUser.uid)
      .collection('wishlist').doc('items')
      .onSnapshot(
        doc => {
          try {
            localWishlist = (doc.exists && Array.isArray(doc.data().items)) ? doc.data().items : [];
            _safeSetItem(KEYS.WISHLIST, JSON.stringify(localWishlist));
            emit('wishlist_changed', localWishlist);
          } catch (err) {
            console.error('[KwabzStore] Wishlist listener error:', err);
          }
        },
        err => {
          console.error('[KwabzStore] Wishlist listener failed:', err);
        }
      );
  }

  let hasAttemptedSettingsInit = false;
  let _lastSettingsJson = null;
  function _setupSettingsListener() {
    const db = firebase.firestore();
    if (unsubscribers.settings) unsubscribers.settings();

    // Shared onSnapshot handler logic
    const handleSettingsDoc = (doc, isAdmin) => {
      if (!doc.exists) {
        if (isAdmin && !hasAttemptedSettingsInit) {
          hasAttemptedSettingsInit = true;
          db.collection('settings').doc('global').set(localSettings)
            .catch(e => console.error('[KwabzStore] Settings init failed:', e));
        }
        return;
      }
      const incoming = doc.data();
      // Deduplicate: skip if data hasn't actually changed (prevents re-renders on no-op snapshots)
      const incomingJson = JSON.stringify(incoming);
      if (incomingJson === _lastSettingsJson) return;
      _lastSettingsJson = incomingJson;

      localSettings = { ...localSettings, ...incoming };
      _safeSetItem(KEYS.SETTINGS, JSON.stringify(_stripHeavyFields(localSettings)));
      emit('settings_changed', localSettings);
      if (!doc.metadata.fromCache) {
        if (!isAdmin) emit('firestore_read', 1);
        if (syncStatus !== 'online') { syncStatus = 'online'; emit('sync_status', syncStatus); }
      }
    };

    // ── Admin: real-time listener with error reporting ────────────────────────
    if (isAdminLoggedIn()) {
      unsubscribers.settings = db.collection('settings').doc('global')
        .onSnapshot(
          doc => {
            try { handleSettingsDoc(doc, true); }
            catch (err) { console.error('[KwabzStore] Settings listener error:', err); }
          },
          err => {
            console.error('[KwabzStore] Settings snapshot failed:', err);
            let errMsg = err.message || String(err);
            if (errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('resource-exhausted') || errMsg.toLowerCase().includes('limit')) {
              errMsg = 'Firebase daily read/write quota exceeded (Free Spark Tier limit reached). Please check Firebase Console.';
            }
            if (syncStatus !== 'offline') { syncStatus = 'offline'; emit('sync_status', 'offline', errMsg); }
            _scheduleReconnect('settings_listener_error');
          }
        );
      return;
    }

    // ── Public user: real-time listener for instant theme propagation ─────────
    // Settings is one tiny document — the read cost is negligible (~1 read/session).
    // This ensures admin theme saves (layout, colors, sellers settings, etc.)
    // propagate to every open user session instantly with no 15-minute delay.
    unsubscribers.settings = db.collection('settings').doc('global')
      .onSnapshot(
        { includeMetadataChanges: false },
        doc => {
          try { handleSettingsDoc(doc, false); }
          catch (err) { console.warn('[KwabzStore] Public settings listener error:', err); }
        },
        err => {
          // Non-fatal: fall back silently to the cached value if the listener fails
          console.warn('[KwabzStore] Public settings listener failed, using cached value:', err);
        }
      );
  }

  function _safeParse(key, fallback) {
    try {
      const item = localStorage.getItem(key);
      if (!item) return fallback;
      const parsed = JSON.parse(item);
      return parsed !== null ? parsed : fallback;
    } catch (e) {
      console.warn(`[KwabzStore] Failed to parse key "${key}" from localStorage:`, e);
      return fallback;
    }
  }

  function _loadFromDiskCache() {
    try {
      // ─── Stale-While-Revalidate ─────────────────────────────────────────────
      // ALWAYS serve every cache key to the UI instantly — even if the data is
      // older than CACHE_TTL. A slightly-stale category list is far better UX
      // than a blank/empty state while waiting for Firestore to respond.
      //
      // The TTL check lives in each individual listener (_setupCategoriesListener,
      // _setupSellersListener, etc.) which decides whether to fire a background
      // network refresh. That is the ONLY place TTL affects read billing.
      localProducts   = _safeParse(KEYS.CACHE_PRODUCTS, []);
      localCategories = _safeParse(KEYS.CACHE_CATEGORIES, []);
      localOrders     = _safeParse(KEYS.CACHE_ORDERS, []);
      localSellers    = _safeParse(KEYS.CACHE_SELLERS, []);
      localSettings   = _safeParse(KEYS.SETTINGS, localSettings);
      userOrders      = _safeParse(KEYS.USER_ORDERS, []);
      localCart       = _safeParse(KEYS.CART, []);
      localWishlist   = _safeParse(KEYS.WISHLIST, []);

      // Emit all available data immediately for zero-latency UI render
      if (localProducts.length > 0)   emit('products_changed', localProducts);
      if (localCategories.length > 0) emit('categories_changed', localCategories);
      if (localSellers.length > 0)    emit('sellers_changed', localSellers);
      if (localOrders.length > 0)     emit('orders_changed', localOrders);
      emit('settings_changed', localSettings);
      emit('cart_changed', localCart);
      emit('wishlist_changed', localWishlist);

      const cacheAge = Date.now() - parseInt(localStorage.getItem(KEYS.CACHE_TIMESTAMP) || '0', 10);
      if (cacheAge > CACHE_TTL) {
        console.log(`[KwabzStore] Cache is stale (${Math.round(cacheAge / 60000)} min old) — rendered from localStorage, background network refresh will follow.`);
      }

    } catch (e) {
      console.error('[KwabzStore] Cache Load Error:', e);
    }
  }

  async function refreshAll() {
    if (!firebase.firestore) return;
    const now = Date.now();
    if (now - lastRefreshTime < 2000) {
      console.log('[KwabzStore] Refresh throttled.');
      return;
    }
    lastRefreshTime = now;

    console.log('[KwabzStore] Forcing full sync...');
    if (syncStatus !== 'syncing') {
      syncStatus = 'syncing';
      emit('sync_status', syncStatus);
    }

    if (useBackend) {
      // In backend mode, refresh via background REST and Socket
      _fetchInitialBackendData().catch(() => {});
      if (socket && !socket.connected) {
        socket.connect();
      }
      return;
    }

    // Reset sync flags for fresh confirmation
    unsubscribers.sync.products = false;
    unsubscribers.sync.categories = false;
    unsubscribers.sync.sellers = false;

    _setupProductsListener();
    _setupCategoriesListener();
    _setupSellersListener();
    _setupSettingsListener();
    if (isAdminLoggedIn()) {
      _setupOrdersListener();
    }
  }

  function _setupOrdersListener() {
    const db = firebase.firestore();
    if (unsubscribers.orders) unsubscribers.orders();

    let isInitial = true;
    unsubscribers.orders = db.collection('orders')
      .onSnapshot(
        snapshot => {
          localOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          // Client-side in-memory sort by created_at desc
          localOrders.sort((a, b) => _getSafeTime(b.created_at) - _getSafeTime(a.created_at));
          // Limit to 200 for large dataset optimization
          if (localOrders.length > 200) {
            localOrders = localOrders.slice(0, 200);
          }
          _saveToDiskCache();
          emit('orders_changed', localOrders);

          // Billing-accurate read tracking — only server-side snapshots cost reads
          if (!snapshot.metadata.fromCache) {
            emit('firestore_read', snapshot.docs.length);
          }

          if (!isInitial) {
            snapshot.docChanges().forEach(change => {
              if (change.type === 'added') {
                const order = change.doc.data();
                if (typeof KwabzUtils !== 'undefined' && typeof KwabzUtils.showNotification === 'function') {
                  KwabzUtils.showNotification(
                    'New Order Received! 🛒',
                    `Order ${order.order_label || order.order_number || ''} placed by ${order.customer?.name || 'Guest'} for GH₵ ${(order.total_price || 0).toFixed(2)}`
                  );
                }
              }
            });
          }
          isInitial = false;
          console.log('[KwabzStore] Orders loaded:', localOrders.length);
        },
        err => {
          console.warn('[KwabzStore] Orders listener restricted:', err.message);
          if (syncStatus !== 'offline') {
            syncStatus = 'offline';
            let errMsg = err.message || String(err);
            if (errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('resource-exhausted') || errMsg.toLowerCase().includes('limit')) {
              errMsg = 'Firebase daily read/write quota exceeded (Free Spark Tier limit reached). Please check Firebase Console.';
            }
            emit('sync_status', 'offline', errMsg);
          }
          _scheduleReconnect('orders_listener_error');
        }
      );
  }

  // ─── User-Specific Real-Time Orders Listener ───────────────
  // Listens to Firestore for this user's orders and syncs status
  // updates (made by admin) into localStorage in real-time.
  function _setupUserOrdersListener(uid) {
    if (!uid) return;
    const db = firebase.firestore();
    if (unsubscribers.userOrders) unsubscribers.userOrders();

    unsubscribers.userOrders = db.collection('orders')
      .where('customer_uid', '==', uid)
      .onSnapshot(
        snapshot => {
          try {
            let freshOrders = snapshot.docs
              .map(doc => ({ id: doc.id, ...doc.data() }))
              .filter(o => !o.hidden_by_customer);

            // Client-side in-memory sort by created_at desc
            freshOrders.sort((a, b) => _getSafeTime(b.created_at) - _getSafeTime(a.created_at));

            // Dynamically track and push status change updates to user
            if (previousUserOrderStatuses) {
              freshOrders.forEach(newOrder => {
                const oldStatus = previousUserOrderStatuses[newOrder.id];
                if (oldStatus && oldStatus !== newOrder.status) {
                  const orderNum = newOrder.order_label || newOrder.order_number || 'order';
                  const title = `📦 Order Status Updated!`;
                  const body = `Your order ${orderNum} is now ${newOrder.status.toUpperCase()}`;

                  console.log(`[PWA] Order status updated: ${orderNum} is now ${newOrder.status}`);

                  // 1. Play Native chiptune chime sound
                  if (typeof KwabzUtils !== 'undefined' && typeof KwabzUtils.playNotificationSound === 'function') {
                    KwabzUtils.playNotificationSound();
                  }

                  // 2. Trigger Custom interactive PWA toast banner
                  if (typeof KwabzUtils !== 'undefined' && typeof KwabzUtils.toast === 'function') {
                    KwabzUtils.toast(body, 'info');
                  }

                  // 3. Mount Native OS Push Notification (if allowed)
                  if (typeof KwabzUtils !== 'undefined' && typeof KwabzUtils.showNotification === 'function') {
                    KwabzUtils.showNotification(title, body);
                  }
                }
              });
            }

            // Map and cache current statuses to prevent redundant notifications
            const currentStatuses = {};
            freshOrders.forEach(o => {
              currentStatuses[o.id] = o.status || 'pending';
            });
            previousUserOrderStatuses = currentStatuses;

            userOrders = freshOrders;
            // Persist to localStorage so status is available offline
            _saveUserOrdersToLocal();
            emit('user_orders_changed', userOrders);
            console.log('[KwabzStore] User orders synced:', userOrders.length);
          } catch (err) {
            console.error('[KwabzStore] User orders listener error:', err);
          }
        },
        err => {
          // Not fatal — fall back to local copy
          console.warn('[KwabzStore] User orders listener unavailable:', err.message);
          userOrders = _loadUserOrdersFromLocal();
          emit('user_orders_changed', userOrders);
        }
      );
  }

  function _saveUserOrdersToLocal() {
    try {
      _safeSetItem(KEYS.USER_ORDERS, JSON.stringify(userOrders));
    } catch (e) {
      console.warn('[KwabzStore] Could not save user orders locally:', e);
    }
  }

  function _loadUserOrdersFromLocal() {
    try {
      return JSON.parse(localStorage.getItem(KEYS.USER_ORDERS) || '[]');
    } catch (e) {
      return [];
    }
  }

  function getUserOrders() {
    // Return from memory if available, else from localStorage
    if (userOrders.length > 0) return userOrders;
    return _loadUserOrdersFromLocal();
  }

  function _checkSyncFinished() {
    // Only require products + categories to declare 'online'.
    // Sellers is optional — if that collection doesn't exist, we still work.
    const isReady = unsubscribers.sync.products && unsubscribers.sync.categories;

    if (isReady) {
      reconnectDelay = 3000; // Reset reconnection delay on successful sync!
      if (syncStatus !== 'online') {
        syncStatus = 'online';
        emit('sync_status', syncStatus);
        console.log('[KwabzStore] System functional (Online)');
        _saveToDiskCache();
      }
    }
    // NOTE: Never set 'offline' here — that is handled by Firestore error callbacks
    // and the window 'offline' event listener. Doing so here causes a flip-flop loop.
  }

  // ── Self-healing dynamic recovery engine with exponential backoff ──
  let reconnectTimeout = null;
  let reconnectDelay = 3000;

  function _scheduleReconnect(source) {
    if (reconnectTimeout) return;
    
    // Scale up reconnect delay if triggered by connection failures
    if (source && source.includes('error')) {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000); // Exponential backoff
    }
    
    console.log(`[KwabzStore] Scheduling sync recovery in ${reconnectDelay / 1000}s (triggered by ${source})...`);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      if (navigator.onLine) {
        console.log('[KwabzStore] Retrying Firestore connection...');
        refreshAll()
          .then(() => {
            // refreshAll always resolves, so we do NOT reset delay here anymore.
            // Delay is only reset to 3000 on verified server-side live data updates.
          })
          .catch((err) => {
            console.warn('[KwabzStore] Sync retry failed, backing off:', err.message);
            reconnectDelay = Math.min(reconnectDelay * 2, 30000); // Exponential backoff
            _scheduleReconnect('retry_failed');
          });
      } else {
        console.warn('[KwabzStore] Postponing recovery retry: browser reports offline.');
        _scheduleReconnect('offline_retry_deferred');
      }
    }, reconnectDelay);
  }

  // ── Safety timeout: if sync hasn't resolved in 10s but we have data, force 'online' ──
  // This handles edge cases where a listener fires but _checkSyncFinished wasn't triggered
  // (e.g. a category collection that's empty still fires, but a race can prevent the flag from being set)
  function _startSyncWatchdog() {
    setTimeout(() => {
      if (syncStatus === 'syncing') {
        // Force sync flags for any collection that already has data or has at least tried
        if (localProducts.length > 0) unsubscribers.sync.products = true;
        if (localCategories.length >= 0) unsubscribers.sync.categories = true; // 0 is valid
        _checkSyncFinished();
        if (syncStatus === 'syncing') {
          // Still syncing? Network likely slow. Mark as online anyway to unblock UI.
          console.warn('[KwabzStore] Sync watchdog: forcing online after timeout.');
          syncStatus = 'online';
          emit('sync_status', syncStatus);
        }
      }
    }, 4000);
  }

  function getSyncStatus() { return syncStatus; }
  function isAuthReady() { return isAuthResolved; }

  // Helper to handle both string dates and Firestore Timestamps
  function _convertToDate(val) {
    if (!val) return new Date(0);
    if (val.toDate && typeof val.toDate === 'function') return val.toDate();
    if (val.seconds) return new Date(val.seconds * 1000);
    return new Date(val);
  }

  function _isMainStoreItem(p) {
    if (!p) return false;
    const sid = p.seller_id;
    return !sid || String(sid).trim().toLowerCase() === 'main';
  }

  async function _migrateLocalStorageToFirestore() {
    if (localStorage.getItem(KEYS.LOCAL_DATA_MIGRATED)) return;
    const db = firebase.firestore();
    const oldProducts = JSON.parse(localStorage.getItem('kwabz_products') || '[]');
    const oldCategories = JSON.parse(localStorage.getItem('kwabz_categories') || '[]');

    if ((oldProducts.length > 0 || oldCategories.length > 0) && isAdminLoggedIn()) {
      try {
        for (const cat of oldCategories) await db.collection('categories').doc(cat.id).set(cat);
        for (const prod of oldProducts) await db.collection('products').doc(prod.id).set(prod);
        localStorage.setItem(KEYS.LOCAL_DATA_MIGRATED, 'true');
        await refreshAll();
      } catch (err) {
        console.error('[KwabzStore] Migration error:', err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC METHODS
  // ═══════════════════════════════════════════════════════════════

  function getProducts() {
    return localProducts.filter(_isMainStoreItem);
  }

  function getAllProducts() { return localProducts; }
  function getCategories() { return localCategories; }
  function getSellers() {
    return [...localSellers].sort((a, b) => {
      const orderA = typeof a.displayOrder === 'number' ? a.displayOrder : 9999;
      const orderB = typeof b.displayOrder === 'number' ? b.displayOrder : 9999;
      return orderA - orderB;
    });
  }
  function getOrders() { return localOrders; }

  function getProductById(id) { return localProducts.find(p => p.id === id) || null; }
  function getCategoryById(id) { return localCategories.find(c => c.id === id) || null; }
  function getSellerById(id) { return localSellers.find(s => s.id === id) || null; }

  function getProductsByCategory(categoryId, sellerId = 'main') {
    let baseProducts = (sellerId === 'all') ? localProducts :
      (sellerId === 'main' ? getProducts() : getProductsBySeller(sellerId));

    if (!categoryId || categoryId === 'all') return baseProducts;
    return baseProducts.filter(p => p.category_id === categoryId);
  }

  function getAllProductsByCategory(categoryId) {
    if (!categoryId || categoryId === 'all') return localProducts;
    return localProducts.filter(p => p.category_id === categoryId);
  }

  function getProductsBySeller(sellerId) {
    // Safety: if no sellerId given, fall back to main store items only
    if (!sellerId || sellerId === 'main') return getProducts();
    // Strict: only return products explicitly tagged to this seller.
    // Products with no seller_id, seller_id=null, or seller_id='main' are NEVER included.
    return localProducts.filter(p => {
      const sid = p.seller_id;
      if (!sid || String(sid).trim().toLowerCase() === 'main') return false; // Exclude main-store items
      return sid === sellerId;
    });
  }

  async function addProduct(product) {
    if (!product.name || !product.price) {
      throw new Error('Incomplete product data. Name and Price are required.');
    }

    // Ensure numeric values
    product.price = parseFloat(product.price);
    product.discount = parseFloat(product.discount || 0);
    product.stock = parseInt(product.stock || 0);

    try {
      if (!isAdminLoggedIn()) throw new Error("Admin access required");

      const db = firebase.firestore();
      const docRef = db.collection('products').doc(); // Instantly generate offline ID

      const newDoc = {
        ...product,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      };

      const productWithId = { id: docRef.id, ...newDoc };

      // 1. Optimistic Local Update
      localProducts.unshift(productWithId);
      _saveToDiskCache();
      emit('products_changed', localProducts);

      // 2. Fire and Forget to Server
      docRef.set(newDoc).then(() => {
        _broadcastNewProduct(newDoc, docRef.id);
      }).catch(err => console.error('[KwabzStore] Background add product failed:', err));

      return productWithId;
    } catch (err) {
      console.error('[KwabzStore] addProduct error:', err);
      throw err;
    }
  }

  async function addOrder(orderData) {
    // Fortification: Validate order structure
    if (!orderData.items || orderData.items.length === 0) {
      throw new Error('Cannot process an empty order.');
    }
    if (!orderData.customer?.phone) {
      throw new Error('Customer contact information is required for checkout.');
    }

    try {
      const seqId = 1000 + localOrders.length + 1;
      const generatedLabel = _generateOrderLabel(seqId);
      const refId = Math.floor(100000 + Math.random() * 900000);
      
      const docRef = await firebase.firestore().collection('orders').add({
        ...orderData,
        order_number: '#' + seqId,
        order_label: generatedLabel,
        ref_id: refId,
        status: 'pending',
        created_at: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Local persistence for receipt generation
      const newOrder = { id: docRef.id, order_label: generatedLabel, order_number: '#' + seqId, ref_id: refId, ...orderData, status: 'pending', created_at: new Date().toISOString() };
      userOrders.unshift(newOrder);
      _safeSetItem(KEYS.USER_ORDERS, JSON.stringify(userOrders.slice(0, 20)));

      return { id: docRef.id, ref_id: refId, order_label: generatedLabel };
    } catch (err) {
      console.error('[KwabzStore] addOrder error:', err);
      throw err;
    }
  }

  async function updateProduct(id, updates) {
    try {
      if (!isAdminLoggedIn()) throw new Error("Admin access required");

      // 1. Optimistic Local Update
      const idx = localProducts.findIndex(p => p.id === id);
      if (idx !== -1) {
        localProducts[idx] = { ...localProducts[idx], ...updates };
        _saveToDiskCache();
        emit('products_changed', localProducts);
      }

      // 2. Fire and Forget to Server
      firebase.firestore().collection('products').doc(id).update(updates)
        .catch(err => console.error('[KwabzStore] Background update product failed:', err));

      return { id, ...updates };
    } catch (err) {
      console.error('[KwabzStore] Update product error:', err);
      throw err;
    }
  }

  async function deleteProduct(id) {
    try {
      if (!isAdminLoggedIn()) throw new Error("Admin access required");

      // 1. Optimistic Local Update
      localProducts = localProducts.filter(p => p.id !== id);
      _saveToDiskCache();
      emit('products_changed', localProducts);

      // 2. Fire and Forget to Server
      firebase.firestore().collection('products').doc(id).delete()
        .catch(err => console.error('[KwabzStore] Background delete product failed:', err));

      return true;
    } catch (err) {
      console.error('[KwabzStore] Delete product error:', err);
      throw err;
    }
  }

  async function toggleProductStock(id) {
    try {
      const p = getProductById(id);
      if (!p) return null;
      return await updateProduct(id, { in_stock: !p.in_stock });
    } catch (err) {
      console.error('[KwabzStore] Toggle stock error:', err);
      throw err;
    }
  }

  async function addCategory(data) {
    try {
      const newDoc = { ...data, created_at: new Date().toISOString() };
      const docRef = await firebase.firestore().collection('categories').add(newDoc);
      const categoryWithId = { id: docRef.id, ...newDoc };
      localCategories.push(categoryWithId);
      _saveToDiskCache();
      emit('categories_changed', localCategories);
      return categoryWithId;
    } catch (err) {
      console.error('[KwabzStore] Add category error:', err);
      throw err;
    }
  }
  async function updateCategory(id, updates) {
    try {
      await firebase.firestore().collection('categories').doc(id).update(updates);
      const idx = localCategories.findIndex(c => c.id === id);
      if (idx !== -1) {
        localCategories[idx] = { ...localCategories[idx], ...updates };
        _saveToDiskCache();
        emit('categories_changed', localCategories);
      }
      return true;
    } catch (err) {
      console.error('[KwabzStore] Update category error:', err);
      throw err;
    }
  }

  async function deleteCategory(id) {
    try {
      await firebase.firestore().collection('categories').doc(id).delete();
      localCategories = localCategories.filter(c => c.id !== id);
      _saveToDiskCache();
      emit('categories_changed', localCategories);
      return true;
    } catch (err) {
      console.error('[KwabzStore] Delete category error:', err);
      throw err;
    }
  }

  // ─── Seller Management ───
  async function addSeller(data) {
    try {
      const newDoc = { ...data, created_at: new Date().toISOString() };
      const docRef = await firebase.firestore().collection('sellers').add(newDoc);
      const sellerWithId = { id: docRef.id, ...newDoc };
      localSellers.push(sellerWithId);
      _saveToDiskCache();
      emit('sellers_changed', localSellers);
      return sellerWithId;
    } catch (err) {
      console.error('[KwabzStore] Add seller error:', err);
      throw err;
    }
  }

  async function updateSeller(id, updates) {
    try {
      await firebase.firestore().collection('sellers').doc(id).update(updates);
      const idx = localSellers.findIndex(s => s.id === id);
      if (idx !== -1) {
        localSellers[idx] = { ...localSellers[idx], ...updates };
        _saveToDiskCache();
        emit('sellers_changed', localSellers);
      }
      return true;
    } catch (err) {
      console.error('[KwabzStore] Update seller error:', err);
      throw err;
    }
  }

  async function deleteSeller(id) {
    try {
      await firebase.firestore().collection('sellers').doc(id).delete();
      localSellers = localSellers.filter(s => s.id !== id);
      _saveToDiskCache();
      emit('sellers_changed', localSellers);
      return true;
    } catch (err) {
      console.error('[KwabzStore] Delete seller error:', err);
      throw err;
    }
  }

  // ─── Wishlist (Firestore-backed when logged in) ───────────
  async function _syncWishlistToFirestore() {
    if (!currentUser) return; // Only sync if user is logged in
    try {
      const db = firebase.firestore();
      await db.collection('users').doc(currentUser.uid)
        .collection('wishlist').doc('items')
        .set({ items: localWishlist, updated_at: new Date().toISOString() });
    } catch (err) {
      console.error('[KwabzStore] Wishlist sync error:', err);
    }
  }

  function _getWishlist() {
    if (!Array.isArray(localWishlist)) {
      localWishlist = [];
    }
    return localWishlist;
  }

  function _setWishlist(wishlist) {
    localWishlist = Array.isArray(wishlist) ? wishlist : [];
    _safeSetItem(KEYS.WISHLIST, JSON.stringify(localWishlist));
    if (currentUser) {
      _syncWishlistToFirestore();
    }
  }

  function getWishlist() { return _getWishlist(); }

  function clearWishlist() {
    _setWishlist([]);
    emit('wishlist_changed', []);
  }

  function addToWishlist(product) {
    const wishlist = _getWishlist();
    if (!product) {
      console.warn('[KwabzStore] Cannot add undefined product to wishlist');
      return wishlist;
    }
    const pid = product.id || product.product_id || product._id || product.uid;
    if (!pid) {
      console.warn('[KwabzStore] Cannot add product to wishlist because ID is missing:', product);
      return wishlist;
    }
    const existing = wishlist.find(i => i.product_id === pid);
    if (!existing) {
      wishlist.push({
        product_id: pid,
        name: product.name || '',
        price: product.price || 0,
        image_url: product.image_url || product.imageUrl || product.image || '',
        seller_id: product.seller_id || 'main'
      });
      _setWishlist(wishlist);
      emit('wishlist_changed', wishlist);
    }
    return wishlist;
  }

  function removeFromWishlist(id) {
    if (!id) return _getWishlist();
    const wishlist = _getWishlist().filter(i => i.product_id !== id);
    _setWishlist(wishlist);
    emit('wishlist_changed', wishlist);
    return wishlist;
  }

  function toggleWishlist(product) {
    if (!product) return _getWishlist();
    const pid = product.id || product.product_id || product._id || product.uid;
    if (!pid) return _getWishlist();

    const wishlist = _getWishlist();
    const existing = wishlist.find(i => i.product_id === pid);
    if (existing) {
      removeFromWishlist(pid);
    } else {
      addToWishlist(product);
    }
    return _getWishlist();
  }

  function isInWishlist(id) {
    if (!id) return false;
    return _getWishlist().some(i => i.product_id === id);
  }

  // ─── Cart (Firestore-backed when logged in) ───────────
  async function _syncCartToFirestore() {
    if (!currentUser) return; // Only sync if user is logged in

    try {
      const db = firebase.firestore();
      await db.collection('users').doc(currentUser.uid)
        .collection('cart').doc('items')
        .set({ items: localCart, updated_at: new Date().toISOString() });
    } catch (err) {
      console.error('[KwabzStore] Cart sync error:', err);
    }
  }

  function _getCart() {
    return localCart;
  }

  function _setCart(cart) {
    localCart = cart;
    _safeSetItem(KEYS.CART, JSON.stringify(cart));
    if (currentUser) {
      _syncCartToFirestore();
    }
  }

  function getCart() { return _getCart(); }

  function clearCart() {
    _setCart([]);
    emit('cart_changed', []);
  }

  function getCartTotal() {
    return _getCart().reduce((s, i) => s + (i.price * i.quantity), 0);
  }

  function getCartItemCount() {
    return _getCart().reduce((s, i) => s + i.quantity, 0);
  }

  function addToCart(product, quantity = 1) {
    const cart = _getCart();
    const sid = product.seller_id || 'main';

    if (cart.length > 0) {
      const existingSid = cart[0].seller_id || 'main';
      if (existingSid !== sid) {
        const storeName = (sid === 'main') ? 'the Kwabz Main Store' : (getSellerById(sid)?.name || 'another mini-store');
        const currentStore = (existingSid === 'main') ? 'Kwabz Main Store' : (getSellerById(existingSid)?.name || 'a mini-store');

        const confirm = window.confirm(
          `Your cart already contains items from "${currentStore}".\n\nAdding this item will clear your current cart because items from different stores must be ordered separately. \n\nDo you want to clear your cart and add this item instead?`
        );

        if (confirm) {
          cart.length = 0; // Clear it
        } else {
          return cart; // Cancel
        }
      }
    }

    const existing = cart.find(i => i.product_id === product.id);
    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.push({
        product_id: product.id,
        name: product.name,
        original_price: product.price,
        discount: KwabzUtils.getEffectiveDiscount ? KwabzUtils.getEffectiveDiscount(product) : 0,
        price: KwabzUtils.getEffectiveDiscount ? KwabzUtils.calcDiscountedPrice(product.price, KwabzUtils.getEffectiveDiscount(product)) : product.price,
        quantity,
        image_url: product.image_url || '',
        seller_id: sid,
        delivery_cost: parseFloat(product.delivery_cost || 0)
      });
    }
    _setCart(cart);
    emit('cart_changed', cart);
    return cart;
  }

  function removeFromCart(id) {
    const cart = _getCart().filter(i => i.product_id !== id);
    _setCart(cart);
    emit('cart_changed', cart);
    return cart;
  }

  function updateCartQuantity(id, qty) {
    const cart = _getCart();
    const item = cart.find(i => i.product_id === id);
    if (!item) return cart;
    if (qty <= 0) return removeFromCart(id);
    item.quantity = qty;
    _setCart(cart);
    emit('cart_changed', cart);
    return cart;
  }

  // ─── Orders ────────────────
  function _generateOrderLabel(sequenceId = null) {
    const now = new Date();
    const yearMonth = now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, '0');
    let suffix;
    if (sequenceId !== null) {
      suffix = String(sequenceId).padStart(4, '0');
    } else {
      suffix = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    }
    return `KBZ-${yearMonth}-${suffix}`;
  }

  async function createOrder(customerInfo, orderMethod = 'local') {
    try {
      const cart = _getCart();
      if (cart.length === 0) return null;
      const user = firebase.auth().currentUser;
      const seqId = 1000 + localOrders.length + 1;
      const generatedLabel = _generateOrderLabel(seqId);

      // Compute Admin Commission dynamically with decimal rate flexibility
      let totalCommission = 0;
      let usedRate = 10;
      const hasMiniStoreItem = cart.some(item => item.seller_id && item.seller_id !== 'main');
      if (hasMiniStoreItem) {
        cart.forEach(item => {
          if (item.seller_id && item.seller_id !== 'main') {
            const seller = getSellerById(item.seller_id);
            const rate = (seller && typeof seller.commission === 'number') ? seller.commission : 10;
            usedRate = rate;
            const itemTotal = (item.price || 0) * (item.quantity || 1);
            totalCommission += itemTotal * (rate / 100);
          }
        });
      }

      // Identify primary seller for backwards compatibility
      let orderSellerId = 'main';
      let orderSellerName = 'Kwabz Main Store';
      if (cart.length > 0) {
        const firstSellerId = cart[0].seller_id || 'main';
        const allSameSeller = cart.every(item => (item.seller_id || 'main') === firstSellerId);
        if (allSameSeller && firstSellerId !== 'main') {
          const seller = getSellerById(firstSellerId);
          if (seller) {
            orderSellerId = seller.id;
            orderSellerName = seller.name;
          }
        }
      }
      
      // Compute delivery fee
      let deliveryFee = 0;
      cart.forEach(item => {
        deliveryFee += (parseFloat(item.delivery_cost) || 0) * item.quantity;
      });

      const rawOrder = {
        order_number: '#' + seqId, // Maintained for backwards compatibility
        order_label: generatedLabel, // MODULE 1: ENTERPRISE ORDER ID ENGINE
        customer: customerInfo,
        customer_uid: user ? user.uid : null, // Link to user account
        order_method: orderMethod,
        items: cart,
        delivery_fee: parseFloat(deliveryFee.toFixed(2)),
        total_price: parseFloat((getCartTotal() + deliveryFee).toFixed(2)),
        admin_commission: hasMiniStoreItem ? parseFloat(totalCommission.toFixed(2)) : 0,
        commission_rate: hasMiniStoreItem ? usedRate : 0,
        seller_id: orderSellerId,
        seller_name: orderSellerName,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      const order = JSON.parse(JSON.stringify(rawOrder));
      const db = firebase.firestore();
      const docRef = db.collection('orders').doc(); // Instantly generate offline ID
      const orderWithId = { id: docRef.id, ...order };
      localOrders.unshift(orderWithId);
      _saveToDiskCache();
      emit('orders_changed', localOrders);

      // ── Always save this order locally so user can track it ──
      // For logged-in users, the real-time listener will keep this up to date.
      // For guests, this serves as a permanent offline receipt.
      userOrders.unshift(orderWithId);
      _saveUserOrdersToLocal();
      emit('user_orders_changed', userOrders);

      clearCart();

      // Fire and forget to Firestore
      docRef.set(order).catch(err => {
        console.error('[KwabzStore] Background save order failed:', err);
      });

      // Trigger Admin Alert
      _alertAdminNewOrder(orderWithId);

      return orderWithId;
    } catch (err) {
      console.error('[KwabzStore] Create order error:', err);
      throw err;
    }
  }

  async function updateOrderStatus(id, status) {
    try {
      await firebase.firestore().collection('orders').doc(id).update({ status });
      const idx = localOrders.findIndex(o => o.id === id);
      if (idx !== -1) {
        localOrders[idx].status = status;
        _saveToDiskCache();
        emit('orders_changed', localOrders);
      }
      return true;
    } catch (err) {
      console.error('[KwabzStore] Update order status error:', err);
      throw err;
    }
  }

  // Admin: permanently delete an order from Firestore
  async function deleteOrder(id) {
    if (!isAdminLoggedIn()) throw new Error('Admin access required to delete orders.');
    try {
      await firebase.firestore().collection('orders').doc(id).delete();
      localOrders = localOrders.filter(o => o.id !== id);
      _saveToDiskCache();
      emit('orders_changed', localOrders);
      console.log('[KwabzStore] Order deleted:', id);
      return true;
    } catch (err) {
      console.error('[KwabzStore] Delete order error:', err);
      throw err;
    }
  }

  function sendCancelNotificationViaWhatsApp(order, phone = '233553866329') {
    try {
      const customerName = order.customer?.name || 'Customer';
      const orderNum = order.order_label || order.order_number || '#NEW';
      const items = order.items || [];
      const totalAmount = order.total_price || 0;
      
      let message = `*🚫 ORDER CANCELLATION REQUEST*\n`;
      message += `----------------------------------------\n`;
      message += `*Customer:* ${customerName}\n`;
      message += `*Ref ID:* ${orderNum}\n`;
      message += `*Items:* ${items.map(i => `${i.name} (x${i.quantity})`).join(', ')}\n`;
      message += `*Total Price:* GH₵ ${totalAmount.toFixed(2)}\n`;
      message += `----------------------------------------\n`;
      message += `_This customer has cancelled their order on the website._`;

      const cleanPhone = phone.replace(/\D/g, '');
      window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`, '_blank');
    } catch (e) {
      console.error('[KwabzStore] Failed to send WhatsApp cancellation message:', e);
    }
  }

  // User: cancel their own order (sets status = cancelled)
  // Only allowed if the order hasn't shipped yet
  async function cancelOrder(id) {
    const order = localOrders.find(o => o.id === id) ||
      userOrders.find(o => o.id === id);

    if (!order) throw new Error('Order not found.');

    // Verify ownership (only check if both currentUser and order.customer_uid exist)
    if (currentUser && order.customer_uid && order.customer_uid !== currentUser.uid) {
      throw new Error('You can only cancel your own orders.');
    }

    const blockedStatuses = ['shipped', 'delivered', 'cancelled'];
    if (blockedStatuses.includes(order.status)) {
      throw new Error(`Cannot cancel an order that is already ${order.status}.`);
    }

    try {
      // 1. Try updating Firestore if ownership matches and user is logged in
      if (currentUser && order.customer_uid === currentUser.uid) {
        await firebase.firestore().collection('orders').doc(id).update({ status: 'cancelled' });
      }
      
      // 2. Update local user orders cache immediately
      const uIdx = userOrders.findIndex(o => o.id === id);
      if (uIdx !== -1) {
        userOrders[uIdx].status = 'cancelled';
        _saveUserOrdersToLocal();
        emit('user_orders_changed', userOrders);
      }
      
      // 3. Open WhatsApp notification for the admin
      sendCancelNotificationViaWhatsApp(order);
      return true;
    } catch (err) {
      console.warn('[KwabzStore] Firestore cancel order failed, falling back to local cancel + WhatsApp:', err);
      const uIdx = userOrders.findIndex(o => o.id === id);
      if (uIdx !== -1) {
        userOrders[uIdx].status = 'cancelled';
        _saveUserOrdersToLocal();
        emit('user_orders_changed', userOrders);
      }
      sendCancelNotificationViaWhatsApp(order);
      return true;
    }
  }


  // User: remove an order from their personal history (for cancelled or delivered items)
  async function removeOrderFromHistory(id) {
    const user = firebase.auth().currentUser;
    try {
      if (user) {
        // Only update Firestore if the user actually owns the order document
        const order = userOrders.find(o => o.id === id);
        if (order && order.customer_uid === user.uid) {
          await firebase.firestore().collection('orders').doc(id).update({
            hidden_by_customer: true
          });
        }
      }
    } catch (err) {
      console.warn('[KwabzStore] Failed to update hidden status in Firestore, hiding locally:', err);
    }
    
    // Always hide locally!
    userOrders = userOrders.filter(o => o.id !== id);
    _saveUserOrdersToLocal();
    emit('user_orders_changed', userOrders);
    return true;
  }

  async function getOrderById(id) {
    try {
      // 1. Check admin local cache first
      let local = localOrders.find(o => o.id === id);
      if (local) return local;

      // 2. Check user's personal local cache
      // Ensure we have loaded from disk if memory is empty (e.g. page refresh)
      if (userOrders.length === 0) {
        userOrders = _loadUserOrdersFromLocal();
      }
      local = userOrders.find(o => o.id === id);
      if (local) return local;

      // 3. Fallback to Firestore (may fail for guests due to security rules)
      if (typeof firebase !== 'undefined' && firebase.apps.length > 0) {
        const doc = await firebase.firestore().collection('orders').doc(id).get();
        if (doc.exists) {
          const data = { id: doc.id, ...doc.data() };
          return data;
        }
      }

      return null;
    } catch (err) {
      console.warn('[KwabzStore] Get order error:', err.message);
      return null;
    }
  }

  // ─── Admin Auth (Secure Firebase Auth) ──────────────────────────
  // (Admin Login consolidated above)

  async function adminLogout() {
    try {
      localStorage.removeItem('kwabz_login_time');
      await firebase.auth().signOut();
      localStorage.removeItem(KEYS.ADMIN_AUTH);
      localStorage.removeItem('kwabz_user_mode');
    } catch (err) {
      console.error('[KwabzStore] Admin logout error:', err);
    }
  }

  async function registerAdmin(email, password, name) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('You must be logged in to register new admins.');

    // ── Aggressive Verification ──
    if (!isAdminLoggedIn()) {
      try {
        const doc = await firebase.firestore().collection('users').doc(user.uid).get();
        if (doc.exists && doc.data().role === 'admin') {
          localRole = 'admin';
          localStorage.setItem(KEYS.ADMIN_AUTH, 'true');
        }
      } catch (e) {
        console.error('[KwabzStore] Deep verification failed:', e);
      }
    }

    if (!isAdminLoggedIn()) {
      console.warn('[KwabzStore] Registration blocked. Current role:', localRole);
      throw new Error('Only existing admins can register new admins. (Verification failed)');
    }

    let secondaryApp;
    try {
      secondaryApp = firebase.app('Secondary');
    } catch (e) {
      secondaryApp = firebase.initializeApp(firebase.app().options, 'Secondary');
    }

    // Wrap the entire process in a timeout to prevent hanging UI
    const registrationTask = (async () => {
      try {
        console.log('[KwabzStore] Creating new admin account...');
        const res = await secondaryApp.auth().createUserWithEmailAndPassword(email, password);
        const uid = res.user.uid;

        console.log('[KwabzStore] New UID created:', uid, '. Syncing identity...');

        // 1. Update Auth Profile
        await res.user.updateProfile({ displayName: name });

        // 2. Set Firestore User Document
        await firebase.firestore().collection('users').doc(uid).set({
          email: email,
          displayName: name,
          role: 'admin',
          created_at: new Date().toISOString()
        });

        console.log('[KwabzStore] Admin registration complete.');
        return true;
      } finally {
        // Always try to clean up the secondary app
        try { await secondaryApp.delete(); } catch (e) { }
      }
    })();

    // 15 second timeout
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Registration timed out. Please check your network and Firebase Rules.')), 15000)
    );

    try {
      return await Promise.race([registrationTask, timeout]);
    } catch (err) {
      console.error('[KwabzStore] Registration error:', err);
      throw err;
    }
  }

  // ─── WhatsApp ──────────────
  /**
   * 2. "Order Inquiry" (User → Admin)
   * High-end, automated WhatsApp messaging with business-grade copywriting.
   */
  function sendOrderViaWhatsApp(order, phone = '233553866329') {
    const customerName = order.customer?.name || 'Customer';
    const customerPhone = order.customer?.phone || '';
    const customerAddress = order.customer?.address || '';
    const items = order.items || [];
    
    // Generate a unique Ref ID for professional tracking
    const randomSuffix = Math.random().toString(36).substring(2, 5).toUpperCase();
    const refId = `KBZ-${randomSuffix}`;

    const firstItem = items[0]?.name || 'Item';
    const isMiniStore = items[0]?.seller_id && items[0].seller_id !== 'main';

    let message = '';

    if (items.length > 1 || (customerPhone && customerAddress)) {
      // Standardize beautiful order manifest for cart checkouts
      const storeName = isMiniStore ? (getSellerById(items[0].seller_id)?.name || 'Mini Store') : 'Kwabz Main Store';
      
      message = `*🛒 NEW ORDER FROM ${storeName.toUpperCase()}*\n`;
      message += `----------------------------------------\n`;
      message += `*Customer Details:*\n`;
      message += `👤 *Name:* ${customerName}\n`;
      if (customerPhone) message += `📞 *Phone:* ${customerPhone}\n`;
      if (customerAddress) message += `📍 *Address:* ${customerAddress}\n\n`;
      
      message += `*Order Items:*\n`;
      let subTotal = 0;
      let deliveryFee = 0;
      items.forEach((item, idx) => {
        const itemTotal = (item.price || 0) * (item.quantity || 1);
        subTotal += itemTotal;
        const itemDelivery = (parseFloat(item.delivery_cost) || 0) * (item.quantity || 1);
        deliveryFee += itemDelivery;
        message += `${idx + 1}. 🛍️ *${item.name}*\n`;
        message += `   Quantity: ${item.quantity || 1} | Price: GH₵ ${itemTotal.toFixed(2)}`;
        if (itemDelivery > 0) {
          message += ` (Delivery: GH₵ ${itemDelivery.toFixed(2)})`;
        }
        message += `\n\n`;
      });
      
      message += `----------------------------------------\n`;
      message += `Subtotal: GH₵ ${subTotal.toFixed(2)}\n`;
      if (deliveryFee > 0) {
        message += `Delivery Fee: GH₵ ${deliveryFee.toFixed(2)}\n`;
      }
      const grandTotal = subTotal + deliveryFee;
      message += `💰 *TOTAL AMOUNT:* GH₵ ${grandTotal.toFixed(2)}\n`;
      message += `📝 *Ref ID:* ${refId}\n`;
      message += `----------------------------------------\n`;
      message += `_Please confirm receipt and share payment methods to proceed!_`;

    } else {
      // Fallback/Single product detail quick checkout
      if (isMiniStore) {
        message = `Hello! I saw your product "${firstItem}" listed on Kwabz Store and would love to place an order. Could you please share your payment methods so I can complete my payment?\n\n*Product:* ${firstItem}\n*Customer:* ${customerName}\n*Ref ID:* ${refId}`;
      } else {
        message = `Hello Kwabz Admin, I would like to inquire about this item:\n\n*Product:* ${firstItem}\n\n*Customer:* ${customerName}\n*Ref ID:* ${refId}\n\n_Please provide payment details to proceed._`;
      }
    }

    const cleanPhone = phone.replace(/\D/g, '');
    window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`, '_blank');
  }

  function sendStatusUpdateViaWhatsApp(order) {
    const status = order.status || 'pending';
    const name = order.customer.name.split(' ')[0];
    const orderNum = order.order_label || order.order_number;
    const phone = order.customer.phone.replace(/\D/g, '');
    let msg = `Hi ${name}, your order *${orderNum}* status has been updated to: *${status}*.`;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  }

  function getSettings() { return localSettings; }

  async function updateSettings(updates) {
    try {
      if (!isAdminLoggedIn()) {
        throw new Error('Unauthorized: Only the system admin can update global theme settings.');
      }

      const db = firebase.firestore();
      console.log('[KwabzStore] Updating global settings...', updates);

      // 1. Optimistic Local Update
      localSettings = { ...localSettings, ...updates };
      _safeSetItem(KEYS.SETTINGS, JSON.stringify(_stripHeavyFields(localSettings)));
      emit('settings_changed', localSettings);

      db.collection('settings').doc('global').set(updates, { merge: true })
        .catch(err => {
          console.error('[KwabzStore] Background update settings failed:', err);
          emit('settings_write_failed', err);
        });

      return true;
    } catch (err) {
      console.error('[KwabzStore] Update settings error:', err);
      throw err;
    }
  }

  function searchProducts(query, sellerId = 'main') {
    let baseProducts = (sellerId === 'all') ? localProducts :
      (sellerId === 'main' ? getProducts() : getProductsBySeller(sellerId));

    if (!query) return baseProducts;

    const q = query.toLowerCase();
    return baseProducts.filter(p => {
      const nameMatch = p.name.toLowerCase().includes(q);
      const descMatch = (p.description || '').toLowerCase().includes(q);
      const cat = getCategoryById(p.category_id);
      const catMatch = (cat && cat.name.toLowerCase().includes(q));
      return nameMatch || descMatch || catMatch;
    });
  }

  /**
   * Helper to strip massive base64 strings before caching to localStorage.
   * This prevents QuotaExceededError while allowing Firestore to keep the full data.
   */
  function _stripHeavyFields(data) {
    if (!data) return data;

    const heavyFields = [
      'image', 'imageUrl', 'image_url', 'thumbnail', 'heroImage', 'logo', 'banner', 'bgImage',
      'heroImage1', 'heroImage2', 'heroImage3', 'logoImageUrl', 'shopHeroImage', 'shopHeroImage2', 
      'authLoginImage', 'authSignupImage', 'sellersBgImage', 'splashBgImage', 'splashFavicon'
    ];

    const _cleanItem = (item) => {
      if (!item || typeof item !== 'object') return item;
      const cleaned = { ...item };
      
      // Clean heavy matching fields if they are base64 strings
      heavyFields.forEach(field => {
        if (cleaned[field] && typeof cleaned[field] === 'string' && cleaned[field].startsWith('data:')) {
          delete cleaned[field];
        }
      });

      // Recursively clean child properties
      for (const key in cleaned) {
        if (cleaned[key] && typeof cleaned[key] === 'object') {
          cleaned[key] = _stripHeavyFields(cleaned[key]);
        }
      }
      return cleaned;
    };

    if (Array.isArray(data)) return data.map(_cleanItem);
    return _cleanItem(data);
  }

  // ─── Automated WhatsApp Notifications (Client-Side) ───
  /**
   * Helper to send a WhatsApp message via Twilio REST API
   */
  async function _sendTwilioMessage(to, body) {
    const config = window.TWILIO_CONFIG;
    if (!config || config.sid.includes('xxx')) {
      console.warn('[Twilio] Config missing or using placeholders. Skipping message.');
      return;
    }

    try {
      const auth = btoa(`${config.sid}:${config.token}`);
      const url = `https://api.twilio.com/2010-04-01/Accounts/${config.sid}/Messages.json`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          From: `whatsapp:${config.from}`,
          To: `whatsapp:${to}`,
          Body: body
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message);
      }
      console.log(`[Twilio] Message sent to ${to}`);
    } catch (err) {
      console.error(`[Twilio] Failed to send to ${to}:`, err);
    }
  }

  /**
   * Broadcast a new product to all users with phone numbers (Twilio)
   * AND writes a Firestore notification doc so online browsers receive push.
   */
  async function _broadcastNewProduct(product, productId) {
    const message = `*Kwabz Store Update:* A new essential has arrived: *${product.name}*.\nPrice: *GH₵ ${product.price}*. View the drop: https://kwabz-store-v2.vercel.app/product-detail.html?id=${productId}`;

    // ── 1. Write Firestore notification doc (browser push trigger) ──
    try {
      await firebase.firestore().collection('product_notifications').add({
        product_id: productId,
        name: product.name,
        price: product.price,
        discount: product.discount || 0,
        image_url: (product.image_url || '').startsWith('data:') ? '' : (product.image_url || ''),
        seller_id: product.seller_id || 'main',
        created_at: new Date().toISOString()
      });
      console.log('[KwabzStore] Browser push notification written to Firestore.');
    } catch (err) {
      console.warn('[KwabzStore] Failed to write push notification doc:', err);
    }

    // ── 2. WhatsApp broadcast via Twilio (existing) ──
    try {
      const db = firebase.firestore();
      const usersSnap = await db.collection('users').where('phoneNumber', '!=', null).get();

      const promises = usersSnap.docs.map(doc => {
        const phone = KwabzUtils.formatWhatsAppPhone(doc.data().phoneNumber);
        if (!phone) return null;
        return _sendTwilioMessage(phone, message);
      });

      await Promise.all(promises);
      console.log(`[Broadcast] Notified ${usersSnap.size} users about ${product.name}.`);
    } catch (err) {
      console.error('[Broadcast Failed]', err);
    }
  }


  /**
   * Alert Admin about a new order inquiry
   */
  async function _alertAdminNewOrder(order) {
    const config = window.TWILIO_CONFIG;
    if (!config || !config.adminPhone) return;

    const customerName = order.customer?.name || 'Customer';
    const firstItem = order.items?.[0]?.name || 'Item';
    const customerPhone = KwabzUtils.formatWhatsAppPhone(order.customer?.phone || '0000000000');
    const orderNum = order.order_label || order.order_number || '#NEW';

    const message = `*Hello Kwabz Admin, I would like to inquire about an item.*\n\n*Product:* ${firstItem}\n*Customer:* ${customerName}\n*Ref ID:* ${orderNum}\n\n_Please provide payment details to proceed._\n\nChat with Customer: https://wa.me/${customerPhone.replace('+', '')}`;

    await _sendTwilioMessage(config.adminPhone, message);
  }

  function _saveToDiskCache() {
    _safeSetItem(KEYS.CACHE_TIMESTAMP, String(Date.now())); // Stamp write time for TTL enforcement
    _safeSetItem(KEYS.CACHE_PRODUCTS, JSON.stringify(_stripHeavyFields(localProducts)));
    _safeSetItem(KEYS.CACHE_CATEGORIES, JSON.stringify(localCategories));
    _safeSetItem(KEYS.CACHE_SELLERS, JSON.stringify(localSellers));

    // Cache up to 50 recent orders so admin dashboard loads instantly.
    // Guard on data presence (not auth state) to avoid the startup race condition
    // where isAdminLoggedIn() returns false before Firebase Auth resolves.
    if (localOrders.length > 0) {
      _safeSetItem(KEYS.CACHE_ORDERS, JSON.stringify(localOrders.slice(0, 50)));
    }
  }

  // ─── Cross-Tab Real-Time Sync ───
  // When admin saves settings in one tab, all other open tabs receive the update instantly.
  window.addEventListener('storage', (e) => {
    if (e.key === KEYS.SETTINGS && e.newValue) {
      try {
        localSettings = JSON.parse(e.newValue);
        emit('settings_changed', localSettings);
      } catch (err) { }
    }
    if (e.key === KEYS.CACHE_PRODUCTS && e.newValue) {
      try {
        localProducts = JSON.parse(e.newValue);
        emit('products_changed', localProducts);
      } catch (err) { }
    }
    if (e.key === KEYS.CACHE_CATEGORIES && e.newValue) {
      try {
        localCategories = JSON.parse(e.newValue);
        emit('categories_changed', localCategories);
      } catch (err) { }
    }
    if (e.key === KEYS.CACHE_SELLERS && e.newValue) {
      try {
        localSellers = JSON.parse(e.newValue);
        emit('sellers_changed', localSellers);
      } catch (err) { }
    }
  });


  // ─── Mini-Store WhatsApp Inquiry Logger ─────────────────────
  /**
   * Called when a customer taps "Order on WhatsApp" on a mini-store product.
   * Creates a Firestore order record so the admin sees it, and 10% commission
   * is captured in the dashboard stats — without changing the customer UX at all.
   */
  async function logWhatsAppInquiry(product, seller) {
    try {
      const user = firebase.auth().currentUser;
      const discountPct = product.discount || 0;
      const finalPrice = discountPct > 0
        ? product.price * (1 - discountPct / 100)
        : product.price;

      // Use the seller's configured commission rate (decimal flexible, e.g. 7.5%), default 10%
      const commissionRate = (typeof seller.commission === 'number' ? seller.commission : 10) / 100;

      const generatedLabel = _generateOrderLabel();
      const orderData = {
        order_label: generatedLabel,
        order_number: '#WA-' + Math.floor(1000 + Math.random() * 9000), // Maintained for backwards compatibility
        order_method: 'whatsapp',
        status: 'pending',
        customer_uid: user ? user.uid : null,
        customer: {
          name: user ? (user.displayName || user.email.split('@')[0]) : 'WhatsApp Customer',
          phone: user ? (user.phoneNumber || '') : '',
          address: 'Via WhatsApp'
        },
        items: [{
          product_id: product.id,
          name: product.name,
          original_price: product.price,
          discount: discountPct,
          price: finalPrice,
          quantity: 1,
          image_url: (product.image_url || '').startsWith('data:') ? '' : (product.image_url || ''),
          seller_id: seller.id
        }],
        total_price: finalPrice,
        admin_commission: parseFloat((finalPrice * commissionRate).toFixed(2)),
        commission_rate: seller.commission ?? 10, // Store the rate used (%) for display in admin
        seller_id: seller.id,
        seller_name: seller.name,
        created_at: new Date().toISOString()
      };

      const docRef = await firebase.firestore().collection('orders').add(orderData);
      const orderWithId = { id: docRef.id, ...orderData };

      // Push into local cache so admin sees it without refresh
      localOrders.unshift(orderWithId);
      _saveToDiskCache();
      emit('orders_changed', localOrders);

      console.log('[KwabzStore] WhatsApp inquiry logged:', docRef.id);
      return orderWithId;
    } catch (err) {
      // Non-blocking — still open WhatsApp even if logging fails
      console.warn('[KwabzStore] Could not log WhatsApp inquiry:', err);
      return null;
    }
  }

  // ─── Review System ─────────────────────────────────────────
  // Per-product review cache: { [productId]: { data: [], ts: timestamp } }
  const _reviewCache = {};
  const _REVIEW_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  async function getReviews(productId) {
    try {
      const now = Date.now();
      const cached = _reviewCache[productId];
      // Return from cache if still fresh
      if (cached && (now - cached.ts) < _REVIEW_CACHE_TTL) {
        return cached.data;
      }

      // Try Backend proxy first
      if (useBackend) {
        try {
          const res = await fetch(`${BACKEND_URL}/api/reviews/${productId}`);
          if (res.ok) {
            const reviews = await res.json();
            _reviewCache[productId] = { data: reviews, ts: now };
            return reviews;
          }
        } catch (e) {
          // Fall back to Firestore
        }
      }

      // Cache miss or stale — fetch from Firestore
      const snapshot = await firebase.firestore().collection('reviews')
        .where('product_id', '==', productId)
        .get();
      const reviews = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      // Sort in-memory to prevent requiring composite indices in Firebase console
      reviews.sort((a, b) => _getSafeTime(b.created_at) - _getSafeTime(a.created_at));

      // Store in cache
      _reviewCache[productId] = { data: reviews, ts: now };
      return reviews;
    } catch (err) {
      console.error('[KwabzStore] Failed to fetch reviews:', err);
      return [];
    }
  }


  // Admin-only: fetch ALL reviews across every product.
  // Uses a single collection-level .get() and populates the per-product cache
  // so subsequent getReviews(productId) calls are served from memory.
  let _allReviewsCache = null;
  let _allReviewsCacheTs = 0;
  const _ALL_REVIEWS_TTL = 3 * 60 * 1000; // 3 minutes for admin panel

  async function getReviewsAll() {
    try {
      const now = Date.now();
      if (_allReviewsCache && (now - _allReviewsCacheTs) < _ALL_REVIEWS_TTL) {
        return _allReviewsCache;
      }

      const snapshot = await firebase.firestore().collection('reviews').get();
      const reviews = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      reviews.sort((a, b) => _getSafeTime(b.created_at) - _getSafeTime(a.created_at));

      // Seed per-product cache while we have all the data
      const byProduct = {};
      reviews.forEach(r => {
        if (!byProduct[r.product_id]) byProduct[r.product_id] = [];
        byProduct[r.product_id].push(r);
      });
      Object.entries(byProduct).forEach(([pid, list]) => {
        _reviewCache[pid] = { data: list, ts: now };
      });

      _allReviewsCache = reviews;
      _allReviewsCacheTs = now;
      return reviews;
    } catch (err) {
      console.error('[KwabzStore] Failed to fetch all reviews:', err);
      return [];
    }
  }


  async function addReview(productId, rating, comment, photos = [], customerName = 'Anonymous') {
    try {
      const user = firebase.auth().currentUser;
      const uid = user ? user.uid : 'guest';
      
      // Check if user has purchased this product (Verified Purchase)
      // OPTIMIZATION: Check local userOrders cache first — zero Firestore reads.
      // Only fall back to a Firestore query if local cache is empty (e.g. first session).
      let verifiedPurchase = false;
      if (user) {
        try {
          const localCheck = userOrders.length > 0 ? userOrders : _loadUserOrdersFromLocal();
          verifiedPurchase = localCheck.some(order =>
            order.customer_uid === uid &&
            Array.isArray(order.items) &&
            order.items.some(item => (item.product_id || item.id) === productId)
          );

          // Fallback to Firestore ONLY if local cache is completely empty
          if (!verifiedPurchase && localCheck.length === 0) {
            const ordersSnapshot = await firebase.firestore().collection('orders')
              .where('customer_uid', '==', uid)
              .get();
            ordersSnapshot.forEach(doc => {
              const order = doc.data();
              if (Array.isArray(order.items)) {
                if (order.items.some(item => (item.product_id || item.id) === productId)) {
                  verifiedPurchase = true;
                }
              }
            });
          }
        } catch (e) {
          console.warn('[KwabzStore] Verified purchase lookup failed:', e);
        }
      }

      const reviewData = {
        product_id: productId,
        user_id: uid,
        customer_name: customerName,
        rating: rating,
        comment: comment,
        photos: photos, // Array of base64 compressed images
        likes: 0,
        liked_by: [], // List of user IDs who liked it
        verified_purchase: verifiedPurchase,
        created_at: new Date().toISOString()
      };

      // Write review proxy
      if (useBackend) {
        try {
          const res = await fetch(`${BACKEND_URL}/api/reviews`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reviewData)
          });
          if (res.ok) {
            const newReview = await res.json();
            delete _reviewCache[productId];
            _allReviewsCache = null;
            return newReview;
          }
        } catch (e) {
          // Fall back to native
        }
      }

      const docRef = await firebase.firestore().collection('reviews').add(reviewData);
      const newReview = { id: docRef.id, ...reviewData };

      // Bust review cache so the product page and admin panel reflect the new review immediately
      delete _reviewCache[productId];
      _allReviewsCache = null;

      return newReview;
    } catch (err) {
      console.error('[KwabzStore] Failed to add review:', err);
      throw err;
    }
  }

  async function toggleLikeReview(reviewId) {
    try {
      const user = firebase.auth().currentUser;
      if (!user) throw new Error('You must be signed in to like reviews.');
      const uid = user.uid;

      const docRef = firebase.firestore().collection('reviews').doc(reviewId);
      const doc = await docRef.get();
      if (!doc.exists) throw new Error('Review not found.');

      const data = doc.data();
      const likedBy = data.liked_by || [];
      const hasLiked = likedBy.includes(uid);

      let newLikes = data.likes || 0;
      let newLikedBy = [...likedBy];

      if (hasLiked) {
        newLikes = Math.max(0, newLikes - 1);
        newLikedBy = newLikedBy.filter(id => id !== uid);
      } else {
        newLikes += 1;
        newLikedBy.push(uid);
      }

      await docRef.update({
        likes: newLikes,
        liked_by: newLikedBy
      });

      return { likes: newLikes, hasLiked: !hasLiked };
    } catch (err) {
      console.error('[KwabzStore] Failed to like review:', err);
      throw err;
    }
  }


  _loadFromDiskCache();

  return {
    // Core
    init, on, emit, refreshAll, getSyncStatus, generateId, isInitialized: () => isFirestoreInitialized,

    // Real-time Data
    getProducts, getAllProducts, getCategories, getOrders,
    getProductById, getCategoryById, getSellerById, getProductsByCategory,
    getAllProductsByCategory,

    // Product Management
    addProduct, updateProduct, deleteProduct, toggleProductStock,

    // Category Management
    addCategory, updateCategory, deleteCategory,

    // Seller Management
    getSellers, addSeller, updateSeller, deleteSeller,
    getProductsBySeller,

    // Cart (Firestore-backed when logged in)
    getCart, addToCart, removeFromCart, updateCartQuantity,
    clearCart, getCartTotal, getCartItemCount,
    getWishlist, addToWishlist, removeFromWishlist, toggleWishlist, isInWishlist, clearWishlist,

    // Admin Orders
    createOrder, updateOrderStatus, getOrderById,
    deleteOrder, cancelOrder,

    // User Order History (local + real-time)
    getUserOrders, removeOrderFromHistory,

    // Firebase Auth
    emailSignUp, emailLogin, logout, getCurrentUser,

    // Legacy Admin Auth
    adminLogin, adminLogout, isAdminLoggedIn,

    // Social
    sendOrderViaWhatsApp, sendStatusUpdateViaWhatsApp,
    searchProducts, logWhatsAppInquiry,

    // Settings
    getSettings, updateSettings,

    // Sync Status
    getSyncStatus, isAuthReady, getBackendStatus: () => backendStatus,

    // Admin & Presence
    onAdminsPresence, registerAdmin, refreshPresence, deleteAdmin,

    // Visitor Tracking
    trackVisitor, onVisitorCount,

    // Reviews
    getReviews, getReviewsAll, addReview, toggleLikeReview
  };
})();

// Load Cache Immediately upon Script Load for zero-latency UI access, and auto-initialize if Firebase is loaded
if (typeof KwabzStore !== 'undefined') {
  if (typeof firebase !== 'undefined' && firebase.firestore) {
    KwabzStore.init();
  } else {
    // Retry initializing every 250ms until Firebase SDK is fully loaded from network
    const _initInterval = setInterval(() => {
      if (typeof firebase !== 'undefined' && firebase.firestore) {
        console.log('[KwabzStore] Firebase SDK resolved. Initializing store now...');
        KwabzStore.init();
        clearInterval(_initInterval);
      }
    }, 250);
    // Safety timeout: stop trying after 10 seconds
    setTimeout(() => clearInterval(_initInterval), 10000);
  }
}
