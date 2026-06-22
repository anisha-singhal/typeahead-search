# Performance Report

Measurements from `npm run bench` (5,000 `/suggest` requests over a mix of prefixes) and
`npm run hash-demo`, on a local machine (macOS, Node.js, dataset of **120,000** queries).

Reproduce with:

```bash
npm run load && npm start          # terminal 1
npm run bench                      # terminal 2
npm run hash-demo                  # consistent-hashing demo
```

## Suggestion latency

| Metric | Client-side (incl. HTTP) | Server-side (`/stats`) |
|--------|--------------------------|------------------------|
| p50    | 0.089 ms                 | 0.002 ms               |
| p95    | 0.178 ms                 | 0.004 ms               |
| p99    | 0.294 ms                 | 0.007 ms               |
| max    | 3.67 ms                  | —                      |

Throughput: **~9,470 req/s** from a single client (5,000 requests in ~0.5 s).

The server-side numbers are the time spent in the suggestion read path itself; the
client-side numbers add Node's HTTP loopback overhead.

## Cache effectiveness

| Metric            | Value |
|-------------------|-------|
| Cache hit rate    | **99.6%** (4,980+ hits / ~20 misses) |
| DB reads (misses) | 20 — one range-scan per distinct prefix, then served from cache |
| Cache node sizes  | `{cache-node-0: 7, cache-node-1: 6, cache-node-2: 7}` |

After the first request for a prefix, every repeat is served from the cache node that owns
it, so the database is touched once per prefix regardless of traffic.

## Batch write reduction

| Metric              | Value |
|---------------------|-------|
| Searches received   | 90    |
| DB writes performed | 2     |
| **Write reduction** | **45×** |

90 searches across 2 distinct queries were aggregated into 2 row upserts (one per flush
window). Under heavier, repetitive traffic this factor grows — the buffer collapses all
repeats of a query within a flush window into a single `count += n`.

> **Cache backend note:** these numbers were captured with the in-process cache backend
> (the app falls back to it when Redis is not running). With Redis enabled the hit/miss
> logic and hit rate are identical; a localhost Redis adds roughly 0.1–0.5 ms per cached
> read for the network round-trip — still far below the suggestion budget. `GET /stats`
> reports which backend produced a given run (`cacheBackend: "redis" | "memory"`).

## Consistent-hashing behaviour (`npm run hash-demo`)

702 prefix keys, 150 virtual nodes per node:

```
3 nodes — key ownership:
  cache-node-0:  241 keys  (34.3%)
  cache-node-1:  246 keys  (35.0%)
  cache-node-2:  215 keys  (30.6%)

After adding cache-node-3:
  cache-node-0:  171 keys  (24.4%)
  cache-node-1:  195 keys  (27.8%)
  cache-node-2:  150 keys  (21.4%)
  cache-node-3:  186 keys  (26.5%)

Keys remapped when adding the 4th node: 186/702 (26.5%)
  ideal with consistent hashing ≈ 1/4 = 25%
  a naive  hash(key) % N  would remap ~75% of keys here.
```

Adding a node remaps only ~1/N of keys (26.5% ≈ the ideal 25%), versus ~75% for a naive
modulo scheme. This is the property that lets cache nodes be added or removed without
invalidating almost the entire cache.

## Verified on Redis (Docker)

Run with `docker compose up --build` (app + Redis). The cache then uses Redis as its
backend — confirmed end-to-end:

- `GET /stats` → `"cacheBackend":"redis"`, dataset 120,000 queries.
- Suggestion read path through Redis: first call **miss ≈ 2.88 ms**, immediate repeat **hit ≈ 0.81 ms**.
- `GET /cache/debug?prefix=mac` → `{"backend":"redis","node":"cache-node-1", ... "nodeSizes":{"cache-node-0":4,"cache-node-1":7,"cache-node-2":5}}`

The 3 logical nodes are Redis databases 0/1/2 on one instance, and the consistent-hash ring
distributes cached prefixes across them. Inspected with `redis-cli -n <db> KEYS '*'`:

```
DB 0 (cache-node-0) — 4 keys:  suggest:basic:cheap   suggest:basic:news    suggest:basic:buy    suggest:basic:goa
DB 1 (cache-node-1) — 7 keys:  suggest:basic:mac     suggest:basic:react   suggest:basic:ip     suggest:basic:gym ...
DB 2 (cache-node-2) — 5 keys:  suggest:basic:samsung suggest:basic:iph     suggest:basic:pizza  suggest:basic:a
```

This confirms the distributed cache and consistent-hash routing work against real Redis,
not only the in-memory fallback.
