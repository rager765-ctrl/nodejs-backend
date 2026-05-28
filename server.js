import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCompress from '@fastify/compress';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { Server } from 'socket.io';
import fs from 'fs';

// Load Config
dotenv.config();

const PORT = process.env.PORT || 5000;
const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT || './firebase-service-account.json';

// ── Fastify Instance ──────────────────────────────────────────
const fastify = Fastify({ trustProxy: true });

// ── Speed Plugins ─────────────────────────────────────────────
await fastify.register(fastifyCompress, { global: true });
await fastify.register(fastifyCors, { origin: '*' });

// ── X-Response-Time ───────────────────────────────────────────
fastify.addHook('onRequest', (req, reply, done) => { req._t = Date.now(); done(); });
fastify.addHook('onSend', (req, reply, payload, done) => {
  reply.header('X-Response-Time', `${Date.now() - req._t}ms`);
  done(null, payload);
});

// ── Socket.IO (uses Fastify's underlying http.Server) ─────────
const io = new Server(fastify.server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000
});

// ── Firebase Admin ────────────────────────────────────────────
let db = null;
let isFirebaseOnline = false;

try {
  let serviceAccount = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.log('📦 Loading Firebase from Environment Variable...');
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.log('📂 Loading Firebase from local file...');
    serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  }
  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    isFirebaseOnline = true;
    console.log('✅ Firebase Admin connected successfully.');
  } else {
    console.warn('⚠️  No Firebase Service Account found. Add FIREBASE_SERVICE_ACCOUNT_JSON env var.');
  }
} catch (err) {
  console.error('❌ Firebase error:', err.message);
}

// ── Mock Fallbacks ────────────────────────────────────────────
const mockData = {
  products: [], categories: [], sellers: [],
  settings: { theme: { primary: '#6200ee' } }
};

// ── In-Memory Cache ───────────────────────────────────────────
const cache = {
  products: [], categories: [], sellers: [],
  orders: [], settings: {}, reviews: {}
};

// Pre-serialized JSON strings — set once on Firestore update, served instantly on every request
const serialized = { products: '[]', categories: '[]', sellers: '[]', orders: '[]', settings: '{}' };
const etags = { products: null, categories: null, sellers: null, orders: null, settings: null };

function updateCache(key, value) {
  const json = JSON.stringify(value);
  const ts = Date.now().toString(36);
  if      (key === 'products')   { cache.products   = value; serialized.products   = json; etags.products   = ts; }
  else if (key === 'categories') { cache.categories = value; serialized.categories = json; etags.categories = ts; }
  else if (key === 'sellers')    { cache.sellers    = value; serialized.sellers    = json; etags.sellers    = ts; }
  else if (key === 'orders')     { cache.orders     = value; serialized.orders     = json; etags.orders     = ts; }
  else if (key === 'settings')   { cache.settings   = value; serialized.settings   = json; etags.settings   = ts; }
}

function setReviewCache(id, value) { cache.reviews[id] = { data: value, ts: Date.now() }; }
function getReviewCache(id) {
  const e = cache.reviews[id];
  return (e && Date.now() - e.ts < 5 * 60 * 1000) ? e.data : null;
}

async function setCacheValue(key, value) {
  const k = key.replace('kwabz:', '');
  k.startsWith('reviews:') ? setReviewCache(k.replace('reviews:', ''), value) : updateCache(k, value);
}
async function getCacheValue(key, fallback) {
  const k = key.replace('kwabz:', '');
  if (k.startsWith('reviews:')) return getReviewCache(k.replace('reviews:', '')) ?? fallback;
  return cache[k] ?? fallback;
}
const cacheKeys = {
  products: 'kwabz:products', categories: 'kwabz:categories',
  sellers: 'kwabz:sellers', orders: 'kwabz:orders',
  settings: 'kwabz:settings', reviews: (id) => `kwabz:reviews:${id}`
};

