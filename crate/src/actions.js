// What the user can do. Views and the keyboard both call these; every change
// ends in render().

import { S, render, toast } from './state.js';
import * as store from './store.js';
import * as player from './player.js';
import * as soundeo from './soundeo.js';
import * as soundcloud from './soundcloud.js';
import * as beatport from './beatport.js';
import * as youtube from './youtube.js';
import { collectionState, getCollection, loadCollection } from './collections.js';
import * as shared from './shared.js';
import * as links from './links.js';
import * as tracklists from './tracklists.js';
import { openUrl } from './safe.js';
import { versionKind, VERSION_GROUPS, titleWords, artistSet } from './util.js';

// ---- scope, rows, focus ------------------------------------------------------

export function scope() {
  if (S.view === 'list' && S.listId) return 'list:' + S.listId;
  if (S.view === 'source' && S.sourceId) return 'source:' + S.sourceId;
  return S.view;
}

const daysAgo = (iso) => (Date.now() - Date.parse(iso)) / 86400000;

export function visibleResults() {
  if (S.suggest) return suggested();
  const f = store.prefs.filters || {};
  const rows = sorted(S.results.filter((t) => {
    if (f.genre && t.genre !== f.genre) return false;
    if (f.days && (!t.released || daysAgo(t.released) > f.days)) return false;
    return true;
  }));
  if (!S.versions) return rows;
  // Versions of one track: only rows with its title, grouped by kind.
  const rank = Object.fromEntries(VERSION_GROUPS.map(([id], i) => [id, i]));
  return rows.map((t) => [t, versionKind(t, S.versions)]).filter(([, kind]) => kind)
    .map(([t, kind], i) => [t, rank[kind] * 1e4 + i]).sort((a, b) => a[1] - b[1]).map(([t]) => t);
}

// Find remixes, edits and bootlegs: search every source for the first artist
// and the title, then show only rows with that title.
// With { sc: true } only SoundCloud is asked, several ways, since that is
// where the unofficial ones live.
export function findVersions(t, opts = {}) {
  if (!t || !t.title) return;
  const lead = (t.artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\bvs\.?)\s*/i)[0].trim();
  const title = t.title.replace(/\[[^\]]*\]/g, '').trim();
  const q = [lead, title].filter(Boolean).join(' ');
  S.versions = { q, k: t.k, title: titleWords(t.title), artists: artistSet(t.artist), label: t.title + (t.artist ? ' · ' + t.artist : ''), sc: !!opts.sc, track: t };
  S.sel.clear();
  S.panel = false;
  S.focus.search = t.k;
  return runSearch(q, { versions: true, runs: opts.sc ? [['sc', () => soundcloud.versions(lead, title)]] : null });
}
export function clearVersions() { S.versions = null; render(); }
export const versionOf = (t) => (S.versions ? versionKind(t, S.versions) : '');

// A source's own list keeps the source's order unless you sort it.
export function collectionTracks() {
  return S.sourceId ? sorted(collectionState(S.sourceId).tracks) : [];
}

function sorted(rows) {
  const sort = store.prefs.sort;
  if (sort === 'plays') rows = rows.slice().sort((a, b) => tracklists.plays(b) - tracklists.plays(a));
  else if (sort === 'newest') rows = rows.slice().sort((a, b) => (b.released || '').localeCompare(a.released || ''));
  else if (sort === 'bpm') rows = rows.slice().sort((a, b) => (a.bpm || 999) - (b.bpm || 999));
  return rows;
}

// Rows of the current list in screen order: { k, track, entry? }.
export function rows() {
  if (S.view === 'search') return visibleResults().map((t) => ({ k: t.k, track: t }));
  if (S.view === 'source') return collectionTracks().map((t) => ({ k: t.k, track: t }));
  if (S.view === 'list') {
    const p = store.getList(S.listId);
    if (!p) return [];
    const entries = p.kind === 'playlist' && S.groupByColour ? groupedEntries(p) : p.entries;
    return entries.map((e) => ({ k: e.k, track: e.track, entry: e }));
  }
  if (S.view === 'library') return libraryLists().map((p) => ({ k: p.id, list: p }));
  if (S.view === 'activity') { const { fresh, old } = activityItems(); return [...fresh, ...old].map((a) => ({ k: 'a' + a.id, activity: a })); }
  return [];
}

