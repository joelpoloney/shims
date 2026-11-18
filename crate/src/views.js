// The screens: top bar, sidebar, main views, the track detail panel.

import { h, fmtLen, fmtTotal, ago, musicalKey, keyCompat, bpmCompat, VERSION_GROUPS } from './util.js';
import { S, render } from './state.js';
import * as store from './store.js';
import * as player from './player.js';
import * as A from './actions.js';
import { SOURCES, READY, chip, chipLanes, art, energy, swatch, avatar, section, compat } from './components.js';
import { openOverlay } from './overlays.js';
import { COLLECTIONS, getCollection, collectionState, loadCollection as reloadCollectionNow } from './collections.js';
import * as shared from './shared.js';
import * as links from './links.js';
import * as columns from './columns.js';
import * as tracklists from './tracklists.js';
import { openUrl } from './safe.js';

const srcName = (id) => (SOURCES.find((s) => s.id === id) || { name: id }).name;
const hits = () => READY.reduce((n, s) => n + (S.sources[s.id].count || 0), 0);
const reloadCollection = (id) => reloadCollectionNow(id, true);

// ---- top bar (mounted once; the search field must survive renders) ------------

let top = null;

export function mountTopbar(el) {
  const input = h('input', { id: 'q', type: 'search', placeholder: 'Search Soundeo, Beatport, SoundCloud: artist, title, label', autocomplete: 'off', spellcheck: 'false' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); A.runSearch(input.value); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); if (input.value && input.value !== S.q) input.value = S.q; else input.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); input.blur(); }
  });
  const meta = h('span', { class: 'q-meta' });
  const tabs = h('nav', { class: 'tabs' });
  const sync = h('span', { class: 'sync' });
  const me = h('span', { class: 'me' });
  el.append(
    h('span', { class: 'wordmark' }, 'CRATE'),
    h('label', { class: 'search' }, h('kbd', null, '/'), input, meta),
    tabs, sync, me,
  );
  top = { input, meta, tabs, sync, me };
}

export function updateTopbar() {
  if (!top) return;
  if (document.activeElement !== top.input && top.input.value !== S.q && !top.input.dataset.dirty) top.input.value = S.q;
  const anyLoading = READY.some((s) => S.sources[s.id] && S.sources[s.id].state === 'loading');
  top.meta.textContent = S.searched
    ? (anyLoading && !S.results.length ? 'searching…' : A.visibleResults().length + ' tracks' + (A.visibleResults().length !== S.results.length ? ' of ' + S.results.length : '') + (hits() > S.results.length ? ' · merged from ' + hits() + ' hits' : ''))
    : '';
  const tab = (view, label, keys) => h('button', { class: 'tab' + (S.view === view || (view === 'library' && S.view === 'list') ? ' is-on' : ''), onclick: () => A.go(view) },
    label, h('span', { class: 'tab-key' }, keys));
  const unread = unreadCount();
  const act = tab('activity', 'Activity', '⌥3');
  if (unread) act.insertBefore(h('span', { class: 'badge' }, unread), act.lastChild);
  top.tabs.replaceChildren(tab('search', 'Search', '⌥1'), tab('library', 'Library', '⌥2'), act, tab('settings', 'Settings', '⌥4'));
  const [kind, syncText] = syncState();
  top.sync.className = 'sync sync-' + kind;
  top.sync.title = syncText;
  top.sync.replaceChildren(h('span', { class: 'dot' }), h('span', { class: 'sync-text' }, syncText));
  top.me.replaceChildren(avatar(store.me()));
}

function syncState() {
  const st = shared.status;
  if (store.status.error) return ['fail', 'Last save failed · ' + store.status.error];
  if (st.mode === 'checking') return ['off', 'Connecting to the shared space…'];
  if (st.mode === 'off') return ['off', 'Local only · shared space not connected'];
  if (st.mode === 'error') return ['fail', 'Shared space unreachable · ' + st.error];
  if (st.writeError) return ['fail', 'Last write rejected · ' + st.writeError];
  if (st.arriving && Date.now() - st.arriving.at < 6000) return ['info', st.arriving.count + (st.arriving.count === 1 ? ' change' : ' changes') + ' from ' + st.arriving.actor + ' · ' + ago(st.arriving.at)];
  return ['ok', 'Shared · synced ' + ago(st.lastSync || Date.now())];
}

export function unreadCount() {
  if (!shared.on()) return 0;
  const seen = store.prefs.seenActivity || 0;
  return shared.activity.filter((a) => a.id > seen && a.actor !== store.me()).length;
}

export const focusSearch = () => { if (top) { top.input.focus(); top.input.select(); } };

// ---- sidebar -------------------------------------------------------------------

export function renderSidebar(el) {
  const compact = S.view !== 'search';
  const parts = [];
  const status = (st) => st.state === 'loading' ? h('span', { class: 'mono dim' }, '···')
    : st.state === 'error' ? h('span', { class: 'mono warn' }, 'error')
      : st.state === 'done' ? h('span', { class: 'mono' }, st.count) : h('span', { class: 'mono dim' }, 'ready');
  const errs = READY.filter((s) => S.sources[s.id].state === 'error').length;
  const unset = SOURCES.filter((s) => !s.ready);

  if (compact) {
    parts.push(section('SOURCES'), h('div', { class: 'side-sum mono' }, (READY.length - errs) + ' ok' + (errs ? ' · ' + errs + ' error' : '') + ' · ' + unset.length + ' to set up'));
  } else {
    parts.push(section('SOURCES', '⌥4'));
    for (const s of READY) {
      const st = S.sources[s.id];
      parts.push(h('div', { class: 'side-row' + (st.state === 'error' ? ' is-warn' : ''), title: st.error || '' }, chip(s.id, { dim: st.state === 'error' }), h('span', { class: 'grow' }, s.name), status(st)));
    }
    parts.push(h('div', { class: 'side-note' }, unset.map((s) => s.name).join(', ') + ' not set up yet'));
  }

  const f = store.prefs.filters || {};
  const filterRows = [
    ['BPM', f.bpmLo || f.bpmHi ? (f.bpmLo || 0) + '–' + (f.bpmHi || 260) : 'any'],
    ['Key', f.key ? f.key + (f.keyWide ? ' ±1' : '') : 'any'],
    ['Genre', f.genre || 'any'],
    ['Released', f.days ? f.days + ' days' : 'any'],
  ];
  const active = filterRows.filter(([, v]) => v !== 'any');
  if (compact) {
    parts.push(section('FILTERS'), h('div', { class: 'side-sum mono' }, active.length ? active.map(([k, v]) => k + ' ' + v).join(' · ') : 'none'));
  } else {
    parts.push(section('FILTERS', 'F'));
    for (const [k, v] of filterRows) {
      parts.push(h('button', { class: 'side-row side-filter', onclick: () => openOverlay('filters') }, h('span', { class: 'grow' }, k), h('span', { class: 'mono' + (v === 'any' ? ' dim' : '') }, v)));
    }
  }

  parts.push(section('FROM YOUR SOURCES'));
  for (const c of COLLECTIONS) {
    const st = collectionState(c.id);
    const on = S.view === 'source' && S.sourceId === c.id;
    if (c.needs && !c.needs()) {
      parts.push(h('button', { class: 'side-row side-list', title: 'Add your SoundCloud profile name in Settings', onclick: () => A.go('settings') },
        chip(c.source, { dim: true }), h('span', { class: 'grow ellip fg3' }, c.name), h('span', { class: 'mono dim' }, 'set up')));
      continue;
    }
    parts.push(h('button', { class: 'side-row side-list' + (on ? ' is-on' : ''), onclick: () => A.openSource(c.id) },
      chip(c.source), h('span', { class: 'grow ellip' }, c.name),
      st.state === 'loading' ? h('span', { class: 'mono dim' }, '···')
        : st.state === 'error' ? h('span', { class: 'mono warn' }, 'error')
          : st.state === 'done' ? h('span', { class: 'mono dim' }, st.tracks.length) : c.count != null ? h('span', { class: 'mono dim' }, c.count) : null));
  }

  const lists = store.allLists();
  const item = (p) => {
    const on = S.view === 'list' && S.listId === p.id;
    const b = h('button', { class: 'side-row side-list' + (on ? ' is-on' : ''), onclick: () => A.openList(p.id), dataset: { list: p.id } },
      h('span', { class: 'grow ellip' }, p.name),
      h('span', { class: 'mono dim' }, p.kind === 'set' ? p.entries.length + ' · ' + fmtTotal(total(p)) : p.entries.length));
    b.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/crate-keys')) { e.preventDefault(); b.classList.add('is-drop'); } });
    b.addEventListener('dragleave', () => b.classList.remove('is-drop'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('is-drop');
      const keys = JSON.parse(e.dataTransfer.getData('text/crate-keys') || '[]');
      const tracks = A.rows().filter((r) => keys.includes(r.k)).map((r) => r.track).filter(Boolean);
      A.addTo(p.id, tracks);
    });
    return b;
  };
  parts.push(section('PLAYLISTS', h('button', { class: 'link', title: 'New playlist', onclick: () => openOverlay('prompt', { mode: 'new-playlist' }) }, '+ new')));
  const pls = lists.filter((p) => p.kind === 'playlist');
  parts.push(...(pls.length ? pls.map(item) : [h('div', { class: 'side-note' }, 'None yet. A on a track makes one.')]));
  parts.push(section('SETS', h('button', { class: 'link', title: 'New set', onclick: () => openOverlay('prompt', { mode: 'new-set' }) }, '+ new')));
  const sets = lists.filter((p) => p.kind === 'set');
  parts.push(...(sets.length ? sets.map(item) : [h('div', { class: 'side-note' }, 'None yet. ⇧F forks a playlist into one.')]));
  el.replaceChildren(...parts);
}

const total = (p) => p.entries.reduce((s, e) => s + (e.track.len || 0), 0);

// ---- main ----------------------------------------------------------------------

let observer = null;

