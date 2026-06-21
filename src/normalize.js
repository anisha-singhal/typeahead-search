// Normalize a query/prefix so stored queries and cache keys stay consistent
// (lower-case, trimmed, single-spaced). Handles empty/missing input gracefully.
function normalize(input) {
  if (typeof input !== 'string') return '';
  return input.toLowerCase().trim().replace(/\s+/g, ' ');
}

module.exports = { normalize };
