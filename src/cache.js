// A distributed cache made of several logical nodes. A consistent-hash ring
// decides which node owns a given prefix, so a prefix's `basic` and `trending`
// entries always live on the same node and can be invalidated together.
//
// Each logical node here is an in-process Map (key -> { value, expiresAt }). In a
// real deployment each node would be a separate Redis instance addressed by the
// same ring; only the storage changes, the routing logic is identical.
const { HashRing } = require('./ring');
const { CACHE_NODES, VNODES_PER_NODE, CACHE_TTL_MS } = require('./config');

class DistributedCache {
  constructor(nodeCount = CACHE_NODES, ttlMs = CACHE_TTL_MS) {
    this.nodes = Array.from({ length: nodeCount }, (_, i) => `cache-node-${i}`);
    this.ring = new HashRing(this.nodes, VNODES_PER_NODE);
    this.stores = new Map(this.nodes.map((n) => [n, new Map()]));
    this.ttlMs = ttlMs;
  }

  // Which logical node owns this prefix? (the consistent-hash decision)
  nodeFor(prefix) {
    return this.ring.getNode(prefix);
  }

  // Returns { hit, node, value }. Expired entries are evicted lazily on read.
  get(prefix, key) {
    const node = this.nodeFor(prefix);
    const store = this.stores.get(node);
    const entry = store.get(key);
    if (!entry) return { hit: false, node, value: null };
    if (entry.expiresAt <= Date.now()) {
      store.delete(key); // lazy expiry
      return { hit: false, node, value: null, expired: true };
    }
    return { hit: true, node, value: entry.value };
  }

  set(prefix, key, value) {
    const node = this.nodeFor(prefix);
    this.stores.get(node).set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return node;
  }

  // Drop both ranking variants for a prefix from its owning node.
  invalidatePrefix(prefix) {
    const node = this.nodeFor(prefix);
    const store = this.stores.get(node);
    store.delete(`suggest:basic:${prefix}`);
    store.delete(`suggest:trending:${prefix}`);
  }

  // Entry count per node, used by /cache/debug and /stats to show distribution.
  sizes() {
    const out = {};
    for (const [node, store] of this.stores) out[node] = store.size;
    return out;
  }
}

module.exports = { DistributedCache };