// A rebuild of the same screen keeps its scroll position; only a keyboard
// move scrolls the focused row into view.
let lastScope = '';
export function renderMain(el) {
  if (observer) { observer.disconnect(); observer = null; }
  const scope = A.scope();
  const scroller = el.querySelector('.rows, .view-settings');
  const keep = scope === lastScope && scroller ? scroller.scrollTop : 0;
  lastScope = scope;
  const view = S.view === 'search' ? searchView()
    : S.view === 'library' ? libraryView()
      : S.view === 'list' ? listView()
        : S.view === 'source' ? sourceView()
          : S.view === 'activity' ? activityView()
        : settingsView();
  el.replaceChildren(view);
  const next = el.querySelector('.rows, .view-settings');
  if (next && keep) next.scrollTop = keep;
  applyFocus(el, false);
  if (S.view === 'search' || S.view === 'source' || S.view === 'list') watchRows(el);
}

// Move the focus ring and selection without rebuilding rows.
export function applyFocus(root, scroll) {
  const k = A.focusKey();
  const playing = player.current();
  let focusedEl = null;
  for (const row of root.querySelectorAll('[data-k]')) {
    const on = row.dataset.k === k;
    row.classList.toggle('is-focus', on);
    row.classList.toggle('is-sel', S.sel.has(row.dataset.k));
    if (row.dataset.track) {
      const isPlaying = !!playing && playing.k === row.dataset.track;
      row.classList.toggle('is-playing', isPlaying);
      const glyph = row.querySelector('.c-play');
      if (glyph) glyph.textContent = isPlaying ? (player.state.playing ? '▶' : '❚❚') : on ? '▷' : '';
    }
    if (on) focusedEl = row;
  }
  if (focusedEl && scroll) focusedEl.scrollIntoView({ block: 'nearest' });
  const foot = root.querySelector('.foot-focus');
  if (foot) foot.replaceChildren(...focusLine());
}

// Rows coming on screen get their BPM / key looked up.
function watchRows(root) {
  const scroller = root.querySelector('.rows');
  if (!scroller) return;
  const seen = new Set();
  let timer = 0;
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) seen.add(e.target.dataset.k); else seen.delete(e.target.dataset.k);
    }
    clearTimeout(timer);
    timer = setTimeout(() => A.enrich([...seen]), 200);
  }, { root: scroller, rootMargin: '0px' });
  for (const row of scroller.querySelectorAll('[data-k]')) observer.observe(row);
}

export function replaceRow(k) {
  const main = document.getElementById('main');
  const old = main.querySelector('[data-k="' + CSS.escape(k) + '"]');
  if (!old || !old.matches('.row-search, .grid-playlist')) return;
  const r = A.rows().find((x) => x.k === k);
  const t = r && r.track;
  if (!t) return;
  const row = r.entry ? playlistRow(r.entry) : searchRow(t);
  old.replaceWith(row);
  if (observer) observer.observe(row);
  applyFocus(main, false);
}

function dragKeys(row, k) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    const keys = S.sel.has(k) ? [...S.sel] : [k];
    e.dataTransfer.setData('text/crate-keys', JSON.stringify(keys));
    e.dataTransfer.setData('text/crate-move', k);
    e.dataTransfer.effectAllowed = 'copyMove';
  });
}

// The chips open the panel: which source is which, and why they share a row.
function sourcesCell(t) {
  return h('button', { class: 'lanes-btn', title: 'Sources and how they matched (I)', onclick: (ev) => { ev.stopPropagation(); A.setFocus(t.k); S.panel = true; render(); } }, chipLanes(t));
}

function rowEvents(row, k) {
  row.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    if (e.shiftKey) A.setFocus(k, { extend: true });
    else if (e.metaKey) { if (S.sel.has(k)) S.sel.delete(k); else S.sel.add(k); A.setFocus(k, { keepSel: true }); }
    else A.setFocus(k);
  });
  row.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) A.playFrom(k); });
}

// ---- table columns ---------------------------------------------------------------
// A table is a list of columns: its width, its heading and how to draw its
// cell. Optional ones (opt) follow the Columns picker. Widths go through a
// per-column variable so the stylesheet can still collapse one on a narrow
// window.

const cellText = (cls, text, title) => h('span', { class: cls, title: title || null }, text);

// Your note on the track, or the group's first when you have none. Click to write.
function noteCell(t) {
  const mine = store.noteFor(t).body;
  const others = store.othersNotes(t).filter((n) => n.body);
  const tip = [mine ? 'You: ' + mine : '', ...others.map((n) => n.author + ': ' + n.body)].filter(Boolean).join('\n');
  return h('span', {
    class: 'ellip c-note' + (mine ? '' : ' fg3'), title: tip || 'Write a note (N)',
    onclick: (e) => { e.stopPropagation(); A.setFocus(t.k); S.panel = true; render(); focusNote(); },
  }, mine || (others[0] ? others[0].author + ': ' + others[0].body : ''),
  mine && others.length ? h('span', { class: 'mono fg3' }, ' +' + others.length) : null);
}

// How many DJ tracklists the track is in, from 1001tracklists.
function playsCell(t) {
  const v = tracklists.get(t);
  const done = v && v.state === 'done';
  return cellText('mono num' + (done && v.plays ? '' : ' fg3'), !v ? '' : done ? v.playsText : v.state === 'loading' ? '·' : v.state === 'none' ? '—' : '',
    done ? 'In ' + v.playsText + ' DJ tracklists on 1001tracklists' : v && v.state === 'none' ? 'Not on 1001tracklists' : tracklists.stopped());
}

function freshCell(t) {
  const id = tracklists.freshness(t);
  return h('span', { class: 'fresh' + (id ? ' fresh-' + id : ''), title: id ? tracklists.FRESH[id][1] : null }, id ? tracklists.FRESH[id][0] : '');
}

const TABLE_COLS = {
  search: [
    { id: 'play', w: '24px', cell: (t) => playGlyph(t.k) },
    { id: 'art', w: '22px', cell: (t) => art(t.art50, 20) },
    { id: 'artist', w: 'minmax(70px,1.1fr)', label: 'ARTIST', cell: (t) => cellText('ellip', t.artist) },
    { id: 'title', w: 'minmax(90px,1.3fr)', label: 'TITLE', cell: (t) => h('span', { class: 'ellip c-title' }, h('span', { class: 't' }, t.title), favMark(t), noteMark(t), tagPills(t)) },
    { id: 'mix', opt: true, w: 'minmax(0,0.9fr)', label: 'MIX', cell: (t) => cellText('ellip fg2', t.mix) },
    { id: 'note', opt: true, w: 'minmax(0,1.5fr)', label: 'NOTES', cell: noteCell },
    { id: 'label', opt: true, w: 'minmax(0,0.8fr)', label: 'LABEL', cell: (t) => cellText('ellip fg3', t.label) },
    { id: 'genre', opt: true, w: 'minmax(0,0.7fr)', label: 'GENRE', cell: (t) => cellText('ellip fg2 c-genre', t.genre, t.genre || '') },
    { id: 'bpm', opt: true, w: '40px', label: 'BPM', num: true, cell: (t) => cellText('mono num' + (t.bpm && !t.bpmGuess ? '' : ' fg3'), t.bpm ? t.bpm + (t.bpmGuess ? '?' : '') : t.enriching ? '·' : t.sources.so ? '' : '—', t.bpmGuess ? (t.bpmFrom === 'audio' ? 'BPM measured from the audio by Crate' : 'BPM read from the title') : '') },
    { id: 'key', opt: true, w: '40px', label: 'KEY', cell: (t) => cellText('mono' + (t.camelot ? '' : ' fg3'), t.camelot || (t.sources.so ? '' : '—')) },
    { id: 'len', opt: true, w: '44px', label: 'LEN', num: true, cell: (t) => cellText('mono num', fmtLen(t.len)) },
    { id: 'released', opt: true, w: '80px', label: 'RELEASED', cell: (t) => h('span', { class: 'mono fg3 c-date' }, t.released, t.preorder ? h('span', { class: 'pre', title: 'not released yet' }, ' pre') : null) },
    { id: 'plays', opt: true, w: '48px', label: 'PLAYS', num: true, cell: playsCell },
    { id: 'fresh', opt: true, w: '70px', label: 'FRESH', cell: freshCell },
    { id: 'sources', opt: true, w: '116px', label: 'SOURCES', cell: (t) => sourcesCell(t) },
    { id: 'add', w: '24px', cell: (t) => addButton(t.k) },
  ],
  playlist: [
    { id: 'swatch', w: '30px', cell: (e) => pickSwatch(e) },
    { id: 'art', w: '22px', cell: (e) => art(e.track.art50, 20) },
    { id: 'artist', w: 'minmax(70px,1.1fr)', label: 'ARTIST', cell: (e) => cellText('ellip', e.track.artist) },
    { id: 'title', w: 'minmax(90px,1.3fr)', label: 'TITLE', cell: (e) => h('span', { class: 'ellip c-title' }, h('span', { class: 't' }, e.track.title), tagPills(e.track)) },
    { id: 'mix', opt: true, w: 'minmax(0,0.9fr)', label: 'MIX', cell: (e) => cellText('ellip fg2', e.track.mix) },
    { id: 'note', opt: true, w: 'minmax(0,1.5fr)', label: 'NOTES', cell: (e) => noteCell(e.track) },
    { id: 'genre', opt: true, w: 'minmax(0,0.7fr)', label: 'GENRE', cell: (e) => cellText('ellip fg2', e.track.genre || '', e.track.genre || '') },
    { id: 'bpm', opt: true, w: '40px', label: 'BPM', num: true, cell: (e) => cellText('mono num' + (e.track.bpmGuess ? ' fg3' : ''), e.track.bpm ? e.track.bpm + (e.track.bpmGuess ? '?' : '') : '', e.track.bpmGuess ? (e.track.bpmFrom === 'audio' ? 'BPM measured from the audio by Crate' : 'BPM read from the title') : '') },
    { id: 'key', opt: true, w: '40px', label: 'KEY', cell: (e) => cellText('mono', e.track.camelot) },
    { id: 'len', opt: true, w: '44px', label: 'LEN', num: true, cell: (e) => cellText('mono num', fmtLen(e.track.len)) },
    { id: 'plays', opt: true, w: '48px', label: 'PLAYS', num: true, cell: (e) => playsCell(e.track) },
    { id: 'fresh', opt: true, w: '70px', label: 'FRESH', cell: (e) => freshCell(e.track) },
    { id: 'added', opt: true, w: '96px', label: 'ADDED', cell: (e) => h('span', { class: 'owner' }, avatar(e.addedBy), h('span', { class: 'mono fg3' }, ago(e.addedAt))) },
    { id: 'cmt', opt: true, w: '30px', label: 'CMT', cell: (e) => commentCell(e) },
    { id: 'energy', opt: true, w: '86px', label: 'ENERGY', cell: (e) => pickEnergy(e) },
    { id: 'sources', opt: true, w: '116px', label: 'SOURCES', cell: (e) => sourcesCell(e.track) },
  ],
};

