import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import http, { createServer } from 'http';
import https from 'https';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';

// Load Config
dotenv.config();

const PORT = process.env.PORT || 5000;
const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT || './firebase-service-account.json';

const app = express();
app.use(cors({ origin: '*' }));
// Allow large JSON bodies for base64 image uploads (up to 20 MB)
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000
});

let db = null;
let isFirebaseOnline = false;

try {
  let serviceAccount = null;

  // 1. Prioritize raw JSON string from Production Environment Variables
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.log('📦 Loading Firebase Service Account from Environment Variable...');
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  // 2. Fall back to local file if available
  else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.log('📂 Loading Firebase Service Account from local file...');
    serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  }

  if (serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount)
    });
    db = getFirestore();
    isFirebaseOnline = true;
    console.log('✅ Firebase Admin connected successfully in backend.');
  } else {
    console.warn('⚠️  No Firebase Service Account provided (File missing and Env Var empty).');
    console.warn('👉 Add FIREBASE_SERVICE_ACCOUNT_JSON to your Render Environment Variables.');
  }
} catch (err) {
  console.error('❌ Firebase connection error in backend:', err.message);
  console.warn('⚠️  Falling back to Mock/Preview mode.');
}

// ─── Mock Fallbacks (Prevent server crashes if offline) ──────
const mockData = {
  products: [],
  categories: [],
  sellers: [],
  settings: { theme: { primary: '#6200ee' } }
};

// ─── In-Memory Server Cache ──────────────────────────────────
const cache = {
  products: [],
  categories: [],
  sellers: [],
  orders: [],
  settings: {},
  blogPosts: [],
  promoCodes: [],
  broadcasts: [],
  foodCategories: [],
  foodItems: [],
  bundles: [],
  gigs: [],
  feedbackConfig: [],
  feedbackSubmissions: [],
  reviews: {}, // productId -> reviews array
  fcmTokens: [] // Cached list of all FCM tokens (refreshed by listener)
};

// ─── Initialize Upstash Redis client ──────────────────────────
import { Redis } from '@upstash/redis';

let redisClient = null;
let isRedisOnline = false;

try {
  console.log('📡 Attempting to connect to Upstash Redis cache backend...');
  // Using the provided credentials or fallback to env
  redisClient = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  
  // Test connection
  redisClient.get('ping').then(() => {
    console.log('✅ Connected to Upstash Redis cache backend successfully.');
    isRedisOnline = true;
    restoreActiveVisitorsFromRedis();
  }).catch(e => {
    console.warn('⚠️ Upstash connection ping failed. Using local in-memory store.', e.message);
  });
} catch (err) {
  console.warn('⚠️  Redis connection failed. Falling back to local memory cache.', err.message);
  isRedisOnline = false;
}

// ─── Socket Payload Sanitizer (Strips heavy Base64 strings to save bandwidth) ───
function sanitizeForSocket(obj) {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    if (obj.startsWith('data:image/') && obj.length > 500) {
      return ''; // Omit inline base64 image strings from socket broadcasts
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForSocket);
  }
  if (typeof obj === 'object') {
    const clean = {};
    for (const key of Object.keys(obj)) {
      clean[key] = sanitizeForSocket(obj[key]);
    }
    return clean;
  }
  return obj;
}

// ─── Redis & local Cache Helpers ──────────────────────────────

const cacheKeys = {
  products: 'kwabz:products',
  categories: 'kwabz:categories',
  sellers: 'kwabz:sellers',
  orders: 'kwabz:orders',
  settings: 'kwabz:settings',
  blogPosts: 'kwabz:blogPosts',
  promoCodes: 'kwabz:promoCodes',
  broadcasts: 'kwabz:broadcasts',
  foodCategories: 'kwabz:foodCategories',
  foodItems: 'kwabz:foodItems',
  bundles: 'kwabz:bundles',
  feedbackConfig: 'kwabz:feedbackConfig',
  feedbackSubmissions: 'kwabz:feedbackSubmissions',
  gigs: 'kwabz:gigs',
  fcmTokens: 'kwabz:fcmTokens',   // All push subscriber tokens
  reviews: (productId) => `kwabz:reviews:${productId}`
};

async function setCacheValue(key, value, ttlSeconds = null) {
  // Always update our local memory cache as local fallback
  if (key === cacheKeys.products) cache.products = value;
  else if (key === cacheKeys.categories) cache.categories = value;
  else if (key === cacheKeys.sellers) cache.sellers = value;
  else if (key === cacheKeys.orders) cache.orders = value;
  else if (key === cacheKeys.settings) cache.settings = value;
  else if (key === cacheKeys.blogPosts) cache.blogPosts = value;
  else if (key === cacheKeys.promoCodes) cache.promoCodes = value;
  else if (key === cacheKeys.broadcasts) cache.broadcasts = value;
  else if (key === cacheKeys.foodCategories) cache.foodCategories = value;
  else if (key === cacheKeys.foodItems) cache.foodItems = value;
  else if (key === cacheKeys.bundles) cache.bundles = value;
  else if (key === cacheKeys.feedbackConfig) cache.feedbackConfig = value;
  else if (key === cacheKeys.feedbackSubmissions) cache.feedbackSubmissions = value;
  else if (key === cacheKeys.gigs) cache.gigs = value;
  else if (key === cacheKeys.fcmTokens) cache.fcmTokens = value; // FCM tokens in memory
  else if (key.startsWith('kwabz:reviews:')) {
    const prodId = key.replace('kwabz:reviews:', '');
    cache.reviews[prodId] = { data: value, ts: Date.now() };
  }

  // Update Redis if online
  if (isRedisOnline && redisClient) {
    try {
      const dataStr = JSON.stringify(value);
      if (ttlSeconds) {
        await redisClient.set(key, dataStr, { ex: ttlSeconds });
      } else {
        await redisClient.set(key, dataStr);
      }
    } catch (err) {
      console.warn(`[Redis Cache] Write failed for key: ${key}`, err.message);
    }
  }
}

async function getCacheValue(key, fallbackLocalValue) {
  if (isRedisOnline && redisClient) {
    try {
      const data = await redisClient.get(key);
      if (data) {
        return typeof data === 'string' ? JSON.parse(data) : data;
      }
    } catch (err) {
      console.warn(`[Redis Cache] Read failed for key: ${key}`, err.message);
    }
  }
  return fallbackLocalValue;
}

// ─── Visitor Registry (Managed 100% in server memory!) ───────
// Key: visitorId, Value: { uid, page, lastActive, displayName }
const activeVisitors = new Map();

// Warm up active visitors from Redis if available
async function restoreActiveVisitorsFromRedis() {
  if (!isRedisOnline || !redisClient) return;
  try {
    const keys = await redisClient.keys('kwabz:active_visitor:*');
    if (keys && keys.length > 0) {
      const values = await redisClient.mget(...keys);
      let count = 0;
      keys.forEach((key, idx) => {
        const val = values[idx];
        if (val) {
          const visitorId = key.replace('kwabz:active_visitor:', '');
          const parsed = typeof val === 'string' ? JSON.parse(val) : val;
          activeVisitors.set(visitorId, {
            uid: parsed.uid,
            page: parsed.page,
            displayName: parsed.displayName,
            lastActive: parsed.lastActive
          });
          count++;
        }
      });
      console.log(`[Redis] Restored ${count} active visitors on startup.`);
      io.emit('visitor_count_updated', activeVisitors.size);
    }
  } catch (err) {
    console.warn('[Redis] Failed to restore active visitors on startup:', err.message);
  }
}

// Helper to get safe numeric timestamp
function getSafeTime(val) {
  if (!val) return 0;
  if (typeof val.toDate === 'function') {
    try { return val.toDate().getTime(); } catch (e) { return 0; }
  }
  if (typeof val === 'number') return val;
  if (val.seconds) return val.seconds * 1000;
  const t = new Date(val).getTime();
  return isNaN(t) ? 0 : t;
}

