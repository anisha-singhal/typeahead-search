// Frontend logic: debounced suggestions, keyboard navigation, search submission,
// and a trending panel. Talks to the backend on the same origin.

const input = document.getElementById('search-input');
const form = document.getElementById('search-form');
const list = document.getElementById('suggestions');
const status = document.getElementById('status');
const response = document.getElementById('response');
const trendingList = document.getElementById('trending-list');
const meta = document.getElementById('meta');

const DEBOUNCE_MS = 250;
let debounceTimer = null;
let activeIndex = -1; // highlighted suggestion for keyboard nav
let current = []; // current suggestion list

function selectedMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'basic';
}

// --- Suggestions -----------------------------------------------------------

function renderSuggestions(items) {
  current = items;
  activeIndex = -1;
  list.innerHTML = '';
  for (let i = 0; i < items.length; i++) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.index = i;
    li.innerHTML = `<span class="query"></span><span class="count"></span>`;
    li.querySelector('.query').textContent = items[i].query;
    li.querySelector('.count').textContent = items[i].count.toLocaleString();
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus so the form can submit
      submitSearch(items[i].query);
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
  status.classList.remove('error');
  status.textContent = 'Loading...';
  try {
    const url = `/suggest?q=${encodeURIComponent(prefix)}&mode=${selectedMode()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSuggestions(data.suggestions || []);
    status.textContent = data.suggestions.length
      ? `${data.suggestions.length} results · ${data.cache} · ${data.node} · ${data.tookMs} ms`
      : 'No matches';
  } catch (err) {
    clearSuggestions();
    status.classList.add('error');
    status.textContent = `Could not load suggestions: ${err.message}`;
  }
}

function highlight(index) {
  const items = list.querySelectorAll('li');
  items.forEach((li, i) => li.classList.toggle('active', i === index));
  if (index >= 0 && items[index]) {
    input.value = current[index].query;
  }
}

// --- Search submission -----------------------------------------------------

async function submitSearch(query) {
  const q = (query || '').trim();
  if (!q) return;
  input.value = q;
  clearSuggestions();
  response.textContent = '';
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    response.textContent = `Server response: "${data.message}" (recorded "${q}")`;
    // Counts update after the next batch flush; refresh trending shortly after.
    setTimeout(loadTrending, 600);
  } catch (err) {
    response.textContent = `Search failed: ${err.message}`;
  }
}

// --- Trending --------------------------------------------------------------

async function loadTrending() {
  try {
    const res = await fetch('/trending?limit=10');
    const data = await res.json();
    trendingList.innerHTML = '';
    for (const item of data.trending || []) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="q"></span><span class="count"></span>`;
      li.querySelector('.q').textContent = item.query;
      li.querySelector('.count').textContent = `(${item.count.toLocaleString()})`;
      trendingList.appendChild(li);
    }
  } catch (err) {
    // Trending is non-critical; leave the panel empty on failure.
  }
}

// --- Events ----------------------------------------------------------------

input.addEventListener('input', () => {
  clearTimeout(debounceTimer); // debounce so we don't call the backend per keystroke
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

document.querySelectorAll('input[name="mode"]').forEach((radio) =>
  radio.addEventListener('change', () => fetchSuggestions(input.value))
);

// Initial load
meta.textContent = 'GET /suggest · POST /search · GET /trending · GET /cache/debug · GET /stats';
loadTrending();
