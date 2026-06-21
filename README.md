# Search Typeahead

A search typeahead (autocomplete) system, similar to the suggestion feature in search
engines and e-commerce sites. As you type a prefix it suggests the most popular matching
queries; submitting a search updates the popularity data. The backend focuses on how
query-count data is stored, how suggestions are served with low latency, how the cache is
distributed with **consistent hashing**, and how write pressure is reduced with **batch
writes**.

## Quick start

```bash
npm install
npm run load     # seed the dataset (~120k queries) into SQLite
npm start        # serves the API + UI on http://localhost:3000
```

Then open <http://localhost:3000>, start typing, and submit a few searches to see
trending update.

## Tech stack

| Layer    | Choice                                  | Why |
|----------|-----------------------------------------|-----|
| Backend  | Node.js + Express                       | Simple, widely taught |
| Store    | SQLite (`better-sqlite3`)               | Durable, single file, no DB server to run |
| Cache    | In-process logical nodes + consistent hashing | Distributed cache behaviour with zero external services |
| Frontend | Vanilla HTML/CSS/JS                      | No build step, easy to read |

> **On the cache:** the cache is split into several **logical nodes**, and a consistent-hash
> ring decides which node owns each prefix. Here each node is an in-process map so the
> project runs with a single `npm start`. In a production deployment each node would be a
> separate Redis instance addressed by the **same ring** — only the storage changes, the
> routing logic in `ring.js` stays identical.

## Architecture

```
 Browser (public/)
   │  GET /suggest        POST /search        GET /trending
   ▼
 Express (src/server.js)
   │                         │                    │
   ▼                         ▼                    ▼
 suggest.js               batch.js             trending.js
   │  cache-first            │  buffer +           │  decay +
   ▼                         ▼  flush              ▼  blend
 cache.js  ──ring.js──►  (logical nodes)        db.js (SQLite)
   │  consistent hashing                           ▲
   └───────────── miss → read ─────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design choices and trade-offs.

## API

| Method & path                         | Purpose                | Notes |
|---------------------------------------|------------------------|-------|
| `GET /suggest?q=<prefix>&mode=`       | Fetch suggestions      | `mode=basic` (default) or `mode=trending`; returns ≤10 sorted by count |
| `POST /search` `{ "query": "..." }`   | Record a search        | Returns `{ "message": "Searched" }` |
| `GET /trending?limit=N`               | Trending searches      | Ranked by recency-aware score |
| `GET /cache/debug?prefix=<prefix>`    | Inspect cache routing  | Shows the owning node and hit/miss |
| `GET /stats`                          | Performance report     | Cache hit rate, DB reads/writes, write-reduction, p50/p95/p99 |

Example:

```bash
curl "http://localhost:3000/suggest?q=iph"
# {"query":"iph","cache":"miss","node":"cache-node-2","tookMs":3.0,
#  "suggestions":[{"query":"iphone","count":100000}, ...]}

curl "http://localhost:3000/suggest?q=iph"     # again -> "cache":"hit", ~0.04 ms
```

## How each requirement is met

- **Typeahead suggestions** — `GET /suggest` normalizes the prefix, checks the owning cache
  node, and on a miss range-scans SQLite (`query >= prefix AND query < prefix+￿`), ranks the
  candidates, and populates the cache. Returns at most 10, sorted by count, handling empty /
  no-match / mixed-case input.
- **Search submission** — `POST /search` returns a dummy `{ "message": "Searched" }` and
  enqueues the query for a batched count update.
- **Query-count storage** — one SQLite table `queries(query PK, count, last_searched,
  trend_score)`.
- **Distributed cache + consistent hashing** — `ring.js` builds an MD5 hash ring with 150
  virtual nodes per logical node; `cache.js` routes each prefix to its owning node. Entries
  expire after a TTL and are invalidated when counts change.
- **Trending searches** — `trending.js` blends all-time popularity with a time-decayed
  recency score (half-life 1 hour), so brief spikes fade instead of ranking forever.
- **Batch writes** — `batch.js` buffers searches in memory, aggregates repeats, and flushes
  to SQLite in a single transaction every 2 s or every 200 distinct queries. See `/stats`
  for the write-reduction factor.

## Dataset

`npm run load` generates a deterministic, Zipf-distributed dataset (~120k queries) from
category word lists, so the queries read like real search phrases and counts follow a
realistic 1/rank curve. Size is configurable: `node scripts/load-data.js --target 150000`.

## Project layout

```
src/
  config.js     all tunables
  normalize.js  prefix/query normalization
  db.js         SQLite schema, prefix range scan, batch transaction
  ring.js       consistent-hash ring (MD5 + virtual nodes)
  cache.js      logical cache nodes routed by the ring
  suggest.js    cache-first read path + ranking
  trending.js   recency-aware ranking (decay + blend)
  batch.js      write-behind buffer + flush
  metrics.js    counters + latency percentiles
  server.js     Express routes
scripts/load-data.js   dataset generator
public/                web UI (index.html, style.css, app.js)
```
