// 1001tracklists: how often DJs play a track, read from the site's own track
// search (the form on its home page). Each result carries the total number of
// tracklists the track appears in, plus its release date, genre and label.
// One search covers a whole page of results; single tracks are looked up
// slowly, one at a time, and remembered for a week. The site's per-track pages
// sit behind a human check, so nothing here reads them.

import { splitLabel, titleWords, artistSet, mixKey } from './util.js';
import { cacheGet, cacheSet } from './store.js';

const HOST = 'www.1001tracklists.com';
const GAP_MS = 2500;
const KEEP_MS = 7 * 86400000;
const KEEP_MISS_MS = 2 * 86400000;

const info = new Map();    // track key → { state: loading | done | none, plays, playsText, released, genre, label }
const pool = [];           // every result read this visit
const poolIds = new Set();
let off = '';              // why lookups stopped, when they have
let offUntil = 0;
let onChange = () => {};

export function setOnChange(fn) { onChange = fn; }
export const get = (t) => (t && info.get(t.k)) || null;
export const stopped = () => (off && Date.now() < offUntil ? off : '');

// "3k", "1.1k", "420" → a number
function count(text) {
  const m = /^([\d.,]+)\s*([km]?)$/i.exec((text || '').trim());
  if (!m) return 0;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * (m[2].toLowerCase() === 'k' ? 1000 : m[2].toLowerCase() === 'm' ? 1e6 : 1));
}

