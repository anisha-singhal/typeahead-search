// Cache-first suggestion read path.
const { normalize } = require('./normalize');
const { prefixSearch, prefixSearchByRecency } = require('./db');
const { blendRank } = require('./trending');
const { MAX_SUGGESTIONS, CANDIDATE_POOL, TREND_ALPHA, TREND_HALF_LIFE_MS } = require('./config');

// Basic ranking: rows already arrive sorted by count desc from SQLite.
function rankBasic(rows, limit) {
  return rows.slice(0, limit).map((r) => ({ query: r.query, count: r.count }));
}

// Drop duplicate queries, keeping the first occurrence.
function dedupeByQuery(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.query)) continue;
    seen.add(r.query);
    out.push(r);
  }
  return out;
}

// Read path:
//   1. normalize the prefix (empty -> no suggestions)
//   2. look in the cache node that owns this prefix
//   3. on a miss, range-scan SQLite, rank, then populate the cache (read-through)
async function getSuggestions(ctx, rawPrefix, mode = 'basic') {
  const prefix = normalize(rawPrefix);
  if (!prefix) return { prefix, mode, cache: 'skip', node: null, suggestions: [] };

  const useTrending = mode === 'trending';
  const key = `suggest:${useTrending ? 'trending' : 'basic'}:${prefix}`;

  const cached = await ctx.cache.get(prefix, key);
  if (cached.hit) {
    ctx.metrics.cacheHit();
    return { prefix, mode, cache: 'hit', node: cached.node, suggestions: cached.value };
  }
  ctx.metrics.cacheMiss();

  let suggestions;
  if (useTrending) {
    // Candidate pool = popular-by-count UNION recently-active-by-trend, so a query
    // that is surging right now can be promoted even if its all-time count is small.
    const byCount = prefixSearch(ctx.db, prefix, CANDIDATE_POOL);
    const byRecency = prefixSearchByRecency(ctx.db, prefix, CANDIDATE_POOL);
    ctx.metrics.dbRead();
    const pool = dedupeByQuery([...byRecency, ...byCount]);
    suggestions = blendRank(pool, Date.now(), TREND_ALPHA, TREND_HALF_LIFE_MS, MAX_SUGGESTIONS);
  } else {
    const rows = prefixSearch(ctx.db, prefix, CANDIDATE_POOL);
    ctx.metrics.dbRead();
    suggestions = rankBasic(rows, MAX_SUGGESTIONS);
  }

  const node = await ctx.cache.set(prefix, key, suggestions);
  return { prefix, mode, cache: 'miss', node, suggestions };
}

module.exports = { getSuggestions, rankBasic };
