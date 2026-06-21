// Simple load benchmark for the suggestions API, used to produce the performance
// report. Start the server first (`npm start`), then run `npm run bench`.
//
// It fires N suggestion requests over a mix of prefixes (so the cache warms up),
// measures client-side latency percentiles, then prints the server's own /stats
// (cache hit rate, DB reads/writes, write-reduction from batching).
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const REQUESTS = Number(process.env.REQUESTS || 5000);

const PREFIXES = ['a', 'ip', 'iph', 'mac', 'lap', 'be', 'best', 'how', 'buy', 'goa', 'pi', 'piz', 'jav', 'react', 'do', 'sam', 'air', 'on', 'che', 'rev'];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  console.log(`Benchmarking ${BASE} with ${REQUESTS} /suggest requests...\n`);
  const latencies = [];

  // Warm-up so the first-touch misses don't skew the numbers.
  for (const p of PREFIXES) await fetch(`${BASE}/suggest?q=${p}`).then((r) => r.json());

  const t0 = Date.now();
  for (let i = 0; i < REQUESTS; i++) {
    const p = PREFIXES[i % PREFIXES.length];
    const start = process.hrtime.bigint();
    const res = await fetch(`${BASE}/suggest?q=${p}`);
    await res.json();
    latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  const wall = (Date.now() - t0) / 1000;

  latencies.sort((a, b) => a - b);
  const throughput = Math.round(REQUESTS / wall);

  console.log('Client-side latency (ms):');
  console.log(`  p50 = ${percentile(latencies, 50).toFixed(3)}`);
  console.log(`  p95 = ${percentile(latencies, 95).toFixed(3)}`);
  console.log(`  p99 = ${percentile(latencies, 99).toFixed(3)}`);
  console.log(`  max = ${latencies[latencies.length - 1].toFixed(3)}`);
  console.log(`Throughput: ~${throughput} req/s (single client, ${wall.toFixed(1)}s)\n`);

  const stats = await fetch(`${BASE}/stats`).then((r) => r.json());
  console.log('Server /stats:');
  console.log(`  cache backend  : ${stats.cacheBackend}`);
  console.log(`  cache hit rate : ${(stats.hitRate * 100).toFixed(1)}%  (${stats.cacheHits} hits / ${stats.cacheMisses} misses)`);
  console.log(`  DB reads       : ${stats.dbReads}`);
  console.log(`  DB writes      : ${stats.dbWrites}  (from ${stats.searchesReceived} searches -> ${stats.writeReduction}x write reduction)`);
  console.log(`  server p50/p95/p99 (ms): ${stats.latencyMs.p50} / ${stats.latencyMs.p95} / ${stats.latencyMs.p99}`);
  console.log(`  cache node sizes: ${JSON.stringify(stats.cacheNodeSizes)}`);
}

main().catch((err) => {
  console.error('Benchmark failed (is the server running?):', err.message);
  process.exit(1);
});
