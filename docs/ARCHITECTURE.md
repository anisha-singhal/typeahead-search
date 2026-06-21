# Architecture & Design Notes

This document explains the main design choices and the trade-offs behind them.

## Overview

```
                        ┌─────────────────────────────┐
   type "iph"  ───────► │  GET /suggest?q=iph         │
                        └──────────────┬──────────────┘
                                       ▼
                          ┌─────────────────────────┐
                          │  suggest.js (read path) │
                          └───────┬─────────────────┘
                                  │ 1. normalize prefix
                                  │ 2. ask the cache
                                  ▼
        ┌──────────────────────────────────────────────┐
        │  cache.js  +  ring.js  (consistent hashing)   │
        │   node = ring.getNode("iph")                  │
        │   ┌──────────┐ ┌──────────┐ ┌──────────┐      │
        │   │ node-0   │ │ node-1   │ │ node-2 ◄─┼─ owns │
        │   └──────────┘ └──────────┘ └──────────┘      │
        └───────────────┬──────────────────────────────┘
                 hit │   │ miss
            (return) │   ▼
                     │  db.js  range scan on PRIMARY KEY
                     │   query >= 'iph' AND query < 'iph￿'
                     │   ORDER BY count DESC LIMIT 50
                     │   ─► rank ─► populate cache ─► return
                     ▼
              ┌──────────────┐
   submit ──► │ POST /search │ ─► batch.js buffer ─► flush ─► SQLite
              └──────────────┘    (every 2s or 200 queries)
```

## 1. Storage: SQLite with a prefix range scan

- One table: `queries(query TEXT PRIMARY KEY, count, last_searched, trend_score)`.
- Suggestions use a **range scan on the primary key**: every query starting with `iph`
  lies in the half-open range `['iph', 'iph￿')`, because `￿` (U+FFFF) is effectively the
  largest UTF-16 code unit. This is an index range scan, not a full table scan.
- **Trade-off vs. a trie:** a trie gives O(prefix length) lookups but lives only in memory
  and must be rebuilt on restart. The SQLite range scan is slightly slower per query but is
  durable, trivial to reason about, and lets us count DB reads/writes for the report. The
  cache hides the per-query cost for popular prefixes anyway.

## 2. Distributed cache with consistent hashing

- The cache is several **logical nodes**. `ring.js` builds a hash ring: each node is placed
  at 150 **virtual node** positions (MD5 → 32-bit), and a key is owned by the first virtual
  node clockwise (found by binary search).
- **Why consistent hashing:** adding or removing a node only remaps about `1/N` of keys
  instead of reshuffling everything, and virtual nodes keep the load balanced.
- A prefix's `basic` and `trending` entries hash on the **prefix**, so they land on the same
  node and can be invalidated together.
- **Cache strategy:** read-through with a TTL (5 min). On a miss we read SQLite, rank, and
  populate the owning node. When a batch flush changes counts, we invalidate the affected
  prefixes so stale suggestions don't linger.
- **Why in-process maps instead of Redis:** the routing/ownership logic is what the
  assignment cares about, and it is identical whether a node is a local map or a remote Redis
  instance. Using maps keeps the project to a single `npm start` with no external services.
  Swapping in Redis means changing only the storage calls inside `cache.js`.

## 3. Trending: popularity blended with recency

- Each query keeps a `trend_score` that is increased on every batch flush and **decays
  exponentially** (half-life 1 hour). Decay is applied lazily using the time since
  `last_searched`, so no background timer is needed.
- The trending rank blends two min-max-normalized signals:
  `score = α · popularity + (1 − α) · recency`, with `α = 0.5` for the trending suggestion
  mode and `α = 0` (pure recency) for the global `/trending` feed.
- **Avoiding permanent over-ranking:** because the recency component decays, a query that
  was popular for only a short burst loses its boost within a few hours and drops back to
  its all-time-count position. The global feed also filters out queries with no recent
  activity, so seeded-but-never-searched rows never appear as "trending".
- **Trade-off:** lazy decay is cheap and good enough for a demo, but the score is only
  refreshed when a query is touched or read; it is an approximation, not a continuously
  exact value.

## 4. Batch (write-behind) writes

- `POST /search` does **not** write to SQLite. It pushes the query into an in-memory buffer
  (`Map<query, count>`) that aggregates repeats — 200 searches for the same query become a
  single `+200`.
- The buffer flushes when it reaches 200 distinct queries **or** every 2 seconds, whichever
  comes first, applying all upserts in one transaction.
- **Snapshot-then-swap:** the buffer is swapped for a fresh map before the (synchronous)
  flush, so searches arriving during a flush are never lost or double-counted. On error the
  snapshot is folded back in and retried on the next tick.
- **Failure trade-off:** the buffer is in process memory. If the app crashes before a flush,
  the searches in the current window are lost. This is an acceptable trade-off for
  popularity counts (which are approximate by nature) in exchange for far fewer DB writes —
  see the `writeReduction` figure in `/stats`. A durable queue (e.g. a write-ahead log or a
  message broker) would remove this risk at the cost of more moving parts.

## 5. Observability

`GET /stats` reports cache hit rate, DB reads/writes, the write-reduction factor
(searches ÷ DB writes), and p50/p95/p99 suggestion latency, so the performance claims can be
checked directly.