// The icon columns stay at the edges; the named ones follow your order.
function tableCols(table) {
  const all = TABLE_COLS[table];
  const named = columns.shown(table).map((id) => all.find((c) => c.id === id)).filter(Boolean);
  const lead = all.slice(0, all.findIndex((c) => c.label));
  const tail = all.filter((c) => !c.label && !lead.includes(c));
  return [...lead, ...named, ...tail];
}
// A width you dragged holds while there is room and gives way before Artist
// and Title do; otherwise the column's own (often flexible) one.
// live = { id, px } overrides one column while it is being dragged.
const dragged = (px) => 'minmax(0,' + px + 'px)';
const colWidth = (table, c, live) => (live && live.id === c.id ? dragged(live.px) : columns.width(table, c.id) ? dragged(columns.width(table, c.id)) : c.w);
const gridCols = (table, live) => tableCols(table).map((c) => 'var(--w-' + c.id + ', ' + colWidth(table, c, live) + ')').join(' ');
const tableCells = (table, x) => tableCols(table).map((c) => { const el = c.cell(x); el.classList.add('col-' + c.id); return el; });
const TABLE_ROWS = { search: '.grid-search, .row-search', playlist: '.grid-playlist' };

let dragCol = null; // { table, id } while a heading is being dragged

function headCell(table, c) {
  if (!c.label) return h('span', { class: 'col-' + c.id });
  const cell = h('span', { class: 'col-' + c.id + (c.num ? ' num' : ''), draggable: 'true', title: 'Drag to move · drag the right edge to resize' }, h('span', { class: 'col-name' }, c.label));
  const clear = () => cell.classList.remove('drop-before', 'drop-after');
  const before = (e) => { const r = cell.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; };
  cell.addEventListener('dragstart', (e) => { dragCol = { table, id: c.id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.label); });
  cell.addEventListener('dragend', () => { dragCol = null; });
  cell.addEventListener('dragover', (e) => {
    if (!dragCol || dragCol.table !== table || dragCol.id === c.id) return;
    e.preventDefault();
    clear();
    cell.classList.add(before(e) ? 'drop-before' : 'drop-after');
  });
  cell.addEventListener('dragleave', clear);
  cell.addEventListener('drop', async (e) => {
    if (!dragCol || dragCol.table !== table || dragCol.id === c.id) return;
    e.preventDefault();
    const order = columns.shown(table);
    const target = before(e) ? c.id : order[order.indexOf(c.id) + 1] || null;
    const id = dragCol.id;
    dragCol = null;
    if (target !== id) await columns.move(table, id, target);
    render();
  });

  // The right edge resizes; double-click gives the column its own width back.
  const grip = h('span', { class: 'col-grip', title: 'Drag to resize · double-click to reset', draggable: 'false' });
  grip.addEventListener('dblclick', async (e) => { e.stopPropagation(); await columns.setWidth(table, c.id, 0); render(); });
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startW = cell.getBoundingClientRect().width;
    let px = startW, frame = 0;
    document.body.classList.add('is-col-resizing');
    const apply = () => { frame = 0; const cols = gridCols(table, { id: c.id, px }); for (const el of document.querySelectorAll('#main ' + TABLE_ROWS[table].split(', ').join(', #main '))) el.style.gridTemplateColumns = cols; };
    const onMove = (m) => { px = Math.max(columns.MIN_WIDTH, Math.round(startW + m.clientX - startX)); if (!frame) frame = requestAnimationFrame(apply); };
    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('is-col-resizing');
      if (px !== Math.round(startW)) await columns.setWidth(table, c.id, px);
      render();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  cell.append(grip);
  return cell;
}

const tableHead = (table, cls) => h('div', { class: 'colhead ' + cls, style: { gridTemplateColumns: gridCols(table) } }, tableCols(table).map((c) => headCell(table, c)));
const columnsButton = (table) => h('button', { class: 'btn', title: 'Choose the columns this table shows', onclick: () => openOverlay('columns', { table }) }, 'Columns');

// A pencil on rows that carry a note: yours, or how many from the group.
function noteMark(t) {
  if (columns.isOn('search', 'note')) return null;
  const mine = store.noteFor(t).body;
  const others = store.othersNotes(t).filter((n) => n.body);
  if (!mine && !others.length) return null;
  const tip = [mine ? 'You: ' + mine : '', ...others.map((n) => n.author + ': ' + n.body)].filter(Boolean).join('\n');
  return h('span', { class: 'note-mark' + (mine ? '' : ' is-theirs'), title: tip }, '✎' + (others.length ? others.length : ''));
}

function tagPills(t) {
  const tags = store.noteFor(t).tags;
  return tags.length ? h('span', { class: 'tags' }, tags.slice(0, 3).map((t) => h('span', { class: 'tag' }, t))) : null;
}

function addButton(k) {
  return h('button', { class: 'c-add', title: 'Add to… (A)', onclick: (e) => { e.stopPropagation(); A.setFocus(k); openOverlay('add'); } }, '+');
}

function playGlyph(k) {
  return h('button', { class: 'c-play', title: 'Play (⏎)', onclick: (e) => { e.stopPropagation(); A.setFocus(k); A.playFrom(k); } });
}

// ---- 01 search -----------------------------------------------------------------

function seg(options, value, onpick) {
  return h('span', { class: 'seg' }, options.map(([v, label]) => h('button', { class: v === value ? 'is-on' : '', onclick: () => onpick(v) }, label)));
}

function hints(...pairs) {
  return h('span', { class: 'hints' }, pairs.map(([k, label]) => h('span', null, h('kbd', null, k), ' ', label)));
}

function searchRow(t) {
  const row = h('div', { class: 'row row-search', dataset: { k: t.k, track: t.k }, style: { gridTemplateColumns: gridCols('search') } }, tableCells('search', t));
  rowEvents(row, t.k);
  dragKeys(row, t.k);
  return row;
}

function favMark(t) {
  if (!t.sources.so || !t.sources.so.favored) return null;
  return h('button', { class: 'fav', title: 'In your Soundeo favorites. Click or press L to remove', onclick: (e) => { e.stopPropagation(); A.toggleFavorite(t.k); } }, '♥');
}

const searchColhead = () => tableHead('search', 'grid-search');

// A list that lives on a source (Soundeo favorites): read-only here; play it,
// tag it, add it to your own playlists and sets.
function sourceView() {
  const c = getCollection(S.sourceId);
  if (!c) return h('div', { class: 'view' }, h('div', { class: 'empty' }, 'That list is gone.'));
  const st = collectionState(c.id);
  const list = A.collectionTracks();
  const head = h('div', { class: 'page-head' },
    chip(c.source, { large: true }),
    h('div', { class: 'title-block' },
      h('h1', null, c.title),
      h('div', { class: 'mono fg3 small' }, st.state === 'done'
        ? list.length + ' tracks · ' + fmtTotal(list.reduce((s, t) => s + (t.len || 0), 0)) + ' · read from ' + srcName(c.source) + ' ' + ago(st.loadedAt)
        : st.state === 'loading' ? 'reading from ' + srcName(c.source) + '…' : '')),
    h('span', { class: 'grow' }),
    seg([['relevance', srcName(c.source) + ' order'], ['newest', 'Newest'], ['bpm', 'BPM'], ['plays', 'DJ plays']], store.prefs.sort, A.setSort),
    h('button', { class: 'btn btn-fill', onclick: A.playAll }, '▶ Play all ', h('kbd', null, 'P')),
    h('button', { class: 'btn', onclick: A.refreshSource }, 'Refresh ', h('kbd', null, 'R')),
    columnsButton('search'),
    h('a', { class: 'btn', href: c.url, target: '_blank', rel: 'noopener' }, 'Open on ' + srcName(c.source) + ' ↗'));
  let body;
  if (st.state === 'error') {
    body = h('div', { class: 'banner' }, chip(c.source, { dim: true }), h('span', { class: 'grow' }, h('b', null, srcName(c.source) + ' didn\'t answer. '), st.error + '.'),
      h('button', { class: 'link', onclick: A.refreshSource }, 'Retry ', h('kbd', null, 'R')));
  } else if (st.state === 'loading' && !list.length) {
    body = h('div', { class: 'empty' }, h('div', { class: 'mono dim' }, '··· reading your ' + c.name.toLowerCase() + ' from ' + srcName(c.source)));
  } else if (!list.length) {
    body = h('div', { class: 'empty' }, h('p', { class: 'fg2' }, 'Nothing in ' + c.name + ' on ' + srcName(c.source) + ' yet. Add tracks there and press R here.'));
  } else body = h('div', { class: 'rows' }, list.map(searchRow));
  return h('div', { class: 'view view-search' }, head, list.length ? searchColhead() : null, body,
    h('div', { class: 'foot mono' }, hints(['⏎', 'play'], ['A', 'add to…'], ['L', '♥ soundeo'], ['G', 'tag'], ['I', 'details'], ['S', 'sort'], ['R', 'refresh']),
      c.source === 'so' ? null : h('span', { class: 'dim' }, 'Read-only: change it on ' + srcName(c.source))));
}

