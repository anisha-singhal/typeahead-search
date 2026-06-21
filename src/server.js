// Express server that wires the modules together and exposes the API.
const path = require('path');
const express = require('express');
const { openDb, rowCount } = require('./db');
const { DistributedCache } = require('./cache');
const { Metrics } = require('./metrics');
const { BatchWriter } = require('./batch');
const { getSuggestions } = require('./suggest');
const { getTrending } = require('./trending');
const { normalize } = require('./normalize');
const config = require('./config');

function createApp() {
  const db = openDb();
  const cache = new DistributedCache();
  const metrics = new Metrics();
  const ctx = { db, cache, metrics };
  const batch = new BatchWriter(ctx);
  batch.start();
  ctx.batch = batch;

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // GET /suggest?q=<prefix>&mode=basic|trending
  app.get('/suggest', (req, res) => {
    const start = process.hrtime.bigint();
    const mode = req.query.mode === 'trending' ? 'trending' : 'basic';
    const result = getSuggestions(ctx, req.query.q || '', mode);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    metrics.recordLatency(ms);
    res.json({
      query: result.prefix,
      mode: result.mode,
      cache: result.cache, // hit | miss | skip
      node: result.node,
      tookMs: Number(ms.toFixed(3)),
      suggestions: result.suggestions,
    });
  });

  // POST /search { "query": "..." } -> records the search, returns a dummy response
  app.post('/search', (req, res) => {
    const query = batch.enqueue(req.body && req.body.query);
    if (!query) return res.status(400).json({ message: 'query is required' });
    res.json({ message: 'Searched' });
  });

  // GET /trending?limit=10
  app.get('/trending', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || config.MAX_SUGGESTIONS, 50);
    res.json({ trending: getTrending(db, Date.now(), limit) });
  });

  // GET /cache/debug?prefix=<prefix> -> which node owns the prefix and hit/miss state
  app.get('/cache/debug', (req, res) => {
    const prefix = normalize(req.query.prefix || '');
    if (!prefix) return res.status(400).json({ message: 'prefix is required' });
    const basic = cache.get(prefix, `suggest:basic:${prefix}`);
    const trending = cache.get(prefix, `suggest:trending:${prefix}`);
    res.json({
      prefix,
      node: cache.nodeFor(prefix),
      basic: { cached: basic.hit },
      trending: { cached: trending.hit },
      nodeSizes: cache.sizes(),
    });
  });

  // GET /stats -> performance + cache + write-reduction report
  app.get('/stats', (req, res) => {
    res.json({
      datasetSize: rowCount(db),
      cacheNodes: cache.nodes,
      cacheNodeSizes: cache.sizes(),
      ...metrics.snapshot(),
    });
  });

  return { app, ctx, batch, db, cache };
}

function start() {
  const { app, batch, db, cache } = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(`Search typeahead running on http://localhost:${config.PORT}`);
    console.log(`Dataset rows: ${rowCount(db)} | cache nodes: ${cache.nodes.join(', ')}`);
  });

  const shutdown = () => {
    console.log('\nShutting down: flushing batch buffer...');
    batch.stop(); // final flush so no buffered searches are lost
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
