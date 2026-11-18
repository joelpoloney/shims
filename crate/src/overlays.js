// Overlays: keyboard map, add-to palette, tag palette, queue, filters, prompts.
// Each is mounted once when opened and updates its own list while you type.

import { h, neighbours, parseCamelot } from './util.js';
import { S, render, toast } from './state.js';
import * as store from './store.js';
import * as player from './player.js';
import * as A from './actions.js';
import * as columns from './columns.js';

let root = null;
let active = null; // { kind, onKey(e) → handled, el }

export function mountOverlays(el) { root = el; }

export function openOverlay(kind, opts = {}) {
  if (!root) return;
  closeOverlay(true);
  const build = BUILDERS[kind];
  if (!build) return;
  S.overlay = { kind, ...opts };
  active = build(opts);
  active.kind = kind;
  root.replaceChildren(active.el);
  root.classList.add('is-open');
  root.classList.toggle('is-anchored', kind === 'queue');
  if (active.focus) active.focus();
  render('player');
}

export function closeOverlay(silent) {
  if (!root) return;
  S.overlay = null;
  active = null;
  root.replaceChildren();
  root.classList.remove('is-open', 'is-anchored');
  if (!silent) render();
}

export function overlayKey(e) {
  if (!active) return false;
  if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); return true; }
  return active.onKey ? active.onKey(e) : false;
}

export const overlayOpen = () => !!active;

if (typeof document !== 'undefined') {
  document.addEventListener('mousedown', (e) => {
    if (active && root && !active.el.contains(e.target) && !e.target.closest('.p-right')) closeOverlay();
  });
}

// ---- palette (shared by add-to and tag) -------------------------------------------

function palette({ title, placeholder, items, onPick, onCreate, createLabel, footer }) {
  const input = h('input', { class: 'pal-input', placeholder, autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'pal-list' });
  let index = 0;
  let shown = [];
  const refresh = () => {
    const q = input.value.trim().toLowerCase();
    const all = items();
    shown = all.filter((it) => !q || it.label.toLowerCase().includes(q));
    if (q && onCreate && !all.some((it) => it.label.toLowerCase() === q)) shown.push({ create: true, label: createLabel(input.value.trim()) });
    index = Math.min(index, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((it, i) => {
      const row = h('div', { class: 'pal-row' + (i === index ? ' is-focus' : '') + (it.create ? ' pal-create' : '') },
        it.lead || h('span', { class: 'pal-lead' }),
        h('span', { class: 'grow ellip' }, it.label),
        it.meta ? h('span', { class: 'mono dim' }, it.meta) : null,
        it.checked ? h('span', { class: 'accent' }, '✓') : null);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); index = i; pick(e.shiftKey); });
      return row;
    }));
    if (!shown.length) list.append(h('div', { class: 'pal-empty dim' }, 'Nothing matches. Type a name to make one.'));
  };
  const pick = async (shift) => {
    const it = shown[index];
    if (!it) return;
    if (it.create) await onCreate(input.value.trim(), shift);
    else await onPick(it, shift);
  };
  input.addEventListener('input', () => { index = 0; refresh(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(shown.length - 1, index + 1); refresh(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); refresh(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(e.shiftKey).then(() => { if (active && active.keepOpen) { refresh(); } }); }
  });
  refresh();
  const el = h('div', { class: 'pal' }, h('div', { class: 'pal-title mono' }, title), input, list, footer ? h('div', { class: 'pal-foot mono' }, footer) : null);
  return { el, focus: () => input.focus(), refresh };
}

function describe(tracks) {
  return tracks.length === 1 ? '“' + tracks[0].title + '”' : tracks.length + ' tracks';
}

