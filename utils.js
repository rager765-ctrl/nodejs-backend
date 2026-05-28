/**
 * Kwabz Store Online — Utility Functions
 */

const KwabzUtils = {
  /**
   * Format a number as USD currency.
   */
  formatPrice(amount) {
    return 'GH₵' + parseFloat(amount).toFixed(2);
  },

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  /**
   * Apply global theme settings (fonts, colors, glass opacity)
   */
  applyGlobalTheme(theme) {
    if (!theme) return;
    
    if (theme.fontFamily) {
      document.documentElement.style.setProperty('--font-headline', theme.fontFamily);
      document.documentElement.style.setProperty('--font-body', theme.fontFamily);
    }
    
    if (theme.primaryColor) {
      document.documentElement.style.setProperty('--primary', theme.primaryColor);
      document.querySelectorAll('.btn-landing--primary').forEach(el => {
        el.style.color = theme.primaryColor;
      });
    }
    
    if (theme.glassOpacity !== undefined) {
      const bg = `rgba(255, 255, 255, ${theme.glassOpacity})`;
      const topBar = document.querySelector('.top-app-bar');
      if (topBar) topBar.style.backgroundColor = bg;
      const dock = document.querySelector('.bottom-nav') || document.querySelector('.bottom-nav-admin');
      if (dock) dock.style.backgroundColor = bg;
    }

    // Custom Login & Sign-up Page Banner Images
    const path = window.location.pathname.split('/').pop() || 'index.html';
    const isLogin = path === 'login.html';
    const isSignup = path === 'signup.html';
    const authHeader = document.querySelector('.auth-top-header');
    
    if (authHeader) {
      if (isLogin && theme.authLoginImage) {
        const isDark = document.body.classList.contains('dark-mode');
        const overlay = isDark 
          ? 'linear-gradient(135deg, rgba(0, 0, 0, 0.5) 0%, rgba(0, 0, 0, 0.85) 100%)' 
          : 'linear-gradient(135deg, rgba(0, 0, 0, 0.35) 0%, rgba(0, 0, 0, 0.75) 100%)';
        authHeader.style.background = `${overlay}, url('${theme.authLoginImage}') center/cover no-repeat`;
      } else if (isSignup && theme.authSignupImage) {
        const isDark = document.body.classList.contains('dark-mode');
        const overlay = isDark 
          ? 'linear-gradient(135deg, rgba(0, 0, 0, 0.5) 0%, rgba(0, 0, 0, 0.85) 100%)' 
          : 'linear-gradient(135deg, rgba(0, 0, 0, 0.35) 0%, rgba(0, 0, 0, 0.75) 100%)';
        authHeader.style.background = `${overlay}, url('${theme.authSignupImage}') center/cover no-repeat`;
      }
    }

    // Dynamic Brand/Logo Rendering
    const brandTitleEl = document.querySelector('.top-app-bar__title');
    if (brandTitleEl) {
      const logoType = theme.logoType || 'text';
      const logoText = theme.logoText || 'Kwabz Store';
      const logoImageUrl = theme.logoImageUrl || '';
      
      const isBrandingPage = window.location.pathname.endsWith('index.html') || 
                             window.location.pathname.endsWith('shop.html') || 
                             window.location.pathname === '/' ||
                             brandTitleEl.textContent.trim().toLowerCase() === 'kwabz store' ||
                             brandTitleEl.textContent.trim().toLowerCase() === 'kwabz';
                             
      if (isBrandingPage) {
        if (logoType === 'image' && logoImageUrl) {
          brandTitleEl.innerHTML = `<img src="${logoImageUrl}" alt="${logoText}" style="max-height: 2.2rem; max-width: 160px; object-fit: contain; vertical-align: middle; display: block;" />`;
        } else {
          brandTitleEl.textContent = logoText;
        }
      }
    }

    const drawerTitleEl = document.querySelector('#sideDrawer h2');
    if (drawerTitleEl) {
      const logoText = theme.logoText || 'Kwabz Store';
      drawerTitleEl.textContent = logoText.toUpperCase();
    }

    // Recalculate status bar color to align with new theme or glass settings
    if (typeof updateDynamicStatusBarColor === 'function') {
      setTimeout(updateDynamicStatusBarColor, 50);
    }
  },

  /**
   * Calculate discounted price.
   */
  calcDiscountedPrice(price, discountPercent) {
    if (!discountPercent || discountPercent <= 0) return price;
    return price * (1 - discountPercent / 100);
  },

  /**
   * Gets the effective discount for a product (checks if seller has a global discount)
   */
  getEffectiveDiscount(product) {
    if (!product) return 0;
    if (product.seller_id && product.seller_id !== 'main' && typeof KwabzStore !== 'undefined') {
      const seller = KwabzStore.getSellerById(product.seller_id);
      if (seller && seller.discount > 0) return seller.discount;
    }
    return product.discount || 0;
  },

  /**
   * Format ISO date string to readable format.
   */
  formatDate(val) {
    if (!val) return '';
    const d = (val.toDate && typeof val.toDate === 'function') ? val.toDate() : new Date(val);
    if (isNaN(d.getTime())) return 'Recently';
    return d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  },

  /**
   * Relative time (e.g., "2 mins ago").
   */
  timeAgo(val) {
    if (!val) return 'Never';
    const date = (val.toDate && typeof val.toDate === 'function') ? val.toDate() : new Date(val);
    if (isNaN(date.getTime())) return 'Recently';

    const diff = Math.floor((Date.now() - date.getTime()) / 1000);

    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} days ago`;
    return KwabzUtils.formatDate(date);
  },

  /**
   * Helper to normalize a date/timestamp to epoch milliseconds for safe math & sorting.
   */
  getSafeTime(val) {
    if (!val) return 0;
    if (val.seconds) return val.seconds * 1000;
    if (val.toDate && typeof val.toDate === 'function') return val.toDate().getTime();
    const parsed = new Date(val).getTime();
    return isNaN(parsed) ? 0 : parsed;
  },

  /**
   * Get URL query parameter.
   */
  getParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  },

  /**
   * Show a toast notification.
   */
  toast(message, type = 'success') {
    const existing = document.getElementById('kwabz-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'kwabz-toast';
    toast.className = `kwabz-toast kwabz-toast--${type}`;
    toast.innerHTML = `
      <span class="material-symbols-outlined" style="font-size:18px;">
        ${type === 'success' ? 'check_circle' : type === 'error' ? 'error' : 'info'}
      </span>
      <span>${message}</span>
    `;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('kwabz-toast--visible'));
    setTimeout(() => {
      toast.classList.remove('kwabz-toast--visible');
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  },

  /**
   * Robust +233 formatting logic for Ghana WhatsApp
   */
  formatWhatsAppPhone(phone) {
    if (!phone) return null;
    let raw = phone.toString().trim();
    
    // If explicitly starts with '+', preserve the exact international country code
    if (raw.startsWith('+')) {
      return '+' + raw.replace(/\D/g, '');
    }
    
    let clean = raw.replace(/\D/g, '');
    
    // Local Ghanaian number style starting with '0'
    if (clean.startsWith('0')) {
      return '+233' + clean.substring(1);
    }
    
    // Fully formatted local style starting with '233' of correct length
    if (clean.startsWith('233') && clean.length >= 12) {
      return '+' + clean;
    }
    
    // Local Ghanaian number missing leading '0' (typically 9 digits)
    if (clean.length === 9) {
      return '+233' + clean;
    }
    
    // Otherwise, assume it's already an international number formatted without '+' (e.g. 1555... or 234...)
    if (clean.length >= 10) {
      return '+' + clean;
    }
    
    // Fallback default
    if (!clean.startsWith('233')) {
      clean = '233' + clean;
    }
    return '+' + clean;
  },

  /**
   * Convert a file to a data URL (for local image preview/storage).
   */
  fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  /**
   * Check if admin is logged in, redirect if not.
   */
  requireAdmin() {
    if (!KwabzStore.isAdminLoggedIn()) {
      const inAdminFolder = window.location.pathname.includes('/admin/');
      window.location.href = inAdminFolder ? 'admin-login.html' : 'admin/admin-login.html';
      return false;
    }
    return true;
  },

  /**
   * Render the cart badge count in a nav element.
   */
  updateCartBadge() {
    const badges = document.querySelectorAll('[data-cart-badge]');
    if (typeof KwabzStore === 'undefined') return;
    const count = KwabzStore.getCartItemCount();
    badges.forEach(badge => {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    });
  },

  /**
   * Enforce Google Chrome (Specifically block Samsung Internet)
   */
  enforceChrome() {
    const ua = navigator.userAgent;
    const isSamsung = ua.includes('SamsungBrowser');

    if (isSamsung) {
      const currentUrl = window.location.href;
      const chromeIntent = `intent://${currentUrl.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
      
      document.body.innerHTML = `
        <div style="position:fixed;inset:0;z-index:99999;background:white;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem;text-align:center;font-family:sans-serif;">
          <div style="width:80px;height:80px;background:#F2F2F2;border-radius:24px;display:flex;align-items:center;justify-content:center;margin-bottom:2rem;">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
          </div>
          <h1 style="font-size:1.5rem;font-weight:800;margin-bottom:0.75rem;letter-spacing:-0.02em;">Browser Not Supported</h1>
          <p style="color:#666;line-height:1.6;margin-bottom:2.5rem;max-width:20rem;">
            Samsung Internet is currently not supported for <strong>Kwabz Store</strong>. Please use Google Chrome for the best experience.
          </p>
          <a href="${chromeIntent}" style="background:black;color:white;padding:1rem 2rem;border-radius:100px;text-decoration:none;font-weight:700;font-size:0.875rem;display:flex;align-items:center;gap:0.75rem;">
            Open in Google Chrome
            <span class="material-symbols-outlined" style="font-size:1.25rem;">open_in_new</span>
          </a>
          <p style="margin-top:2rem;font-size:0.75rem;color:#999;max-width:18rem;">
            Switching to Chrome will ensure all features work correctly.
          </p>
        </div>
      `;
      document.body.style.overflow = 'hidden';
      return false;
    }
    return true;
  },

  /**
   * Initialize Auth-responsive navigation across all pages.
   */
  initAuthNavigation() {
    if (typeof KwabzStore === 'undefined') return;
    
    const updateUI = (user) => {
      // 1. Bottom Nav Elements
      const navLink = document.getElementById('authNavLink');
      const navText = document.getElementById('authNavText');
      const navIcon = navLink ? navLink.querySelector('.material-symbols-outlined') : null;

      // 2. Header Action Icons (Universal Selector)
      const headerBtns = document.querySelectorAll('header .icon-btn');
      
      if (user) {
        if (navLink) navLink.href = 'account.html';
        if (navText) navText.textContent = 'Account';
        if (navIcon) navIcon.classList.add('filled');
        
        headerBtns.forEach(btn => {
          if (btn.href && (btn.href.includes('login') || btn.href.includes('account'))) {
            btn.href = 'account.html';
          }
        });
      } else {
        if (navLink) navLink.href = 'login.html';
        if (navText) navText.textContent = 'Sign In';
        if (navIcon) navIcon.classList.remove('filled');

        headerBtns.forEach(btn => {
          if (btn.href && (btn.href.includes('login') || btn.href.includes('account'))) {
            btn.href = 'login.html';
          }
        });
      }
    };

    // Listen for state changes
    KwabzStore.on('user_changed', updateUI);
    
    // Initial check (if already loaded or optimistically cached)
    const currentUser = KwabzStore.getCurrentUser();
    const cachedUid = localStorage.getItem('kwabz_auth_cache');
    
    if (currentUser) {
      updateUI(currentUser);
    } else if (cachedUid) {
      // Optimistically point to Account to prevent redirect loop while loading/syncing
      updateUI({ uid: cachedUid });
    } else {
      // If we are currently "syncing", we wait for the first user_changed
      // Otherwise we can safely update empty UI
      if (KwabzStore.getSyncStatus() !== 'syncing') {
        updateUI(null);
      }
    }
  },

  /**
   * Require user to be logged in. Prevents unauthorized content flashes by hiding
   * the page until authentication state is verified.
   */
  requireLogin() {
    const checkRedirect = () => {
      const path = window.location.pathname.split('/').pop() || 'index.html';
      if (path === 'login.html' || path === 'signup.html') return;

      document.documentElement.style.display = 'none'; 
      const search = window.location.search;
      const current = encodeURIComponent(path + search);
      window.location.replace(`login.html?redirect=${current}`);
    };

    // 1. If Firebase is ready and we have NO user, redirect immediately
    if (KwabzStore.isAuthReady()) {
      if (!KwabzStore.getCurrentUser()) {
        checkRedirect();
        return false;
      }
      return true;
    }

    // 2. Optimistic Rendering: If we have a cached UID, don't hide yet
    const cachedUid = localStorage.getItem('kwabz_auth_cache');
    if (!cachedUid) {
      document.documentElement.style.display = 'none';
    }
    
    KwabzStore.on('user_changed', (user) => {
      if (user) {
        document.documentElement.style.display = ''; // Show page
      } else {
        checkRedirect();
      }
    });

    // Watchdog to prevent permanent white screen (reduced to 1s for better UX)
    setTimeout(() => {
      if (!KwabzStore.isAuthReady()) {
        if (!KwabzStore.getCurrentUser() && !localStorage.getItem('kwabz_auth_cache')) checkRedirect();
        else document.documentElement.style.display = '';
      }
    }, 1000);

    return true; // We return true to let the script continue, but the UI is hidden
  },

  /**
   * Alias for requireLogin.
   */
  requireAuth() {
    return this.requireLogin();
  },

  /**
   * Redirect to admin login if administrator is not authenticated.
   * Uses a strict gate to prevent admin-panel flashes for non-admins.
   */
  requireAdmin() {
    const check = () => {
      if (!KwabzStore.isAdminLoggedIn()) {
        document.documentElement.style.display = 'none';
        const inAdminFolder = window.location.pathname.includes('/admin/');
        window.location.href = inAdminFolder ? 'admin-login.html' : 'admin/admin-login.html';
        return false;
      }
      document.documentElement.style.display = '';
      return true;
    };

    // 1. Optimistic Rendering: If we have a cached admin flag, don't hide yet
    const cachedAdmin = localStorage.getItem('kwabz_admin_auth');
    if (!cachedAdmin) {
      document.documentElement.style.display = 'none';
    }
    
    if (!KwabzStore.isAuthReady()) {
      KwabzStore.on('user_changed', (user) => {
        if (user && KwabzStore.isAdminLoggedIn()) {
          document.documentElement.style.display = '';
        } else if (KwabzStore.isAuthReady()) {
          check();
        }
      });

      // Safety timeout (reduced for better UX)
      setTimeout(() => {
        if (!KwabzStore.isAuthReady() || !KwabzStore.isAdminLoggedIn()) {
          check();
        }
      }, 1500);

      return true;
    }

    // Watchdog: Periodically re-verify admin state in the background
    if (!window._adminWatchdogStarted) {
      window._adminWatchdogStarted = true;
      setInterval(() => {
        if (!KwabzStore.isAdminLoggedIn()) {
          const inAdminFolder = window.location.pathname.includes('/admin/');
          const targetUrl = inAdminFolder ? 'admin-login.html' : 'admin/admin-login.html';
          KwabzUtils.toast('Session expired. Redirecting...', 'error');
          setTimeout(() => window.location.href = targetUrl, 1500);
        }
      }, 300000); // Check every 5 minutes
    }

    return check();
  },

  /**
   * Smart Branding: Update page headers based on session context.
   */
  applySmartBranding() {
    const sellerName = sessionStorage.getItem('kwabz_active_seller_name');
    const sellerId = sessionStorage.getItem('kwabz_active_seller_id');
    const titleEl = document.querySelector('.top-app-bar__title');
    const backBtn = document.querySelector('.top-app-bar .icon-btn'); // Usually back btn is first

    if (sellerName && titleEl) {
      titleEl.textContent = sellerName;
      if (backBtn && backBtn.href.includes('shop.html')) {
        backBtn.href = `seller-store.html?id=${sellerId}`;
      }
    }
  },

  /**
   * Check if cart belongs to a single seller for contextual branding.
   */
  getCartBranding() {
    const cart = KwabzStore.getCart();
    if (cart.length === 0) return null;
    
    // Check if all items in product list have same seller_id
    const products = KwabzStore.getAllProducts();
    const itemSellers = cart.map(item => {
      const p = products.find(prod => prod.id === item.product_id);
      return p ? p.seller_id : null;
    });

    const firstSeller = itemSellers[0];
    const isPure = itemSellers.every(s => s === firstSeller && s !== null && s !== 'main');
    
    if (isPure) {
      const seller = KwabzStore.getSellers().find(s => s.id === firstSeller);
      return seller ? seller.name : null;
    }
    return null;
  },

  clearSmartBranding() {
    sessionStorage.removeItem('kwabz_active_seller_id');
    sessionStorage.removeItem('kwabz_active_seller_name');
  },

  audioCtx: null,

  initAudio() {
    if (this.audioCtx) return this.audioCtx;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioCtx = new AudioContext();
      }
    } catch (e) {
      console.warn('AudioContext failed to initialize:', e);
    }
    return this.audioCtx;
  },

  /**
   * Synthesize a premium chiptune chime sound using Web Audio API (0% external dependencies)
   */
  playNotificationSound() {
    try {
      const ctx = this.initAudio();
      if (!ctx) return;

      // If context is suspended, try to resume it (will succeed if called within a user gesture)
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      
      // Chime 1 (high note)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      gain1.gain.setValueAtTime(0.12, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.3);

      // Chime 2 (higher note, slightly delayed)
      setTimeout(() => {
        try {
          if (ctx.state === 'suspended') return;
          const osc2 = ctx.createOscillator();
          const gain2 = ctx.createGain();
          osc2.connect(gain2);
          gain2.connect(ctx.destination);
          osc2.frequency.setValueAtTime(880, ctx.currentTime); // A5
          gain2.gain.setValueAtTime(0.12, ctx.currentTime);
          gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
          osc2.start();
          osc2.stop(ctx.currentTime + 0.4);
        } catch (innerErr) {
          console.warn('Delayed audio playback failed:', innerErr);
        }
      }, 80);
    } catch (e) {
      console.warn('Audio alert blocked or unsupported:', e);
    }
  },

  /**
   * Display a native system notification with sound
   */
  showNotification(title, body) {
    if (!('Notification' in window)) return;
    
    const options = {
      body,
      icon: '/icon-192.png',
      badge: '/icon-96x96.png',
      vibrate: [100, 50, 100],
      tag: 'kwabz-order-update',
      renotify: true
    };
    
    const trigger = () => {
      // Use Service Worker's showNotification (Industry standard for mobile / Android / iOS PWA support!)
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(reg => {
          reg.showNotification(title, options).catch(err => {
            console.warn('[Notification] Service Worker showNotification failed, trying fallback:', err);
            try {
              new Notification(title, options);
            } catch (fallbackErr) {
              console.warn('[Notification] Fallback also failed:', fallbackErr);
            }
          });
        });
      } else {
        // Desktop / Fallback API
        try {
          new Notification(title, options);
        } catch (e) {
          console.warn('[Notification] Standard Notification fallback failed:', e);
        }
      }
    };

    // ALWAYS play the sound and show the in-app toast, regardless of OS permission!
    this.playNotificationSound();
    this.toast(title + ' ' + body, 'info'); 

    if (Notification.permission === 'granted') {
      trigger();
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') trigger();
      });
    }
  },

  /**
   * Biometric Login Support & Helpers (WebAuthn / Passkeys)
   */
  isBiometricSupported() {
    return !!(window.PublicKeyCredential && 
              window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable &&
              typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function');
  },

  hasBiometricSetup() {
    return !!localStorage.getItem('kwabz_biometric_cred_id') && !!localStorage.getItem('kwabz_biometric_user');
  },

  async registerBiometric(email, password) {
    if (!this.isBiometricSupported()) {
      throw new Error('Biometric authentication is not supported on this device or browser.');
    }
    
    let isAvailable = false;
    try {
      isAvailable = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      console.warn('Biometric hardware check error:', e);
    }
    
    if (!isAvailable) {
      throw new Error('No biometric hardware (like Touch ID, Face ID, or Windows Hello) was found or enabled on this device.');
    }

    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);
    
    const userId = new Uint8Array(16);
    window.crypto.getRandomValues(userId);

    const rpId = window.location.hostname || "localhost";

    const publicKeyCredentialCreationOptions = {
      challenge: challenge,
      rp: {
        name: "Kwabz Store",
        id: rpId
      },
      user: {
        id: userId,
        name: email,
        displayName: email
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },   // ES256
        { type: "public-key", alg: -257 }  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred"
      },
      timeout: 60000
    };

    const credential = await navigator.credentials.create({
      publicKey: publicKeyCredentialCreationOptions
    });

    if (!credential) {
      throw new Error('Failed to register biometric credentials.');
    }

    const credIdHex = Array.from(new Uint8Array(credential.rawId))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    localStorage.setItem('kwabz_biometric_cred_id', credIdHex);
    
    const payload = {
      email: email,
      password: btoa(password), // Simple base64 encoding (secure since browser isolates localStorage)
      registeredAt: Date.now()
    };
    localStorage.setItem('kwabz_biometric_user', JSON.stringify(payload));

    return true;
  },

  disableBiometric() {
    localStorage.removeItem('kwabz_biometric_cred_id');
    localStorage.removeItem('kwabz_biometric_user');
  },

  async authenticateBiometric() {
    if (!this.hasBiometricSetup()) {
      throw new Error('Biometric login is not set up on this device.');
    }

    const credIdHex = localStorage.getItem('kwabz_biometric_cred_id');
    const credIdBytes = new Uint8Array(credIdHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const rpId = window.location.hostname || "localhost";

    const publicKeyCredentialRequestOptions = {
      challenge: challenge,
      rpId: rpId,
      allowCredentials: [{
        id: credIdBytes,
        type: 'public-key'
      }],
      userVerification: 'required',
      timeout: 60000
    };

    const assertion = await navigator.credentials.get({
      publicKey: publicKeyCredentialRequestOptions
    });

    if (!assertion) {
      throw new Error('Biometric verification failed.');
    }

    const userJson = localStorage.getItem('kwabz_biometric_user');
    if (!userJson) {
      throw new Error('Biometric credentials missing or corrupted.');
    }

    const user = JSON.parse(userJson);
    return {
      email: user.email,
      password: atob(user.password)
    };
  }
};