export function parse(html) {
  // The site's inline click handlers are dropped before parsing: they would never run here, only log.
  const doc = new DOMParser().parseFromString(html.replace(/\son[a-z]+="[^"]*"/gi, ''), 'text/html');
  const out = [];
  for (const el of doc.querySelectorAll('.bItm.oItm')) {
    const link = el.querySelector('.bTitle a[href^="/track/"]');
    if (!link) continue;
    const parts = splitLabel(link.textContent);
    if (!parts.title) continue;
    const text = (sel) => { const x = el.querySelector(sel); return x ? x.textContent.trim() : ''; };
    const playsText = text('[title="total tracklist plays"] span');
    out.push({
      id: el.getAttribute('data-id') || link.getAttribute('href'),
      title: titleWords(parts.title), mix: mixKey(parts.mix), artists: artistSet(parts.artist),
      plays: count(playsText), playsText: playsText || '0',
      released: (/\d{4}-\d{2}-\d{2}/.exec(text('[title="release date"]')) || [''])[0],
      genre: text('[title="genre"]'),
      label: text('.trackLabel a'),
    });
  }
  return out;
}

async function searchSite(q) {
  const res = await window.api.fetch(HOST, '/search/result.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'text/html, */*' },
    body: new URLSearchParams({ main_search: q, search_selection: '2', orderby: 'match' }).toString(),
  });
  if (!res.ok) {
    if (res.error === 'authoring-read-only') stop('1001tracklists is off while a coding session is building Crate', 600000);
    else if (res.error === 'write-not-granted') stop('Shim hasn\'t allowed Crate to search 1001tracklists', 600000);
    throw new Error(res.error || 'HTTP ' + res.status);
  }
  const html = res.text || '';
  if (!/bItm oItm|search result/i.test(html)) {
    stop(/turnstile|you will be forwarded/i.test(html) ? '1001tracklists is asking for a human check' : '1001tracklists\' search page changed, so Crate can\'t read it', 900000);
    throw new Error(off);
  }
  const found = parse(html);
  for (const it of found) if (!poolIds.has(it.id)) { poolIds.add(it.id); pool.push(it); }
  return found;
}

function stop(why, ms) { off = why; offUntil = Date.now() + ms; }

// The same recording: same title, same mix (an extended or original cut counts
// as the plain track), and at least one artist in common.
function match(t, items) {
  const title = titleWords(t.title), mix = mixKey(t.mix), artists = artistSet(t.artist);
  let best = null;
  for (const it of items) {
    if (it.title !== title || it.mix !== mix) continue;
    if (![...it.artists].some((a) => artists.has(a))) continue;
    if (!best || it.plays > best.plays) best = it;
  }
  return best;
}

function settle(t, it) {
  const v = it ? { state: 'done', plays: it.plays, playsText: it.playsText, released: it.released, genre: it.genre, label: it.label } : { state: 'none' };
  info.set(t.k, v);
  cacheSet('tl:' + t.k, { ...v, at: Date.now() });
  onChange(t.k);
}

// One search for what the user typed: every row it names gets its plays.
let priming = Promise.resolve();
export function prime(q, tracks) {
  priming = primeNow(q, tracks);
  return priming;
}
async function primeNow(q, tracks) {
  if (!q || stopped()) return;
  try { await searchSite(q); } catch { return; }
  for (const t of tracks()) {
    const have = info.get(t.k);
    if (have && have.state === 'done') continue;
    const it = match(t, pool);
    if (it) settle(t, it);
  }
}

// ---- single tracks, paced ------------------------------------------------------

const queue = [];
let running = false;
const checking = new Set(); // keys whose saved answer is being read
const unsaved = new Set();  // keys with no saved answer, so it is read once

// A saved answer that is still current: true when it filled the row in.
async function remembered(t) {
  if (unsaved.has(t.k)) return false;
  checking.add(t.k);
  const saved = await cacheGet('tl:' + t.k);
  checking.delete(t.k);
  if (saved && Date.now() - saved.at < (saved.state === 'done' ? KEEP_MS : KEEP_MISS_MS)) {
    if (!info.has(t.k)) { info.set(t.k, saved); onChange(t.k); }
    return true;
  }
  unsaved.add(t.k);
  return false;
}

// The rows on screen. `lookup` says which may cost a request of their own;
// asks for rows that scrolled away are dropped.
export async function want(tracks, lookup) {
  await priming;
  const keep = new Set(tracks.map((t) => t.k));
  for (let i = queue.length - 1; i >= 0; i--) if (!keep.has(queue[i].k)) { info.delete(queue[i].k); queue.splice(i, 1); }
  for (const t of tracks) {
    if (info.has(t.k) || checking.has(t.k) || !t.title) continue;
    const it = match(t, pool);
    if (it) { settle(t, it); continue; }
    if (!(await remembered(t)) && lookup(t) && !stopped() && !info.has(t.k)) {
      info.set(t.k, { state: 'loading' });
      onChange(t.k);
      queue.unshift(t);
    }
  }
  pump();
}

// One track, asked for by name (its details are open).
export async function ask(t) {
  if (!t || !t.title || info.has(t.k) || checking.has(t.k)) return;
  if ((await remembered(t)) || stopped() || info.has(t.k)) return;
  info.set(t.k, { state: 'loading' });
  onChange(t.k);
  queue.unshift(t);
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const t = queue.shift();
    if (stopped()) { info.delete(t.k); onChange(t.k); continue; }
    const lead = (t.artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\bvs\.?)\s*/i)[0].trim();
    try {
      await searchSite([lead, t.title.replace(/\[[^\]]*\]/g, '').trim()].filter(Boolean).join(' '));
      settle(t, match(t, pool));
    } catch {
      // Stopped lookups are asked again once they resume; a one-off failure isn't.
      if (stopped()) info.delete(t.k); else info.set(t.k, { state: 'error' });
      onChange(t.k);
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  running = false;
}

// ---- freshness -------------------------------------------------------------------

const DAY = 86400000;
export const FRESH = {
  upcoming: ['UPCOMING', 'Not released yet'],
  fresh: ['FRESH', 'Out under two months, and few DJs have it yet'],
  hot: ['HOT', 'Out under two months and already in a lot of sets'],
  peaking: ['PEAKING', 'Out under a year and in a lot of sets'],
  rinsed: ['RINSED', 'Everyone has played it'],
  classic: ['CLASSIC', 'Over five years old and still played'],
  sleeper: ['SLEEPER', 'Out a while, and almost nobody plays it'],
  steady: ['STEADY', 'Played now and then'],
};

// Where a track is in its life: how long it has been out against how many
// tracklists it is in. '' when there is too little to say.
export function freshness(t) {
  const v = get(t);
  const known = v && v.state === 'done';
  const released = t.released || (known ? v.released : '');
  const days = released ? (Date.now() - Date.parse(released)) / DAY : NaN;
  if (t.preorder || days < 0) return 'upcoming';
  if (!Number.isFinite(days)) return '';
  if (!known) return v && v.state === 'none' ? (days <= 60 ? 'fresh' : 'sleeper') : '';
  const plays = v.plays;
  if (days <= 60) return plays >= 30 ? 'hot' : 'fresh';
  if (plays >= 500 && days <= 5 * 365) return 'rinsed';
  if (days <= 365) return plays >= 100 ? 'peaking' : plays < 10 ? 'sleeper' : 'steady';
  if (days > 5 * 365 && plays >= 200) return 'classic';
  return plays < 10 ? 'sleeper' : 'steady';
}

export const plays = (t) => { const v = get(t); return v && v.state === 'done' ? v.plays : -1; };
