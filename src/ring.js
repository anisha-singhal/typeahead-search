// Consistent-hash ring used to decide which cache node owns a given prefix.
const crypto = require('crypto');
const { VNODES_PER_NODE } = require('./config');

// A 32-bit hash taken from the first 4 bytes of an MD5 digest (Ketama style).
function hash32(key) {
  return crypto.createHash('md5').update(key).digest().readUInt32BE(0);
}

// Each physical node is placed at many "virtual node" positions around the ring,
// so keys spread evenly and adding/removing a node only remaps about 1/N of keys.
class HashRing {
  constructor(nodes = [], vnodes = VNODES_PER_NODE) {
    this.vnodes = vnodes;
    this.points = []; // sorted array of { hash, node }
    for (const node of nodes) this._place(node);
    this._sort();
  }

  _place(node) {
    for (let i = 0; i < this.vnodes; i++) {
      this.points.push({ hash: hash32(`${node}#${i}`), node });
    }
  }

  _sort() {
    this.points.sort((a, b) => a.hash - b.hash);
  }

  addNode(node) {
    this._place(node);
    this._sort();
  }

  // Walk clockwise from the key's hash to the first virtual node (binary search).
  getNode(key) {
    if (this.points.length === 0) return null;
    const h = hash32(key);
    // Past the last point on the ring -> wrap around to the first.
    if (h > this.points[this.points.length - 1].hash) return this.points[0].node;

    let lo = 0;
    let hi = this.points.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid].hash >= h) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return this.points[ans].node;
  }
}

module.exports = { HashRing, hash32 };