// ─── FCM Push Notification Service ──────────────────────────────
// Admin tokens are cached in memory after first load, refreshed on change.
let _cachedAdminTokens = [];
let _adminTokensCachedAt = 0;
const ADMIN_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getAdminTokens() {
  const now = Date.now();
  if (_cachedAdminTokens.length > 0 && (now - _adminTokensCachedAt) < ADMIN_TOKEN_TTL_MS) {
    return _cachedAdminTokens;
  }

  if (isRedisOnline && redisClient) {
    try {
      const redisTokens = await redisClient.get('kwabz:adminFcmTokens');
      if (redisTokens) {
        const parsed = typeof redisTokens === 'string' ? JSON.parse(redisTokens) : redisTokens;
        if (Array.isArray(parsed)) {
          _cachedAdminTokens = parsed;
          _adminTokensCachedAt = now;
          console.log(`[FCM Cache] Warm admin tokens loaded from Redis. Count: ${_cachedAdminTokens.length}`);
          return _cachedAdminTokens;
        }
      }
    } catch (err) {
      console.warn('[FCM Cache] Failed to read admin tokens from Redis:', err.message);
    }
  }

  if (!isFirebaseOnline || !db) return [];
  try {
    const adminsSnap = await db.collection('users').where('role', '==', 'admin').get();
    const tokens = [];
    adminsSnap.forEach(doc => {
      const data = doc.data();
      if (data.fcmTokens && Array.isArray(data.fcmTokens)) tokens.push(...data.fcmTokens);
    });
    const deduped = [...new Set(tokens)].filter(Boolean);
    
    _cachedAdminTokens = deduped;
    _adminTokensCachedAt = now;

    if (isRedisOnline && redisClient) {
      try {
        await redisClient.set('kwabz:adminFcmTokens', JSON.stringify(deduped), { ex: 300 }); // 5 minutes TTL
      } catch (err) {
        console.warn('[FCM Cache] Failed to save admin tokens to Redis:', err.message);
      }
    }

    console.log(`[FCM Cache] Admin tokens refreshed from Firestore. Count: ${_cachedAdminTokens.length}`);
    return _cachedAdminTokens;
  } catch (err) {
    console.error('[FCM Cache] Failed to fetch admin tokens from Firestore:', err);
    return _cachedAdminTokens;
  }
}

