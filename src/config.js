// Central place for all tunables so they are easy to find and explain.
module.exports = {
  PORT: process.env.PORT || 3000,
  DB_PATH: process.env.DB_PATH || './data/typeahead.db',

  // Distributed cache (logical nodes routed by a consistent-hash ring)
  CACHE_NODES: 3,
  VNODES_PER_NODE: 150, // virtual nodes per logical node -> even key spread
  CACHE_TTL_MS: 5 * 60 * 1000, // entries expire after 5 minutes

  // Suggestions
  MAX_SUGGESTIONS: 10,
  CANDIDATE_POOL: 50, // rows pulled from SQLite before ranking

  // Batch (write-behind) writes
  BATCH_SIZE: 200, // flush once this many distinct queries are buffered
  FLUSH_INTERVAL_MS: 2000, // ...or every 2 seconds, whichever comes first
  MAX_PREFIX_INVALIDATE: 8, // longest prefix we invalidate per changed query

  // Trending (recency-aware ranking)
  TREND_HALF_LIFE_MS: 60 * 60 * 1000, // a trend score halves every hour
  TREND_ALPHA: 0.5, // 0 = pure recency, 1 = pure popularity

  // Dataset loader
  SEED_TARGET: 120000,

  // Metrics
  LATENCY_SAMPLES: 2000,
};