// ── Fast JSON Responder (pre-serialized + ETag) ───────────────
function sendCached(req, reply, key, fallback = '[]') {
  const etag = etags[key];
  if (etag) {
    reply.header('ETag', `"${etag}"`);
    if (req.headers['if-none-match'] === `"${etag}"`) return reply.code(304).send();
  }
  reply.header('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
  return reply.type('application/json').send(serialized[key] || fallback);
}

// ── Visitor Registry ──────────────────────────────────────────
const activeVisitors = new Map();

function getSafeTime(val) {
  if (!val) return 0;
  if (typeof val.toDate === 'function') { try { return val.toDate().getTime(); } catch { return 0; } }
  if (typeof val === 'number') return val;
  if (val.seconds) return val.seconds * 1000;
  const t = new Date(val).getTime(); return isNaN(t) ? 0 : t;
}

function getActiveAdminsCount() {
  const threshold = 15 * 60 * 1000;
  const now = Date.now();
  return Array.from(activeVisitors.values()).filter(v => 
    (now - v.lastActive < threshold) && 
    (v.page && v.page.includes('admin') || v.uid && ['admin@kwabzstore.com', 'admin@kwabz.com', 'kelvin@kwabz.com'].includes(v.displayName))
  ).length;
}

// Sweep inactive visitors every 30s
setInterval(() => {
  const threshold = 15 * 60 * 1000;
  let changed = false;
  let adminsChanged = false;
  const prevAdminsCount = getActiveAdminsCount();

  for (const [k, v] of activeVisitors.entries()) {
    if (Date.now() - v.lastActive > threshold) { activeVisitors.delete(k); changed = true; }
  }

  if (changed) {
    io.emit('visitor_count_updated', activeVisitors.size);
    if (getActiveAdminsCount() !== prevAdminsCount) {
      io.emit('admin_presence_updated', getActiveAdminsCount());
    }
  }
}, 30000);

// ── Firestore Background Sync ─────────────────────────────────
const unsubscribers = { products: null, categories: null, sellers: null, settings: null, orders: null };

function setupBackgroundSync() {
  if (!isFirebaseOnline || !db) { console.warn('⚠️  Mock mode — DB offline.'); return; }
  console.log('🔄 Starting Firestore Live-Sync listeners...');

  unsubscribers.products = db.collection('products').onSnapshot(async snap => {
    const p = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    p.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
    await setCacheValue(cacheKeys.products, p);
    io.emit('products_changed', cache.products);
    console.log(`[Sync] products: ${p.length} items`);
  }, e => console.error('[Sync] products error:', e.message));

  unsubscribers.categories = db.collection('categories').onSnapshot(async snap => {
    const c = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    await setCacheValue(cacheKeys.categories, c);
    io.emit('categories_changed', cache.categories);
  }, e => console.error('[Sync] categories error:', e.message));

  unsubscribers.sellers = db.collection('sellers').onSnapshot(async snap => {
    const s = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    await setCacheValue(cacheKeys.sellers, s);
    io.emit('sellers_changed', cache.sellers);
  }, e => console.error('[Sync] sellers error:', e.message));

  unsubscribers.orders = db.collection('orders').orderBy('created_at', 'desc').limit(200)
    .onSnapshot(async snap => {
      const o = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      await setCacheValue(cacheKeys.orders, o);
      io.emit('orders_changed', cache.orders);
    }, e => console.error('[Sync] orders error:', e.message));

  unsubscribers.settings = db.collection('settings').doc('global').onSnapshot(async doc => {
    if (doc.exists) {
      await setCacheValue(cacheKeys.settings, doc.data());
      io.emit('settings_changed', cache.settings);
    }
  }, e => console.error('[Sync] settings error:', e.message));
}

// ── Routes ────────────────────────────────────────────────────

// 0. Status Landing Page
fastify.get('/', async (req, reply) => {
  reply.type('text/html').send(`<!DOCTYPE html><html lang="en"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Kwabz Store API — Online</title>
    <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}.c{background:#1e293b;padding:2.5rem;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.3);max-width:480px;border:1px solid #334155}.icon{font-size:3rem;display:inline-block;animation:pulse 2s infinite ease-in-out}h1{font-size:1.5rem;margin:0 0 .5rem;color:#38bdf8}p{color:#94a3b8;font-size:.875rem;line-height:1.5;margin:0 0 1.5rem}.badge{display:inline-flex;align-items:center;gap:.5rem;background:#166534;color:#4ade80;font-weight:700;font-size:.75rem;padding:.35rem .75rem;border-radius:9999px;text-transform:uppercase;letter-spacing:.05em}.dot{width:8px;height:8px;background:#4ade80;border-radius:50%;display:inline-block;box-shadow:0 0 8px #4ade80;animation:blink 1.5s infinite}@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}@keyframes blink{0%,100%{opacity:.3}50%{opacity:1}}</style>
    </head><body><div class="c"><div class="icon">⚡</div><h1>Kwabz Store API</h1>
    <p>Powered by <strong>Fastify</strong> — 3× faster than Express. Real-time Socket.IO push active.</p>
    <span class="badge"><span class="dot"></span> Server Online</span></div></body></html>`);
});

// 1. Healthcheck
fastify.get('/api/health', async (req, reply) => ({
  status: 'healthy',
  framework: 'Fastify',
  firebase: isFirebaseOnline ? 'connected' : 'fallback_mock',
  cacheSizes: { products: cache.products.length, categories: cache.categories.length, sellers: cache.sellers.length },
  activeVisitors: activeVisitors.size,
  activeAdmins: getActiveAdminsCount()
}));

// 2. Products — served from pre-serialized string, sub-millisecond
fastify.get('/api/products', (req, reply) => {
  if (cache.products.length > 0) return sendCached(req, reply, 'products');
  reply.header('Cache-Control', 'no-store'); return reply.send(mockData.products);
});

// 3. Categories
fastify.get('/api/categories', (req, reply) => {
  if (cache.categories.length > 0) return sendCached(req, reply, 'categories');
  reply.header('Cache-Control', 'no-store'); return reply.send(mockData.categories);
});

// 4. Sellers
fastify.get('/api/sellers', (req, reply) => {
  if (cache.sellers.length > 0) return sendCached(req, reply, 'sellers');
  reply.header('Cache-Control', 'no-store'); return reply.send(mockData.sellers);
});

// 5. Settings
fastify.get('/api/settings', (req, reply) => {
  if (Object.keys(cache.settings).length > 0) return sendCached(req, reply, 'settings', '{}');
  reply.header('Cache-Control', 'no-store'); return reply.send(mockData.settings);
});

// 6. Visitor Heartbeat
fastify.post('/api/visitors/heartbeat', async (req, reply) => {
  const { visitorId, uid, page, displayName } = req.body || {};
  if (!visitorId) return reply.code(400).send({ error: 'visitorId is required' });
  const prevSize = activeVisitors.size;
  const prevAdminsCount = getActiveAdminsCount();

  activeVisitors.set(visitorId, { 
    uid: uid || null, 
    page: page || 'index.html', 
    displayName: displayName || null, 
    lastActive: Date.now() 
  });

  if (activeVisitors.size !== prevSize) {
    io.emit('visitor_count_updated', activeVisitors.size);
  }
  if (getActiveAdminsCount() !== prevAdminsCount) {
    io.emit('admin_presence_updated', getActiveAdminsCount());
  }

  return { success: true, activeCount: activeVisitors.size, activeAdmins: getActiveAdminsCount() };
});

// 7. Visitor Count
fastify.get('/api/visitor-count', async () => ({ count: activeVisitors.size }));

// 8. Place Order
fastify.post('/api/orders', async (req, reply) => {
  if (!isFirebaseOnline || !db) return reply.code(503).send({ error: 'Database unavailable' });
  try {
    const orderData = { ...req.body, created_at: req.body?.created_at || new Date().toISOString() };
    const docRef = await db.collection('orders').add(orderData);
    return reply.code(201).send({ id: docRef.id, ...orderData });
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

// 9. Fetch Orders (Admin)
fastify.get('/api/orders', async (req, reply) => {
  if (!isFirebaseOnline || !db) return reply.code(503).send({ error: 'Database unavailable' });
  try {
    const limit = parseInt(req.query.limit) || 100;
    const snap = await db.collection('orders').orderBy('created_at', 'desc').limit(limit).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

// 10. Fetch Reviews
fastify.get('/api/reviews/:productId', async (req, reply) => {
  const { productId } = req.params;
  const cached = await getCacheValue(cacheKeys.reviews(productId), null);
  if (cached) return cached;
  if (!isFirebaseOnline || !db) return [];
  try {
    const snap = await db.collection('reviews').where('product_id', '==', productId).get();
    const reviews = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    reviews.sort((a, b) => getSafeTime(b.created_at) - getSafeTime(a.created_at));
    await setCacheValue(cacheKeys.reviews(productId), reviews);
    return reviews;
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

// 11. Add Review
fastify.post('/api/reviews', async (req, reply) => {
  if (!isFirebaseOnline || !db) return reply.code(503).send({ error: 'Database unavailable' });
  try {
    const reviewData = { ...req.body, created_at: req.body?.created_at || new Date().toISOString() };
    const docRef = await db.collection('reviews').add(reviewData);
    delete cache.reviews[reviewData.product_id];
    return reply.code(201).send({ id: docRef.id, ...reviewData });
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

// ── Socket.IO Events ──────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);
  
  // Push initial status payloads immediately to the connecting client
  socket.emit('visitor_count_updated', activeVisitors.size);
  socket.emit('admin_presence_updated', getActiveAdminsCount());
  
  if (cache.products.length > 0)               socket.emit('products_changed', cache.products);
  if (cache.categories.length > 0)             socket.emit('categories_changed', cache.categories);
  if (cache.sellers.length > 0)                socket.emit('sellers_changed', cache.sellers);
  if (cache.orders.length > 0)                 socket.emit('orders_changed', cache.orders);
  if (Object.keys(cache.settings).length > 0)  socket.emit('settings_changed', cache.settings);
  
  socket.on('ping_keepalive', () => socket.emit('pong_keepalive'));
  socket.on('disconnect', () => console.log(`🔌 Socket disconnected: ${socket.id}`));
});

// ── Keep-Alive Self-Ping (prevents Render free-tier sleep) ────
const SELF_URL = process.env.SELF_URL || 'https://nodejs-backend-1-wle5.onrender.com';
setInterval(async () => {
  try {
    const r = await fetch(`${SELF_URL}/api/health`);
    console.log(`[Keep-Alive] Self-ping OK — ${r.status}`);
  } catch (e) { console.warn('[Keep-Alive] Self-ping failed:', e.message); }
}, 8 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────
try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log('===================================================');
  console.log('⚡ Kwabz Store API — Powered by Fastify');
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log('🛡️  Firestore Live-Sync active...');
  console.log('===================================================');
  setupBackgroundSync();
} catch (err) {
  console.error(err);
  process.exit(1);
}

// ── Graceful Shutdown ─────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  Object.values(unsubscribers).forEach(unsub => { if (typeof unsub === 'function') unsub(); });
  await fastify.close();
  process.exit(0);
});
