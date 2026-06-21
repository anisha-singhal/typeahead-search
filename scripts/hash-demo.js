// Demonstrates the consistent-hashing behaviour of the cache ring, satisfying the
// "logs or a short explanation showing consistent-hashing behavior" requirement.
//
//   node scripts/hash-demo.js
//
// It shows (1) how prefixes distribute across the cache nodes, and (2) that adding
// a node only remaps about 1/N of keys — the whole point of consistent hashing.
const { HashRing } = require('../src/ring');

// Build a realistic set of prefix keys: all 1- and 2-letter prefixes.
const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
const keys = [];
for (const a of letters) {
  keys.push(a);
  for (const b of letters) keys.push(a + b);
}

function distribution(ring, keys) {
  const dist = {};
  const owner = {};
  for (const k of keys) {
    const n = ring.getNode(k);
    dist[n] = (dist[n] || 0) + 1;
    owner[k] = n;
  }
  return { dist, owner };
}

function printDist(title, nodes, dist, total) {
  console.log(title);
  for (const n of nodes) {
    const c = dist[n] || 0;
    console.log(`  ${n}: ${String(c).padStart(4)} keys  (${((c / total) * 100).toFixed(1)}%)`);
  }
}

const before3 = ['cache-node-0', 'cache-node-1', 'cache-node-2'];
const ring3 = new HashRing(before3);
const r3 = distribution(ring3, keys);

console.log(`\nConsistent-hash ring — ${keys.length} prefix keys, 150 virtual nodes per node\n`);
printDist('3 nodes — key ownership:', before3, r3.dist, keys.length);

const after4 = [...before3, 'cache-node-3'];
const ring4 = new HashRing(after4);
const r4 = distribution(ring4, keys);

console.log('');
printDist('After adding cache-node-3:', after4, r4.dist, keys.length);

let moved = 0;
for (const k of keys) if (r3.owner[k] !== r4.owner[k]) moved++;
const pct = ((moved / keys.length) * 100).toFixed(1);

console.log(`\nKeys remapped when adding the 4th node: ${moved}/${keys.length} (${pct}%)`);
console.log('  ideal with consistent hashing ≈ 1/4 = 25%');
console.log('  a naive  hash(key) % N  would remap ~75% of keys here.');
console.log('\nThis is why adding/removing a cache node only disturbs a small slice of');
console.log('the cache instead of invalidating almost everything.\n');
