// Recency-aware ranking. The basic typeahead sorts purely by all-time count;
// trending additionally rewards queries that were searched recently.
const { recentPool } = require('./db');
const { TREND_HALF_LIFE_MS, MAX_SUGGESTIONS } = require('./config');

// Decay a stored trend score to "now": it halves every half-life of inactivity,
// so a query that spiked only briefly fades instead of ranking forever.
function decayedScore(row, now, halfLifeMs = TREND_HALF_LIFE_MS) {
  const elapsed = now - row.last_searched;
  return row.trend_score * Math.pow(0.5, elapsed / halfLifeMs);
}

// Blend popularity and recency for a candidate pool. Both dimensions are min-max
// normalized within the pool so neither one dominates by raw scale.
//   alpha = 1 -> pure popularity, alpha = 0 -> pure recency.
function blendRank(rows, now, alpha, halfLifeMs, limit) {
  if (rows.length === 0) return [];
  const enriched = rows.map((r) => ({ ...r, recency: decayedScore(r, now, halfLifeMs) }));
  const maxCount = Math.max(...enriched.map((e) => e.count), 1);
  const maxRecency = Math.max(...enriched.map((e) => e.recency), 1e-9);
  for (const e of enriched) {
    e.score = alpha * (e.count / maxCount) + (1 - alpha) * (e.recency / maxRecency);
  }
  enriched.sort((a, b) => b.score - a.score || b.count - a.count);
  return enriched.slice(0, limit).map((e) => ({ query: e.query, count: e.count }));
}

// Global trending feed: queries with genuine recent activity, ranked by decay.
// Seed rows that were never searched have trend_score 0, so they are filtered out
// here — trending must reflect what people are searching *now*, not all-time hits.
function getTrending(db, now, limit = MAX_SUGGESTIONS, halfLifeMs = TREND_HALF_LIFE_MS) {
  const pool = recentPool(db, Math.max(200, limit * 10));
  const active = pool.filter((r) => decayedScore(r, now, halfLifeMs) > 1e-6);
  return blendRank(active, now, 0, halfLifeMs, limit); // alpha = 0 -> pure recency
}

module.exports = { decayedScore, blendRank, getTrending };
