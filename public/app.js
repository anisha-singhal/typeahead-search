// Frontend logic: debounced suggestions with prefix highlighting, keyboard
// navigation, search submission, a live trending panel, and a system-stats bar.

const input = document.getElementById('search-input');
const form = document.getElementById('search-form');
const list = document.getElementById('suggestions');
const status = document.getElementById('status');
const response = document.getElementById('response');
const trendingList = document.getElementById('trending-list');
const statsEl = document.getElementById('stats');
const segButtons = document.querySelectorAll('.seg');

const DEBOUNCE_MS = 200;
let debounceTimer = null;
let activeIndex = -1; // highlighted suggestion for keyboard nav
let current = []; // current suggestion list
let mode = 'basic';

const SEARCH_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n);

// --- Suggestions -----------------------------------------------------------

function renderSuggestions(items, prefix) {
  current = items;
  activeIndex = -1;
  list.innerHTML = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.index = i;

    const icon = document.createElement('span');
    icon.className = 'q-icon';
    icon.innerHTML = SEARCH_ICON;

    // Show the typed prefix normally and bold the completion (Google-style).
    const text = document.createElement('span');
    text.className = 'q-text';
    const typed = document.createElement('span');
    typed.textContent = item.query.slice(0, prefix.length);
    const completion = document.createElement('b');
    completion.textContent = item.query.slice(prefix.length);
    text.append(typed, completion);

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = fmt(item.count);

    li.append(icon, text, count);
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep input focus so the form can submit
      submitSearch(item.query);
    });
    list.appendChild(li);
  }
}

function clearSuggestions() {
  current = [];
  activeIndex = -1;
  list.innerHTML = '';
}

async function fetchSuggestions(prefix) {
  if (!prefix.trim()) {
    clearSuggestions();
    status.textContent = '';
    return;
  }
  status.className = 'status';
  status.textContent = 'Searching…';
  try {
    const url = `/suggest?q=${encodeURIComponent(prefix)}&mode=${mode}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSuggestions(data.suggestions || [], data.query || '');
    if (data.suggestions.length) {
      status.innerHTML =
        `<span class="tag ${data.cache}">${data.cache}</span>` +
        `<span class="tag">${data.node}</span>` +
        `${data.suggestions.length} results · ${data.tookMs} ms`;
    } else {
      status.textContent = 'No matches';
    }
  } catch (err) {
    clearSuggestions();
    status.className = 'status error';
    status.textContent = `Could not load suggestions: ${err.message}`;
  }
}

function highlight(index) {
  const items = list.querySelectorAll('li');
  items.forEach((li, i) => li.classList.toggle('active', i === index));
  if (index >= 0 && current[index]) input.value = current[index].query;
}

// --- Search submission -----------------------------------------------------

async function submitSearch(query) {
  const q = (query || '').trim();
  if (!q) return;
  input.value = q;
  clearSuggestions();
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    response.className = 'response show';
    response.textContent = `Server response: "${data.message}" — recorded "${q}"`;
    // Counts only land after the next batch flush (every ~2s), so refresh once the
    // flush has had time to run. The periodic refresh below keeps it live after that.
    setTimeout(() => { loadTrending(); loadStats(); }, 2300);
  } catch (err) {
    response.className = 'response show';
    response.textContent = `Search failed: ${err.message}`;
  }
}

// --- Trending --------------------------------------------------------------

async function loadTrending() {
  try {
    const res = await fetch('/trending?limit=10');
    const data = await res.json();
    trendingList.innerHTML = '';
    const items = data.trending || [];
    trendingList.classList.toggle('empty', items.length === 0);
    for (const item of items) {
      const li = document.createElement('li');
      const q = document.createElement('span');
      q.className = 'q';
      q.textContent = item.query;
      const c = document.createElement('span');
      c.className = 'count';
      c.textContent = fmt(item.count);
      li.append(q, c);
      trendingList.appendChild(li);
    }
  } catch (err) {
    /* trending is non-critical */
  }
}

// --- System stats ----------------------------------------------------------

function statCard(value, label) {
  return `<div class="stat"><div class="v">${value}</div><div class="k">${label}</div></div>`;
}

async function loadStats() {
  try {
    const res = await fetch('/stats');
    const s = await res.json();
    statsEl.innerHTML =
      statCard(fmt(s.datasetSize), 'queries') +
      statCard(`${Math.round((s.hitRate || 0) * 100)}%`, 'cache hit rate') +
      statCard(`${s.writeReduction || 0}×`, 'write reduction') +
      statCard(`${s.latencyMs ? s.latencyMs.p95 : 0} ms`, 'p95 latency');
  } catch (err) {
    /* stats are non-critical */
  }
}

// --- Events ----------------------------------------------------------------

input.addEventListener('input', () => {
  clearTimeout(debounceTimer); // debounce so we don't hit the backend per keystroke
  const value = input.value;
  debounceTimer = setTimeout(() => fetchSuggestions(value), DEBOUNCE_MS);
});

input.addEventListener('keydown', (e) => {
  if (!current.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex = (activeIndex + 1) % current.length;
    highlight(activeIndex);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex = (activeIndex - 1 + current.length) % current.length;
    highlight(activeIndex);
  } else if (e.key === 'Escape') {
    clearSuggestions();
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const chosen = activeIndex >= 0 ? current[activeIndex].query : input.value;
  submitSearch(chosen);
});

segButtons.forEach((btn) =>
  btn.addEventListener('click', () => {
    segButtons.forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    mode = btn.dataset.mode;
    fetchSuggestions(input.value);
  })
);

// Initial load + keep the "live" trending panel and stats fresh.
loadTrending();
loadStats();
setInterval(() => { loadTrending(); loadStats(); }, 3000);

// Optional deep link: /?q=<prefix> prefills the box and shows suggestions.
const initialQuery = new URLSearchParams(location.search).get('q');
if (initialQuery) {
  input.value = initialQuery;
  input.focus();
  fetchSuggestions(initialQuery);
}
