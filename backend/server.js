import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';
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
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://kwabz.com',
  'https://admin.kwabz.com',
  'https://seller.kwabz.com',
  'https://kwabz-store-v2.vercel.app'
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const isAllowed = allowedOrigins.includes(origin) || 
                      origin.endsWith('.kwabz.com') || 
                      origin.includes('vercel.app');
    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const isAllowed = allowedOrigins.includes(origin) || 
                        origin.endsWith('.kwabz.com') || 
                        origin.includes('vercel.app');
      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
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
  reviews: {} // productId -> reviews array
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
  }).catch(e => {
    console.warn('⚠️ Upstash connection ping failed. Using local in-memory store.', e.message);
  });
} catch (err) {
  console.warn('⚠️  Redis connection failed. Falling back to local memory cache.', err.message);
  isRedisOnline = false;
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

// ─── background live-sync listeners (exactly 1 read path per server process) ───
let unsubscribers = {
  products: null,
  categories: null,
  sellers: null,
  settings: null,
  blogPosts: null,
  promoCodes: null,
  broadcasts: null,
  orders: null,
  communications: null
};

function setupBackgroundSync() {
  if (!isFirebaseOnline || !db) {
    console.warn('⚠️  Mock data fallback enabled (Database offline).');
    return;
  }

  console.log('🔄 Setting up background Firestore Live-Sync listeners + FCM push...');

  // 1. Live Products Listener
  unsubscribers.products = db.collection('products')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] products collection updated. Syncing ${snapshot.size} items.`);
      const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      // In-memory sort by created_at desc
      products.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
      await setCacheValue(cacheKeys.products, products);
      // Broadcast real-time change to all connected socket clients (0 Firestore read cost!)
      io.emit('products_changed', cache.products);
    }, err => {
      console.error('[Firestore Sync] Products snapshot failed:', err.message);
    });

  // 2. Live Categories Listener
  unsubscribers.categories = db.collection('categories')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] categories collection updated. Syncing ${snapshot.size} items.`);
      const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      await setCacheValue(cacheKeys.categories, categories);
      io.emit('categories_changed', cache.categories);
    }, err => {
      console.error('[Firestore Sync] Categories snapshot failed:', err.message);
    });

  // 3. Live Sellers Listener
  unsubscribers.sellers = db.collection('sellers')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] sellers collection updated. Syncing ${snapshot.size} items.`);
      const sellers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      await setCacheValue(cacheKeys.sellers, sellers);
      io.emit('sellers_changed', cache.sellers);
    }, err => {
      console.error('[Firestore Sync] Sellers snapshot failed:', err.message);
    });

  // 3.5. Live Orders Listener — Admin Dashboard cache + FCM push on status change
  const _orderStatusCache = new Map(); // orderId -> last known status
  let _ordersInitialLoad = true;

  unsubscribers.orders = db.collection('orders')
    .orderBy('created_at', 'desc')
    .limit(200)
    .onSnapshot(async snapshot => {
      const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      await setCacheValue(cacheKeys.orders, orders);
      io.emit('orders_changed', cache.orders);

      // Skip pushing on initial load — only push on actual mutations
      if (_ordersInitialLoad) {
        _ordersInitialLoad = false;
        // Seed the status cache from the initial snapshot
        snapshot.docs.forEach(doc => {
          _orderStatusCache.set(doc.id, doc.data().status);
        });
        return;
      }

      // Detect status changes on modified docs and push to the customer
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'modified') continue;

        const orderId  = change.doc.id;
        const data     = change.doc.data();
        const newStatus = data.status || 'pending';
        const oldStatus = _orderStatusCache.get(orderId);

        // Update cache
        _orderStatusCache.set(orderId, newStatus);

        // Only push if status actually changed
        if (oldStatus === newStatus) continue;

        const customerUid = data.customer_uid;
        const orderLabel  = data.order_label || data.order_number || orderId.slice(-6).toUpperCase();
        const customerName = data.customer?.name || 'Customer';

        console.log(`[FCM] Order ${orderLabel} status: ${oldStatus} → ${newStatus} (uid: ${customerUid || 'guest'})`);

        // Guest orders have no uid — nothing to push to
        if (!customerUid || customerUid === 'guest') continue;

        // Find all FCM tokens for this specific user
        let tokens = [];
        try {
          const snap = await db.collection('fcm_tokens')
            .where('uid', '==', customerUid)
            .get();
          tokens = snap.docs
            .map(d => d.data().token || d.id)
            .filter(t => typeof t === 'string' && t.length > 0);
        } catch (e) {
          console.warn(`[FCM] Could not fetch tokens for uid ${customerUid}:`, e.message);
        }

        if (tokens.length === 0) continue;

        // Status-specific messaging
        const STATUS_LABELS = {
          confirmed:  { emoji: '✅', msg: `Your order ${orderLabel} has been confirmed!` },
          shipped:    { emoji: '🚚', msg: `Your order ${orderLabel} is on its way!` },
          delivered:  { emoji: '🎉', msg: `Your order ${orderLabel} has been delivered. Enjoy!` },
          cancelled:  { emoji: '❌', msg: `Your order ${orderLabel} was cancelled. Contact us for details.` },
          processing: { emoji: '⚙️', msg: `Your order ${orderLabel} is being processed.` },
          pending:    { emoji: '⏳', msg: `Your order ${orderLabel} is pending confirmation.` },
        };
        const label = STATUS_LABELS[newStatus] || { emoji: '📦', msg: `Order ${orderLabel} status updated to ${newStatus}.` };
        const receiptUrl = `https://kwabz-store-v2.vercel.app/receipt.html?id=${orderId}`;

        const push = {
          notification: {
            title: `${label.emoji} Order Update — Kwabz Store`,
            body: label.msg
          },
          data: { order_id: orderId, url: receiptUrl },
          android: { priority: 'high' },
          apns: {
            headers: {
              'apns-priority': '10',
              'apns-push-type': 'alert'
            }
          },
          webpush: {
            headers: {
              Urgency: 'high'
            },
            fcmOptions: { link: receiptUrl },
            notification: {
              icon: 'https://kwabz-store-v2.vercel.app/icon-192x192.png',
              badge: 'https://kwabz-store-v2.vercel.app/notification-badge.png'
            }
          },
          tokens
        };

        try {
          const messaging = getMessaging();
          const resp = await messaging.sendEachForMulticast(push);
          console.log(`[FCM] Order push to ${customerName}: ${resp.successCount} ok, ${resp.failureCount} failed.`);

          // Cleanup stale tokens
          resp.responses.forEach((r, i) => {
            if (!r.success) {
              const code = r.error?.code || '';
              if (code.includes('not-registered') || code.includes('invalid-registration-token')) {
                db.collection('fcm_tokens').doc(tokens[i]).delete().catch(() => {});
              }
            }
          });
        } catch (e) {
          console.error('[FCM] Order status push failed:', e.message);
        }
      }
    }, err => {
      console.error('[Firestore Sync] Orders snapshot failed:', err.message);
    });

  // 5. Live Blog Posts Listener
  unsubscribers.blogPosts = db.collection('blog_posts')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] blog_posts collection updated. Syncing ${snapshot.size} items.`);
      const blogPosts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      blogPosts.sort((a, b) => getSafeTime(b.created_at || b.date) - getSafeTime(a.created_at || a.date));
      await setCacheValue(cacheKeys.blogPosts, blogPosts);
      io.emit('blog_posts_changed', cache.blogPosts);
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

  // 7. Live Broadcasts Listener — cache sync + FCM push to all users on new broadcast
  let _broadcastsInitialLoad = true;

  unsubscribers.broadcasts = db.collection('broadcasts')
    .onSnapshot(async snapshot => {
      const broadcasts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      broadcasts.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
      await setCacheValue(cacheKeys.broadcasts, broadcasts);
      io.emit('broadcasts_changed', cache.broadcasts);

      if (_broadcastsInitialLoad) { _broadcastsInitialLoad = false; return; }

      // Push to all users when a new broadcast is added by admin
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;

        const bd = change.doc.data();
        // Skip if already pushed
        if (bd.fcm_sent) continue;

        console.log(`[FCM] New broadcast: "${bd.title || 'Announcement'}". Pushing to all devices...`);

        try {
          // Mark as pushed first to prevent duplicate sends
          await db.collection('broadcasts').doc(change.doc.id).update({ fcm_sent: true });
        } catch (_) {}

        let tokens = [];
        try {
          const snap = await db.collection('fcm_tokens').get();
          tokens = snap.docs.map(d => d.data().token || d.id).filter(t => t && t.length > 0);
        } catch (e) {
          console.warn('[FCM] Could not fetch tokens for broadcast:', e.message);
        }

        if (tokens.length === 0) continue;

        const push = {
          notification: {
            title: `📢 ${bd.title || 'Kwabz Store Update'}`,
            body: bd.message || bd.body || 'Tap to view the latest announcement.'
          },
          data: { url: 'https://kwabz-store-v2.vercel.app/shop.html' },
          android: { priority: 'high' },
          apns: {
            headers: {
              'apns-priority': '10',
              'apns-push-type': 'alert'
            }
          },
          webpush: {
            headers: {
              Urgency: 'high'
            },
            fcmOptions: { link: 'https://kwabz-store-v2.vercel.app/shop.html' },
            notification: {
              icon: 'https://kwabz-store-v2.vercel.app/icon-192x192.png',
              badge: 'https://kwabz-store-v2.vercel.app/notification-badge.png'
            }
          },
          tokens
        };

        try {
          const messaging = getMessaging();
          const resp = await messaging.sendEachForMulticast(push);
          console.log(`[FCM] Broadcast push: ${resp.successCount} ok, ${resp.failureCount} failed.`);
        } catch (e) {
          console.error('[FCM] Broadcast push failed:', e.message);
        }
      }
    }, err => {
      console.error('[Firestore Sync] Broadcasts snapshot failed:', err.message);
    });

  // 7.5. Communications listener — push to user when admin sends a chat reply
  let _commsInitialLoad = true;

  unsubscribers.communications = db.collection('communications')
    .where('type', '==', 'chat')
    .where('sender_id', '==', 'admin')
    .onSnapshot(async snapshot => {
      if (_commsInitialLoad) { _commsInitialLoad = false; return; }

      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;

        const msg = change.doc.data();
        // conversation_id is the customer's uid (set by shell.js)
        const customerUid = msg.receiver_id || msg.conversation_id;
        if (!customerUid || customerUid === 'admin') continue;

        console.log(`[FCM] Admin replied to chat session ${customerUid}. Sending push...`);

        let tokens = [];
        try {
          const snap = await db.collection('fcm_tokens')
            .where('uid', '==', customerUid)
            .get();
          tokens = snap.docs.map(d => d.data().token || d.id).filter(t => t && t.length > 0);
        } catch (e) {
          console.warn('[FCM] Could not fetch tokens for chat push:', e.message);
        }

        if (tokens.length === 0) continue;

        const senderName = msg.sender_name || 'Kwabz Support';
        const chatText   = msg.message || '...';

        const push = {
          notification: {
            title: `💬 ${senderName}`,
            body: chatText.length > 80 ? chatText.slice(0, 77) + '...' : chatText
          },
          data: { url: 'https://kwabz-store-v2.vercel.app/account.html' },
          android: { priority: 'high' },
          apns: {
            headers: {
              'apns-priority': '10',
              'apns-push-type': 'alert'
            }
          },
          webpush: {
            headers: {
              Urgency: 'high'
            },
            fcmOptions: { link: 'https://kwabz-store-v2.vercel.app/account.html' },
            notification: {
              icon: 'https://kwabz-store-v2.vercel.app/icon-192x192.png',
              badge: 'https://kwabz-store-v2.vercel.app/notification-badge.png',
              tag: `kwabz-chat-${customerUid}`,
              renotify: true
            }
          },
          tokens
        };

        try {
          const messaging = getMessaging();
          const resp = await messaging.sendEachForMulticast(push);
          console.log(`[FCM] Chat push sent: ${resp.successCount} ok, ${resp.failureCount} failed.`);

          // Cleanup stale tokens
          resp.responses.forEach((r, i) => {
            if (!r.success) {
              const code = r.error?.code || '';
              if (code.includes('not-registered') || code.includes('invalid-registration-token')) {
                db.collection('fcm_tokens').doc(tokens[i]).delete().catch(() => {});
              }
            }
          });
        } catch (e) {
          console.error('[FCM] Chat push failed:', e.message);
        }
      }
    }, err => {
      console.error('[Firestore Sync] Communications snapshot failed:', err.message);
    });

  // 8. product_notifications listener → FCM multicast fan-out
  // Written by the client (store.js) when a new product is added.
  // This listener reads it, fetches all user FCM tokens, and sends a push.
  db.collection('product_notifications')
    .where('notified', '!=', true)         // Only unprocessed docs
    .onSnapshot(async snapshot => {
      if (snapshot.empty) return;

      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;

        const notifDoc = change.doc;
        const notifData = notifDoc.data();

        console.log(`[FCM] New product notification: "${notifData.name}" (id: ${notifDoc.id})`);

        // Mark as processed immediately to prevent duplicate sends on server restart
        try {
          await db.collection('product_notifications').doc(notifDoc.id).update({ notified: true });
        } catch (markErr) {
          console.warn('[FCM] Could not mark notification as processed:', markErr.message);
        }

        // Fetch all FCM tokens from the dedicated fcm_tokens collection
        // (Shell.js stores tokens here as: fcm_tokens/{token} = { token, uid, ... })
        let tokens = [];
        try {
          const tokensSnap = await db.collection('fcm_tokens').get();

          tokens = tokensSnap.docs
            .map(d => d.data().token || d.id)    // doc ID is the token
            .filter(t => typeof t === 'string' && t.trim().length > 0);

          console.log(`[FCM] Found ${tokens.length} registered device token(s) to notify.`);
        } catch (fetchErr) {
          console.error('[FCM] Failed to fetch FCM tokens:', fetchErr.message);
          continue;
        }

        if (tokens.length === 0) {
          // No registered users — this is normal, not a bug. Log info-level only.
          console.log('[FCM] No FCM tokens registered yet — skipping push for this notification.');
          continue;
        }

        // Build the multicast FCM message
        const productUrl = `https://kwabz-store-v2.vercel.app/product-detail.html?id=${notifData.product_id || ''}`;
        const message = {
          notification: {
            title: `🛍️ New Drop: ${notifData.name || 'New Item'}`,
            body: `Now available for GH₵ ${
              notifData.discount > 0
                ? ((notifData.price || 0) * (1 - notifData.discount / 100)).toFixed(2)
                : (notifData.price || 0).toFixed(2)
            } — Tap to view!`,
            imageUrl: notifData.image_url || undefined
          },
          data: {
            product_id: notifData.product_id || '',
            url: productUrl
          },
          android: { priority: 'high' },
          apns: {
            headers: {
              'apns-priority': '10',
              'apns-push-type': 'alert'
            }
          },
          webpush: {
            headers: {
              Urgency: 'high'
            },
            fcmOptions: { link: productUrl },
            notification: {
              icon: 'https://kwabz-store-v2.vercel.app/icon-192x192.png',
              badge: 'https://kwabz-store-v2.vercel.app/notification-badge.png'
            }
          },
          tokens: tokens
        };

        // Send multicast push
        try {
          const messaging = getMessaging();
          const response = await messaging.sendEachForMulticast(message);

          console.log(`[FCM] Push sent: ${response.successCount} success, ${response.failureCount} failed.`);

          // Clean up stale/invalid tokens from Firestore
          if (response.failureCount > 0) {
            const staleTokens = [];
            response.responses.forEach((resp, idx) => {
              if (!resp.success) {
                const errCode = resp.error?.code || '';
                if (
                  errCode === 'messaging/registration-token-not-registered' ||
                  errCode === 'messaging/invalid-registration-token'
                ) {
                  staleTokens.push(tokens[idx]);
                } else {
                  console.warn(`[FCM] Token send failed (non-stale):`, resp.error?.message);
                }
              }
            });

            // Remove stale tokens from the fcm_tokens collection
            if (staleTokens.length > 0) {
              console.log(`[FCM] Removing ${staleTokens.length} stale token(s) from fcm_tokens...`);
              const batch = db.batch();
              staleTokens.forEach(token => {
                batch.delete(db.collection('fcm_tokens').doc(token));
              });
              await batch.commit();
              console.log('[FCM] Stale token cleanup complete.');
            }
          }
        } catch (sendErr) {
          console.error('[FCM] Multicast send failed:', sendErr.message);
        }
      }
    }, err => {
      console.error('[Firestore Sync] product_notifications snapshot failed:', err.message);
    });

  console.log('✅ Background Firestore listeners + FCM fan-out ready.');

  // Settings Document Listener (must remain last — depends on others being set up)
  unsubscribers.settings = db.collection('settings').doc('global')
    .onSnapshot(async doc => {
      if (doc.exists) {
        console.log('[Firestore Sync] Global Settings document updated.');
        await setCacheValue(cacheKeys.settings, doc.data());
        io.emit('settings_changed', cache.settings);
      }
    }, err => {
      console.error('[Firestore Sync] Settings snapshot failed:', err.message);
    });
}