async function sendFCMPush(payload, targetRole = 'all') {
  if (!isFirebaseOnline || !db) return;
  try {
    let tokens = [];

    if (targetRole === 'admin') {
      // Served from cache (memory/Redis)
      tokens = await getAdminTokens();
    } else if (targetRole === 'all') {
      // Served from the fcm_tokens cache (memory first, then Redis, then cold Firestore fetch)
      tokens = [...cache.fcmTokens];
      if (tokens.length === 0) {
        // Try Redis before hitting Firestore
        const redisTokens = await getCacheValue(cacheKeys.fcmTokens, null);
        if (redisTokens && redisTokens.length > 0) {
          console.log(`[FCM] Warm from Redis cache. Count: ${redisTokens.length}`);
          cache.fcmTokens = redisTokens;
          tokens = [...cache.fcmTokens];
        } else {
          // True cold-start: Firestore one-time fetch
          console.log('[FCM] Cold-start: fetching fcm_tokens once to populate cache...');
          const tokensSnap = await db.collection('fcm_tokens').get();
          tokensSnap.forEach(doc => { if (doc.data().token) tokens.push(doc.data().token); });
          const deduped = [...new Set(tokens)].filter(Boolean);
          await setCacheValue(cacheKeys.fcmTokens, deduped); // persist to Redis too
          tokens = deduped;
        }
      }
    } else {
      // Treat targetRole as a specific UID string
      // 1. Get tokens associated with this UID in fcm_tokens collection
      const tokensSnap = await db.collection('fcm_tokens').where('uid', '==', targetRole).get();
      tokensSnap.forEach(doc => {
        const data = doc.data();
        if (data.token) tokens.push(data.token);
      });

      // 2. Fallback to user's nested fcmTokens array
      const userDoc = await db.collection('users').doc(targetRole).get();
      if (userDoc.exists) {
        const data = userDoc.data();
        if (data.fcmTokens && Array.isArray(data.fcmTokens)) tokens.push(...data.fcmTokens);
      }
    }

    // Deduplicate tokens
    tokens = [...new Set(tokens)].filter(Boolean);
    if (tokens.length === 0) return;

    const messaging = getMessaging();
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const message = {
        ...payload,
        tokens: batch
      };
      
      message.android = { priority: 'high' };
      message.webpush = { headers: { Urgency: 'high' } };

      const response = await messaging.sendEachForMulticast(message);
      console.log(`[FCM] Push sent: ${response.successCount} successful, ${response.failureCount} failed.`);
      
      // Cleanup invalid tokens
      if (response.failureCount > 0) {
        for (let idx = 0; idx < response.responses.length; idx++) {
          const resp = response.responses[idx];
          if (!resp.success) {
            const badToken = batch[idx];
            const errorCode = resp.error?.code;
            console.warn(`[FCM] Error sending to token ${badToken.substring(0, 15)}... :`, resp.error);
            const PURGEABLE_ERRORS = [
              'messaging/registration-token-not-registered',
              'messaging/invalid-argument',
              'messaging/third-party-auth-error',  // token registered under a different Firebase project
              'messaging/invalid-registration-token'
            ];
            if (PURGEABLE_ERRORS.includes(errorCode)) {
              console.log(`[FCM] Cleaning up stale/mismatched token (${errorCode}): ${badToken.substring(0, 20)}...`);
              
              // Remove from in-memory caches immediately
              cache.fcmTokens = cache.fcmTokens.filter(t => t !== badToken);
              _cachedAdminTokens = _cachedAdminTokens.filter(t => t !== badToken);
              
              if (isRedisOnline && redisClient) {
                redisClient.set('kwabz:fcmTokens', JSON.stringify(cache.fcmTokens)).catch(() => {});
                redisClient.set('kwabz:adminFcmTokens', JSON.stringify(_cachedAdminTokens), { ex: 300 }).catch(() => {});
              }

              await db.collection('fcm_tokens').doc(badToken).delete().catch(() => {});
              
              const usersWithToken = await db.collection('users').where('fcmTokens', 'array-contains', badToken).get();
              usersWithToken.forEach(async (uDoc) => {
                await uDoc.ref.update({
                  fcmTokens: FieldValue.arrayRemove(badToken)
                }).catch(() => {});
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[FCM] Error sending push notification:', err);
  }
}

// ─── background live-sync listeners (exactly 1 read path per server process) ───
let unsubscribers = {
  products: null,
  categories: null,
  sellers: null,
  settings: null,
  blogPosts: null,
  promoCodes: null,
  broadcasts: null,
  gigs: null,
  userChats: null,
  communications: null,
  orders: null,
  productNotifications: null,
  bundles: null,
  fcmTokens: null
};

function setupBackgroundSync() {
  if (!isFirebaseOnline || !db) {
    console.warn('⚠️  Mock data fallback enabled (Database offline).');
    return;
  }

  console.log('🔄 Setting up background Firestore Live-Sync listeners...');

  // 1. Live Products Listener
  unsubscribers.products = db.collection('products')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] products collection updated. Syncing ${snapshot.size} items.`);
      const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      // In-memory sort by created_at desc
      products.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
      await setCacheValue(cacheKeys.products, products);
      // Broadcast real-time change to all connected socket clients (sanitized payload)
      io.emit('products_changed', sanitizeForSocket(cache.products));
    }, err => {
      console.error('[Firestore Sync] Products snapshot failed:', err.message);
    });

  // 2. Live Categories Listener
  unsubscribers.categories = db.collection('categories')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] categories collection updated. Syncing ${snapshot.size} items.`);
      const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      await setCacheValue(cacheKeys.categories, categories);
      io.emit('categories_changed', sanitizeForSocket(cache.categories));
    }, err => {
      console.error('[Firestore Sync] Categories snapshot failed:', err.message);
    });

  // 3. Live Sellers Listener
  let isInitialSellers = true;
  unsubscribers.sellers = db.collection('sellers')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] sellers collection updated. Syncing ${snapshot.size} items.`);
      const sellers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      await setCacheValue(cacheKeys.sellers, sellers);
      io.emit('sellers_changed', sanitizeForSocket(cache.sellers));

      if (isInitialSellers) {
        isInitialSellers = false;
        return;
      }

      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const seller = change.doc.data();
          sendFCMPush({
            data: {
              title: '🏪 New Seller Registered!',
              body: `Store "${seller.name || 'Unnamed Store'}" (${seller.phone || 'No Phone'}) has registered.`,
              url: '/admin-sellers.html'
            }
          }, 'admin');
        }
      });
    }, err => {
      console.error('[Firestore Sync] Sellers snapshot failed:', err.message);
    });

  // 3.5. Live Orders Listener (for Admin Dashboard)
  let isInitialOrders = true;
  unsubscribers.orders = db.collection('orders')
    .orderBy('created_at', 'desc')
    .limit(200)
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] orders collection updated. Syncing ${snapshot.size} items.`);
      // We need to keep a snapshot of the previous cache to detect status changes
      const previousOrders = [...cache.orders];
      
      const rawOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const seenKeys = new Set();
      const orders = [];
      const duplicateIdsToDelete = [];

      for (const order of rawOrders) {
        const key = order.tracking_number || order.trackingNumber || order.order_label || order.order_number || order.orderId;
        if (key) {
          if (seenKeys.has(key)) {
            // Stray duplicate document in Firestore created prior to doc(orderId).set fix
            if (order.id && order.id !== key) {
              duplicateIdsToDelete.push(order.id);
            }
            continue;
          }
          seenKeys.add(key);
        }
        orders.push(order);
      }

      // Automatically purge stray duplicate documents from Firestore in background
      if (duplicateIdsToDelete.length > 0) {
        console.log(`[Firestore Sync] Purging ${duplicateIdsToDelete.length} legacy duplicate order docs...`);
        duplicateIdsToDelete.forEach(dupId => {
          db.collection('orders').doc(dupId).delete().catch(e => console.warn('Silent cleanup duplicate doc error:', dupId, e));
        });
      }

      await setCacheValue(cacheKeys.orders, orders);
      io.emit('orders_changed', cache.orders);

      if (isInitialOrders) {
        isInitialOrders = false;
        return;
      }

      snapshot.docChanges().forEach(change => {
        const order = change.doc.data();
        const displayOrderNum = order.tracking_number || order.trackingNumber || order.order_label || order.order_number || order.orderId || order.id || change.doc.id;
        const customerUid = order.customer_uid || order.uid;
        
        if (change.type === 'added') {
          // Notify Admin
          sendFCMPush({
            data: {
              title: '🔔 New Order Received!',
              body: `Order ${displayOrderNum} for GH₵ ${Number(order.total_amount || order.total_price || order.total || 0).toFixed(2)}`,
              url: '/admin-orders.html'
            }
          }, 'admin');

          // Notify Seller (if order belongs to a seller store)
          if (order.seller_id && order.seller_id !== 'main') {
            sendFCMPush({
              data: {
                title: '🛍️ New Order Received!',
                body: `You received order ${displayOrderNum} for GH₵ ${Number(order.total_amount || order.total_price || order.total || 0).toFixed(2)}`,
                url: '/seller-dashboard.html?tab=orders'
              }
            }, order.seller_id);
          }
        } 
        else if (change.type === 'modified') {
          const oldOrder = previousOrders.find(o => o.id === change.doc.id || o.orderId === change.doc.id);
          if (oldOrder && oldOrder.status !== order.status && order.status) {
             // Notify Customer
             if (customerUid) {
               sendFCMPush({
                 data: {
                   title: `📦 Order Update: ${order.status.toUpperCase()}`,
                   body: `Your order ${displayOrderNum} status is now ${order.status}.`,
                   url: '/account.html?tab=orders'
                 }
               }, customerUid);
             }
             // Notify Seller
             if (order.seller_id && order.seller_id !== 'main') {
               sendFCMPush({
                 data: {
                   title: `📦 Order Update: ${order.status.toUpperCase()}`,
                   body: `Order ${displayOrderNum} status is now ${order.status}.`,
                   url: '/seller-dashboard.html?tab=orders'
                 }
               }, order.seller_id);
             }
          }
        }
        else if (change.type === 'removed') {
          console.log(`[Firestore Sync] Order ${change.doc.id} deleted from Firestore. Updating cache...`);
          cache.orders = cache.orders.filter(o => o.id !== change.doc.id && o.orderId !== change.doc.id);
          setCacheValue(cacheKeys.orders, cache.orders);
          io.emit('orders_changed', cache.orders);
        }
      });
    }, err => {
      console.error('[Firestore Sync] Orders snapshot failed:', err.message);
    });

  // 5. Live Blog Posts Listener
  let isInitialBlogPosts = true;
  unsubscribers.blogPosts = db.collection('blog_posts')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] blog_posts collection updated. Syncing ${snapshot.size} items.`);
      const blogPosts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      blogPosts.sort((a, b) => getSafeTime(b.created_at || b.date) - getSafeTime(a.created_at || a.date));
      await setCacheValue(cacheKeys.blogPosts, blogPosts);
      io.emit('blog_posts_changed', cache.blogPosts);

      if (isInitialBlogPosts) {
        isInitialBlogPosts = false;
        return;
      }

      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const post = change.doc.data();
          sendFCMPush({
            data: {
              title: '📖 New Journal Entry Published!',
              body: post.title || 'Check out our latest update in the journal.',
              image_url: post.image_url || '',
              url: '/blog.html'
            }
          }, 'all');
        }
      });
    }, err => {
      console.error('[Firestore Sync] Blog posts snapshot failed:', err.message);
    });

  // 6. Live Promo Codes Listener
  unsubscribers.promoCodes = db.collection('promo_codes')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] promo_codes collection updated. Syncing ${snapshot.size} items.`);
      const promoCodes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      promoCodes.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
      await setCacheValue(cacheKeys.promoCodes, promoCodes);
      io.emit('promo_codes_changed', cache.promoCodes);
    }, err => {
      console.error('[Firestore Sync] Promo codes snapshot failed:', err.message);
    });

  // 7. Live Broadcasts Listener
  let isInitialBroadcasts = true;
  unsubscribers.broadcasts = db.collection('broadcasts')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] broadcasts collection updated. Syncing ${snapshot.size} items.`);
      const broadcasts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      broadcasts.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
      await setCacheValue(cacheKeys.broadcasts, broadcasts);
      io.emit('broadcasts_changed', cache.broadcasts);

      if (isInitialBroadcasts) {
        isInitialBroadcasts = false;
        return;
      }

      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const broadcast = change.doc.data();
          sendFCMPush({
            data: {
              title: '\uD83D\uDCE2 Announcement from Kwabz Store!',
              body: broadcast.message || 'Check out our latest update.',
              image_url: broadcast.image_url || '',
              url: '/account.html?tab=announcements'
            }
          }, 'all');
        }
      });
    }, err => {
      console.error('[Firestore Sync] Broadcasts snapshot failed:', err.message);
    });

  // Live Product Notifications Listener (for Push)
  let isInitialProductsNotif = true;
  unsubscribers.productNotifications = db.collection('product_notifications')
    .orderBy('created_at', 'desc')
    .limit(5)
    .onSnapshot(snapshot => {
      if (isInitialProductsNotif) {
        isInitialProductsNotif = false;
        return;
      }
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const data = change.doc.data();
          const discStr = data.discount > 0 ? ` \u2014 ${data.discount}% OFF!` : '';
          sendFCMPush({
            data: {
              title: '\uD83D\uDED2 New Arrival at Kwabz Store!',
              body: `${data.name}${discStr} | GH\u20B5 ${Number(data.price).toFixed(2)}`,
              image_url: data.image_url || '',
              product_id: data.product_id || '',
              url: data.product_id ? `/product-detail.html?id=${data.product_id}` : '/shop.html'
            }
          }, 'all');
        }
      });
    }, err => {
      console.error('[Firestore Sync] product_notifications snapshot failed:', err.message);
    });

  // 4. Live Settings Document Listener
  let isInitialSettings = true;
  unsubscribers.settings = db.collection('settings').doc('global')
    .onSnapshot(async doc => {
      if (doc.exists) {
        console.log('[Firestore Sync] Global Settings document updated.');
        const oldSettings = { ...cache.settings };
        const newSettings = doc.data();
        await setCacheValue(cacheKeys.settings, newSettings);
        io.emit('settings_changed', cache.settings);

        if (isInitialSettings) {
          isInitialSettings = false;
          return;
        }

        // Detect if Force PWA Update Banner was toggled ON
        if (newSettings.forcePwaUpdate && !oldSettings.forcePwaUpdate) {
          sendFCMPush({
            data: {
              title: '⚡ New App Update Available!',
              body: 'A fresh update has been deployed. Tap to reload and sync the latest features.',
              url: '/'
            }
          }, 'all');
        }
      }
    }, err => {
      console.error('[Firestore Sync] Settings snapshot failed:', err.message);
    });

  // FCM Tokens Live Listener — keeps cache.fcmTokens in sync (memory + Redis)
  // so sendFCMPush('all') never scans the full Firestore collection on every push.
  unsubscribers.fcmTokens = db.collection('fcm_tokens')
    .onSnapshot(async snapshot => {
      const tokens = [];
      snapshot.forEach(doc => { if (doc.data().token) tokens.push(doc.data().token); });
      const deduped = [...new Set(tokens)].filter(Boolean);
      await setCacheValue(cacheKeys.fcmTokens, deduped);
      console.log(`[Firestore Sync] fcm_tokens cache refreshed (memory + Redis). Count: ${deduped.length}`);
    }, err => {
      console.error('[Firestore Sync] fcmTokens snapshot failed:', err.message);
    });

  // Live Data Bundles Listener
  unsubscribers.bundles = db.collection('bundles')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] bundles collection updated. Syncing ${snapshot.size} items.`);
      const bundles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      bundles.sort((a, b) => {
        if (a.network !== b.network) return (a.network || '').localeCompare(b.network || '');
        return (a.price || 0) - (b.price || 0);
      });
      await setCacheValue(cacheKeys.bundles, bundles);
      io.emit('bundles_changed', cache.bundles);
    }, err => {
      console.error('[Firestore Sync] Bundles snapshot failed:', err.message);
    });

  // 11. Live Food Categories Listener
  unsubscribers.foodCategories = db.collection('food_categories')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] food_categories updated. Syncing ${snapshot.size} items.`);
      const foodCats = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      await setCacheValue(cacheKeys.foodCategories, foodCats);
      io.emit('food_categories_changed', cache.foodCategories);
    }, err => {
      console.error('[Firestore Sync] Food categories snapshot failed:', err.message);
    });

  // 12. Live Food Items Listener
  unsubscribers.foodItems = db.collection('food_items')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] food_items updated. Syncing ${snapshot.size} items.`);
      const foods = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      await setCacheValue(cacheKeys.foodItems, foods);
      io.emit('food_items_changed', cache.foodItems);
    }, err => {
      console.error('[Firestore Sync] Food items snapshot failed:', err.message);
    });

  // 13. Live Bundles Listener
  unsubscribers.bundles = db.collection('bundles')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] bundles updated. Syncing ${snapshot.size} items.`);
      const bunds = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      bunds.sort((a, b) => (parseFloat(a.price) || 0) - (parseFloat(b.price) || 0));
      await setCacheValue(cacheKeys.bundles, bunds);
      io.emit('bundles_changed', cache.bundles);
    }, err => {
      console.error('[Firestore Sync] Bundles snapshot failed:', err.message);
    });

  // 14. Live Feedback Config Listener
  unsubscribers.feedbackConfig = db.collection('feedback_form_config')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] feedback_form_config updated. Syncing ${snapshot.size} items.`);
      const configs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      await setCacheValue(cacheKeys.feedbackConfig, configs);
      io.emit('feedback_config_changed', cache.feedbackConfig);
    }, err => {
      console.error('[Firestore Sync] Feedback config snapshot failed:', err.message);
    });

  // 15. Live Feedback Submissions Listener
  unsubscribers.feedbackSubmissions = db.collection('feedback_submissions')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] feedback_submissions updated. Syncing ${snapshot.size} items.`);
      const subs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      subs.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
      await setCacheValue(cacheKeys.feedbackSubmissions, subs);
      io.emit('feedback_submissions_changed', cache.feedbackSubmissions);
    }, err => {
      console.error('[Firestore Sync] Feedback submissions snapshot failed:', err.message);
    });

  // 16. Live Gigs Listener
  let isInitialGigs = true;
  unsubscribers.gigs = db.collection('gigs')
    .onSnapshot(async snapshot => {
      const previousGigs = [...cache.gigs];
      console.log(`[Firestore Sync] gigs updated. Syncing ${snapshot.size} items.`);
      const gigs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      gigs.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
      await setCacheValue(cacheKeys.gigs, gigs);
      io.emit('gigs_changed', cache.gigs);

      if (isInitialGigs) {
        isInitialGigs = false;
        return;
      }

      snapshot.docChanges().forEach(change => {
        const gig = change.doc.data();
        if (change.type === 'added') {
          if (gig.is_approved !== false) {
            sendFCMPush({
              data: {
                title: '💼 New Opportunity Posted!',
                body: gig.title || 'A new opportunity is now available.',
                image_url: gig.image_url || '',
                url: '/gigs.html'
              }
            }, 'all');
          }
        } else if (change.type === 'modified') {
          const oldGig = previousGigs.find(g => g.id === change.doc.id);
          if (oldGig && !oldGig.is_approved && gig.is_approved) {
            sendFCMPush({
              data: {
                title: '💼 New Opportunity Approved!',
                body: gig.title || 'A new opportunity is now available.',
                image_url: gig.image_url || '',
                url: '/gigs.html'
              }
            }, 'all');
          }
        }
      });
    }, err => {
      console.error('[Firestore Sync] Gigs snapshot failed:', err.message);
    });

  // 17. Live User Chats Listener
  let isInitialChats = true;
  unsubscribers.userChats = db.collection('user_chats')
    .orderBy('created_at', 'desc')
    .limit(20)
    .onSnapshot(snapshot => {
      if (isInitialChats) {
        isInitialChats = false;
        return;
      }

      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const chat = change.doc.data();
          if (chat.sender === 'admin') {
            sendFCMPush({
              data: {
                title: `💬 Message from ${chat.sender_name || 'Kwabz Support'}`,
                body: chat.message || 'Sent an image.',
                image_url: chat.image_url || '',
                url: '/account.html?tab=chat'
              }
            }, chat.user_id);
          } else if (chat.sender === 'user') {
            sendFCMPush({
              data: {
                title: `💬 New Message from ${chat.sender_name || 'Customer'}`,
                body: chat.message || 'Sent an image.',
                image_url: chat.image_url || '',
                url: `/admin-chat.html?uid=${chat.user_id}`
              }
            }, 'admin');
          }
        }
      });
    }, err => {
      console.error('[Firestore Sync] User chats snapshot failed:', err.message);
    });

  // 18. Live Communications Listener (Admin-Seller Chat)
  let isInitialCommunications = true;
  unsubscribers.communications = db.collection('communications')
    .orderBy('timestamp', 'desc')
    .limit(20)
    .onSnapshot(snapshot => {
      if (isInitialCommunications) {
        isInitialCommunications = false;
        return;
      }

      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const msg = change.doc.data();
          if (msg.type === 'broadcast') return;
          
          if (msg.sender_id === 'admin') {
            sendFCMPush({
              data: {
                title: '💬 Message from Kwabz Admin',
                body: msg.message || 'Sent an image.',
                image_url: msg.image_url || '',
                url: '/seller-dashboard.html?tab=support'
              }
            }, msg.receiver_id);
          } else {
            sendFCMPush({
              data: {
                title: `💬 Seller Message: ${msg.sender_name || 'Seller'}`,
                body: msg.message || 'Sent an image.',
                image_url: msg.image_url || '',
                url: `/admin-sellers.html?chat=${msg.conversation_id}`
              }
            }, 'admin');
          }
        }
      });
    }, err => {
      console.error('[Firestore Sync] Communications snapshot failed:', err.message);
    });
}

// ─── Memory Visitor Heartbeat Sweep Task ─────────────────────
// Sweeps the visitor registry every 30 seconds and removes any inactive past 15 minutes.
setInterval(async () => {
  const now = Date.now();
  const threshold = 15 * 60 * 1000; // 15 mins
  let changed = false;

  for (const [key, value] of activeVisitors.entries()) {
    if (now - value.lastActive > threshold) {
      activeVisitors.delete(key);
      changed = true;
      console.log(`🧹 Visitor timed out: ${key}`);
    }
  }

  // Sync with Redis expired keys to handle multiple instances
  if (isRedisOnline && redisClient) {
    try {
      const keys = await redisClient.keys('kwabz:active_visitor:*');
      const currentActiveIds = new Set(keys.map(k => k.replace('kwabz:active_visitor:', '')));
      for (const localId of activeVisitors.keys()) {
        if (!currentActiveIds.has(localId)) {
          activeVisitors.delete(localId);
          changed = true;
          console.log(`🧹 Visitor timed out (via Redis): ${localId}`);
        }
      }
    } catch (err) {
      console.warn('[Redis] Sweep sync failed:', err.message);
    }
  }

  if (changed) {
    // Notify all connected dashboard clients of updated visitor count in real time
    io.emit('visitor_count_updated', activeVisitors.size);
  }
}, 30000);

// ─── REST API Routes ──────────────────────────────────────────

// 0. Professional Status Landing Page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Kwabz Store API — Online</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #0f172a;
          color: #f8fafc;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
          text-align: center;
        }
        .container {
          background: #1e293b;
          padding: 2.5rem;
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
          max-width: 480px;
          border: 1px solid #334155;
        }
        .icon {
          font-size: 3rem;
          margin-bottom: 1rem;
          display: inline-block;
          animation: pulse 2s infinite ease-in-out;
        }
        h1 {
          font-size: 1.5rem;
          margin: 0 0 0.5rem 0;
          color: #38bdf8;
        }
        p {
          color: #94a3b8;
          font-size: 0.875rem;
          line-height: 1.5;
          margin: 0 0 1.5rem 0;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          background: #166534;
          color: #4ade80;
          font-weight: bold;
          font-size: 0.75rem;
          padding: 0.35rem 0.75rem;
          border-radius: 9999px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .pulse-dot {
          width: 8px;
          height: 8px;
          background: #4ade80;
          border-radius: 50%;
          display: inline-block;
          box-shadow: 0 0 8px #4ade80;
          animation: blink 1.5s infinite;
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.1); }
        }
        @keyframes blink {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">🚀</div>
        <h1>Kwabz Store API</h1>
        <p>Your custom high-performance Node.js caching & optimization server is fully operational and syncing with Cloud Firestore in the background.</p>
        <span class="badge"><span class="pulse-dot"></span> Server Online</span>
      </div>
    </body>
    </html>
  `);
});