function searchView() {
  const parts = [];
  parts.push(h('div', { class: 'toolbar' },
    seg([['relevance', S.suggest ? 'Best fit' : 'Relevance'], ['newest', 'Newest'], ['bpm', 'BPM'], ['plays', 'DJ plays']], store.prefs.sort, A.setSort),
    h('span', { class: 'mono dim small' }, 'S cycles sort'),
    columnsButton('search'),
    h('span', { class: 'grow' }),
    S.sel.size > 1 ? h('button', { class: 'btn', title: 'These rows are one recording: join them, for everyone in the group', onclick: A.mergeSelected }, 'Same track ', h('kbd', null, 'M')) : null,
    hints(['↑↓', 'move'], ['⏎', 'play'], ['A', 'add to…'], ['L', '♥ soundeo'], ['G', 'tag'], ['I', 'details'], ['?', 'keys'])));

  const ok = READY.filter((s) => S.sources[s.id].state === 'done').length;
  for (const s of READY) {
    const st = S.sources[s.id];
    if (st.state !== 'error') continue;
    parts.push(h('div', { class: 'banner' }, chip(s.id, { dim: true }),
      h('span', { class: 'grow' }, h('b', null, s.name + ' didn\'t answer. '), st.error + '.', ok ? ' Results from the other sources are below.' : ''),
      h('button', { class: 'link', onclick: A.retrySources }, 'Retry ', h('kbd', null, 'R'))));
  }

  if (!S.searched) { parts.push(homeState()); return h('div', { class: 'view view-search' }, parts); }
  if (S.versions) {
    parts.push(h('div', { class: 'versions-head' },
      h('div', { class: 'grow' }, h('div', { class: 'mono fg3 small' }, S.versions.sc ? 'REMIXES, EDITS AND BOOTLEGS ON SOUNDCLOUD' : 'VERSIONS OF'), h('div', { class: 'v-title' }, S.versions.label)),
      h('span', { class: 'mono fg3 small' }, 'searched “' + S.versions.q + '”'),
      S.versions.sc
        ? h('button', { class: 'btn', title: 'Look on Soundeo, Beatport and YouTube too', onclick: () => A.findVersions(S.versions.track) }, 'Every source ', h('kbd', null, 'V'))
        : h('button', { class: 'btn', title: 'Ask SoundCloud several ways for remixes, edits and bootlegs', onclick: () => A.findVersions(S.versions.track, { sc: true }) }, chip('sc'), ' SoundCloud only ', h('kbd', null, '⇧V')),
      h('button', { class: 'btn', title: 'Show every result for this search', onclick: A.clearVersions }, 'All results')));
  }

  const sg = S.suggest;
  if (sg) {
    parts.push(h('div', { class: 'versions-head' },
      h('div', { class: 'grow' }, h('div', { class: 'mono fg3 small' }, 'SUGGESTIONS FOR'), h('div', { class: 'v-title' }, sg.name)),
      h('span', { class: 'mono small tempo', title: 'The middle of this playlist\'s BPMs, with 3 BPM either side. Nothing outside it is suggested; half and double time count.' }, sg.lo + '–' + sg.hi + (sg.alt ? ' / ' + sg.alt[0] + '–' + sg.alt[1] : '') + ' BPM'),
      sg.allGenres.length ? h('span', { class: 'mono small fg2 ellip sg-genres', title: 'Only genres this playlist already holds' }, sg.allGenres.join(', ')) : null,
      h('span', { class: 'mono fg3 small ellip sg-from', title: [...sg.artists, ...sg.labels].join(', ') }, 'more from ' + [...sg.artists, ...sg.labels].join(', ')),
      h('button', { class: 'btn', onclick: () => A.openList(sg.listId) }, 'Back to playlist')));
  }

  const list = A.visibleResults();
  const loading = READY.filter((s) => S.sources[s.id].state === 'loading');
  if (!list.length && loading.length) {
    parts.push(h('div', { class: 'empty' }, h('div', { class: 'mono dim' }, '··· ' + loading.map((s) => s.name).join(' and ') + (sg ? ' looking for tracks at ' + sg.lo + '–' + sg.hi + ' BPM' : ' searching for “' + S.q + '”'))));
    return h('div', { class: 'view view-search' }, parts);
  }
  if (!list.length && sg) {
    parts.push(h('div', { class: 'empty' }, h('p', { class: 'fg2' }, 'Nothing new at ' + sg.lo + '–' + sg.hi + ' BPM from this playlist\'s artists and labels.')));
    return h('div', { class: 'view view-search' }, parts);
  }
  if (!list.length && ok && S.versions && !loading.length) {
    parts.push(h('div', { class: 'empty' }, h('p', { class: 'fg2' }, 'No other versions found for “' + S.versions.q + '”. ', h('button', { class: 'link', onclick: A.clearVersions }, 'Show all results'))));
    return h('div', { class: 'view view-search' }, parts);
  }
  if (!list.length && ok) { parts.push(noResults()); return h('div', { class: 'view view-search' }, parts); }

  parts.push(searchColhead());
  parts.push(h('div', { class: 'rows' }, S.versions ? versionRows(list) : list.map(searchRow)));
  const missing = list.filter((t) => !t.camelot).length;
  parts.push(h('div', { class: 'foot mono' },
    loading.length ? '··· ' + loading.map((s) => s.name).join(' and ') + ' still sending results · new matches merge in place, focus stays put'
      : list.length + ' tracks from ' + READY.filter((s) => S.sources[s.id].count).map((s) => s.name).join(' and ') + (sg ? ' · all at this playlist\'s tempo' : '') + (missing ? ' · Soundeo BPM and key fill in as rows come on screen' : '')));
  return h('div', { class: 'view view-search' }, parts);
}

// Versions grouped: original & cuts, remixes, edits & bootlegs, other artists.
function versionRows(list) {
  const out = [];
  let last = '';
  for (const t of list) {
    const kind = A.versionOf(t);
    if (kind !== last) {
      const n = list.filter((x) => A.versionOf(x) === kind).length;
      out.push(h('div', { class: 'group-head mono' }, VERSION_GROUPS.find(([id]) => id === kind)[1] + ' · ' + n));
      last = kind;
    }
    out.push(searchRow(t));
  }
  return out;
}

function homeState() {
  return h('div', { class: 'home' },
    setupCard(),
    h('h2', null, 'Dig'),
    h('p', { class: 'fg2' }, 'Type at the top and press ⏎. Soundeo, Beatport and SoundCloud are searched together, and the same track from several sources merges into one row. Beatport brings BPM and key; for Soundeo-only rows they\'re looked up a few at a time as rows come on screen, so Soundeo isn\'t hammered.'),
    h('div', { class: 'home-keys' },
      [['/', 'search'], ['↑↓', 'move'], ['⏎', 'play from here'], ['Space', 'play / pause'], ['J K', 'previous / next'], ['← →', 'seek 10s'],
        ['A', 'add to playlist or set'], ['G', 'tag'], ['I', 'details and private note'], ['⇧↑↓', 'select several'], ['Q', 'queue'], ['?', 'every key']]
        .map(([k, l]) => h('div', null, h('kbd', null, k), h('span', null, l)))));
}

// ---- setup -------------------------------------------------------------------------
// What a new member still has to do, each with its real state and the fix.
// On Dig until the essentials are done (a name, and the shared space), and
// always at the top of Settings.

function setupItems() {
  const fav = S.collections['so-favorites'];
  const so = !fav || fav.state === 'idle' || fav.state === 'loading' ? 'wait' : fav.state === 'done' ? 'ok' : 'todo';
  const bp = S.bpAuth ? S.bpAuth.state : 'wait';
  const named = !!store.prefs.me;
  return [
    { need: true, state: named ? 'ok' : 'todo', label: named ? 'You\'re ' + store.prefs.me : 'Pick a display name',
      how: 'Friends see it on everything you add, move, colour or comment.',
      act: ['' + (named ? 'Change' : 'Set name'), () => openOverlay('prompt', { mode: 'name' })] },
    { need: true, state: shared.on() ? 'ok' : shared.status.mode === 'error' ? 'warn' : 'todo',
      label: shared.on() ? 'Shared space connected' : shared.status.mode === 'error' ? 'Shared space unreachable' : 'Connect the shared space',
      how: shared.on() ? 'Playlists, sets and comments sync with the group.'
        : 'In Shim\'s sidebar, open Crate\'s settings, find the "shared" connection and paste the project URL and key from your invite. Then reload Crate.' + (shared.status.error ? ' (' + shared.status.error + ')' : '') },
    { state: so, label: 'Soundeo', how: so === 'ok' ? 'Signed in: search, favorites and ♥ work.' : so === 'wait' ? 'Checking…' : 'Needs a Soundeo account: sign in to soundeo.com in a normal Shim tab, then reload Crate.' },
    { state: bp, label: 'Beatport', how: bp === 'ok' ? 'Signed in: search, BPM and key, and your playlists.' : bp === 'wait' ? 'Checking…' : 'Needs a Beatport account: sign in to beatport.com in a normal Shim tab, then reload Crate.' },
    { state: 'ok', label: 'SoundCloud', how: 'Works without signing in.' + (store.prefs.scProfile ? '' : ' Add your profile name in Settings to see your Likes.') },
  ];
}

export function setupDone() {
  return setupItems().every((i) => !i.need || i.state === 'ok');
}

function setupList(items) {
  const icon = { ok: '✓', todo: '○', warn: '!', wait: '·' };
  return h('div', { class: 'setup' }, items.map((i) => h('div', { class: 'setup-row is-' + i.state },
    h('span', { class: 'setup-icon mono' }, icon[i.state]),
    h('div', { class: 'grow' }, h('div', null, i.label, i.need ? null : h('span', { class: 'fg3 small' }, '  optional')), h('div', { class: 'fg2 small' }, i.how)),
    i.act ? h('button', { class: 'btn', onclick: i.act[1] }, i.act[0]) : null)));
}

