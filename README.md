# Search Typeahead

A search typeahead (autocomplete) system, similar to the suggestion feature in search
engines and e-commerce sites. As you type a prefix it suggests the most popular matching
queries; submitting a search updates the popularity data. The backend focuses on how
query-count data is stored, how suggestions are served with low latency, how the cache is
distributed with **consistent hashing**, and how write pressure is reduced with **batch
writes**.

## Quick start

### Option A — Docker (runs the app + Redis together)

```bash
docker compose up --build
```

This starts Redis and the app (seeding the dataset on boot) on
<http://localhost:3000>, with the cache backed by Redis — `GET /stats` shows
`"cacheBackend":"redis"`.

### Option B — Node directly

```bash
npm install
npm run load     # seed the dataset (~120k queries) into SQLite
npm start        # serves the API + UI on http://localhost:3000
```

Without a running Redis, Option B uses the in-memory cache fallback (same consistent
hashing). To use Redis with Option B, start one first:
`docker run -d -p 6379:6379 redis:7-alpine`.

Then open <http://localhost:3000>, start typing, and submit a few searches to see
trending update.

## Screenshots

| Home (trending + live stats) | Suggestions as you type |
|------------------------------|-------------------------|
| ![Home](screenshots/landing.png) | ![Suggestions](screenshots/suggestions.png) |

## Tech stack

| Layer    | Choice                                  | Why |
|----------|-----------------------------------------|-----|
| Backend  | Node.js + Express                       | Simple, widely taught |
| Store    | SQLite (`better-sqlite3`)               | Durable, single file, no DB server to run |
| Cache    | Redis (3 logical nodes) + consistent hashing | Distributed cache, routed by a hash ring |
| Frontend | Vanilla HTML/CSS/JS                      | No build step, easy to read |

> **On the cache:** the cache is split into **3 logical nodes**, and a consistent-hash ring
> (`ring.js`) decides which node owns each prefix. The logical nodes are three Redis
> databases (`0`, `1`, `2`) on one Redis instance, each addressed by its own client. If
> Redis is not running, the app **automatically falls back to an in-process cache** using
> the same ring, so it still works with a single `npm start` — only the storage changes, the
> routing logic stays identical. `GET /stats` and `GET /cache/debug` report which backend is
> active (`redis` or `memory`).

### Running Redis (optional but recommended)

```bash
docker run -d --name typeahead-redis -p 6379:6379 redis:7-alpine
```

Then `npm start` will connect automatically. Without it, the in-memory fallback is used.

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
  virtual nodes per logical node; `cache.js` routes each prefix to its owning Redis node
  (DB 0/1/2). Entries expire after a TTL and are invalidated when counts change. Run
  `npm run hash-demo` to see the ring distribute keys and remap only ~1/N on node changes.
- **Trending searches** — `trending.js` blends all-time popularity with a time-decayed
  recency score (half-life 1 hour), so brief spikes fade instead of ranking forever.
- **Batch writes** — `batch.js` buffers searches in memory, aggregates repeats, and flushes
  to SQLite in a single transaction every 2 s or every 200 distinct queries. See `/stats`
  for the write-reduction factor.

## Dataset

`npm run load` generates a deterministic, Zipf-distributed dataset (~120k queries) from
category word lists, so the queries read like real search phrases and counts follow a
realistic 1/rank curve. Size is configurable: `node scripts/load-data.js --target 150000`.
It also marks a handful of queries as recently trending (e.g. `best pizza`, `goa trip`) so
the Trending feed is populated and the Popularity-vs-Trending toggle shows a difference
immediately — without that seed activity, a brand-new dataset has nothing trending yet, so
the two modes would look identical until you submit some searches.

## Project layout

```
src/
  config.js     all tunables
  normalize.js  prefix/query normalization
  db.js         SQLite schema, prefix range scan, batch transaction
  ring.js       consistent-hash ring (MD5 + virtual nodes)
  cache.js      Redis-backed logical cache nodes (in-memory fallback), routed by the ring
  suggest.js    cache-first read path + ranking
  trending.js   recency-aware ranking (decay + blend)
  batch.js      write-behind buffer + flush
  metrics.js    counters + latency percentiles
  server.js     Express routes
scripts/
  load-data.js  dataset generator
  benchmark.js  latency + cache + write-reduction load test  (npm run bench)
  hash-demo.js  consistent-hashing distribution demo          (npm run hash-demo)
public/         web UI (index.html, style.css, app.js)
docs/           ARCHITECTURE.md, PERFORMANCE.md
```

## Performance

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for measured latency (p50/p95/p99), cache hit
rate, and the batch write-reduction factor, plus sample consistent-hashing output.
