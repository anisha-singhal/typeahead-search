// Lightweight in-process counters + a latency ring buffer for the /stats report.
const { LATENCY_SAMPLES } = require('./config');

class Metrics {
  constructor(maxSamples = LATENCY_SAMPLES) {
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.dbReads = 0; // prefix range scans
    this.dbWrites = 0; // rows upserted by batch flushes
    this.searches = 0; // POST /search calls received
    this.batches = 0; // number of batch flushes
    this.latencies = [];
    this.maxSamples = maxSamples;
  }

  cacheHit() { this.cacheHits++; }
  cacheMiss() { this.cacheMisses++; }
  dbRead() { this.dbReads++; }
  searchReceived() { this.searches++; }
  batchFlushed(rows) { this.batches++; this.dbWrites += rows; }

  recordLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > this.maxSamples) this.latencies.shift();
  }

  percentile(p) {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Number(sorted[idx].toFixed(3));
  }

  snapshot() {
    const lookups = this.cacheHits + this.cacheMisses;
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRate: lookups ? Number((this.cacheHits / lookups).toFixed(3)) : 0,
      dbReads: this.dbReads,
      dbWrites: this.dbWrites,
      searchesReceived: this.searches,
      batchesFlushed: this.batches,
      // how many raw searches each actual DB write represents (batching payoff)
      writeReduction: this.dbWrites ? Number((this.searches / this.dbWrites).toFixed(2)) : 0,
      latencyMs: { p50: this.percentile(50), p95: this.percentile(95), p99: this.percentile(99) },
    };
  }
}

module.exports = { Metrics };