// ─── Memory Visitor Heartbeat Sweep Task ─────────────────────
// Sweeps the visitor registry every 30 seconds and removes any inactive past 15 minutes.
setInterval(() => {
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

  if (changed) {
    // Notify all connected dashboard clients of updated visitor count in real time
    io.emit('visitor_count_updated', activeVisitors.size);
  }
}, 30000);

// Helper to parse cookie from req.headers.cookie
function getCookieFromRequest(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';');
  for (let i = 0; i < cookies.length; i++) {
    const c = cookies[i].trim();
    if (c.startsWith(name + '=')) {
      return decodeURIComponent(c.substring(name.length + 1));
    }
  }
  return null;
}

// Middleware to require admin authentication
async function requireAdmin(req, res, next) {
  // If Firebase admin is offline, bypass auth in development mock mode
  if (!isFirebaseOnline) {
    return next();
  }

  try {
    // 1. Prioritize reading token from cookie
    let token = getCookieFromRequest(req, 'kwabz_auth_token');
    
    // 2. Fall back to Authorization header
    if (!token && req.headers.authorization) {
      const parts = req.headers.authorization.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    // Verify token
    const decodedToken = await getAuth().verifyIdToken(token);
    
    // Check if user is admin
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    const ADMIN_EMAILS = ['admin@kwabzstore.com', 'admin@kwabz.com', 'kelvin@kwabz.com'];
    const isDesignatedAdmin = ADMIN_EMAILS.includes(decodedToken.email);
    
    if ((userDoc.exists && userDoc.data().role === 'admin') || isDesignatedAdmin) {
      req.user = decodedToken;
      return next();
    }

    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  } catch (err) {
    console.error('Auth verification failed:', err.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// ─── REST API Routes ──────────────────────────────────────────

// Endpoint to set HttpOnly session cookie
app.post('/api/auth/set-session', (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  // Determine domain
  let domain = null;
  const host = req.get('host') || '';
  if (host.includes('kwabz.com')) {
    domain = '.kwabz.com';
  }

  const cookieOptions = {
    httpOnly: true,
    secure: req.secure || !host.includes('localhost'),
    sameSite: 'Strict',
    maxAge: 1000 * 60 * 60 * 24 * 5 // 5 days
  };
  if (domain) {
    domain = '.kwabz.com'; // Enforce dot prefix to ensure all subdomains share it
    cookieOptions.domain = domain;
  }

  res.cookie('kwabz_auth_token', token, cookieOptions);
  res.json({ success: true });
});

// Endpoint to clear HttpOnly session cookie
app.post('/api/auth/clear-session', (req, res) => {
  let domain = null;
  const host = req.get('host') || '';
  if (host.includes('kwabz.com')) {
    domain = '.kwabz.com';
  }

  const cookieOptions = {
    httpOnly: true,
    secure: req.secure || !host.includes('localhost'),
    sameSite: 'Strict',
    maxAge: 0
  };
  if (domain) {
    domain = '.kwabz.com'; // Enforce dot prefix
    cookieOptions.domain = domain;
  }

  res.cookie('kwabz_auth_token', '', cookieOptions);
  res.json({ success: true });
});

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

// 6. Visitor Heartbeat Endpoint (COMPLETELY replaces Firestore visitor database writes!)
app.post('/api/visitors/heartbeat', (req, res) => {
  const { visitorId, uid, page, displayName } = req.body;
  if (!visitorId) {
    return res.status(400).json({ error: 'visitorId is required' });
  }

  const prevSize = activeVisitors.size;
  activeVisitors.set(visitorId, {
    uid: uid || null,
    page: page || 'index.html',
    displayName: displayName || null,
    lastActive: Date.now()
  });

  // If visitor count changed, notify sockets
  if (activeVisitors.size !== prevSize) {
    io.emit('visitor_count_updated', activeVisitors.size);
  }

  res.json({ success: true, activeCount: activeVisitors.size });
});

// 7. Get Active Visitor Count
app.get('/api/visitor-count', (req, res) => {
  res.json({ count: activeVisitors.size });
});

// 7.5. Get Detailed Active Visitors
app.get('/api/visitors/detailed', requireAdmin, (req, res) => {
  const visitors = Array.from(activeVisitors.entries()).map(([vid, data]) => ({
    visitorId: vid,
    ...data
  }));
  res.json({ count: visitors.length, visitors });
});

// 8. Order Placement Proxy
app.post('/api/orders', async (req, res) => {
  if (!isFirebaseOnline || !db) {
    return res.status(503).json({ error: 'Database service is unavailable' });
  }
  try {
    const orderData = req.body;
    const customerUid = orderData.customer_uid;
    if (customerUid && orderData.order_method === 'wallet') {
      const userDoc = await db.collection('users').doc(customerUid).get();
      if (userDoc.exists && userDoc.data().wallet_locked === true) {
        return res.status(403).json({ error: 'Your wallet is locked. Wallet checkout is disabled.' });
      }
    }
    orderData.created_at = orderData.created_at || new Date().toISOString();
    const docRef = await db.collection('orders').add(orderData);
    res.status(201).json({ id: docRef.id, ...orderData });
  } catch (err) {
    console.error('Failed to create order:', err);
    res.status(500).json({ error: err.message });
  }
});

// 9. Admin Fetch Orders (Capped to 100 to prevent read explosion!)
app.get('/api/orders', requireAdmin, async (req, res) => {
  if (!isFirebaseOnline || !db) {
    return res.status(503).json({ error: 'Database service is unavailable' });
  }
  try {
    const limit = parseInt(req.query.limit) || 100;
    const snap = await db.collection('orders')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();
    const orders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (err) {
    console.error('Failed to fetch orders:', err);
    res.status(500).json({ error: err.message });
  }
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

// ─── WebSocket Event Handling ─────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Client connected to Socket.IO: ${socket.id}`);

  // Send active visitor count immediately to new dashboards
  socket.emit('visitor_count_updated', activeVisitors.size);

  // Send caches immediately so they don't wait for a background tick
  if (cache.products.length > 0) socket.emit('products_changed', cache.products);
  if (cache.categories.length > 0) socket.emit('categories_changed', cache.categories);
  if (cache.sellers.length > 0) socket.emit('sellers_changed', cache.sellers);
  if (cache.orders.length > 0) socket.emit('orders_changed', cache.orders);
  if (Object.keys(cache.settings).length > 0) socket.emit('settings_changed', cache.settings);

  // Respond to client keep-alive pings (prevents Render free-tier sleep)
  socket.on('ping_keepalive', () => {
    socket.emit('pong_keepalive');
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected from Socket.IO: ${socket.id}`);
  });
});

// ─── Render 24/7 Keep-Alive Self-Ping ─────────────────────────
// NOTE: Render free tier now IGNORES self-pings from the same instance.
// The self-ping below is a fallback. For reliable uptime, point an EXTERNAL
// free cron service (e.g. https://cron-job.org) to:
//   GET  https://your-app.onrender.com/api/ping   (every 4 minutes)
//
// Set EXTERNAL_PING_URL in Render env vars to enable cross-service waking.

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

console.log(`📡 Keep-Alive: Self-pinging every 4 min for:`, pingUrls);

// Self-ping every 4 minutes (belt-and-suspenders; external cron is the true fix)
setInterval(() => {
  pingUrls.forEach(url => safePing(url, 'Self'));

  // Also wake any external partner URL if configured (e.g., the WhatsApp bot server)
  if (process.env.EXTERNAL_PING_URL) {
    safePing(process.env.EXTERNAL_PING_URL, 'External');
  }
}, 4 * 60 * 1000); // Every 4 minutes

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
