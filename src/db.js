// SQLite is the primary, durable store for query-count data.
// We use better-sqlite3 because it is synchronous and simple to reason about.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('./config');

function openDb(dbPath = DB_PATH) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // better concurrent read/write behaviour

  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      query         TEXT    PRIMARY KEY,
      count         INTEGER NOT NULL DEFAULT 0,
      last_searched INTEGER NOT NULL DEFAULT 0,
      trend_score   REAL    NOT NULL DEFAULT 0
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_queries_count ON queries(count DESC);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_queries_last ON queries(last_searched DESC);');
  return db;
}

// '￿' is effectively the largest UTF-16 code unit, so [prefix, prefix+￿)
// is the half-open range of every row whose key starts with `prefix`. Because
// `query` is the PRIMARY KEY this is a fast index range scan, not a full table scan.
function prefixRange(prefix) {
  return { lo: prefix, hi: prefix + '￿' };
}

// Range-scan candidates for a prefix, ordered by popularity. The ranking layer
// re-ranks this pool (basic = by count, trending = count blended with recency).
function prefixSearch(db, prefix, limit) {
  const { lo, hi } = prefixRange(prefix);
  return db
    .prepare(
      `SELECT query, count, last_searched, trend_score
         FROM queries
        WHERE query >= ? AND query < ?
        ORDER BY count DESC
        LIMIT ?`
    )
    .all(lo, hi, limit);
}

// Most recently active queries; the trending layer re-scores these with time decay.
function recentPool(db, limit) {
  return db
    .prepare(
      `SELECT query, count, last_searched, trend_score
         FROM queries
        ORDER BY last_searched DESC
        LIMIT ?`
    )
    .all(limit);
}

// Apply one batch of aggregated search counts in a single transaction.
// For each query we fold the *decayed* old trend score into the new one, so recent
// activity is rewarded without needing a separate background decay job.
function applyBatch(db, batch, now, halfLifeMs) {
  const get = db.prepare('SELECT trend_score, last_searched FROM queries WHERE query = ?');
  const upsert = db.prepare(
    `INSERT INTO queries (query, count, last_searched, trend_score)
     VALUES (@query, @count, @last, @trend)
     ON CONFLICT(query) DO UPDATE SET
       count         = count + @count,
       last_searched = @last,
       trend_score   = @trend`
  );

  const run = db.transaction((entries) => {
    for (const [query, delta] of entries) {
      const row = get.get(query);
      let trend = delta;
      if (row) {
        const elapsed = now - row.last_searched;
        const decayed = row.trend_score * Math.pow(0.5, elapsed / halfLifeMs);
        trend = decayed + delta;
      }
      upsert.run({ query, count: delta, last: now, trend });
    }
    return entries.length;
  });

  return run([...batch.entries()]);
}

// Bulk insert used only by the dataset loader.
function bulkInsert(db, rows) {
  const insert = db.prepare(
    `INSERT INTO queries (query, count, last_searched, trend_score)
     VALUES (?, ?, 0, 0)
     ON CONFLICT(query) DO UPDATE SET count = excluded.count`
  );
  const run = db.transaction((batch) => {
    for (const [query, count] of batch) insert.run(query, count);
  });
  run(rows);
}

function rowCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM queries').get().n;
}

module.exports = { openDb, prefixSearch, recentPool, applyBatch, bulkInsert, rowCount, prefixRange };
