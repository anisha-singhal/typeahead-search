// Write-behind buffer for search-count updates. Instead of writing to SQLite on
// every search, we aggregate counts in memory and flush them periodically (or when
// the buffer is full) in a single transaction. Repeated queries collapse to one row.
const { normalize } = require('./normalize');
const { applyBatch } = require('./db');
const { BATCH_SIZE, FLUSH_INTERVAL_MS, TREND_HALF_LIFE_MS, MAX_PREFIX_INVALIDATE } = require('./config');

class BatchWriter {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = new Map(); // query -> pending count
    this.timer = null;
    this.flushing = false;
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  // Called on every POST /search. Returns the normalized query (or null if empty).
  enqueue(rawQuery) {
    const query = normalize(rawQuery);
    if (!query) return null;
    this.buffer.set(query, (this.buffer.get(query) || 0) + 1);
    this.ctx.metrics.searchReceived();
    if (this.buffer.size >= BATCH_SIZE) this.flush();
    return query;
  }

  flush() {
    if (this.flushing || this.buffer.size === 0) return 0;
    this.flushing = true;

    // Snapshot-then-swap so searches arriving mid-flush are not lost or double counted.
    const snapshot = this.buffer;
    this.buffer = new Map();

    try {
      const rows = applyBatch(this.ctx.db, snapshot, Date.now(), TREND_HALF_LIFE_MS);
      this.ctx.metrics.batchFlushed(rows);
      for (const query of snapshot.keys()) this._invalidate(query);
      return rows;
    } catch (err) {
      // Fold the snapshot back in and retry on the next tick.
      for (const [q, delta] of snapshot) {
        this.buffer.set(q, (this.buffer.get(q) || 0) + delta);
      }
      console.error('[batch] flush failed, will retry:', err.message);
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  // Counts changed, so cached suggestions for this query's prefixes are now stale.
  _invalidate(query) {
    const upto = Math.min(query.length, MAX_PREFIX_INVALIDATE);
    for (let i = 1; i <= upto; i++) {
      this.ctx.cache.invalidatePrefix(query.slice(0, i));
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush(); // final flush so buffered searches are not lost on shutdown
  }
}

module.exports = { BatchWriter };
