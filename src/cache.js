// A distributed cache made of several logical nodes. A consistent-hash ring
// (ring.js) decides which node owns a given prefix, so a prefix's `basic` and
// `trending` entries always live on the same node and can be invalidated together.
//
// Primary backend is Redis: CACHE_NODES logical nodes map to Redis databases
// 0..N-1 on one instance (the same "logical nodes on one Redis" idea the reference
// repo uses). If Redis is not reachable, we fall back to an in-process map cache so
// the app still runs with a single `npm start`. The consistent-hash routing is
// identical for both backends — only the storage changes.
const { HashRing } = require('./ring');
const { CACHE_NODES, VNODES_PER_NODE, CACHE_TTL_MS } = require('./config');

// ---- In-process fallback cache -------------------------------------------
class MemoryCache {
  constructor(nodeCount = CACHE_NODES, ttlMs = CACHE_TTL_MS) {
    this.backend = 'memory';
    this.nodes = Array.from({ length: nodeCount }, (_, i) => `cache-node-${i}`);
    this.ring = new HashRing(this.nodes, VNODES_PER_NODE);
    this.stores = new Map(this.nodes.map((n) => [n, new Map()]));
    this.ttlMs = ttlMs;
  }

  nodeFor(prefix) {
    return this.ring.getNode(prefix);
  }

  get(prefix, key) {
    const node = this.nodeFor(prefix);
    const store = this.stores.get(node);
    const entry = store.get(key);
    if (!entry) return { hit: false, node, value: null };
    if (entry.expiresAt <= Date.now()) {
      store.delete(key); // lazy expiry
      return { hit: false, node, value: null };
    }
    return { hit: true, node, value: entry.value };
  }

  set(prefix, key, value) {
    const node = this.nodeFor(prefix);
    this.stores.get(node).set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return node;
  }

  invalidatePrefix(prefix) {
    const node = this.nodeFor(prefix);
    const store = this.stores.get(node);
    store.delete(`suggest:basic:${prefix}`);
    store.delete(`suggest:trending:${prefix}`);
  }

  sizes() {
    const out = {};
    for (const [node, store] of this.stores) out[node] = store.size;
    return out;
  }
}

// ---- Redis-backed distributed cache --------------------------------------
class RedisCache {
  constructor(clients, ttlMs = CACHE_TTL_MS) {
    this.backend = 'redis';
    this.nodes = clients.map((_, i) => `cache-node-${i}`);
    this.ring = new HashRing(this.nodes, VNODES_PER_NODE);
    this.clients = new Map(this.nodes.map((n, i) => [n, clients[i]])); // node -> redis client (DB i)
    this.ttlSec = Math.max(1, Math.round(ttlMs / 1000));
  }

  nodeFor(prefix) {
    return this.ring.getNode(prefix);
  }

  async get(prefix, key) {
    const node = this.nodeFor(prefix);
    try {
      const raw = await this.clients.get(node).get(key);
      if (raw == null) return { hit: false, node, value: null };
      return { hit: true, node, value: JSON.parse(raw) };
    } catch {
      // Degrade gracefully: a cache error is treated as a miss (falls back to DB).
      return { hit: false, node, value: null };
    }
  }

  async set(prefix, key, value) {
    const node = this.nodeFor(prefix);
    try {
      await this.clients.get(node).set(key, JSON.stringify(value), { EX: this.ttlSec });
    } catch {
      /* best-effort */
    }
    return node;
  }

  async invalidatePrefix(prefix) {
    const node = this.nodeFor(prefix);
    try {
      await this.clients.get(node).del([`suggest:basic:${prefix}`, `suggest:trending:${prefix}`]);
    } catch {
      /* best-effort */
    }
  }

  async sizes() {
    const out = {};
    for (const [node, client] of this.clients) {
      try { out[node] = await client.dbSize(); } catch { out[node] = null; }
    }
    return out;
  }

  async close() {
    for (const [, client] of this.clients) {
      try { await client.quit(); } catch { /* ignore */ }
    }
  }
}

// Try Redis first; fall back to the in-memory cache if it is unavailable.
async function createCache() {
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  let createClient;
  try {
    ({ createClient } = require('redis'));
  } catch {
    console.warn('[cache] redis module not installed; using in-memory cache.');
    return new MemoryCache();
  }

  const clients = [];
  try {
    for (let i = 0; i < CACHE_NODES; i++) {
      const client = createClient({
        url,
        database: i, // logical node i -> Redis DB i
        socket: { connectTimeout: 1500, reconnectStrategy: false },
      });
      client.on('error', () => {}); // handled via connect()/op try-catch
      await client.connect();
      clients.push(client);
    }
    console.log(`[cache] Redis connected: ${CACHE_NODES} logical nodes (DBs 0..${CACHE_NODES - 1}) @ ${url}`);
    return new RedisCache(clients, CACHE_TTL_MS);
  } catch (err) {
    for (const c of clients) { try { await c.disconnect(); } catch { /* ignore */ } }
    console.warn(`[cache] Redis unavailable (${err.message}); using in-memory cache.`);
    return new MemoryCache();
  }
}

module.exports = { createCache, MemoryCache, RedisCache };