// ─── Automatic Global Theme Application (on settings change only) ───
if (typeof KwabzStore !== 'undefined') {
  KwabzStore.on('settings_changed', (settings) => {
    if (window.location.search.includes('preview=')) return;
    if (settings && settings.theme) KwabzUtils.applyGlobalTheme(settings.theme);
  });

  // Apply theme immediately if already loaded in store
  const settings = typeof KwabzStore.getSettings === 'function' ? KwabzStore.getSettings() : null;
  if (settings && settings.theme) {
    KwabzUtils.applyGlobalTheme(settings.theme);
  }
}

// Auto-run browser enforcement
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => KwabzUtils.enforceChrome());
} else {
  KwabzUtils.enforceChrome();
}

// Automatically unlock the AudioContext on first user interaction with the document
if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    if (typeof KwabzUtils !== 'undefined' && typeof KwabzUtils.initAudio === 'function') {
      const ctx = KwabzUtils.initAudio();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().then(() => {
          console.log('[KwabzUtils] AudioContext successfully unlocked by user gesture.');
          cleanup();
        }).catch(err => console.warn('[KwabzUtils] Failed to unlock AudioContext:', err));
      } else if (ctx && ctx.state === 'running') {
        cleanup();
      }
    }
  };

  const cleanup = () => {
    window.removeEventListener('click', unlockAudio);
    window.removeEventListener('touchstart', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };

  window.addEventListener('click', unlockAudio);
  window.addEventListener('touchstart', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
}