// 1. Healthcheck
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    firebase: isFirebaseOnline ? 'connected' : 'fallback_mock',
    redis: isRedisOnline ? 'connected' : 'offline',
    cacheSizes: {
      products: cache.products.length,
      categories: cache.categories.length,
      sellers: cache.sellers.length
    },
    activeVisitors: activeVisitors.size
  });
});

// 1.1 Lightweight Ping/Wake Endpoint (for external cron services like cron-job.org)
// Point your external pinger HERE: /api/ping — minimal response, no Firebase reads
app.get('/api/ping', (req, res) => {
  res.json({ status: 'awake', ts: Date.now() });
});

// 2. Fetch Products (Serves instantly from memory cache!)
app.get('/api/products', (req, res) => {
  res.json(cache.products.length > 0 ? cache.products : mockData.products);
});

// 3. Fetch Categories
app.get('/api/categories', (req, res) => {
  res.json(cache.categories.length > 0 ? cache.categories : mockData.categories);
});

// 4. Fetch Sellers
app.get('/api/sellers', (req, res) => {
  res.json(cache.sellers.length > 0 ? cache.sellers : mockData.sellers);
});

// 5. Fetch Settings
app.get('/api/settings', (req, res) => {
  res.json(Object.keys(cache.settings).length > 0 ? cache.settings : mockData.settings);
});