function setupCard() {
  if (setupDone() || store.prefs.setupHidden) return null;
  return h('div', { class: 'setup-card' },
    h('div', { class: 'setup-head' }, h('h3', null, 'Getting set up'),
      h('button', { class: 'link small', onclick: () => { store.prefs.setupHidden = true; store.savePrefs(); render(); } }, 'Hide')),
    setupList(setupItems()));
}

function noResults() {
  const f = store.prefs.filters || {};
  const others = S.results;
  const count = (pred) => others.filter(pred).length;
  const sugg = [];
  if (f.genre) sugg.push({ label: 'Remove Genre ' + f.genre, note: count((t) => !f.days || (t.released && (Date.now() - Date.parse(t.released)) / 864e5 <= f.days)) + ' tracks match', run: () => A.setFilters({ ...f, genre: '' }) });
  if (f.days) sugg.push({ label: 'Remove Released ' + f.days + ' days', note: count((t) => !f.genre || t.genre === f.genre) + ' tracks match', run: () => A.setFilters({ ...f, days: 0 }) });
  if (f.bpmLo || f.bpmHi) sugg.push({ label: 'Remove BPM ' + (f.bpmLo || 0) + '–' + (f.bpmHi || 260), note: 'search again', run: () => A.setFilters({ ...f, bpmLo: 0, bpmHi: 0 }) });
  if (f.key) sugg.push({ label: 'Remove Key ' + f.key, note: 'search again', run: () => A.setFilters({ ...f, key: '', keyWide: false }) });
  if (sugg.length > 1) sugg.push({ label: 'Clear all filters', note: '', run: () => A.setFilters({}) });
  return h('div', { class: 'noresults' },
    h('h2', null, 'No tracks for “' + S.q + '”'),
    h('p', { class: 'fg2' }, others.length ? 'Your sources answered with ' + others.length + ' tracks. Your filters are narrower than the matches.' : sugg.length ? 'Your sources answered. Your filters may be narrower than the matches.' : 'Your sources answered with nothing.'),
    sugg.length ? h('div', { class: 'sugg' }, sugg.map((s, i) => h('button', { class: 'sugg-row' + (i === 0 ? ' is-focus' : ''), onclick: s.run }, h('span', { class: 'grow' }, s.label), h('span', { class: 'mono dim' }, s.note), i === 0 ? h('kbd', null, '⏎') : null))) : null,
    h('p', { class: 'dim small' }, 'Matching ignores punctuation, “feat.” and mix names. Fewer words usually find more.'));
}

// ---- 03 library ------------------------------------------------------------------

function libraryView() {
  const lists = A.libraryLists();
  const head = h('div', { class: 'page-head' },
    h('h1', null, 'Library'),
    seg([['all', 'All'], ['playlists', 'Playlists'], ['sets', 'Sets'], ['shared', 'Shared with me']], S.libFilter, (v) => { S.libFilter = v; render(); }),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn', onclick: () => openOverlay('prompt', { mode: 'new-playlist' }) }, 'New playlist ', h('kbd', null, 'N')),
    h('button', { class: 'btn', onclick: () => openOverlay('prompt', { mode: 'new-set' }) }, 'New set ', h('kbd', null, '⇧N')));
  const colhead = h('div', { class: 'colhead grid-lib' }, h('span'), h('span', null, 'NAME'), h('span', null, 'TYPE'), h('span', null, 'OWNER'), h('span', { class: 'num' }, 'TRACKS'), h('span', { class: 'num' }, 'LENGTH'), h('span', null, 'UPDATED'), h('span', null, 'SHARING'));
  const row = (p) => {
    const r = h('div', { class: 'row grid-lib', dataset: { k: p.id } },
      h('span', { class: 'dim' }, p.kind === 'set' ? '≡' : '♫'),
      h('span', { class: 'ellip t' }, p.name),
      h('span', { class: 'fg2' }, p.kind === 'set' ? 'Set' : 'Playlist'),
      h('span', { class: 'owner' }, avatar(p.owner), h('span', { class: 'ellip' }, p.owner)),
      h('span', { class: 'mono num' }, p.entries.length),
      h('span', { class: 'mono num' }, fmtTotal(total(p))),
      h('span', { class: 'mono fg3' }, ago(p.updatedAt)),
      h('span', { class: 'fg3' }, p.shared ? 'Group' : 'Private'));
    r.addEventListener('mousedown', () => A.setFocus(p.id));
    r.addEventListener('dblclick', () => A.openList(p.id));
    return r;
  };
  let body;
  if (S.libFilter === 'shared') body = h('div', { class: 'empty' }, h('p', { class: 'fg2' }, 'Shared playlists show up here once the shared space is connected. That comes next.'));
  else if (!lists.length) body = h('div', { class: 'empty' }, h('p', { class: 'fg2' }, 'No playlists or sets yet. Press N to start a playlist, ⇧N for a set, or A on any track.'));
  else if (S.libFilter === 'all') {
    const pls = lists.filter((p) => p.kind === 'playlist'), sets = lists.filter((p) => p.kind === 'set');
    body = h('div', { class: 'rows' },
      pls.length ? [h('div', { class: 'group-head mono' }, 'PLAYLISTS · ' + pls.length), pls.map(row)] : null,
      sets.length ? [h('div', { class: 'group-head mono' }, 'SETS · ' + sets.length), sets.map(row)] : null);
  } else body = h('div', { class: 'rows' }, lists.map(row));
  return h('div', { class: 'view view-library' }, head, colhead, body,
    h('div', { class: 'foot mono' }, hints(['⏎', 'open'], ['N', 'new playlist'], ['⇧N', 'new set'], ['R', 'rename'], ['⌫', 'delete'])));
}

// ---- 04 playlist / 05 set ------------------------------------------------------------

function legend() {
  return h('span', { class: 'legend' }, [1, 2, 3, 4, 5, 6, 7, 8].map((c) => h('span', { class: 'swatch', style: { background: 'var(--tcs' + c + ')' } }, c)), h('span', { class: 'swatch swatch-none' }, '0'));
}

function focusLine() {
  if (S.view !== 'list') return [];
  const r = A.focusedRow();
  if (!r || !r.entry) return ['Nothing focused'];
  const e = r.entry;
  const bits = ['Focused: ', h('b', null, r.track.title)];
  if (e.color) bits.push(' · colour ' + e.color + ' set by ' + e.colorBy + (e.colorAt ? ', ' + ago(e.colorAt) : ''));
  if (e.energy) bits.push(' · energy ' + e.energy + ' by ' + e.energyBy);
  return bits;
}

// Comments on the entry, and a pencil when you have a note on the track.
function commentCell(e) {
  const note = store.noteFor(e.track).body;
  const n = shared.on() ? shared.commentCount(S.listId, e.k) : 0;
  return h('button', { class: 'fg3 c-cmt', title: (note ? 'Your note: ' + note + '. ' : '') + (shared.on() ? n + ' comments · click to comment' : 'Details'), onclick: (ev) => { ev.stopPropagation(); openComments(e.k); } },
    note ? '✎' : '', n ? h('span', { class: 'mono' }, '💬' + n) : null,
    !note && !n ? h('span', { class: 'c-cmt-empty' }, '+') : null);
}

function playlistRow(e) {
  const row = h('div', {
    class: 'row grid-playlist' + (isNew(e.k) ? ' is-new' : ''), dataset: { k: e.k, track: e.k },
    style: { gridTemplateColumns: gridCols('playlist'), ...(e.color && !isNew(e.k) ? { background: 'var(--tc' + e.color + ')' } : {}) },
  }, tableCells('playlist', e));
  rowEvents(row, e.k);
  dragKeys(row, e.k);
  dropReorder(row, e.k);
  return row;
}

// Clickable stars: the click's position picks a half step (left edge = 0).
function pickEnergy(e) {
  const el = energy(e.energy);
  el.classList.add('is-pick');
  el.title = 'Energy ' + (e.energy || 0) + ' / 5 · click to set, [ ] to nudge';
  el.addEventListener('mousedown', (ev) => ev.stopPropagation());
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const r = el.getBoundingClientRect();
    const v = Math.max(0, Math.min(5, Math.round((ev.clientX - r.left) / r.width * 10) / 2));
    A.setFocus(e.k);
    A.setEnergy(v === e.energy ? 0 : v, false);
  });
  return el;
}

function pickSwatch(e) {
  const el = h('button', { class: 'swatch-btn', title: (e.color ? 'Colour ' + e.color + (e.colorBy ? ' · ' + e.colorBy : '') : 'No colour') + ' · click to change, 1–8 / 0' }, swatch(e.color, e.colorBy));
  el.addEventListener('mousedown', (ev) => ev.stopPropagation());
  el.addEventListener('click', (ev) => { ev.stopPropagation(); A.setFocus(e.k); openOverlay('colour'); });
  return el;
}

function openComments(k) {
  A.setFocus(k);
  S.panel = true;
  render();
  if (!focusComment()) focusNote();
}

// A friend's change arrived in the last few seconds.
function isNew(k) {
  const at = shared.arrived.get(S.listId + '|' + k);
  return !!at && Date.now() - at < 5000;
}

function dropReorder(row, k) {
  row.addEventListener('dragover', (ev) => { if (ev.dataTransfer.types.includes('text/crate-move') && !S.groupByColour) { ev.preventDefault(); row.classList.add('is-drop'); } });
  row.addEventListener('dragleave', () => row.classList.remove('is-drop'));
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    row.classList.remove('is-drop');
    const moving = ev.dataTransfer.getData('text/crate-move');
    if (moving && moving !== k) A.moveTo(moving, k);
  });
}

function listView() {
  const p = store.getList(S.listId);
  if (!p) return h('div', { class: 'view' }, h('div', { class: 'empty' }, 'That list is gone.'));
  return p.kind === 'set' ? setView(p) : playlistView(p);
}

