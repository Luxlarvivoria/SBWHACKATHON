// util.js — shared helpers: storage, fetching, formatting, DOM
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- settings (localStorage) ---------------- */
const SKEY = 'consilium.settings.v1';
const LKEY = 'consilium.library.v1';

export const settings = {
  get() {
    try { return { mailto: '', apiKey: '', useS2: false, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; }
    catch { return { mailto: '', apiKey: '', useS2: false }; }
  },
  set(patch) {
    const next = { ...settings.get(), ...patch };
    try { localStorage.setItem(SKEY, JSON.stringify(next)); } catch {}
    return next;
  },
};

export const library = {
  all() {
    try { return JSON.parse(localStorage.getItem(LKEY) || '[]'); } catch { return []; }
  },
  has(id) { return library.all().some((p) => p.id === id); },
  toggle(paper) {
    const list = library.all();
    const i = list.findIndex((p) => p.id === paper.id);
    if (i >= 0) list.splice(i, 1);
    else list.unshift({
      id: paper.id, title: paper.title, authors: (paper.authors || []).map((a) => a.name).slice(0, 8),
      year: paper.year, venue: paper.venue, doi: paper.doi, url: paper.url,
    });
    try { localStorage.setItem(LKEY, JSON.stringify(list.slice(0, 500))); } catch {}
    return i < 0;
  },
  remove(id) {
    const list = library.all().filter((p) => p.id !== id);
    try { localStorage.setItem(LKEY, JSON.stringify(list)); } catch {}
  },
};

/* ---------------- fetching ---------------- */
const cache = new Map();

export async function getJSON(url, { timeout = 15000, headers = {}, cacheKey } = {}) {
  const key = cacheKey || url;
  if (cache.has(key)) return cache.get(key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cache.set(key, data);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs promises, never rejects — returns {ok, value|error} per entry. */
export async function settle(tasks) {
  return Promise.all(
    tasks.map((p) => Promise.resolve(p).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )),
  );
}

/* ---------------- text ---------------- */
export function stripTags(html) {
  return String(html || '')
    .replace(/<jats:[^>]*>|<\/jats:[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rebuild an abstract from OpenAlex's inverted index. */
export function fromInverted(idx) {
  if (!idx) return '';
  const words = [];
  for (const [word, positions] of Object.entries(idx)) {
    for (const p of positions) words[p] = word;
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

const ABBREV = /\b(e\.g|i\.e|vs|et al|approx|cf|Fig|Dr|Prof|No|Eq|ca|resp)\.$/i;
const SPLIT = '';

export function sentences(text) {
  const parts = String(text || '')
    .replace(/([.!?])["')\]]?\s+(?=[A-Z(\d])/g, '$1' + SPLIT)
    .split(SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
  // re-join fragments that split on an abbreviation ("e.g." / "et al.")
  const out = [];
  for (const p of parts) {
    if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out.filter((s) => s.length > 12);
}

export const truncate = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1).trimEnd() + '…' : String(s || ''));

export function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function authorLine(authors, max = 4) {
  const names = (authors || []).map((a) => a.name).filter(Boolean);
  if (!names.length) return 'Unknown authors';
  if (names.length <= max) return names.join(', ');
  return names.slice(0, max).join(', ') + ` +${names.length - max} more`;
}

/** Content words from a query/title, for keyword matching. */
const STOP = new Set(('a an the of and or in on for to with by from is are was were be been do does did ' +
  'this that these those we our their its as at it not no but if then than there here how what which who whom ' +
  'study studies effect effects using based between among during into over under about can may might').split(' '));

export function keywords(text, max = 12) {
  const out = [];
  const seen = new Set();
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []) {
    if (STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** How many distinct content words the two texts actually share. */
export function sharedKeywords(a, b) {
  const A = new Set(keywords(a, 25));
  const seen = new Set();
  for (const w of keywords(b, 60)) if (A.has(w)) seen.add(w);
  return seen.size;
}

export function overlapScore(a, b) {
  const A = new Set(keywords(a, 25));
  const B = keywords(b, 40);
  if (!A.size || !B.length) return 0;
  let hit = 0;
  for (const w of B) if (A.has(w)) hit++;
  return hit / A.size;
}

/* ---------------- misc ---------------- */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

export const searchUrl = {
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  news: (q) => `https://news.google.com/search?q=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  scholar: (q) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`,
  podcast: (q) => `https://www.listennotes.com/search/?q=${encodeURIComponent(q)}&type=episode`,
  wikipedia: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
};