app.post('/api/settings', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('settings').doc('global').set(req.body, { merge: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Visitor Heartbeat Endpoint (COMPLETELY replaces Firestore visitor database writes!)
app.post('/api/visitors/heartbeat', async (req, res) => {
  const { visitorId, uid, page, displayName } = req.body;
  if (!visitorId) {
    return res.status(400).json({ error: 'visitorId is required' });
  }

  const prevSize = activeVisitors.size;
  const visitorData = {
    uid: uid || null,
    page: page || 'index.html',
    displayName: displayName || null,
    lastActive: Date.now()
  };

  activeVisitors.set(visitorId, visitorData);

  if (isRedisOnline && redisClient) {
    try {
      const key = `kwabz:active_visitor:${visitorId}`;
      await redisClient.set(key, JSON.stringify(visitorData), { ex: 900 }); // 15 mins TTL
    } catch (err) {
      console.warn('[Redis] Failed to save active visitor heartbeat:', err.message);
    }
  }

  // If visitor count changed, notify sockets
  if (activeVisitors.size !== prevSize) {
    io.emit('visitor_count_updated', activeVisitors.size);
  }

  res.json({ success: true, activeCount: activeVisitors.size });
});

// 7. Get Active Visitor Count
app.get('/api/visitor-count', async (req, res) => {
  if (isRedisOnline && redisClient) {
    try {
      const keys = await redisClient.keys('kwabz:active_visitor:*');
      return res.json({ count: keys.length });
    } catch (_) {}
  }
  res.json({ count: activeVisitors.size });
});

// 7.5. Get Detailed Active Visitors
app.get('/api/visitors/detailed', async (req, res) => {
  if (isRedisOnline && redisClient) {
    try {
      const keys = await redisClient.keys('kwabz:active_visitor:*');
      const visitors = [];
      if (keys.length > 0) {
        const values = await redisClient.mget(...keys);
        keys.forEach((key, idx) => {
          const val = values[idx];
          if (val) {
            const visitorId = key.replace('kwabz:active_visitor:', '');
            const parsed = typeof val === 'string' ? JSON.parse(val) : val;
            visitors.push({ visitorId, ...parsed });
          }
        });
      }
      // Sync local map
      activeVisitors.clear();
      visitors.forEach(v => {
        activeVisitors.set(v.visitorId, {
          uid: v.uid,
          page: v.page,
          displayName: v.displayName,
          lastActive: v.lastActive
        });
      });
      return res.json({ count: visitors.length, visitors });
    } catch (err) {
      console.warn('[Redis] Failed to fetch detailed active visitors, falling back to local memory', err.message);
    }
  }
  const visitors = Array.from(activeVisitors.entries()).map(([vid, data]) => ({
    visitorId: vid,
    ...data
  }));
  res.json({ count: visitors.length, visitors });
});

// 7.7. FCM Token Registration Proxy
app.post('/api/fcm/register', async (req, res) => {
  const { token, uid, userAgent, deviceId } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }
  try {
    // Keep in-memory FCM cache updated
    if (!cache.fcmTokens.includes(token)) {
      cache.fcmTokens.push(token);
    }
    if (typeof cacheKeys !== 'undefined' && cacheKeys.fcmTokens) {
      await setCacheValue(cacheKeys.fcmTokens, cache.fcmTokens).catch(() => {});
    }

    if (isFirebaseOnline && db) {
      // 1. Save to fcm_tokens collection (guest or user)
      await db.collection('fcm_tokens').doc(token).set({
        token,
        uid: uid || 'guest',
        userAgent: userAgent || '',
        deviceId: deviceId || '',
        last_updated: FieldValue.serverTimestamp()
      }, { merge: true });

      // 2. If user is logged in (has uid and not 'guest'), nest inside user doc
      if (uid && uid !== 'guest') {
        await db.collection('users').doc(uid).set({
          fcmTokens: FieldValue.arrayUnion(token)
        }, { merge: true });

        // Invalidate admin push token cache in memory/Redis
        _cachedAdminTokens = [];
        _adminTokensCachedAt = 0;
        if (isRedisOnline && redisClient) {
          try {
            await redisClient.del('kwabz:adminFcmTokens');
          } catch (_) {}
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[FCM Proxy] Error registering token:', err);
    res.status(500).json({ error: err.message });
  }
});

// 7.8. FCM Token Deduplication & Cleanup API
app.post('/api/fcm/clean-duplicates', async (req, res) => {
  if (!isFirebaseOnline || !db) {
    return res.status(503).json({ error: 'Database service is unavailable' });
  }
  try {
    const { uid } = req.body || {};
    let query = db.collection('fcm_tokens');
    if (uid && uid !== 'guest') {
      query = query.where('uid', '==', uid);
    }
    const snap = await query.get();
    const userGroups = new Map();

    snap.forEach(doc => {
      const data = doc.data();
      const userKey = data.uid || 'guest';
      if (!userGroups.has(userKey)) userGroups.set(userKey, []);
      userGroups.get(userKey).push({ id: doc.id, ...data });
    });

    let deletedCount = 0;
    const batch = db.batch();

    for (const [groupUid, docs] of userGroups.entries()) {
      if (groupUid === 'guest') continue;
      if (docs.length <= 1) continue;

      // Sort by last_updated descending (newest first)
      docs.sort((a, b) => {
        const getTs = (item) => {
          const val = item.last_updated || item.updatedAt || item.created_at || item.timestamp;
          if (!val) return 0;
          if (typeof val === 'number') return val;
          if (typeof val.toDate === 'function') return val.toDate().getTime();
          if (typeof val.seconds === 'number') return val.seconds * 1000;
          if (typeof val === 'string') {
            const p = Date.parse(val);
            return isNaN(p) ? 0 : p;
          }
          return 0;
        };
        return getTs(b) - getTs(a);
      });

      const recentDoc = docs[0];
      const deadDocs = docs.slice(1);

      for (const dead of deadDocs) {
        batch.delete(db.collection('fcm_tokens').doc(dead.id));
        deletedCount++;
      }

      if (groupUid && groupUid !== 'guest') {
        const userRef = db.collection('users').doc(groupUid);
        batch.set(userRef, { fcmTokens: [recentDoc.token || recentDoc.id] }, { merge: true });
      }
    }

    if (deletedCount > 0) {
      await batch.commit();
      cache.fcmTokens = [];
      if (typeof cacheKeys !== 'undefined' && cacheKeys.fcmTokens) {
        await setCacheValue(cacheKeys.fcmTokens, []).catch(() => {});
      }
    }

    console.log(`[FCM Cleanup] Pruned ${deletedCount} duplicate dead-end tokens.`);
    res.json({ success: true, deletedCount });
  } catch (err) {
    console.error('[FCM Cleanup] Failed to prune duplicate tokens:', err);
    res.status(500).json({ error: err.message });
  }
});

// 7.8. FCM Token Unregistration Proxy
app.post('/api/fcm/unregister', async (req, res) => {
  const { token, uid, logout } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }
  try {
    if (logout) {
      // For logouts: Keep the token active as 'guest' so the device still receives active/broadcast pushes
      if (!cache.fcmTokens.includes(token)) {
        cache.fcmTokens.push(token);
      }
      if (isFirebaseOnline && db) {
        await db.collection('fcm_tokens').doc(token).set({
          token,
          uid: 'guest',
          last_updated: FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => {});
      }
    } else {
      // For explicit disable: Delete from fcm_tokens collection completely
      cache.fcmTokens = cache.fcmTokens.filter(t => t !== token);
      if (isFirebaseOnline && db) {
        await db.collection('fcm_tokens').doc(token).delete().catch(() => {});
      }
    }

    if (typeof cacheKeys !== 'undefined' && cacheKeys.fcmTokens) {
      await setCacheValue(cacheKeys.fcmTokens, cache.fcmTokens).catch(() => {});
    }

    // Remove from user's nested fcmTokens array
    if (uid && uid !== 'guest' && isFirebaseOnline && db) {
      await db.collection('users').doc(uid).set({
        fcmTokens: FieldValue.arrayRemove(token)
      }, { merge: true }).catch(() => {});

      // Invalidate admin push token cache in memory/Redis
      _cachedAdminTokens = [];
      _adminTokensCachedAt = 0;
      if (isRedisOnline && redisClient) {
        try {
          await redisClient.del('kwabz:adminFcmTokens');
        } catch (_) {}
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[FCM Proxy] Error unregistering token:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8. Order Placement Proxy
app.post('/api/orders', async (req, res) => {
  if (!isFirebaseOnline || !db) {
    return res.status(503).json({ error: 'Database service is unavailable' });
  }
  try {
    const orderData = req.body;
    orderData.created_at = orderData.created_at || new Date().toISOString();
    
    // Check if a specific order ID or tracking number is provided to prevent duplicate doc creation
    const targetDocId = orderData.orderId || orderData.id || orderData.order_number || orderData.tracking_number;
    
    if (targetDocId) {
      await db.collection('orders').doc(targetDocId).set(orderData, { merge: true });
      console.log(`[REST API] Order saved under docId: ${targetDocId}`);
      res.status(201).json({ id: targetDocId, ...orderData });
    } else {
      const docRef = await db.collection('orders').add(orderData);
      console.log(`[REST API] Order added under auto-id: ${docRef.id}`);
      res.status(201).json({ id: docRef.id, ...orderData });
    }
  } catch (err) {
    console.error('Failed to create order:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8.5. Admin Order Deletion Proxy
app.delete('/api/orders/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) {
    return res.status(503).json({ error: 'Database service is unavailable' });
  }
  try {
    const orderId = req.params.id;
    try {
      await db.collection('orders').doc(orderId).delete();
    } catch (_) {}
    cache.orders = cache.orders.filter(o => 
      o.id !== orderId && 
      o.orderId !== orderId && 
      o.tracking_number !== orderId && 
      o.order_number !== orderId && 
      o.order_label !== orderId
    );
    await setCacheValue(cacheKeys.orders, cache.orders);
    io.emit('orders_changed', cache.orders);
    console.log(`[REST API] Deleted order ${orderId} from Firestore & Cache`);
    res.json({ success: true, id: orderId });
  } catch (err) {
    console.error('Failed to delete order:', err);
    res.status(500).json({ error: err.message });
  }
});

// 9. Admin Fetch Orders — served from in-memory cache (same as products/categories)
// The live onSnapshot listener (setupBackgroundSync) keeps cache.orders fresh.
app.get('/api/orders', (req, res) => {
  if (cache.orders.length > 0) {
    const limit = parseInt(req.query.limit) || 200;
    return res.json(cache.orders.slice(0, limit));
  }
  // Cache is empty (server just started) — fall back to a one-time Firestore read
  if (!isFirebaseOnline || !db) {
    return res.status(503).json({ error: 'Database service is unavailable' });
  }
  const limit = parseInt(req.query.limit) || 100;
  db.collection('orders')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .get()
    .then(snap => res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))))
    .catch(err => { console.error('Failed to fetch orders (cold start):', err); res.status(500).json({ error: err.message }); });
});

// 10. Fetch Product Reviews (With in-memory/Redis caching)
app.get('/api/blog-posts', (req, res) => {
  res.json(cache.blogPosts.length > 0 ? cache.blogPosts : []);
});

app.get('/api/promo-codes', (req, res) => {
  const list = cache.promoCodes.length > 0 ? cache.promoCodes : [];
  const safeList = list.filter(p => p.active !== false && (!p.cash_limit || (p.total_discounted || 0) < p.cash_limit));
  res.json(safeList);
});

app.get('/api/broadcasts', (req, res) => {
  res.json(cache.broadcasts.length > 0 ? cache.broadcasts : []);
});

app.get('/api/reviews/:productId', async (req, res) => {
  const { productId } = req.params;
  const key = cacheKeys.reviews(productId);

  // Try fetching from cache (Redis or local memory fallback)
  const cachedData = await getCacheValue(key, null);
  if (cachedData) {
    return res.json(cachedData);
  }

  // Serve from local memory as secondary fallback check
  const now = Date.now();
  const cachedLocal = cache.reviews[productId];
  if (cachedLocal && (now - cachedLocal.ts) < 5 * 60 * 1000) {
    return res.json(cachedLocal.data);
  }

  if (!isFirebaseOnline || !db) {
    return res.json([]);
  }

  try {
    const snap = await db.collection('reviews')
      .where('product_id', '==', productId)
      .get();
    const reviews = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    reviews.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));

    // Store in cache (with 5-minute TTL)
    await setCacheValue(key, reviews, 5 * 60);
    res.json(reviews);
  } catch (err) {
    console.error('Failed to fetch reviews:', err);
    res.status(500).json({ error: err.message });
  }
});

// 11. Add Review
app.post('/api/reviews', async (req, res) => {
  if (!isFirebaseOnline || !db) {
    return res.status(503).json({ error: 'Database service is unavailable' });
  }
  try {
    const reviewData = req.body;
    reviewData.created_at = reviewData.created_at || new Date().toISOString();
    const docRef = await db.collection('reviews').add(reviewData);

    // Invalidate product reviews cache in local RAM and Redis
    delete cache.reviews[reviewData.product_id];
    if (isRedisOnline && redisClient) {
      try {
        await redisClient.del(cacheKeys.reviews(reviewData.product_id));
      } catch (err) {
        console.warn('[Redis Cache] Failed to invalidate reviews key:', err.message);
      }
    }

    res.status(201).json({ id: docRef.id, ...reviewData });
  } catch (err) {
    console.error('Failed to add review:', err);
    res.status(500).json({ error: err.message });
  }
});

// 12. Fetch Reviews by User (for account.html My Reviews sheet)
app.get('/api/reviews/user/:uid', async (req, res) => {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: 'uid is required' });

  const cacheKey = `kwabz:reviews:user:${uid}`;

  // Try Redis/memory cache first
  if (isRedisOnline && redisClient) {
    try {
      const data = await redisClient.get(cacheKey);
      if (data) {
        return res.json(typeof data === 'string' ? JSON.parse(data) : data);
      }
    } catch (err) {
      console.warn('[Redis] User reviews read failed:', err.message);
    }
  }

  if (!isFirebaseOnline || !db) return res.json([]);

  try {
    const snap = await db.collection('reviews').where('user_id', '==', uid).get();
    const reviews = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    reviews.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });

    // Cache for 2 minutes
    if (isRedisOnline && redisClient) {
      try { await redisClient.set(cacheKey, JSON.stringify(reviews), { ex: 120 }); } catch (_) {}
    }

    res.json(reviews);
  } catch (err) {
    console.error('Failed to fetch user reviews:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Food Categories Endpoints ───────────────────────────────
app.get('/api/food-categories', (req, res) => {
  res.json(cache.foodCategories.length > 0 ? cache.foodCategories : []);
});

app.post('/api/food-categories', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    const docRef = await db.collection('food_categories').add(req.body);
    res.json({ id: docRef.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/food-categories/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('food_categories').doc(req.params.id).set(req.body, { merge: true });
    res.json({ id: req.params.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/food-categories/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('food_categories').doc(req.params.id).delete();
    // Immediately evict from RAM cache so subsequent GET requests return fresh data
    cache.foodCategories = cache.foodCategories.filter(c => c.id !== req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Food Items Endpoints ────────────────────────────────────
app.get('/api/food-items', (req, res) => {
  res.json(cache.foodItems.length > 0 ? cache.foodItems : []);
});

app.post('/api/food-items', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    const docRef = await db.collection('food_items').add(req.body);
    res.json({ id: docRef.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/food-items/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('food_items').doc(req.params.id).set(req.body, { merge: true });
    res.json({ id: req.params.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/food-items/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('food_items').doc(req.params.id).delete();
    // Immediately evict from RAM cache
    cache.foodItems = cache.foodItems.filter(f => f.id !== req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Data Bundles Endpoints ──────────────────────────────────
app.get('/api/bundles', async (req, res) => {
  if (cache.bundles.length > 0) {
    return res.json(cache.bundles);
  }
  if (!isFirebaseOnline || !db) return res.json([]);
  try {
    const snap = await db.collection('bundles').get();
    const bundles = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    bundles.sort((a, b) => {
      if (a.network !== b.network) return (a.network || '').localeCompare(b.network || '');
      return (a.price || 0) - (b.price || 0);
    });
    await setCacheValue(cacheKeys.bundles, bundles);
    res.json(bundles);
  } catch (err) {
    console.error('Failed to fetch bundles (cold start):', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bundles/clean-duplicates', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    const snap = await db.collection('bundles').get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const seen = new Map();
    const duplicates = [];

    for (const item of docs) {
      const key = `${(item.network || '').toLowerCase().trim()}_${(item.name || '').toLowerCase().trim()}_${item.price}`;
      if (seen.has(key)) {
        const existing = seen.get(key);
        if (existing.in_stock === false && item.in_stock !== false) {
          duplicates.push(existing.id);
          seen.set(key, item);
        } else {
          duplicates.push(item.id);
        }
      } else {
        seen.set(key, item);
      }
    }

    if (duplicates.length > 0) {
      const batch = db.batch();
      duplicates.forEach(id => batch.delete(db.collection('bundles').doc(id)));
      await batch.commit();
    }

    // Refresh cache
    const freshSnap = await db.collection('bundles').get();
    const freshBundles = freshSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    freshBundles.sort((a, b) => {
      if (a.network !== b.network) return (a.network || '').localeCompare(b.network || '');
      return (a.price || 0) - (b.price || 0);
    });
    await setCacheValue(cacheKeys.bundles, freshBundles);

    res.json({ success: true, removedCount: duplicates.length });
  } catch (err) {
    console.error('Clean duplicate bundles error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bundles', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    const docRef = await db.collection('bundles').add(req.body);
    const bundleWithId = { id: docRef.id, ...req.body };
    const updated = [...cache.bundles.filter(b => b.id !== docRef.id), bundleWithId];
    updated.sort((a, b) => {
      if (a.network !== b.network) return (a.network || '').localeCompare(b.network || '');
      return (a.price || 0) - (b.price || 0);
    });
    await setCacheValue(cacheKeys.bundles, updated);
    res.json(bundleWithId);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bundles/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('bundles').doc(req.params.id).set(req.body, { merge: true });
    const bundleWithId = { id: req.params.id, ...req.body };
    const updated = cache.bundles.map(b => b.id === req.params.id ? { ...b, ...req.body } : b);
    if (!updated.some(b => b.id === req.params.id)) updated.push(bundleWithId);
    updated.sort((a, b) => {
      if (a.network !== b.network) return (a.network || '').localeCompare(b.network || '');
      return (a.price || 0) - (b.price || 0);
    });
    await setCacheValue(cacheKeys.bundles, updated);
    res.json(bundleWithId);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bundles/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('bundles').doc(req.params.id).delete();
    const updated = cache.bundles.filter(b => b.id !== req.params.id);
    await setCacheValue(cacheKeys.bundles, updated);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Feedback Config & Submissions Endpoints ─────────────────
app.get('/api/feedback-config', (req, res) => {
  res.json(cache.feedbackConfig.length > 0 ? cache.feedbackConfig : []);
});

app.post('/api/feedback-config', async (req, res) => {
  try {
    const { id, config } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing form ID' });
    const itemData = { id, ...(config || {}) };
    const existingIdx = cache.feedbackConfig.findIndex(c => c.id === id);
    if (existingIdx >= 0) {
      cache.feedbackConfig[existingIdx] = itemData;
    } else {
      cache.feedbackConfig.push(itemData);
    }
    if (typeof cacheKeys !== 'undefined' && cacheKeys.feedbackConfig) {
      await setCacheValue(cacheKeys.feedbackConfig, cache.feedbackConfig).catch(() => {});
    }

    if (isFirebaseOnline && db) {
      await db.collection('feedback_form_config').doc(id).set(config || {});
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/feedback-config/:id', async (req, res) => {
  try {
    const id = req.params.id;
    cache.feedbackConfig = cache.feedbackConfig.filter(c => c.id !== id);
    if (typeof cacheKeys !== 'undefined' && cacheKeys.feedbackConfig) {
      await setCacheValue(cacheKeys.feedbackConfig, cache.feedbackConfig).catch(() => {});
    }

    if (isFirebaseOnline && db) {
      await db.collection('feedback_form_config').doc(id).delete();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/feedback-submissions', (req, res) => {
  res.json(cache.feedbackSubmissions.length > 0 ? cache.feedbackSubmissions : []);
});

app.post('/api/feedback-submissions', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    const docRef = await db.collection('feedback_submissions').add(req.body);
    res.json({ id: docRef.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/feedback-submissions/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('feedback_submissions').doc(req.params.id).update(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/feedback-submissions/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('feedback_submissions').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Gigs & Campus Opportunities Endpoints ────────────────────
app.get('/api/gigs', (req, res) => {
  res.json(cache.gigs.length > 0 ? cache.gigs : []);
});

app.post('/api/gigs', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    const gigData = {
      ...req.body,
      apply_count: req.body.apply_count !== undefined ? req.body.apply_count : 0,
      share_count: req.body.share_count !== undefined ? req.body.share_count : 0,
      view_count: req.body.view_count !== undefined ? req.body.view_count : 0
    };
    const docRef = await db.collection('gigs').add(gigData);
    res.json({ id: docRef.id, ...gigData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gigs/public-submit', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    const gigData = req.body;
    const newGig = {
      title: gigData.title,
      category: gigData.category,
      image_url: gigData.image_url || '',
      about: gigData.about || '',
      apply_link: gigData.apply_link || '',
      is_hero: false,
      is_approved: false,
      start_date: gigData.start_date || '',
      end_date: gigData.end_date || '',
      apply_count: 0,
      share_count: 0,
      view_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const docRef = await db.collection('gigs').add(newGig);
    res.json({ id: docRef.id, ...newGig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gigs/:id/track', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    const { id } = req.params;
    const { action } = req.body;
    const field = action === 'apply' ? 'apply_count' : action === 'share' ? 'share_count' : action === 'view' ? 'view_count' : null;

    if (!field) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    await db.collection('gigs').doc(id).update({
      [field]: FieldValue.increment(1)
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/gigs/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('gigs').doc(req.params.id).set(req.body, { merge: true });
    res.json({ id: req.params.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/gigs/:id', async (req, res) => {
  if (!isFirebaseOnline || !db) return res.status(503).json({ error: 'Database service is unavailable' });
  try {
    await db.collection('gigs').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cloudinary Signing Endpoint ─────────────────────────────
// Returns a timestamp + SHA-1 signature so the browser can do a
// SIGNED direct upload to Cloudinary without the image passing
// through this server (avoids body-size limits entirely).
// GET /api/cloudinary-sign → { timestamp, signature, apiKey, cloudName }
app.get('/api/cloudinary-sign', async (req, res) => {
  // ── Parse credentials from CLOUDINARY_URL or individual env vars ──
  let cloudName = 'dcix8pa5a';
  let apiKey    = '379252623331886';
  let apiSecret = '';

  const cloudinaryUrl = process.env.CLOUDINARY_URL || '';
  if (cloudinaryUrl.startsWith('cloudinary://')) {
    try {
      const parsed = new URL(cloudinaryUrl);
      apiKey    = parsed.username || apiKey;
      apiSecret = parsed.password || apiSecret;
      cloudName = parsed.hostname || cloudName;
    } catch (e) {
      console.warn('[Cloudinary Sign] Failed to parse CLOUDINARY_URL:', e.message);
    }
  } else {
    cloudName = process.env.CLOUDINARY_CLOUD_NAME || cloudName;
    apiKey    = process.env.CLOUDINARY_API_KEY    || apiKey;
    apiSecret = process.env.CLOUDINARY_API_SECRET || apiSecret;
  }

  if (!apiSecret) {
    console.error('[Cloudinary Sign] No API secret found. Set CLOUDINARY_URL on Render.');
    return res.status(500).json({ error: 'Cloudinary API secret not configured on server. Set CLOUDINARY_URL env var.' });
  }

  const timestamp = Math.round(Date.now() / 1000);
  const { createHash } = await import('crypto');
  const strToSign = `timestamp=${timestamp}${apiSecret}`;
  const signature = createHash('sha1').update(strToSign).digest('hex');

  console.log(`[Cloudinary Sign] Issued signature for cloud: ${cloudName}, key: ${apiKey.slice(0, 6)}...`);
  res.json({ timestamp, signature, apiKey, cloudName });
});

// ─── Cloudinary Upload Proxy ──────────────────────────────────
// Proxies image uploads to Cloudinary using server-side signed credentials.
// Accepts JSON: { file: base64DataUrl|remoteUrl, cloudName?, uploadPreset? }
// Returns:      { secure_url: string, public_id: string }
app.post('/api/upload', async (req, res) => {
  const { file, cloudName: clientCloudName, uploadPreset: clientPreset } = req.body || {};

  if (!file) {
    return res.status(400).json({ error: 'No file data provided' });
  }

  // ── Parse CLOUDINARY_URL if set (format: cloudinary://api_key:api_secret@cloud_name)
  let cloudName    = clientCloudName || 'dcix8pa5a';
  let apiKey       = '379252623331886';
  let apiSecret    = '';
  let uploadPreset = clientPreset    || 'j5l8qibi';

  const cloudinaryUrl = process.env.CLOUDINARY_URL || '';
  if (cloudinaryUrl.startsWith('cloudinary://')) {
    try {
      const parsed  = new URL(cloudinaryUrl);
      apiKey        = parsed.username  || apiKey;
      apiSecret     = parsed.password  || apiSecret;
      cloudName     = parsed.hostname  || cloudName;
      console.log(`[Cloudinary Proxy] Parsed CLOUDINARY_URL → cloud: ${cloudName}, key: ${apiKey.slice(0,6)}...`);
    } catch (e) {
      console.warn('[Cloudinary Proxy] Failed to parse CLOUDINARY_URL:', e.message);
    }
  } else {
    // Fall back to individual env vars
    cloudName    = process.env.CLOUDINARY_CLOUD_NAME    || cloudName;
    apiKey       = process.env.CLOUDINARY_API_KEY       || apiKey;
    apiSecret    = process.env.CLOUDINARY_API_SECRET    || apiSecret;
    uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || uploadPreset;
  }

  const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

  try {
    // Use native FormData (Node 18+ built-in — no extra packages needed)
    const form = new FormData();
    form.append('file', file);

    if (apiSecret) {
      // ── Signed Upload (preferred — no upload preset needed) ──
      const timestamp = Math.round(Date.now() / 1000);
      const { createHash } = await import('crypto');
      const strToSign = `timestamp=${timestamp}${apiSecret}`;
      const signature  = createHash('sha1').update(strToSign).digest('hex');

      form.append('api_key',   apiKey);
      form.append('timestamp', String(timestamp));
      form.append('signature', signature);

      console.log(`[Cloudinary Proxy] Signed upload → cloud: ${cloudName}`);
    } else {
      // ── Unsigned Upload (preset must exist and be set to Unsigned) ──
      form.append('upload_preset', uploadPreset);
      console.log(`[Cloudinary Proxy] Unsigned upload → preset: ${uploadPreset}`);
    }

    // Node 18+ has global fetch — no node-fetch required
    const response = await fetch(uploadUrl, { method: 'POST', body: form });
    const data     = await response.json();

    if (!response.ok || !data.secure_url) {
      const errMsg = data?.error?.message || JSON.stringify(data);
      console.error('[Cloudinary Proxy] Cloudinary rejected upload:', errMsg);
      return res.status(response.status || 500).json({ error: errMsg });
    }

    console.log(`[Cloudinary Proxy] ✅ Upload OK: ${data.secure_url}`);
    return res.json({ secure_url: data.secure_url, public_id: data.public_id });

  } catch (err) {
    console.error('[Cloudinary Proxy] Unexpected error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── WebSocket Event Handling ─────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Client connected to Socket.IO: ${socket.id}`);

  // Send active visitor count immediately to new dashboards
  socket.emit('visitor_count_updated', activeVisitors.size);

  // Demand-driven cache sync: clients can request specific datasets on-demand
  // instead of auto-dumping 11 full memory arrays on every connection
  socket.on('request_sync', (type) => {
    if (type === 'products' && cache.products.length > 0) socket.emit('products_changed', sanitizeForSocket(cache.products));
    else if (type === 'categories' && cache.categories.length > 0) socket.emit('categories_changed', sanitizeForSocket(cache.categories));
    else if (type === 'sellers' && cache.sellers.length > 0) socket.emit('sellers_changed', sanitizeForSocket(cache.sellers));
    else if (type === 'orders' && cache.orders.length > 0) socket.emit('orders_changed', sanitizeForSocket(cache.orders));
    else if (type === 'settings' && Object.keys(cache.settings).length > 0) socket.emit('settings_changed', sanitizeForSocket(cache.settings));
    else if (type === 'gigs' && cache.gigs.length > 0) socket.emit('gigs_changed', sanitizeForSocket(cache.gigs));
    else if (type === 'bundles' && cache.bundles.length > 0) socket.emit('bundles_changed', sanitizeForSocket(cache.bundles));
  });

  // Respond to client keep-alive pings (prevents Render free-tier sleep)
  socket.on('ping_keepalive', () => {
    socket.emit('pong_keepalive');
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected from Socket.IO: ${socket.id}`);
  });
});

// ─── Render Keep-Alive Self-Ping ──────────────────────────────
// NOTE: Render free tier now IGNORES self-pings from the same instance.
// For reliable uptime, point an EXTERNAL free cron service (e.g. https://cron-job.org) to:
//   GET  https://your-app.onrender.com/api/ping   (every 10 minutes)

function safePing(rawUrl, label) {
  try {
    const urlObj = new URL(rawUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.get(urlObj.href, (res) => {
      res.resume(); // Drain response body to free socket
      console.log(`[Keep-Alive] ${label} ping → ${urlObj.hostname} : ${res.statusCode}`);
    });
    // Hard timeout: abort if no response within 10 seconds
    req.setTimeout(10000, () => {
      req.destroy();
      console.warn(`[Keep-Alive] ${label} ping timed out for ${rawUrl}`);
    });
    req.on('error', (err) => {
      console.warn(`[Keep-Alive] ${label} ping error (${urlObj.hostname}):`, err.message);
    });
  } catch (err) {
    console.warn(`[Keep-Alive] Invalid URL skipped (${label}):`, err.message);
  }
}

const candidateUrls = [
  process.env.RENDER_EXTERNAL_URL,
  process.env.SELF_URL,
  'https://nodejs-backend-1-ucbq.onrender.com',
  'https://kwabz-store-backend.onrender.com'
].filter(Boolean);

// Map to the lightweight /api/ping endpoint (not /api/health which does more work)
const pingUrls = [...new Set(candidateUrls)].map(url => `${url.replace(/\/$/, '')}/api/ping`);

console.log(`📡 Keep-Alive: Self-pinging every 10 min for:`, pingUrls);

// Self-ping every 10 minutes (bandwidth optimized)
setInterval(() => {
  pingUrls.forEach(url => safePing(url, 'Self'));

  // Also wake any external partner URL if configured
  if (process.env.EXTERNAL_PING_URL) {
    safePing(process.env.EXTERNAL_PING_URL, 'External');
  }
}, 10 * 60 * 1000); // Every 10 minutes

// Start Server
httpServer.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 Kwabz Store Optimization API Server Online!`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`🛡️  Live-Sync Engine listening to Firestore...`);
  console.log(`👀 Live Audience endpoint mounted at /api/visitors/detailed`);
  console.log(`===================================================`);
  setupBackgroundSync();
});

// ─── Graceful Shutdown (Render rolling deploy / manual stop) ─────────────
process.on('SIGTERM', () => {
  console.log('[Render] SIGTERM received — rolling deploy or stop. Cleaning up...');
  // Tear down ALL Firestore listeners to prevent dangling connections
  Object.values(unsubscribers).forEach(unsub => { if (typeof unsub === 'function') unsub(); });
  httpServer.close(() => {
    console.log('[Render] HTTP server closed. Process exiting cleanly.');
    process.exit(0);
  });
  // Force-exit after 10s if httpServer.close() hangs
  setTimeout(() => {
    console.warn('[Render] Force-exiting after 10s timeout.');
    process.exit(1);
  }, 10000).unref();
});

// ─── Process Crash Guards ─────────────────────────────────────────────────
// Prevent a single unhandled async error from killing the entire server
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception — server continuing:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Promise Rejection — server continuing:', reason);
});