function playlistView(p) {
  const dur = total(p);
  const head = h('div', { class: 'page-head' },
    h('div', { class: 'title-block' },
      h('h1', { class: 'editable', title: 'Rename (R)', onclick: () => openOverlay('prompt', { mode: 'rename', id: p.id }) }, p.name),
      h('div', { class: 'mono fg3 small' }, p.entries.length + ' tracks · ' + fmtTotal(dur) + (p.shared ? ' · shared with the group' + (p.owner !== store.me() ? ' · by ' + p.owner : '') : ' · on this machine only'))),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn btn-fill', onclick: A.playAll }, '▶ Play all ', h('kbd', null, 'P')),
    h('button', { class: 'btn btn-accent', onclick: A.forkToSet }, 'Fork to set ', h('kbd', null, '⇧F')),
    h('button', { class: 'btn', title: 'More from this playlist\'s artists and labels, at its BPM only', onclick: () => A.suggestFor(p.id) }, 'Suggest tracks ', h('kbd', null, 'U')),
    h('button', { class: 'btn', onclick: A.exportLinks }, 'Export links'),
    h('button', { class: 'btn' + (S.groupByColour ? ' is-on' : ''), onclick: () => { S.groupByColour = !S.groupByColour; render(); } }, 'Group: ' + (S.groupByColour ? 'Colour' : 'None')),
    columnsButton('playlist'),
    legend());
  const colhead = tableHead('playlist', 'grid-playlist');
  let body;
  if (!p.entries.length) body = h('div', { class: 'empty' }, h('p', { class: 'fg2' }, 'Empty. In Search, press A on a track (or drag it onto this playlist in the sidebar).'));
  else if (S.groupByColour) {
    const groups = new Map();
    for (const e of A.groupedEntries(p)) { const c = e.color || 0; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(e); }
    body = h('div', { class: 'rows' }, [...groups.entries()].map(([c, es]) => [
      h('div', { class: 'group-head' }, swatch(c), h('span', null, c ? 'Colour ' + c : 'No colour'), h('span', { class: 'mono dim' }, es.length + ' tracks · ' + fmtTotal(es.reduce((s, e) => s + (e.track.len || 0), 0)))),
      es.map(playlistRow)]));
  } else body = h('div', { class: 'rows' }, p.entries.map(playlistRow));
  return h('div', { class: 'view view-list' }, head, colhead, body,
    h('div', { class: 'foot foot-split mono' }, h('span', { class: 'foot-focus' }, focusLine()),
      hints(['1–8', 'colour'], ['[ ]', 'energy'], ['⌥↑↓', 'move'], ['⌫', 'remove'], ['⇧↑↓', 'select'])));
}

function setView(p) {
  const dur = total(p);
  let clashes = 0, jumps = 0;
  for (let i = 0; i + 1 < p.entries.length; i++) {
    const a = p.entries[i].track, b = p.entries[i + 1].track;
    const k = keyCompat(a.camelot, b.camelot), bp = bpmCompat(a.bpm, b.bpm);
    if (k && k.level === 'bad') clashes++;
    if (bp && bp.level === 'bad') jumps++;
  }
  const issues = [clashes ? clashes + (clashes === 1 ? ' clash' : ' clashes') : '', jumps ? jumps + (jumps === 1 ? ' BPM jump' : ' BPM jumps') : ''].filter(Boolean).join(' · ');
  const head = h('div', { class: 'page-head' },
    h('div', { class: 'title-block' },
      h('h1', { class: 'editable', title: 'Rename (R)', onclick: () => openOverlay('prompt', { mode: 'rename', id: p.id }) }, p.name),
      h('div', { class: 'mono fg3 small' }, 'Set · ' + p.entries.length + ' tracks · ' + fmtTotal(dur) + (p.forkedFrom ? ' · forked from ' + p.forkedFrom : ''))),
    h('span', { class: 'grow' }),
    issues ? h('span', { class: 'issues mono' }, issues, ' ', h('kbd', null, '⇧E')) : h('span', { class: 'mono ok small' }, p.entries.length > 1 ? 'every transition fits' : ''),
    h('button', { class: 'btn btn-fill', onclick: A.playAll }, '▶ Play from top ', h('kbd', null, 'P')),
    h('button', { class: 'btn', onclick: A.exportLinks }, 'Export'));

  const focusK = A.focusKey();
  const arc = h('div', { class: 'arc' },
    h('div', { class: 'arc-bars' }, p.entries.map((e) => h('span', {
      class: 'arc-bar' + (e.k === focusK ? ' is-focus' : ''),
      title: e.track.title + ' · energy ' + (e.energy || 0),
      style: { flexGrow: String(e.track.len || 300), height: Math.max(4, (e.energy || 0) / 5 * 100) + '%', background: e.color ? 'var(--tcs' + e.color + ')' : 'var(--fg3)' },
      onclick: () => A.setFocus(e.k),
    }))),
    h('div', { class: 'arc-axis mono' }, h('span', null, '5★'), h('span', null, '0')));

  let start = 0;
  const slots = [];
  p.entries.forEach((e, i) => {
    const t = e.track;
    const row = h('div', { class: 'row grid-set' + (isNew(e.k) ? ' is-new' : ''), dataset: { k: e.k, track: e.k } },
      h('span', { class: 'handle', title: 'Drag, or ⌥↑↓' }, '⋮⋮'),
      h('span', { class: 'mono fg3 num' }, i + 1),
      h('span', { class: 'cbar', style: { background: e.color ? 'var(--tcs' + e.color + ')' : 'var(--line)' } }),
      art(t.art50, 24),
      h('span', { class: 'ellip c-title' }, h('span', { class: 't' }, t.title), t.mix ? h('span', { class: 'fg2' }, ' ' + t.mix) : null, h('span', { class: 'fg3' }, ' · ' + t.artist)),
      h('span'),
      h('span', { class: 'mono num' }, t.bpm || ''),
      h('span', { class: 'mono' }, t.camelot),
      pickEnergy(e),
      h('span', { class: 'mono num' }, fmtLen(t.len)),
      h('span', { class: 'mono fg3 num' }, fmtLen(start) || '0:00'),
      h('span', { class: 'owner' }, avatar(e.addedBy)));
    rowEvents(row, e.k);
    dragKeys(row, e.k);
    dropReorder(row, e.k);
    slots.push(row);
    start += t.len || 0;
    const nxt = p.entries[i + 1];
    if (nxt) {
      const c = compat(t, nxt.track, e.note ? { text: e.note, by: e.noteBy } : null);
      c.addEventListener('click', () => { A.setFocus(e.k); openOverlay('prompt', { mode: 'transition', id: p.id, k: e.k }); });
      slots.push(c);
    }
  });
  const body = p.entries.length ? h('div', { class: 'rows rows-set' }, slots)
    : h('div', { class: 'empty' }, h('p', { class: 'fg2' }, 'Empty set. In Search, press A on a track, or fork a playlist into a set.'));
  return h('div', { class: 'view view-list' }, head, p.entries.length ? arc : null, body,
    h('div', { class: 'foot foot-split mono' }, hints(['⌥↑↓', 'move'], ['[ ]', 'energy'], ['T', 'transition note'], ['⌫', 'remove'], ['1–8', 'colour']),
      h('span', { class: 'dim' }, 'Energy arc: height = energy, colour = track colour, width = length')));
}

// ---- 07 settings ---------------------------------------------------------------------

function settingsView() {
  const src = (s) => {
    const live = S.sources[s.id];
    const st = !s.ready ? ['off', 'Not set up'] : live.state === 'error' ? ['warn', 'Error · ' + live.error] : live.state === 'done' ? ['ok', 'Working · ' + live.count + ' results last search'] : ['ok', 'Ready'];
    return h('div', { class: 'set-row grid-sources' + (s.ready && live.state === 'error' ? ' is-warn' : '') },
      chip(s.id, { unset: !s.ready }),
      h('span', null, s.name),
      h('span', { class: 'fg2' }, s.how),
      h('span', { class: 'st st-' + st[0] }, h('span', { class: 'dot' }), st[1]),
      h('span', { class: 'mono fg3' }, s.ready && S.searched ? 'this session' : ''),
      s.ready ? h('button', { class: 'btn', onclick: () => A.runSearch(S.q || 'house') }, 'Test') : h('span', { class: 'dim small' }, 'coming soon'));
  };
  const nameInput = h('input', { class: 'field', value: store.prefs.me || '', placeholder: 'Your name', maxlength: 32 });
  nameInput.addEventListener('change', () => { store.prefs.me = nameInput.value.trim(); store.savePrefs(); render('top'); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur(); });
  const idInput = h('input', { class: 'field mono', value: store.prefs.uid || '', title: 'Your id', maxlength: 64, spellcheck: 'false' });
  idInput.addEventListener('change', () => {
    const v = idInput.value.trim();
    if (!store.VALID_UID.test(v)) { idInput.value = store.prefs.uid; toastMsg('An id is 8 to 64 letters, digits or hyphens'); return; }
    store.prefs.uid = v; store.savePrefs(); render();
  });
  idInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') idInput.blur(); });
  const copyId = h('button', { class: 'btn', onclick: () => A.copy(store.prefs.uid).then((ok) => toastMsg(ok ? 'Copied your id' : 'Couldn\'t copy: clipboard blocked')) }, 'Copy id');
  return h('div', { class: 'view view-settings' }, h('div', { class: 'settings' },
    h('h1', null, 'Settings'),
    section('SETUP'),
    setupList(setupItems()),
    section('SOURCES'),
    h('div', { class: 'set-table' }, SOURCES.map(src)),
    h('p', { class: 'dim small' }, 'Soundeo uses your signed-in session in Shim. If it says you\'re signed out, sign in to soundeo.com in a normal Shim tab, then press Test. SoundCloud needs no sign-in: Crate uses the public key SoundCloud\'s own site uses, and plays full streams where the uploader allows.'),
    section('SOUNDCLOUD LIKES'),
    scProfileField(),
    section('YOU'),
    h('div', { class: 'set-block' }, nameInput, h('p', { class: 'fg2 small' }, 'How friends will see your edits and comments. It isn\'t an account: anyone in the group can write anything.'),
      h('div', { class: 'id-row' }, idInput, copyId),
      h('p', { class: 'fg2 small' }, 'Your notes are filed under this id, so they stay yours when you change your name. Give the Track Notes shim on Soundeo the same id and name, and both write the same notes.')),
    section('MEDIA KEYS'),
    h('p', { class: 'fg2 small set-block' }, '⏯ ⏭ ⏮ on your keyboard control Crate while it\'s the last tab that played audio, even when Crate isn\'t focused. If another tab plays (Soundeo with your Hotkeys shim, say), the keys follow it until you press ▶ here again.'),
    section('SHARED SPACE · SUPABASE'),
    sharedSettings(),
    section('SHARE CRATE'),
    h('div', { class: 'fg2 small set-block' },
      h('p', null, 'To bring a friend in:'),
      h('ol', { class: 'steps' },
        h('li', null, 'In Shim\'s library, export Crate as crate.shim and send it.'),
        h('li', null, 'Send the shared space\'s project URL and publishable key separately. The key is meant to be shared; it only reaches the group\'s tables.'),
        h('li', null, 'They import crate.shim in Shim, allow the sites it asks for, paste the URL and key into Crate\'s "shared" connection, and pick a name.')),
      h('p', null, 'Each person signs in to Soundeo and Beatport with their own account. SoundCloud needs none. An imported copy doesn\'t update when you change yours: send a new crate.shim.'))));
}

