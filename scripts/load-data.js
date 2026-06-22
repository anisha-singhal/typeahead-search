// Seeds the SQLite store with a synthetic, Zipf-distributed query dataset.
//
//   node scripts/load-data.js                # default target (see config.SEED_TARGET)
//   node scripts/load-data.js --target 150000
//
// The dataset is built from category word lists so the queries read like real
// search phrases (e.g. "iphone", "iphone price", "buy iphone online"). Counts
// follow a 1/rank curve: a few very popular queries and a long tail of rare ones,
// which is what real search-popularity data looks like. It is fully offline and
// deterministic, so everyone who runs it gets the same dataset.
const { openDb, bulkInsert, rowCount } = require('../src/db');
const { SEED_TARGET } = require('../src/config');

// ~120 common words ordered roughly most-popular-first, so the most common
// queries get the highest counts.
const CATEGORIES = {
  tech: ['iphone', 'ipad', 'macbook', 'laptop', 'android', 'samsung', 'google', 'windows', 'linux', 'python', 'javascript', 'java', 'react', 'nodejs', 'docker', 'kubernetes', 'github', 'chatgpt', 'airpods', 'playstation'],
  brands: ['apple', 'sony', 'dell', 'hp', 'lenovo', 'asus', 'nike', 'adidas', 'puma', 'amazon', 'flipkart', 'netflix', 'spotify', 'youtube', 'instagram'],
  shopping: ['buy', 'best', 'cheap', 'price', 'review', 'deals', 'discount', 'offer', 'online', 'shop', 'order', 'sale', 'coupon', 'compare', 'top'],
  howto: ['how', 'what', 'why', 'when', 'where', 'guide', 'tutorial', 'tips', 'steps', 'example', 'meaning', 'definition', 'vs', 'near', 'me'],
  food: ['pizza', 'burger', 'pasta', 'sushi', 'coffee', 'tea', 'cake', 'chicken', 'salad', 'sandwich', 'noodles', 'biryani', 'paneer', 'momos', 'dosa'],
  travel: ['flight', 'hotel', 'tickets', 'trip', 'tour', 'beach', 'goa', 'manali', 'paris', 'london', 'tokyo', 'dubai', 'singapore', 'bali', 'mountain'],
  misc: ['weather', 'news', 'movie', 'song', 'game', 'cricket', 'football', 'stock', 'bitcoin', 'jobs', 'resume', 'course', 'college', 'exam', 'login'],
  more: ['gym', 'yoga', 'diet', 'protein', 'workout', 'recipe', 'salary', 'interview', 'internship', 'scholarship'],
};

function flattenWords() {
  return Object.values(CATEGORIES).flat();
}

// 1/rank^exp popularity curve. rank 0 -> ~100000, then it falls away quickly.
function zipfCount(rank, base = 100000, exp = 0.9) {
  return Math.max(1, Math.round(base / Math.pow(rank + 1, exp)));
}

function buildDataset(target) {
  const words = flattenWords();
  const rows = [];
  const seen = new Set();

  const push = (q) => {
    if (seen.has(q)) return false;
    seen.add(q);
    rows.push([q, zipfCount(rows.length)]); // rank = current length
    return rows.length >= target;
  };

  // 1-grams: single words (most popular)
  for (const w of words) if (push(w)) return rows;

  // 2-grams: "word word" (skip exact repeats so phrases read naturally)
  for (let i = 0; i < words.length; i++) {
    for (let j = 0; j < words.length; j++) {
      if (i === j) continue;
      if (push(`${words[i]} ${words[j]}`)) return rows;
    }
  }

  // 3-grams: long tail, avoiding adjacent repeated words
  for (let i = 0; i < words.length; i++) {
    for (let j = 0; j < words.length; j++) {
      if (j === i) continue;
      for (let k = 0; k < words.length; k++) {
        if (k === j) continue;
        if (push(`${words[i]} ${words[j]} ${words[k]}`)) return rows;
      }
    }
  }

  return rows;
}

// A few queries are marked as "recently trending" so the Trending feed is populated
// and the Popularity-vs-Trending toggle shows a visible difference out of the box
// (otherwise, on a brand-new dataset nothing has been searched yet, so the two modes
// are identical). These all exist as generated 2-grams.
const TRENDING_SEED = [
  'best pizza', 'goa trip', 'java tutorial', 'buy laptop', 'cheap flight',
  'react course', 'best laptop', 'paris hotel', 'gym workout', 'resume tips',
  'movie review', 'bitcoin price',
];

function seedTrending(db) {
  const now = Date.now();
  const update = db.prepare('UPDATE queries SET trend_score = ?, last_searched = ? WHERE query = ?');
  const run = db.transaction(() => {
    TRENDING_SEED.forEach((q, i) => update.run(200 - i * 12, now, q));
  });
  run();
}

function parseTarget() {
  const idx = process.argv.indexOf('--target');
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return SEED_TARGET;
}

function main() {
  const target = parseTarget();
  const db = openDb();

  console.log(`Generating synthetic dataset (~${target} queries)...`);
  const rows = buildDataset(target);

  console.log(`Inserting ${rows.length} rows...`);
  db.exec('DELETE FROM queries;'); // reset so counts stay deterministic across runs
  bulkInsert(db, rows);

  seedTrending(db);
  console.log(`Done. Dataset size: ${rowCount(db)} queries.`);
  console.log('Sample:', rows.slice(0, 3).map(([q, c]) => `${q} (${c})`).join(', '));
  console.log(`Seeded ${TRENDING_SEED.length} trending queries (e.g. "best pizza", "goa trip").`);
  db.close();
}

main();
