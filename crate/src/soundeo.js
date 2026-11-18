// Soundeo: search through its own track listing (HTML, read with the user's
// session), previews from the sample URL on each result, and BPM / key from the
// per-track status JSON, fetched slowly for the rows on screen and cached.

import { parseLen, splitLabel, trackKey, keyFilterName, neighbours, cleanCamelot } from './util.js';
import { cacheGet, cacheSet } from './store.js';
import { openUrl } from './safe.js';

const HOST = 'soundeo.com';
export const ID = 'so';
export const NAME = 'Soundeo';

export function mediaPath(raw) {
  try {
    const u = new URL(raw, 'https://' + HOST);
    return '/_media/' + u.host + u.pathname + u.search;
  } catch { return ''; }
}

function listPath(q, filters, page) {
  const p = new URLSearchParams({
    availableFilter: '0', artistFilter: '', labelFilter: '', genreFilter: '', timeFilter: '0',
    bpmFilter: '', keyFilter: '', trackTypeFilter: '', searchFilter: q, page: String(page || 1),
  });
  if (filters.bpmLo || filters.bpmHi) p.set('bpmFilter', (filters.bpmLo || 0) + ',' + (filters.bpmHi || 260));
  if (filters.key) {
    const keys = filters.keyWide ? neighbours(filters.key) : [filters.key];
    p.set('keyFilter', keys.map(keyFilterName).filter(Boolean).join(','));
  }
  return '/list/tracks?' + p.toString();
}

function parseItem(el) {
  const link = el.querySelector('.info strong a');
  if (!link) return null;
  const { artist, title, mix } = splitLabel(link.textContent);
  if (!title) return null;
  const id = el.getAttribute('data-track-id') || '';
  const cover = el.querySelector('img.cover');
  const coverSrc = cover ? cover.getAttribute('src') || '' : '';
  const sample = el.querySelector('[data-track-url]');
  const audio = sample ? mediaPath(sample.getAttribute('data-track-url')) : '';
  const info = el.querySelector('.info');
  const infoText = info ? info.textContent : '';
  const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(infoText);
  const time = el.querySelector('.info time');
  const labelLink = [...el.querySelectorAll('.info span a')].find((a) => /labelFilter=\d/.test(a.getAttribute('href') || ''));
  const genreLink = [...el.querySelectorAll('.info span a')].find((a) => /genreFilter=\d/.test(a.getAttribute('href') || ''));
  const releaseLink = el.querySelector('.info span a[href^="/release/"]');
  return {
    k: trackKey(artist, title, mix),
    artist, title, mix,
    label: labelLink ? labelLink.textContent.trim() : '',
    release: releaseLink ? releaseLink.textContent.trim() : '',
    genre: genreLink ? genreLink.textContent.trim() : '',
    released: date ? date[1] : '',
    preorder: !!el.querySelector('.preorder-date'),
    len: time ? parseLen(time.textContent) : null,
    bpm: null, camelot: '',
    art50: coverSrc ? mediaPath(coverSrc) : '',
    art500: coverSrc ? mediaPath(coverSrc.replace(/-50\.jpg$/, '-500.jpg')) : '',
    sources: { so: { id, url: 'https://soundeo.com' + (link.getAttribute('href') || ''), audio, clip: true, favored: !!el.querySelector('button.favorites.favored') } },
  };
}