function scProfileField() {
  const input = h('input', { class: 'field', value: store.prefs.scProfile || '', placeholder: 'your-profile-name', maxlength: 64, spellcheck: 'false' });
  const save = () => {
    const v = input.value.trim().replace(/^https?:\/\/(www\.)?soundcloud\.com\//, '').replace(/\/.*$/, '');
    if (v === (store.prefs.scProfile || '')) return;
    store.prefs.scProfile = v;
    store.savePrefs();
    reloadCollection('sc-likes');
    render();
  };
  input.addEventListener('change', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
  return h('div', { class: 'set-block' }, h('div', null, h('span', { class: 'fg3 mono' }, 'soundcloud.com/ '), input),
    h('p', { class: 'fg2 small' }, 'Likes are public on SoundCloud, so Crate reads them from your profile name. They show under From your sources.'));
}

function sharedSettings() {
  const st = shared.status;
  if (st.mode === 'on') {
    const local = store.uncopiedLocal();
    const copy = h('button', { class: 'btn', onclick: async () => {
      copy.disabled = true;
      copy.textContent = 'Copying…';
      const n = await store.copyLocalToShared();
      toastMsg('Copied ' + n + (n === 1 ? ' list' : ' lists') + ' to the shared space');
      render();
    } }, 'Copy ' + local.length + (local.length === 1 ? ' local list' : ' local lists') + ' to the shared space');
    return h('div', { class: 'set-block' },
      h('p', null, h('span', { class: 'st st-ok' }, h('span', { class: 'dot' }), 'Connected · checking for friends\' changes every 5s · last sync ' + ago(st.lastSync || Date.now()))),
      h('p', { class: 'fg2 small' }, 'The project URL and key are stored encrypted in Shim; this page never sees them.'),
      h('p', { class: 'fg2 small' }, 'In the group so far: ', shared.members().join(', ') || 'just you'),
      st.writeError ? h('p', { class: 'warn small' }, 'Last write rejected: ' + st.writeError) : null,
      local.length ? h('div', null, h('p', { class: 'fg2 small' }, 'Playlists you made before connecting are still on this machine only:', ' ', local.map((p) => p.name).join(', ')), copy) : null);
  }
  return h('div', { class: 'set-block shared-off' },
    h('p', null, h('span', { class: 'st st-' + (st.mode === 'error' ? 'warn' : 'off') }, h('span', { class: 'dot' }), st.mode === 'error' ? 'Can\'t reach it · ' + st.error : 'Not connected')),
    h('p', { class: 'fg2 small' }, 'Connect the group\'s Supabase project in Shim: open Crate\'s settings in Shim\'s sidebar, find the "shared" connection, and paste the project URL and its publishable key. The key stays in Shim; this page never sees it. Then reload Crate.'),
    h('p', { class: 'fg2 small' }, 'Until then, playlists and sets are saved on this machine only.'));
}

let toastMsg = () => {};
export function setToast(fn) { toastMsg = fn; }

// ---- 06 activity -------------------------------------------------------------------

function activityView() {
  if (!shared.on()) {
    return h('div', { class: 'view' }, h('div', { class: 'home' }, h('h2', null, 'Activity'),
      h('p', { class: 'fg2' }, 'What friends change in shared playlists and sets shows up here once the shared space is connected (Settings).')));
  }
  const { fresh, old } = A.activityItems();
  const items = [...fresh, ...old];
  const byList = new Map();
  for (const a of fresh) { const key = a.listId || ''; if (!byList.has(key)) byList.set(key, []); byList.get(key).push(a); }
  const item = (a, unread) => {
    const row = h('div', { class: 'act-row row' + (unread ? ' is-unread' : ''), dataset: { k: 'a' + a.id } },
      h('span', { class: 'act-dot' }, unread ? '●' : ''),
      avatar(a.actor),
      h('span', { class: 'grow' }, h('b', null, a.actor), ' ', shared.describe(a),
        a.verb === 'commented' || a.verb === 'noted' || a.verb === 'track-noted' ? h('div', { class: 'act-quote' }, (a.detail.body || a.detail.note || '')) : null),
      h('span', { class: 'mono fg3' }, ago(a.at)));
    row.addEventListener('mousedown', () => A.setFocus('a' + a.id));
    row.addEventListener('dblclick', () => A.openActivity(a));
    return row;
  };
  const groups = [...byList.entries()].map(([id, as]) => {
    const l = shared.getList(id);
    return [h('div', { class: 'group-head mono' }, (l ? l.name : id ? 'Deleted' : 'Match fixes').toUpperCase() + ' · ' + as.length), as.map((a) => item(a, true))];
  });
  return h('div', { class: 'view view-activity' },
    h('div', { class: 'page-head' }, h('h1', null, 'Activity'),
      h('span', { class: 'mono fg3 small' }, fresh.length ? fresh.length + ' new since you last looked' : 'Nothing new'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: A.markSeen }, 'Mark all seen ', h('kbd', null, '⇧M'))),
    h('div', { class: 'rows act-rows' }, groups, old.length ? [h('div', { class: 'group-head mono' }, 'SEEN'), old.map((a) => item(a, false))] : null,
      !items.length ? h('div', { class: 'empty' }, h('p', { class: 'fg2' }, 'No activity yet. Add a track to a playlist and it shows up here for everyone.')) : null),
    h('div', { class: 'foot mono' }, hints(['↑↓', 'move'], ['⏎', 'open'], ['⇧M', 'mark all seen'])));
}

// ---- 02 track detail ------------------------------------------------------------------

let panelFor = null;

export function panelTrack() {
  const r = A.focusedRow();
  return r && r.track ? r.track : null;
}

export function renderPanel(el, force) {
  const t = S.panel ? panelTrack() : null;
  el.classList.toggle('is-open', !!t);
  if (!t) { el.replaceChildren(); panelFor = null; return; }
  const active = document.activeElement;
  if (!force && panelFor === t.k && active && el.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
  panelFor = t.k;
  const note = store.noteFor(t);
  const sharing = store.canShareNote(t) && !store.isPrivate(t);
  const textarea = h('textarea', { class: 'note', placeholder: (sharing ? '' : 'Only you see this. ') + 'Where it works, what to mix it with…', rows: 4, maxlength: 4000 });
  textarea.value = note.body;
  let saveTimer = 0;
  const saveNote = () => { clearTimeout(saveTimer); if (textarea.value !== store.noteFor(t).body) store.setNote(t, textarea.value); };
  textarea.addEventListener('input', () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNote, sharing ? 1200 : 400); });
  textarea.addEventListener('blur', saveNote);
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); textarea.blur(); } });
  const visibility = store.canShareNote(t) ? h('button', {
    class: 'link small note-vis',
    onclick: async () => {
      saveNote();
      const ok = await store.setPrivate(t, sharing);
      if (!ok) toastMsg('Note not moved: ' + (shared.status.writeError || 'refused'));
      render('panel-force');
    },
  }, sharing ? 'Keep private' : 'Share with the group') : null;
  tracklists.ask(t);
  player.tempoOf(t);
  const tags = store.allTags();
  const inLists = store.allLists().filter((p) => p.entries.some((e) => e.k === t.k));
  const canSplit = Object.keys(t.sources || {}).length > 1 && (S.view === 'search' || S.view === 'list');
  const srcRows = Object.entries(t.sources || {}).map(([id, s]) => h('div', { class: 'src-row' },
    chip(id, { large: true }),
    h('span', { class: 'grow src-name' }, SOURCES.find((x) => x.id === id).name,
      h('span', { class: 'fg3 small ellip' }, [s.audio ? 'preview' + (s.clip ? ', clip' : '') : '', id === 'yt' ? [s.uploader, s.views ? s.views.toLocaleString() + ' views' : '', s.age].filter(Boolean).join(' · ') : '', id === 'sc' ? [s.uploader, s.plays ? s.plays.toLocaleString() + ' plays' : '', s.free ? 'free download' : ''].filter(Boolean).join(' · ') : '', t.matchedBy && MATCHED[t.matchedBy[id]]].filter(Boolean).join(' · '))),
    s.audio ? h('button', { class: 'btn', onclick: () => A.playFrom(t.k) }, '▶') : null,
    id === 'so' ? h('button', { class: 'btn' + (s.favored ? ' fav-on' : ''), title: s.favored ? 'Remove from your Soundeo favorites (L)' : 'Add to your Soundeo favorites (L)', onclick: () => A.toggleFavorite(t.k) }, s.favored ? '♥' : '♡') : null,
    canSplit ? h('button', { class: 'btn', title: 'Not the same track: split ' + srcName(id) + '\'s track off this row', onclick: () => A.splitSource(t.k, id) }, '✂') : null,
    openUrl(id, s.url) ? h('a', { class: 'btn open-link', href: openUrl(id, s.url), target: '_blank', rel: 'noopener noreferrer' }, 'Open ↗') : null));
  el.replaceChildren(h('div', { class: 'panel-inner' },
    h('div', { class: 'd-head' }, art(t.art500 || t.art50, 72),
      h('div', { class: 'd-meta' },
        h('div', { class: 'd-title' }, t.title),
        h('div', { class: 'fg2' }, t.artist + (t.mix ? ' · ' + t.mix : '')),
        h('div', { class: 'fg3 small' }, [t.label, t.released, t.genre].filter(Boolean).join(' · ')),
        h('div', { class: 'mono small' }, [t.bpm ? t.bpm + (t.bpmGuess ? '? BPM' : ' BPM') : '', t.camelot ? t.camelot + (musicalKey(t.camelot) ? ' (' + musicalKey(t.camelot) + ')' : '') : '', fmtLen(t.len)].filter(Boolean).join(' · ')))),
    h('div', { class: 'd-actions' }, h('button', { class: 'btn', title: 'Remixes, edits, bootlegs and VIPs of this track, from every source', onclick: () => A.findVersions(t) }, 'Find versions ', h('kbd', null, 'V')),
      h('button', { class: 'btn', title: 'Remixes, edits and bootlegs of this track on SoundCloud', onclick: () => A.findVersions(t, { sc: true }) }, chip('sc'), ' Remixes on SoundCloud ', h('kbd', null, '⇧V'))),
    djPlays(t),
    section('SOURCES'),
    h('div', { class: 'src-list' }, srcRows),
    matchNote(t),
    section(sharing ? 'YOUR NOTE · THE GROUP SEES IT' : 'PRIVATE NOTE · ONLY YOU', 'N'),
    textarea,
    visibility,
    h('div', { class: 'tag-pills' }, tags.map((tag) => h('button', { class: 'pill' + (note.tags.includes(tag) ? ' is-on' : ''), onclick: () => { A.setFocus(t.k); store.toggleTag([t], tag).then(() => render()); } }, tag)),
      h('button', { class: 'pill pill-add', onclick: () => openOverlay('tag') }, '+ tag ', h('kbd', null, 'G'))),
    groupNotes(t),
    inThisList(t),
    commentsSection(t),
    section('IN YOUR PLAYLISTS'),
    inLists.length ? h('div', { class: 'in-lists' }, inLists.map((p) => {
      const e = p.entries.find((x) => x.k === t.k);
      return h('button', { class: 'side-row', onclick: () => A.openList(p.id) }, swatch(e.color), h('span', { class: 'grow ellip' }, p.name), energy(e.energy));
    })) : h('p', { class: 'dim small' }, 'Not in any yet. A adds it.'),
    h('div', { class: 'foot mono' }, hints(['Esc', 'close'], ['N', 'note'], ['O', 'open link']))));
}

