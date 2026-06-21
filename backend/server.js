import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
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
app.use(express.json());

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
  broadcasts: null
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

  // 3.5. Live Orders Listener (for Admin Dashboard)
  unsubscribers.orders = db.collection('orders')
    .orderBy('created_at', 'desc')
    .limit(200)
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] orders collection updated. Syncing ${snapshot.size} items.`);
      const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      await setCacheValue(cacheKeys.orders, orders);
      io.emit('orders_changed', cache.orders);
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

  // 7. Live Broadcasts Listener
  unsubscribers.broadcasts = db.collection('broadcasts')
    .onSnapshot(async snapshot => {
      console.log(`[Firestore Sync] broadcasts collection updated. Syncing ${snapshot.size} items.`);
      const broadcasts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      broadcasts.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
      await setCacheValue(cacheKeys.broadcasts, broadcasts);
      io.emit('broadcasts_changed', cache.broadcasts);
    }, err => {
      console.error('[Firestore Sync] Broadcasts snapshot failed:', err.message);
    });

  // 4. Live Settings Document Listener
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
app.get('/api/visitors/detailed', (req, res) => {
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
    orderData.created_at = orderData.created_at || new Date().toISOString();
    const docRef = await db.collection('orders').add(orderData);
    res.status(201).json({ id: docRef.id, ...orderData });
  } catch (err) {
    console.error('Failed to create order:', err);
    res.status(500).json({ error: err.message });
  }
});

// 9. Admin Fetch Orders (Capped to 100 to prevent read explosion!)
app.get('/api/orders', async (req, res) => {
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
// Free Render instances spin down after 15 minutes of inactivity.
// We ping our own public URL every 8 minutes to keep the instance active and warm!
const candidateUrls = [
  process.env.RENDER_EXTERNAL_URL,
  process.env.SELF_URL,
  'https://nodejs-backend-1-ucbq.onrender.com',
  'https://kwabz-store-backend.onrender.com'
].filter(Boolean);

// Deduplicate candidate URLs and map to health endpoint
const pingUrls = [...new Set(candidateUrls)].map(url => `${url.replace(/\/$/, '')}/api/health`);

console.log(`📡 Keep-Alive configured. Warming self-pings every 8 min for:`, pingUrls);

setInterval(() => {
  pingUrls.forEach(url => {
    try {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      const req = client.get(urlObj.href, (res) => {
        res.resume(); // Consume response data to free up memory and socket resources
        console.log(`[Keep-Alive] Sent warming ping to ${urlObj.hostname}. Status: ${res.statusCode}`);
      });
      req.on('error', (err) => {
        console.warn(`[Keep-Alive] Self-ping failed for ${urlObj.hostname}:`, err.message);
      });
    } catch (err) {
      console.warn(`[Keep-Alive] Invalid ping URL: ${url}`, err.message);
    }
  });
}, 8 * 60 * 1000); // Every 8 minutes — well under Render's 15-min sleep threshold

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

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('Gracefully shutting down...');
  if (unsubscribers.products) unsubscribers.products();
  if (unsubscribers.categories) unsubscribers.categories();
  if (unsubscribers.sellers) unsubscribers.sellers();
  if (unsubscribers.settings) unsubscribers.settings();
  httpServer.close(() => {
    console.log('Server process terminated.');
    process.exit(0);
  });
});