export function groupedEntries(p) {
  const order = (c) => (c ? c : 99);
  return p.entries.slice().sort((a, b) => order(a.color) - order(b.color));
}

export function libraryLists() {
  const all = store.allLists();
  if (S.libFilter === 'playlists') return all.filter((p) => p.kind === 'playlist');
  if (S.libFilter === 'sets') return all.filter((p) => p.kind === 'set');
  if (S.libFilter === 'shared') return all.filter((p) => p.shared && p.owner !== store.me());
  return all.filter((p) => p.kind === 'playlist').concat(all.filter((p) => p.kind === 'set'));
}

export function focusKey() {
  const list = rows();
  const k = S.focus[scope()];
  if (k && list.some((r) => r.k === k)) return k;
  return list.length ? list[0].k : null;
}

export function focusedRow() {
  const k = focusKey();
  return rows().find((r) => r.k === k) || null;
}

export function setFocus(k, opts = {}) {
  const sc = scope();
  if (opts.extend) {
    const list = rows().map((r) => r.k);
    const from = S.anchor && list.includes(S.anchor) ? S.anchor : focusKey();
    S.anchor = from;
    const a = list.indexOf(from), b = list.indexOf(k);
    S.sel = new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (!opts.keepSel) {
    S.sel.clear();
    S.anchor = null;
  }
  S.focus[sc] = k;
  render('focus');
}

export function moveFocus(delta, opts = {}) {
  const list = rows();
  if (!list.length) return;
  const i = Math.max(0, list.findIndex((r) => r.k === focusKey()));
  const j = Math.max(0, Math.min(list.length - 1, i + delta));
  setFocus(list[j].k, opts);
}

// The rows an action applies to: the selection, else the focused row.
export function targets() {
  const list = rows();
  if (S.sel.size) return list.filter((r) => S.sel.has(r.k));
  const r = list.find((x) => x.k === focusKey());
  return r ? [r] : [];
}

// ---- navigation --------------------------------------------------------------

export function go(view, id) {
  S.view = view;
  S.listId = view === 'list' ? id : null;
  S.sourceId = view === 'source' ? id : null;
  S.sel.clear();
  S.anchor = null;
  S.overlay = null;
  if (view !== 'search' && view !== 'list' && view !== 'source') S.panel = false;
  render();
  if (view === 'source') loadCollection(id);
}
export const openSource = (id) => go('source', id);

// The feed: what friends did since you last looked, grouped by playlist, then
// the recent history you've seen.
export function activityItems() {
  const seen = store.prefs.seenActivity || 0;
  const mine = (a) => a.actor === store.me();
  const items = shared.activity.slice().reverse();
  const fresh = items.filter((a) => a.id > seen && !mine(a));
  const order = [...new Set(fresh.map((a) => a.listId || ''))];
  fresh.sort((a, b) => order.indexOf(a.listId || '') - order.indexOf(b.listId || '') || b.id - a.id);
  const old = items.filter((a) => !(a.id > seen && !mine(a))).slice(0, 60);
  return { fresh, old };
}

export function markSeen() {
  const last = shared.activity[shared.activity.length - 1];
  if (last) { store.prefs.seenActivity = last.id; store.savePrefs(); }
  render();
}

// Open what an activity item is about: the playlist, focused on its track.
export function openActivity(a) {
  if (a && a.verb === 'track-noted' && a.detail && a.detail.title) { go('search'); runSearch(a.detail.title); return; }
  if (!a || !a.listId || !store.getList(a.listId)) return;
  go('list', a.listId);
  if (a.k) { S.focus['list:' + a.listId] = a.k; if (a.verb === 'commented') S.panel = true; render(); }
}
export const refreshSource = () => { if (S.sourceId) loadCollection(S.sourceId, true); };
export const openList = (id) => go('list', id);

// ---- search ------------------------------------------------------------------

let searchSeq = 0;

export async function runSearch(q, opts = {}) {
  q = (q || '').trim();
  if (S.versions && !opts.versions && S.versions.q !== q) S.versions = null;
  S.suggest = null;
  rerun = () => runSearch(q, opts);
  S.q = q;
  if (store.prefs.lastQ !== q) { store.prefs.lastQ = q; store.savePrefs(); }
  if (!q) { S.results = []; S.searched = false; render(); return; }
  const seq = ++searchSeq;
  S.view = 'search';
  S.searching = true;
  S.searched = true;
  S.results = [];
  raw.clear();
  // Every source fans out at once; each merges in as it answers.
  const all = [
    ['so', () => soundeo.search(q, store.prefs.filters || {})],
    ['sc', () => soundcloud.search(q)],
    ['bp', () => beatport.search(q)],
    ['yt', () => youtube.search(q)],
  ];
  const runs = opts.runs || all;
  for (const [id] of all) S.sources[id] = { state: runs.some((r) => r[0] === id) ? 'loading' : 'idle', count: 0, error: '' };
  render();
  // One ask covers the page: how often DJs play what this search finds.
  tracklists.prime(q, () => S.results);
  await Promise.all(runs.map(async ([id, run]) => {
    try {
      const found = await run();
      if (seq !== searchSeq) return;
      S.results = merge(S.results, found, id);
      S.sources[id] = { state: 'done', count: found.length, error: '' };
    } catch (e) {
      if (seq !== searchSeq) return;
      S.sources[id] = { state: 'error', count: 0, error: e.message || String(e) };
    }
    render();
  }));
  if (seq !== searchSeq) return;
  S.searching = false;
  render();
}

// Results merge by identity: a track found again gains that source's chip.
// The same recording, three ways: ISRC (Beatport, SoundCloud), the preview
// file (Soundeo's previews are Beatport's samples), else artist / title / mix.
const sampleOf = (t) => {
  const s = (t.sources.so && t.sources.so.audio) || (t.sources.bp && t.sources.bp.audio) || '';
  return /geo-samples\.beatport\.com/.test(s) ? s.split('?')[0] : '';
};

// Fixes win over guesses: a source track split from a row never joins it, and
// one marked the same as a row's track joins it even when nothing matches.
// A split-off row whose artist / title / mix key is taken gets its own key;
// a source's own duplicate listings of a recording collapse into one.
function merge(into, found, source) {
  const byKey = new Map(), byIsrc = new Map(), bySample = new Map();
  const index = (t) => {
    byKey.set(t.k, t);
    if (t.isrc) byIsrc.set(t.isrc, t);
    const s = sampleOf(t);
    if (s) bySample.set(s, t);
  };
  into.forEach(index);
  for (const t of found) {
    const ref = links.refOf(source, t.sources[source]);
    raw.set(ref, t);
    const fits = (x) => x && !x.sources[source] && !links.splitFrom(x, ref);
    const pick = (x, why) => (fits(x) ? [x, why] : null);
    const guess = (t.isrc && pick(byIsrc.get(t.isrc), 'isrc'))
      || (sampleOf(t) && pick(bySample.get(sampleOf(t)), 'preview'))
      || pick(byKey.get(t.k), 'name')
      || [null, ''];
    // A second listing of a recording a row already has from this source (a
    // re-release, a compilation) adds nothing: keep the first.
    const again = (t.isrc && byIsrc.get(t.isrc)) || (sampleOf(t) && bySample.get(sampleOf(t))) || byKey.get(t.k);
    if (again && again.sources[source] && !links.splitFrom(again, ref) && again.sources[source].id !== t.sources[source].id) continue;
    const fixed = ref ? pick(into.find((x) => links.sameAs(x, ref)), 'fix') : null;
    const [have, why] = fixed && fixed[0] !== guess[0] ? fixed : guess;
    if (have) { absorb(have, t, source, why); index(have); }
    else {
      const row = { ...t, sources: { ...t.sources }, matchedBy: {} };
      if (byKey.has(row.k)) row.k = t.k + '~' + ref;
      index(row); into.push(row);
    }
  }
  return into;
}

function absorb(have, t, source, why) {
  have.sources = { ...have.sources, [source]: t.sources[source] };
  have.matchedBy = { ...(have.matchedBy || {}), [source]: why };
  // Beatport's metadata is the cleanest; it fills gaps and corrects guesses.
  for (const f of ['bpm', 'camelot', 'label', 'genre', 'released', 'len', 'art50', 'art500', 'isrc']) {
    if (t[f] && (!have[f] || (source === 'bp' && (f === 'bpm' || f === 'camelot')) || (f === 'bpm' && have.bpmGuess))) have[f] = t[f];
  }
  if (source === 'bp' || (t.bpm && !t.bpmGuess)) have.bpmGuess = false;
}

// Each source's own track as it arrived, by ref, so a split can rebuild it.
const raw = new Map();

player.setResolver({
  stale: (src) => soundeo.stale(src) || soundcloud.stale(src),
  fresh: async (t) => {
    const a = player.audioOf(t);
    const src = a && a.source === 'sc' ? await soundcloud.freshAudio(t) : await soundeo.freshAudio(t);
    // Saved entries keep the placeholder, never a signed link that expires.
    if (src && a && a.source !== 'sc') store.refreshTrack(t);
    return src;
  },
});
player.setWaveProvider((t, bins) => soundcloud.waveform(t, bins));
// A BPM measured from the audio fills an empty one, marked as a guess.
player.setTempoSink((t, bpm) => {
  if (t.bpm) return;
  t.bpm = bpm;
  t.bpmGuess = true;
  t.bpmFrom = 'audio';
  store.refreshTrack(t);
  render('row:' + t.k);
});

let rerun = null;
export function retrySources() { if (rerun) rerun(); }

// ---- suggestions for a playlist ----------------------------------------------------
// More from the artists and labels a playlist already holds, kept to its
// tempo and genres: a track outside the playlist's BPM range is never
// suggested, one with no known BPM only when Soundeo's own BPM filter let it
// through, and one filed under a genre the playlist doesn't hold never.

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const top = (names, n) => [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name]) => name);
const artistNames = (t) => (t.artist || '').replace(/\s*[([]?\b(feat\.?|ft\.?|featuring)\s+.*$/i, '').split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);

function profile(p) {
  const bpms = p.entries.map((e) => e.track.bpm).filter(Boolean).sort((a, b) => a - b);
  if (bpms.length < 3) return null;
  const lo = bpms[Math.floor((bpms.length - 1) * 0.1)] - 3, hi = bpms[Math.ceil((bpms.length - 1) * 0.9)] + 3;
  const artists = new Map(), labels = new Map(), genres = new Map();
  const bump = (m, name) => { if (name) m.set(name, (m.get(name) || 0) + 1); };
  for (const e of p.entries) {
    artistNames(e.track).forEach((a) => bump(artists, a));
    bump(labels, e.track.label);
    bump(genres, e.track.genre);
  }
  // Drum & bass is listed at 87 on one site and 174 on another: ask for both.
  const alt = hi <= 100 ? [lo * 2, hi * 2] : lo >= 140 ? [Math.floor(lo / 2), Math.ceil(hi / 2)] : null;
  return { lo, hi, alt, artists: top(artists, 5), labels: top(labels, 2), genres: top(genres, 2), allGenres: [...genres.keys()] };
}

// Half and double time count as the same tempo (87 is 174).
const inTempo = (bpm, s) => [bpm, bpm * 2, bpm / 2].some((b) => b >= s.lo && b <= s.hi);
// A track filed under a genre the playlist doesn't hold is left out too, so
// a house record at an odd tempo never lands in a drum & bass playlist.
const inGenre = (t, s) => !t.genre || !s.allGenres.length || s.allGenres.includes(t.genre);

function suggested() {
  const s = S.suggest;
  const p = store.getList(s.listId);
  const have = new Set(p ? p.entries.map((e) => e.k) : []);
  const names = new Set(s.artists.map((a) => a.toLowerCase()));
  const score = (t) => artistNames(t).filter((a) => names.has(a.toLowerCase())).length * 2 + (s.labels.includes(t.label) ? 1 : 0) + (s.genres.includes(t.genre) ? 1 : 0);
  const rows = S.results.filter((t) => !have.has(t.k) && inGenre(t, s) && (t.bpm ? inTempo(t.bpm, s) : t.tempoChecked));
  if (store.prefs.sort !== 'relevance') return sorted(rows);
  return rows.map((t) => [t, score(t)]).sort((a, b) => b[1] - a[1] || (b[0].released || '').localeCompare(a[0].released || '')).map(([t]) => t);
}

export async function suggestFor(listId) {
  const p = store.getList(listId);
  if (!p) return;
  const prof = profile(p);
  if (!prof) { toast('Suggestions need at least 3 tracks with a BPM in this playlist', 'warn'); return; }
  const seq = ++searchSeq;
  rerun = () => suggestFor(listId);
  S.versions = null;
  S.suggest = { listId, name: p.name, ...prof };
  S.q = '';
  S.view = 'search';
  S.listId = null;
  S.sel.clear();
  S.panel = false;
  S.searching = true;
  S.searched = true;
  S.results = [];
  raw.clear();
  const jobs = [
    ['so', async (q) => {
      const found = await soundeo.search(q, { bpmLo: prof.lo, bpmHi: prof.hi });
      if (!prof.alt) return found;
      await pause(400);
      return found.concat(await soundeo.search(q, { bpmLo: prof.alt[0], bpmHi: prof.alt[1] }));
    }],
    ['bp', (q) => beatport.search(q)],
  ];
  for (const id of Object.keys(S.sources)) S.sources[id] = { state: jobs.some((j) => j[0] === id) ? 'loading' : 'idle', count: 0, error: '' };
  render();
  const asks = [...prof.artists, ...prof.labels];
  await Promise.all(jobs.map(async ([id, run]) => {
    const seen = new Set();
    let n = 0, error = '';
    for (const q of asks) {
      try {
        const found = (await run(q)).filter((t) => !seen.has(t.sources[id].id) && (t.bpm ? inTempo(t.bpm, prof) : id === 'so'));
        if (seq !== searchSeq) return;
        for (const t of found) { seen.add(t.sources[id].id); if (id === 'so') t.tempoChecked = true; }
        S.results = merge(S.results, found, id);
        n += found.length;
        S.sources[id] = { state: 'loading', count: n, error: '' };
        render();
      } catch (e) {
        error = e.message || String(e);
      }
      await pause(400);
    }
    if (seq !== searchSeq) return;
    S.sources[id] = n || !error ? { state: 'done', count: n, error: '' } : { state: 'error', count: 0, error };
  }));
  if (seq !== searchSeq) return;
  S.searching = false;
  render();
}

// Look up BPM / key for the rows on screen, slowly, and fill them in place.
export function enrich(keys) {
  const pool = rows().map((r) => r.track).filter(Boolean);
  // Released tracks are worth a lookup of their own; an upload that is only on
  // SoundCloud or YouTube gets one when its details are open.
  const shown = pool.filter((t) => keys.includes(t.k));
  const open = S.panel ? focusKey() : null;
  tracklists.want(shown, (t) => S.view === 'list' || !!(t.sources.so || t.sources.bp) || t.k === open);
  if (S.view === 'list') return;
  const wanted = pool.filter((t) => keys.includes(t.k) && !t.camelot && !t.enriching && t.sources.so);
  soundeo.keepOnly(pool.filter((t) => keys.includes(t.k)).map((t) => t.sources.so && t.sources.so.id).filter(Boolean));
  // Each ask goes to the front of the queue, so ask bottom-up to fill rows top-down.
  for (const t of wanted.slice().reverse()) {
    t.enriching = true;
    soundeo.details(t.sources.so.id).then((d) => {
      t.enriching = false;
      if (!d) return;
      Object.assign(t, d);
      store.refreshTrack(t);
      render('row:' + t.k);
    });
  }
}

export function cycleSort() {
  const order = ['relevance', 'newest', 'bpm', 'plays'];
  store.prefs.sort = order[(order.indexOf(store.prefs.sort) + 1) % order.length];
  store.savePrefs();
  render();
}
export function setSort(s) { store.prefs.sort = s; store.savePrefs(); render(); }

export function setFilters(next) {
  const before = store.prefs.filters || {};
  store.prefs.filters = next;
  store.savePrefs();
  const server = (f) => [f.bpmLo || '', f.bpmHi || '', f.key || '', f.keyWide ? 1 : 0].join('|');
  if (server(before) !== server(next) && S.q) runSearch(S.q);
  else render();
}

// ---- playing -----------------------------------------------------------------

function fromLabel() {
  if (S.view === 'list') { const p = store.getList(S.listId); return p ? p.name : ''; }
  if (S.view === 'source') { const c = getCollection(S.sourceId); return c ? c.title : ''; }
  return S.q ? 'Search “' + S.q + '”' : 'Search';
}

export function playFrom(k) {
  const list = rows().filter((r) => r.track);
  const i = list.findIndex((r) => r.k === k);
  if (i < 0) return;
  if (!player.playable(list[i].track)) { toast(list[i].track.sources && list[i].track.sources.yt ? 'YouTube doesn\'t play here: O opens it in a tab' : 'No playable audio for this track', 'warn'); return; }
  player.playList(list.map((r) => r.track), i, fromLabel());
}

export function playAll() {
  const list = rows().filter((r) => r.track);
  if (!list.length || !player.playList(list.map((r) => r.track), 0, fromLabel())) toast('Nothing playable here', 'warn');
}

export function queueNext() {
  const n = player.playNext(targets().map((r) => r.track).filter(Boolean));
  toast(n ? n + (n === 1 ? ' track' : ' tracks') + ' play next' : 'Already queued');
}

// ---- lists -------------------------------------------------------------------

export async function addTo(listId, tracks) {
  const p = store.getList(listId);
  if (!p || !tracks.length) return;
  const n = await store.addTracks(listId, tracks);
  toast(n ? 'Added ' + (n === 1 ? '“' + tracks[0].title + '”' : n + ' tracks') + ' to ' + p.name : 'Already in ' + p.name);
}

export async function createAndAdd(name, kind, tracks) {
  const p = await store.createList(name, kind);
  if (!p) return null;
  if (tracks && tracks.length) await store.addTracks(p.id, tracks);
  toast((kind === 'set' ? 'New set ' : 'New playlist ') + p.name + (tracks && tracks.length ? ' · ' + tracks.length + ' added' : ''));
  return p;
}

export async function setColour(c) {
  if (S.view !== 'list') return;
  for (const r of targets()) await store.updateEntry(S.listId, r.k, { color: c, colorBy: store.me(), colorAt: Date.now() });
  render();
}

export async function setEnergy(v, relative) {
  if (S.view !== 'list') return;
  for (const r of targets()) {
    const cur = r.entry.energy || 0;
    const next = Math.max(0, Math.min(5, relative ? cur + v : v));
    await store.updateEntry(S.listId, r.k, { energy: next, energyBy: store.me(), energyAt: Date.now() });
  }
  render();
}

export async function removeSelected() {
  if (S.view !== 'list') return;
  const list = rows();
  const ts = targets();
  if (!ts.length) return;
  const last = list.findIndex((r) => r.k === ts[ts.length - 1].k);
  const after = list.slice(last + 1).find((r) => !ts.some((t) => t.k === r.k)) || list.slice(0, last).reverse().find((r) => !ts.some((t) => t.k === r.k));
  await store.removeTracks(S.listId, ts.map((r) => r.k));
  S.sel.clear();
  if (after) S.focus[scope()] = after.k;
  toast('Removed ' + (ts.length === 1 ? '“' + ts[0].track.title + '”' : ts.length + ' tracks'));
  render();
}

export async function moveFocused(delta) {
  if (S.view !== 'list' || S.groupByColour) { if (S.groupByColour) toast('Turn off colour grouping to reorder'); return; }
  const k = focusKey();
  if (k && await store.moveEntry(S.listId, k, delta)) render();
}

export async function moveTo(k, beforeK) {
  if (await store.moveBefore(S.listId, k, beforeK)) render();
}

export async function setTransition(fromK, text) {
  await store.updateEntry(S.listId, fromK, { note: text.trim(), noteBy: store.me(), noteAt: Date.now() });
  render();
}

export async function forkToSet() {
  const p = store.getList(S.listId);
  if (!p || p.kind !== 'playlist') return;
  const set = await store.forkToSet(p.id);
  if (set) { toast('Forked to set ' + set.name); openList(set.id); }
}

export function exportLinks() {
  const p = store.getList(S.listId);
  if (!p) return;
  const text = p.entries.map((e, i) => {
    const t = e.track;
    const links = Object.entries(t.sources || {}).map(([id, s]) => openUrl(id, s.url)).filter(Boolean).join('  ');
    return (i + 1) + '. ' + t.artist + ' – ' + t.title + (t.mix ? ' (' + t.mix + ')' : '') + (links ? '  ' + links : '');
  }).join('\n');
  copy(p.name + '\n\n' + text).then((ok) => toast(ok ? 'Copied ' + p.entries.length + ' links' : 'Couldn\'t copy: clipboard blocked', ok ? '' : 'warn'));
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// ---- notes and tags ----------------------------------------------------------

// ---- Soundeo ♥ ---------------------------------------------------------------

function favError(res) {
  if (res.error === 'authoring-read-only') return 'Crate can\'t change Soundeo while a coding session is building it';
  if (res.error === 'write-not-granted') return 'Shim hasn\'t allowed Crate to change your Soundeo favorites';
  if (res.status === 401 || res.status === 403) return 'Not signed in to Soundeo in Shim';
  return 'Soundeo didn\'t change the favorite: ' + (res.error || 'HTTP ' + res.status);
}

// Every copy of this Soundeo track Crate holds: search, source lists, playlists.
function soundeoCopies(id) {
  const out = [...S.results];
  for (const st of Object.values(S.collections)) out.push(...(st.tracks || []));
  for (const p of store.allLists()) for (const e of p.entries) if (e.track) out.push(e.track);
  return out.filter((t) => t && t.sources && t.sources.so && t.sources.so.id === id);
}

export async function toggleFavorite(k) {
  const r = rows().find((x) => x.k === k);
  const so = r && r.track && r.track.sources && r.track.sources.so;
  if (!so) { toast('Only tracks on Soundeo have a Soundeo ♥'); return; }
  const res = await soundeo.toggleFavorite(so.id);
  if (res.busy) return;
  if (!res.ok) { toast(favError(res), 'error'); return; }
  for (const t of soundeoCopies(so.id)) t.sources.so.favored = res.favored;
  // The Favorites list is re-read the next time it's opened, but not under the user's eyes.
  const fav = S.collections['so-favorites'];
  if (fav && fav.state === 'done' && S.sourceId !== 'so-favorites') fav.state = 'idle';
  toast(res.favored ? '♥ Added to your Soundeo favorites' : 'Removed from your Soundeo favorites');
  render();
}

export async function toggleTag(tag) {
  const ks = targets().map((r) => r.track).filter(Boolean);
  if (!ks.length) return;
  const on = await store.toggleTag(ks, tag);
  toast((on ? 'Tagged ' : 'Untagged ') + (ks.length === 1 ? '' : ks.length + ' tracks ') + tag);
  render();
}

// ---- match fixes -----------------------------------------------------------------

const SRC_NAME = { so: 'Soundeo', bp: 'Beatport', sc: 'SoundCloud' };
const fixesNeedName = () => shared.on() && store.unnamed();
const fixError = () => {
  const e = shared.status.writeError || '';
  return /authoring-read-only/.test(e) ? 'Crate can\'t save fixes while a coding session is building it' : 'Couldn\'t save the fix' + (e ? ': ' + e : '');
};

// Rebuild a search row from its sources' own tracks, as merge would.
function rowFrom(refs, k) {
  const parts = refs.map((r) => [r.split(':')[0], raw.get(r)]).filter(([, t]) => t);
  if (!parts.length) return null;
  const [[, first], ...rest] = parts;
  const row = { ...first, k, sources: { ...first.sources }, matchedBy: {} };
  for (const [source, t] of rest) absorb(row, t, source, 'fix');
  return row;
}

// "Not the same track": this source's track leaves the row.
export async function splitSource(k, source) {
  const r = rows().find((x) => x.k === k);
  const t = r && r.track;
  if (!t || !t.sources[source] || Object.keys(t.sources).length < 2) return;
  if (fixesNeedName()) return;
  const ref = links.refOf(source, t.sources[source]);
  const others = links.refsOf(t).filter((q) => q !== ref);
  if (!ref || !others.length) { toast('Crate can\'t tell these tracks apart: one has no id'); return; }
  const oks = await Promise.all(others.map((q) => links.set(q, ref, 'split', t.title, store.me())));
  if (oks.includes(false)) { toast(fixError()); return; }
  if (S.view === 'search') {
    const i = S.results.findIndex((x) => x.k === k);
    const kept = rowFrom(others, k) || { ...t, sources: Object.fromEntries(Object.entries(t.sources).filter(([id]) => id !== source)) };
    kept.matchedBy = Object.fromEntries(Object.entries(t.matchedBy || {}).filter(([id]) => id !== source));
    const own = raw.get(ref) || { ...t, sources: { [source]: t.sources[source] } };
    const off = { ...own, sources: { ...own.sources }, matchedBy: {} };
    if (S.results.some((x) => x.k === off.k)) off.k = own.k + '~' + ref;
    S.results.splice(i, 1, kept, off);
  } else if (S.view === 'list' && r.entry) {
    const track = { ...t, sources: Object.fromEntries(Object.entries(t.sources).filter(([id]) => id !== source)) };
    if (!(await store.setEntryTrack(S.listId, k, track))) { toast(fixError()); return; }
  }
  toast('Split: ' + SRC_NAME[source] + '\'s track is a different one' + (S.view === 'list' ? '. It left this row; search for it to add it on its own' : '') + (shared.on() ? ' · fixed for everyone' : ''));
  render();
}

// "Same track": the selected search rows become one.
export function mergeSelected() {
  if (S.view !== 'search') { toast('Join rows in search: select both (⇧↑↓ or ⌘-click), then press M'); return; }
  const picked = targets();
  if (picked.length < 2) { toast('Select the rows that are the same track (⇧↑↓ or ⌘-click), then press M'); return; }
  return joinRows(picked.map((p) => p.k));
}

export async function joinRows(keys) {
  const picked = keys.map((k) => S.results.find((x) => x.k === k)).filter(Boolean);
  if (picked.length < 2) return;
  const seen = new Set();
  for (const t of picked) for (const id of Object.keys(t.sources)) {
    if (seen.has(id)) { toast('Two of those rows are both from ' + SRC_NAME[id] + ': a row holds one track per source'); return; }
    seen.add(id);
  }
  const refs = picked.flatMap((t) => links.refsOf(t));
  if (refs.length !== seen.size) { toast('Crate can\'t join these: one has no id'); return; }
  if (fixesNeedName()) return;
  const first = picked[0];
  const jobs = [];
  for (let i = 0; i < refs.length; i++) for (let j = i + 1; j < refs.length; j++) jobs.push(links.set(refs[i], refs[j], 'same', first.title, store.me()));
  if ((await Promise.all(jobs)).includes(false)) { toast(fixError()); return; }
  const row = rowFrom(refs, first.k) || first;
  row.matchedBy = Object.fromEntries(Object.keys(row.sources).map((id) => [id, first.sources[id] ? (first.matchedBy || {})[id] : 'fix']));
  const gone = new Set(picked.map((t) => t.k));
  const at = S.results.findIndex((x) => x.k === first.k);
  S.results = S.results.filter((x) => !gone.has(x.k));
  S.results.splice(Math.min(at, S.results.length), 0, row);
  S.sel.clear();
  S.focus[scope()] = row.k;
  toast('Joined as one track' + (shared.on() ? ' · fixed for everyone' : ''));
  render();
}

// Rows in this search that could be the same recording: same title, no
// source in common, and not kept apart by a fix.
export function joinCandidates(t) {
  if (S.view !== 'search') return [];
  const title = t.k.split('|')[1];
  const mine = links.refsOf(t);
  return S.results.filter((x) => x.k !== t.k && x.k.split('|')[1] === title
    && !Object.keys(x.sources).some((id) => t.sources[id])
    && !mine.some((r) => links.splitFrom(x, r))).slice(0, 3);
}

// Undo fixes: forget them and search again so the automatic guess comes back.
export async function undoFix(fixes) {
  if (fixesNeedName()) return;
  const oks = await Promise.all(fixes.map((f) => links.set(f.a, f.b, 'none', '', store.me())));
  if (oks.includes(false)) { toast(fixError()); return; }
  toast(fixes.length > 1 ? 'Fixes undone' : 'Fix undone');
  if (S.view === 'search' && S.q) runSearch(S.q); else render();
}