const BUILDERS = {
  columns(opts) {
    const table = opts.table === 'playlist' ? 'playlist' : 'search';
    const name = Object.fromEntries(columns.TABLES[table].map(([id, label]) => [id, label]));
    const p = palette({
      title: 'COLUMNS',
      placeholder: 'Column',
      items: () => [
        ...columns.order(table).filter((id) => !columns.TABLES[table].find((c) => c[0] === id)[2]).map((id) => ({ id, label: name[id], checked: columns.isOn(table, id) })),
        ...(columns.changed(table) ? [{ reset: true, label: 'Reset order and widths' }] : []),
      ],
      onPick: async (it) => { if (it.reset) await columns.reset(table); else await columns.toggle(table, it.id); render(); p.refresh(); },
      footer: '⏎ show or hide · drag a heading to move it, its right edge to resize',
    });
    p.keepOpen = true;
    return p;
  },
  add(opts) {
    const tracks = opts.tracks || A.targets().map((r) => r.track).filter(Boolean);
    if (!tracks.length) { toast('Focus a track first'); return { el: h('div') }; }
    const p = palette({
      title: 'ADD ' + describe(tracks).toUpperCase() + ' TO…',
      placeholder: 'Playlist or set name',
      items: () => store.allLists().map((l) => ({
        id: l.id, label: l.name, meta: (l.kind === 'set' ? 'set · ' : '') + l.entries.length,
        checked: tracks.every((t) => store.contains(l.id, t.k)),
        lead: h('span', { class: 'pal-lead dim' }, l.kind === 'set' ? '≡' : '♫'),
      })),
      onPick: async (it) => { await A.addTo(it.id, tracks); closeOverlay(); },
      onCreate: async (name, shift) => { await A.createAndAdd(name, shift ? 'set' : 'playlist', tracks); closeOverlay(); },
      createLabel: (name) => 'New playlist “' + name + '”  (⇧⏎ for a set)',
      footer: '↑↓ choose · ⏎ add · type to filter or name a new one · Esc',
    });
    return p;
  },

  colour() {
    const rows = A.targets().filter((r) => r.entry);
    if (!rows.length) { toast('Colour is per playlist: open one first'); return { el: h('div') }; }
    const cur = rows[0].entry.color || 0;
    const p = palette({
      title: 'COLOUR ' + (rows.length === 1 ? '“' + rows[0].track.title.toUpperCase() + '”' : rows.length + ' TRACKS') + ' IN THIS PLAYLIST',
      placeholder: 'Type 0–8, or pick',
      items: () => [1, 2, 3, 4, 5, 6, 7, 8, 0].map((c) => ({
        c, label: c ? 'Colour ' + c : 'No colour', meta: String(c), checked: c === cur,
        lead: h('span', { class: 'pal-lead' }, h('span', { class: 'swatch' + (c ? '' : ' swatch-none'), style: c ? { background: 'var(--tcs' + c + ')' } : null })),
      })),
      onPick: async (it) => { await A.setColour(it.c); closeOverlay(); },
      footer: '↑↓ choose · ⏎ set · Esc',
    });
    return p;
  },

  tag() {
    const keys = A.targets().map((r) => r.track).filter(Boolean);
    if (!keys.length) { toast('Focus a track first'); return { el: h('div') }; }
    const p = palette({
      title: 'TAG ' + (keys.length === 1 ? 'THIS TRACK' : keys.length + ' TRACKS'),
      placeholder: 'Tag',
      items: () => store.allTags().map((t) => ({ label: t, checked: keys.every((k) => store.noteFor(k).tags.includes(t)) })),
      onPick: async (it) => { await A.toggleTag(it.label); p.refresh(); },
      onCreate: async (name) => { await A.toggleTag(name.toLowerCase()); closeOverlay(); },
      createLabel: (name) => 'New tag “' + name.toLowerCase() + '”',
      footer: '⏎ toggle · stays open for more · Esc done',
    });
    p.keepOpen = true;
    return p;
  },

  keys() {
    const group = (title, rows) => h('div', { class: 'k-group' }, h('div', { class: 'sec-head' }, title),
      rows.map(([k, label]) => h('div', { class: 'k-row' }, h('span', { class: 'k-caps' }, k.split(' ').map((x) => h('kbd', null, x))), h('span', { class: 'fg2' }, label))));
    const el = h('div', { class: 'keys' },
      h('div', { class: 'keys-head' }, h('b', null, 'Keyboard'), h('span', { class: 'dim mono' }, 'Esc closes')),
      h('div', { class: 'keys-grid' },
        group('GO TO', [['/', 'search field'], ['⌥1', 'Search'], ['⌥2', 'Library'], ['⌥3', 'Activity'], ['⌥4', 'Settings'], ['?', 'this overlay']]),
        group('LISTS', [['↑ ↓', 'move'], ['⇧↑ ⇧↓', 'extend selection'], ['⏎', 'play from here'], ['I', 'details'], ['A', 'add to…'], ['G', 'tag'], ['L', '♥ on Soundeo'], ['M', 'same track (selected rows)'], ['V', 'find remixes and edits'], ['⇧V', 'remixes on SoundCloud'], ['U', 'suggest tracks at a playlist\'s BPM'], ['N', 'private note'], ['O', 'open source link']]),
        group('PLAYER', [['Space', 'play / pause'], ['J K', 'previous / next'], ['← →', 'seek 10s'], ['Q', 'queue'], ['⇧Q', 'play next'], ['− =', 'volume']]),
        group('SEARCH', [['F', 'filters'], ['S', 'cycle sort'], ['R', 'retry source'], ['Esc', 'leave field']]),
        group('PLAYLIST', [['1–8', 'colour'], ['0', 'clear colour'], ['[ ]', 'energy ½'], ['⇧0–5', 'energy'], ['⌥↑ ⌥↓', 'move'], ['⌫', 'remove'], ['C', 'comment'], ['P', 'play all'], ['⇧F', 'fork to set'], ['R', 'rename']]),
        group('SET BUILDER', [['⌥↑ ⌥↓', 'move'], ['T', 'transition note'], ['⇧E', 'next clash'], ['⌫', 'remove']])),
      h('div', { class: 'keys-hw mono' }, h('b', null, 'HARDWARE MEDIA KEYS'), ' ⏯ play / pause · ⏭ next in queue · ⏮ restart, twice for previous · Work when Crate isn\'t focused. The last tab to play holds them.'));
    return { el };
  },

  queue() {
    let index = Math.max(0, player.state.index);
    const list = h('div', { class: 'q-list' });
    const head = h('div', { class: 'q-head mono' });
    const refresh = () => {
      const st = player.state;
      head.replaceChildren(h('b', null, 'Queue'), st.from ? ' · from ' + st.from : '', ' · ' + st.queue.length, h('span', { class: 'grow' }),
        h('button', { class: 'link', onclick: () => { player.clear(); refresh(); } }, 'Clear'), ' · Q / Esc');
      index = Math.min(index, Math.max(0, st.queue.length - 1));
      list.replaceChildren(...(st.queue.length ? st.queue.map((t, i) => {
        const row = h('div', { class: 'q-row' + (i === index ? ' is-focus' : '') + (i === st.index ? ' is-playing' : '') },
          h('span', { class: 'mono fg3 num' }, i === st.index ? '▶' : i + 1),
          h('span', { class: 'ellip' }, h('span', { class: 't' }, t.title), h('span', { class: 'fg3' }, ' · ' + t.artist)),
          h('span', { class: 'mono fg3' }, Object.keys(t.sources || {})[0] ? Object.keys(t.sources)[0].toUpperCase() : ''),
          h('span', { class: 'mono num' }, t.bpm || ''), h('span', { class: 'mono' }, t.camelot || ''));
        row.addEventListener('mousedown', () => { index = i; refresh(); });
        row.addEventListener('dblclick', () => { player.playList(st.queue, i, st.from); refresh(); });
        return row;
      }) : [h('div', { class: 'pal-empty dim' }, 'Queue is empty. ⏎ on a track plays from there; ⇧Q adds one to play next.')]));
      const f = list.querySelector('.is-focus');
      if (f) f.scrollIntoView({ block: 'nearest' });
    };
    const off = player.onChange(refresh);
    refresh();
    const el = h('div', { class: 'queue' }, head, list, h('div', { class: 'pal-foot mono' }, '⏎ play · ⌥↑↓ reorder · ⌫ remove · ⇧Q on any row: play next'));
    return {
      el,
      onKey(e) {
        const st = player.state;
        if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); off(); closeOverlay(); return true; }
        if (e.key === 'ArrowDown' && e.altKey) { index = player.moveInQueue(index, 1); refresh(); return true; }
        if (e.key === 'ArrowUp' && e.altKey) { index = player.moveInQueue(index, -1); refresh(); return true; }
        if (e.key === 'ArrowDown') { index = Math.min(st.queue.length - 1, index + 1); refresh(); return true; }
        if (e.key === 'ArrowUp') { index = Math.max(0, index - 1); refresh(); return true; }
        if (e.key === 'Enter') { player.playList(st.queue, index, st.from); refresh(); return true; }
        if (e.key === 'Backspace' || e.key === 'Delete') { player.removeAt(index); refresh(); return true; }
        return false;
      },
    };
  },

  filters() {
    const f = { ...(store.prefs.filters || {}) };
    const lo = h('input', { class: 'field field-num', type: 'number', min: '40', max: '260', placeholder: 'from', value: f.bpmLo || '' });
    const hi = h('input', { class: 'field field-num', type: 'number', min: '40', max: '260', placeholder: 'to', value: f.bpmHi || '' });
    const key = h('input', { class: 'field field-num', placeholder: 'e.g. 8A', value: f.key || '', maxlength: 3 });
    const wide = h('input', { type: 'checkbox' });
    wide.checked = !!f.keyWide;
    const genres = [...new Set(S.results.map((t) => t.genre).filter(Boolean))].sort();
    if (f.genre && !genres.includes(f.genre)) genres.unshift(f.genre);
    const genre = h('select', { class: 'field' }, h('option', { value: '' }, 'any'), genres.map((g) => h('option', { value: g, selected: g === f.genre }, g)));
    const days = h('select', { class: 'field' }, [[0, 'any time'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, 'a year']].map(([v, l]) => h('option', { value: v, selected: Number(f.days || 0) === v }, l)));
    const keyHint = h('span', { class: 'dim small mono' });
    const showHint = () => { const k = key.value.trim().toUpperCase(); keyHint.textContent = parseCamelot(k) ? (wide.checked ? neighbours(k).join(' ') : k) : key.value ? 'Camelot, like 8A' : ''; };
    key.addEventListener('input', showHint); wide.addEventListener('change', showHint); showHint();
    const apply = () => {
      const k = key.value.trim().toUpperCase();
      A.setFilters({
        bpmLo: Number(lo.value) || 0, bpmHi: Number(hi.value) || 0,
        key: parseCamelot(k) ? k : '', keyWide: wide.checked && !!parseCamelot(k),
        genre: genre.value, days: Number(days.value) || 0,
      });
      closeOverlay();
    };
    const row = (label, ...field) => h('label', { class: 'f-row' }, h('span', { class: 'f-label' }, label), ...field);
    const el = h('form', { class: 'pal filters', onsubmit: (e) => { e.preventDefault(); apply(); } },
      h('div', { class: 'pal-title mono' }, 'FILTERS'),
      row('BPM', lo, h('span', { class: 'dim' }, '–'), hi, h('span', { class: 'dim small' }, 'asks Soundeo')),
      row('Key', key, h('label', { class: 'small' }, wide, ' ±1 on the wheel'), keyHint),
      row('Genre', genre, h('span', { class: 'dim small' }, 'from these results')),
      row('Released', days),
      h('div', { class: 'f-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => { A.setFilters({}); closeOverlay(); } }, 'Clear all'), h('span', { class: 'grow' }), h('button', { type: 'submit', class: 'btn btn-fill' }, 'Apply ⏎')));
    return {
      el,
      focus: () => lo.focus(),
      onKey(e) { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); apply(); return true; } return false; },
    };
  },

  prompt(opts) {
    const p = opts.id ? store.getList(opts.id) : null;
    let title, value = '', placeholder = 'Name', run;
    if (opts.mode === 'new-playlist' || opts.mode === 'new-set') {
      const kind = opts.mode === 'new-set' ? 'set' : 'playlist';
      title = kind === 'set' ? 'NEW SET' : 'NEW PLAYLIST';
      const tracks = opts.tracks || [];
      run = async (v) => { const l = await A.createAndAdd(v, kind, tracks); closeOverlay(true); if (l) A.openList(l.id); };
    } else if (opts.mode === 'rename' && p) {
      title = 'RENAME ' + (p.kind === 'set' ? 'SET' : 'PLAYLIST');
      value = p.name;
      run = async (v) => { await store.renameList(p.id, v); closeOverlay(); };
    } else if (opts.mode === 'transition' && p) {
      const i = p.entries.findIndex((e) => e.k === opts.k);
      const a = p.entries[i], b = p.entries[i + 1];
      if (!a || !b) return { el: h('div') };
      title = 'TRANSITION · ' + a.track.title.toUpperCase() + ' → ' + b.track.title.toUpperCase();
      value = a.note || '';
      placeholder = 'How you get from one to the other: loop the outro, EQ swap at the drop…';
      run = async (v) => { await A.setTransition(a.k, v); closeOverlay(); };
    } else if (opts.mode === 'name') {
      title = 'WHAT SHOULD FRIENDS CALL YOU?';
      value = store.prefs.me || '';
      placeholder = 'Display name, like Sam';
      run = async (v) => { if (!v.trim()) return; store.prefs.me = v.trim().slice(0, 32); await store.savePrefs(); closeOverlay(); };
    } else return { el: h('div') };
    const input = h('input', { class: 'pal-input', value, placeholder, autocomplete: 'off', spellcheck: 'false' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(input.value); } });
    return { el: h('div', { class: 'pal' }, h('div', { class: 'pal-title mono' }, title), input, h('div', { class: 'pal-foot mono' }, '⏎ save · Esc cancel')), focus: () => { input.focus(); input.select(); } };
  },

  confirm(opts) {
    const yes = h('button', { class: 'btn btn-fill', onclick: () => { opts.run(); closeOverlay(); } }, opts.yes || 'Delete', ' ⏎');
    return {
      el: h('div', { class: 'pal' }, h('div', { class: 'pal-title mono' }, opts.title || 'ARE YOU SURE?'), h('p', { class: 'fg2' }, opts.text),
        h('div', { class: 'f-actions' }, h('button', { class: 'btn', onclick: () => closeOverlay() }, 'Cancel Esc'), h('span', { class: 'grow' }), yes)),
      focus: () => yes.focus(),
      onKey(e) { if (e.key === 'Enter') { e.preventDefault(); opts.run(); closeOverlay(); return true; } return false; },
    };
  },
};