export async function search(q, filters) {
  const res = await window.api.fetch(HOST, listPath(q, filters, 1), {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html, */*' },
  });
  if (!res.ok) {
    const why = res.error || ('HTTP ' + res.status);
    throw new Error(res.status === 401 || res.status === 403 ? 'not signed in to Soundeo in Shim' : why);
  }
  const { tracks } = parseListing(res.text, 'results');
  return withCachedDetails(tracks);
}

function parseListing(html, what) {
  if (/id="login|name="password"/i.test(html) && !/trackitem/.test(html)) throw new Error('not signed in to Soundeo in Shim');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items = [...doc.querySelectorAll('.trackitem')];
  if (!items.length && !/trackitem|no tracks|nothing found|pagination/i.test(html)) throw new Error('Soundeo\'s ' + what + ' page changed, so Crate can\'t read it');
  return { doc, tracks: items.map(parseItem).filter(Boolean) };
}

// Apply cached details right away; the rest are looked up as rows show.
async function withCachedDetails(tracks) {
  await Promise.all(tracks.map(async (t) => {
    const d = await cacheGet('so:' + t.sources.so.id);
    if (d) Object.assign(t, d, { camelot: cleanCamelot(d.camelot) });
  }));
  return tracks;
}

// Your favorites, in Soundeo's order, following its pagination when there is
// more than one page.
export async function favorites() {
  const get = async (path) => {
    const res = await window.api.fetch(HOST, path, { headers: { Accept: 'text/html, */*' } });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'not signed in to Soundeo in Shim' : (res.error || 'HTTP ' + res.status));
    return parseListing(res.text, 'favorites');
  };
  const first = await get('/account/favorites');
  const pages = [...new Set([...first.doc.querySelectorAll('.pagination a[href]')]
    .map((a) => a.getAttribute('href'))
    .filter((href) => /^\/account\/favorites/.test(href) && /\d/.test(href)))].slice(0, 20);
  const all = first.tracks.slice();
  const seen = new Set(all.map((t) => t.sources.so.id));
  for (const path of pages) {
    const { tracks } = await get(path);
    for (const t of tracks) if (!seen.has(t.sources.so.id)) { seen.add(t.sources.so.id); all.push(t); }
  }
  return withCachedDetails(all);
}

// ---- fresh preview links ------------------------------------------------------

// preview.sndstatic.com links carry ?t=<unix expiry>; treat them as stale a
// minute early.
export function stale(src) {
  const m = /[?&]t=(\d{9,})/.exec(src || '');
  return !!m && Number(m[1]) * 1000 < Date.now() + 60000;
}

// Read the track's own page for a current preview link (falling back to a
// search by its title), and keep the new link on the track.
export async function freshAudio(track) {
  const so = track.sources && track.sources.so;
  if (!so || !so.id) return '';
  const pick = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const btns = [...doc.querySelectorAll('[data-track-url]')];
    const b = btns.find((x) => x.getAttribute('data-track-id') === so.id) || null;
    return b ? mediaPath(b.getAttribute('data-track-url')) : '';
  };
  let src = '';
  try {
    // Only the track's own page is ever asked for; anything else in a saved link is ignored.
    if (openUrl('so', so.url)) {
      const page = await window.api.fetch(HOST, new URL(so.url).pathname, { headers: { Accept: 'text/html, */*' } });
      if (page.ok) src = pick(page.text);
    }
    if (!src) {
      const res = await window.api.fetch(HOST, listPath(track.artist + ' ' + track.title, {}, 1), { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html, */*' } });
      if (res.ok) src = pick(res.text);
    }
  } catch { src = ''; }
  if (src) so.audio = src;
  return src;
}

// ---- details, paced ------------------------------------------------------------

const queue = [];
const pending = new Map(); // id → [resolve]
let running = false;
let pausedUntil = 0;
const GAP_MS = 700;

export function details(id) {
  if (!id) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (pending.has(id)) { pending.get(id).push(resolve); return; }
    pending.set(id, [resolve]);
    queue.unshift(id); // newest ask first: what's on screen now
    pump();
  });
}

// Drop asks for rows that scrolled away or belong to an old search.
export function keepOnly(ids) {
  const keep = new Set(ids);
  for (let i = queue.length - 1; i >= 0; i--) {
    const id = queue[i];
    if (!keep.has(id)) { queue.splice(i, 1); for (const r of pending.get(id) || []) r(null); pending.delete(id); }
  }
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const id = queue.shift();
    const waiters = pending.get(id) || [];
    pending.delete(id);
    let result = await cacheGet('so:' + id);
    if (result) result = { ...result, camelot: cleanCamelot(result.camelot) };
    else {
      result = await fetchDetails(id);
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    for (const r of waiters) r(result);
  }
  running = false;
}

// ♥ on Soundeo is a toggle: the site's own button posts an empty body to
// /tracks/favor/:id and reads the new state from `result`. Crate does the same,
// takes the answer as the truth, and never has two in flight for one track
// (a second would flip it straight back).
const favoring = new Set();

export async function toggleFavorite(id) {
  if (favoring.has(id)) return { ok: false, busy: true };
  favoring.add(id);
  try {
    const res = await window.api.fetch(HOST, '/tracks/favor/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: '',
    });
    if (!res.ok) return { ok: false, error: res.error || '', status: res.status };
    let j;
    try { j = JSON.parse(res.text); } catch { return { ok: false, error: 'Soundeo sent something Crate can\'t read' }; }
    if (!j || !j.success) return { ok: false, error: (j && j.flash && j.flash.message) || 'Soundeo said no' };
    return { ok: true, favored: j.result === 'favored' };
  } finally {
    favoring.delete(id);
  }
}

async function fetchDetails(id) {
  const res = await window.api.fetch(HOST, '/tracks/status/' + encodeURIComponent(id), {
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (res.status === 429 || res.status === 503) { pausedUntil = Date.now() + 30000; return null; }
  if (!res.ok) return null;
  try {
    const t = JSON.parse(res.text).track;
    if (!t) return null;
    const bpm = Number(t.bpm);
    const d = {
      bpm: Number.isFinite(bpm) && bpm >= 40 && bpm <= 250 ? bpm : null,
      camelot: cleanCamelot(t.key),
    };
    if (t.genre) d.genre = t.genre;
    if (t.label) d.label = t.label;
    if (t.date) d.released = t.date;
    await cacheSet('so:' + id, d);
    return d;
  } catch { return null; }
}
