# Search Typeahead

A search typeahead (autocomplete) system: as you type a prefix it suggests the most
popular matching queries, and submitting a search updates the popularity data.

## Setup

```bash
npm install
npm run load     # seed the dataset (~120k queries)
npm start        # http://localhost:3000
```

## Status

Work in progress. Implemented so far:

- SQLite store for query-count data
- Prefix range-scan for suggestions
- Dataset loader

More to come: distributed cache, trending searches, batch writes, and the web UI.