// How often DJs play it and where it is in its life, from 1001tracklists,
// which also fills in a release date, genre or label the sources left out.
function djPlays(t) {
  const v = tracklists.get(t);
  const id = tracklists.freshness(t);
  const badge = id ? h('span', { class: 'fresh fresh-' + id }, tracklists.FRESH[id][0]) : null;
  let body;
  if (v && v.state === 'done') {
    const extra = [!t.released && v.released ? 'released ' + v.released : '', !t.genre ? v.genre : '', !t.label ? v.label : ''].filter(Boolean).join(' · ');
    body = [h('div', { class: 'dj-line' }, h('span', { class: 'dj-n mono' }, v.playsText), h('span', { class: 'fg2' }, v.plays === 1 ? 'DJ tracklist has it' : 'DJ tracklists have it'), badge),
      id ? h('div', { class: 'fg3 small' }, tracklists.FRESH[id][1] + '.') : null,
      extra ? h('div', { class: 'fg3 small' }, extra) : null];
  } else if (v && v.state === 'none') {
    body = h('div', { class: 'dj-line' }, h('span', { class: 'fg2' }, 'No DJ tracklist has it.'), badge);
  } else if (v && v.state === 'loading') {
    body = h('div', { class: 'mono dim small' }, '··· asking 1001tracklists');
  } else {
    body = h('div', { class: 'dim small' }, tracklists.stopped() ? tracklists.stopped() + '.' : v ? '1001tracklists didn\'t answer.' : 'Not looked up yet.');
  }
  return [section('DJ PLAYS · 1001TRACKLISTS'), h('div', { class: 'dj-plays' }, body)];
}

const MATCHED = { isrc: 'ISRC match', preview: 'same preview', name: 'name match', fix: 'joined by hand' };

// Why these sources share a row, and the fixes you can undo (one line per kind).
function matchNote(t) {
  const fixes = links.fixesFor(t);
  const mine = new Set(links.refsOf(t));
  const by = (fs) => [...new Set(fs.map((f) => f.by).filter(Boolean))].join(', ');
  const line = (fs, text) => (fs.length ? h('div', { class: 'fix-row small' },
    h('span', { class: 'grow fg2' }, text, h('span', { class: 'fg3' }, by(fs) ? ' · ' + by(fs) : '')),
    h('button', { class: 'link fix-undo', onclick: () => A.undoFix(fs) }, 'Undo')) : null);
  const same = fixes.filter((f) => f.kind === 'same');
  const split = fixes.filter((f) => f.kind === 'split');
  const apart = [...new Set(split.map((f) => (mine.has(f.a) ? f.b : f.a)).map((r) => srcName(r.split(':')[0])))];
  const hint = Object.keys(t.sources || {}).length > 1
    ? 'Wrong match? ✂ splits that source off this row.'
    : S.view === 'search' ? 'Same track as another row? Join it below, or select both and press M.' : 'Sources join this row when a search finds the same track.';
  const lines = [line(same, 'Joined by hand'), line(split, 'Kept apart from ' + (apart.length === 1 ? 'a ' + apart[0] + ' track' : 'tracks on ' + apart.join(' and ')))].filter(Boolean);
  const maybe = A.joinCandidates(t).map((x) => h('div', { class: 'fix-row small' },
    h('span', { class: 'lanes-mini' }, Object.keys(x.sources).map((id) => chip(id))),
    h('span', { class: 'grow ellip fg2' }, x.artist + ' – ' + x.title + (x.mix ? ' (' + x.mix + ')' : '')),
    h('button', { class: 'link', title: 'Same recording: join it into this row', onclick: () => A.joinRows([t.k, x.k]) }, 'Join')));
  return [h('p', { class: 'dim small' }, hint), lines.length ? h('div', { class: 'fixes' }, lines) : null,
    maybe.length ? [h('div', { class: 'fg3 small' }, 'Maybe the same track:'), h('div', { class: 'fixes' }, maybe)] : null];
}

// Everyone else's note on this track, newest first.
function groupNotes(t) {
  const list = store.othersNotes(t).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) return null;
  return [
    section('NOTES FROM THE GROUP'),
    h('div', { class: 'comments' }, list.map((n) => h('div', { class: 'comment' },
      avatar(n.author), h('div', { class: 'grow' },
        h('div', null, h('b', null, n.author), h('span', { class: 'mono fg3' }, ' · ' + ago(n.updatedAt))),
        n.body ? h('div', { class: 'comment-body' }, n.body) : null,
        n.tags.length ? h('div', { class: 'tags group-tags' }, n.tags.map((tag) => h('span', { class: 'tag' }, tag))) : null)))),
  ];
}

// Colour and energy for this track in the open playlist or set.
function inThisList(t) {
  if (S.view !== 'list' || !S.listId) return null;
  const l = store.getList(S.listId);
  const e = l && l.entries.find((x) => x.k === t.k);
  if (!e) return null;
  return [
    section('IN ' + l.name.toUpperCase()),
    h('div', { class: 'in-this' },
      h('div', { class: 'swatch-row' }, [0, 1, 2, 3, 4, 5, 6, 7, 8].map((c) => h('button', {
        class: 'swatch-btn' + (e.color === c ? ' is-on' : ''), title: c ? 'Colour ' + c + ' (' + c + ')' : 'No colour (0)',
        onclick: () => { A.setFocus(t.k); A.setColour(c); },
      }, swatch(c)))),
      h('div', { class: 'energy-row' }, pickEnergy(e), h('span', { class: 'mono fg3 small' }, e.energy ? e.energy + ' / 5' + (e.energyBy ? ' · ' + e.energyBy : '') : 'no energy yet'))),
  ];
}

// Comments belong to a track within one shared playlist, so they show while
// you're in that playlist or set.
function commentsSection(t) {
  if (!shared.on() || S.view !== 'list' || !S.listId) return null;
  const l = shared.getList(S.listId);
  if (!l) return null;
  const list = shared.commentsFor(l.id, t.k);
  const input = h('input', { class: 'field comment-input', placeholder: 'Comment in ' + l.name + '…', maxlength: 4000 });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); input.blur(); return; }
    if (e.key !== 'Enter' || !input.value.trim()) return;
    e.preventDefault();
    const body = input.value.trim();
    if (store.unnamed()) return;
    input.disabled = true;
    const ok = await shared.postComment(l.id, t.k, body);
    input.disabled = false;
    if (ok) { input.value = ''; render('panel-force'); } else toastMsg('Comment not saved: ' + (shared.status.writeError || 'refused'));
  });
  return [
    section('COMMENTS · ' + l.name.toUpperCase(), 'C'),
    list.length ? h('div', { class: 'comments' }, list.map((c) => h('div', { class: 'comment' },
      avatar(c.author), h('div', { class: 'grow' }, h('div', null, h('b', null, c.author), h('span', { class: 'mono fg3' }, ' · ' + ago(c.at))), h('div', { class: 'comment-body' }, c.body)))))
      : h('p', { class: 'dim small' }, 'No comments yet.'),
    input,
  ];
}

export function focusComment() {
  const i = document.querySelector('#panel .comment-input');
  if (i) i.focus();
  return !!i;
}

export function focusNote() {
  const ta = document.querySelector('#panel textarea');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

export function focusOpenLink() {
  const a = document.querySelector('#panel .open-link');
  if (a) a.focus();
  return !!a;
}

