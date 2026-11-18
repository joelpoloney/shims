// Crate: entry point. Builds the shell, wires the render hook and the keyboard.

import { S, setRender, toast } from './state.js';
import * as store from './store.js';
import * as player from './player.js';
import * as A from './actions.js';
import * as V from './views.js';
import { mountPlayer, updatePlayer } from './playerbar.js';
import { mountOverlays, openOverlay, overlayKey, overlayOpen } from './overlays.js';
import { h, keyCompat, bpmCompat } from './util.js';
import { loadCollection, loadBeatportPlaylists } from './collections.js';
import * as shared from './shared.js';
import * as links from './links.js';
import * as tracklists from './tracklists.js';

const $ = (id) => document.getElementById(id);

function renderAll(parts) {
  const want = (p) => !parts || parts.includes(p);
  const rowParts = parts ? parts.filter((p) => p.startsWith('row:')) : [];
  if (parts && parts.every((p) => p === 'focus' || p.startsWith('row:'))) {
    for (const p of rowParts) V.replaceRow(p.slice(4));
    V.applyFocus($('main'), parts.includes('focus'));
    V.renderPanel($('panel'));
    if (S.view === 'list') refreshArcFocus();
    return;
  }
  if (want('top')) V.updateTopbar();
  if (!parts || want('sidebar')) V.renderSidebar($('sidebar'));
  if (!parts) V.renderMain($('main'));
  if (!parts || want('panel') || want('panel-force')) V.renderPanel($('panel'), !parts || want('panel-force'));
  if (want('player')) updatePlayer();
  if (want('toast')) renderToast();
  document.body.classList.toggle('has-panel', S.panel && !!V.panelTrack());
}

function refreshArcFocus() {
  const k = A.focusKey();
  const bars = $('main').querySelectorAll('.arc-bar');
  const p = store.getList(S.listId);
  if (!p) return;
  bars.forEach((b, i) => b.classList.toggle('is-focus', p.entries[i] && p.entries[i].k === k));
}

function renderToast() {
  const el = $('toast');
  el.replaceChildren(...(S.toast ? [h('div', { class: 'toast' + (S.toast.kind ? ' toast-' + S.toast.kind : '') }, S.toast.text)] : []));
}

// ---- keyboard ------------------------------------------------------------------

const isField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

function onKey(e) {
  if (e.defaultPrevented) return;
  if (overlayKey(e)) return;
  if (overlayOpen()) return; // the overlay's own fields take the rest
  if (isField(e.target)) return; // single letters never fire inside a field
  if (e.metaKey || e.ctrlKey) return; // leave ⌘ shortcuts to Shim

  const k = e.key;
  const inList = S.view === 'list';
  const p = inList ? store.getList(S.listId) : null;

  // ⌥1 / ⌥2 / ⌥3 switch screens (Shim keeps ⌘1–9 for its tabs).
  if (e.altKey && /^Digit[1-4]$/.test(e.code)) {
    e.preventDefault();
    A.go(['search', 'library', 'activity', 'settings'][Number(e.code.slice(5)) - 1]);
    return;
  }

  const handled = () => e.preventDefault();

  switch (true) {
    case k === '/': handled(); V.focusSearch(); return;
    case k === '?': handled(); openOverlay('keys'); return;
    case k === 'Escape':
      handled();
      if (S.panel) { S.panel = false; renderAll(); }
      else if (S.sel.size) { S.sel.clear(); renderAll(['focus']); }
      return;
    case k === ' ': handled(); player.toggle(); return;
    case k === 'j' || k === 'J': handled(); player.prev(); return;
    case k === 'k' || k === 'K': handled(); player.next(); return;
    case k === 'ArrowLeft': handled(); player.seekBy(-10); return;
    case k === 'ArrowRight': handled(); player.seekBy(10); return;
    case k === '-' || k === '_': handled(); player.setVolume(player.volume() - 0.05); return;
    case k === '=' || k === '+': handled(); player.setVolume(player.volume() + 0.05); return;
    case k === 'Q' && e.shiftKey: handled(); A.queueNext(); return;
    case k === 'q': handled(); openOverlay('queue'); return;
    case k === 'ArrowDown' && e.altKey && inList: handled(); A.moveFocused(1); return;
    case k === 'ArrowUp' && e.altKey && inList: handled(); A.moveFocused(-1); return;
    case k === 'ArrowDown': handled(); A.moveFocus(1, { extend: e.shiftKey }); return;
    case k === 'ArrowUp': handled(); A.moveFocus(-1, { extend: e.shiftKey }); return;
    case k === 'PageDown': handled(); A.moveFocus(15); return;
    case k === 'PageUp': handled(); A.moveFocus(-15); return;
    case k === 'Home': handled(); A.moveFocus(-1e6); return;
    case k === 'End': handled(); A.moveFocus(1e6); return;
  }

  if (S.view === 'activity') {
    const r = A.focusedRow();
    if (k === 'Enter' && r) { handled(); A.openActivity(r.activity); return; }
    if (k === 'M' && e.shiftKey) { handled(); A.markSeen(); return; }
    return;
  }

  if (S.view === 'library') {
    const r = A.focusedRow();
    if (k === 'Enter' && r) { handled(); A.openList(r.k); return; }
    if (k === 'N') { handled(); openOverlay('prompt', { mode: 'new-set' }); return; }
    if (k === 'n') { handled(); openOverlay('prompt', { mode: 'new-playlist' }); return; }
    if ((k === 'r' || k === 'R') && r) { handled(); openOverlay('prompt', { mode: 'rename', id: r.k }); return; }
    if ((k === 'Backspace' || k === 'Delete') && r) {
      handled();
      openOverlay('confirm', { title: 'DELETE ' + (r.list.kind === 'set' ? 'SET' : 'PLAYLIST'), text: 'Delete “' + r.list.name + '” and its ' + r.list.entries.length + ' tracks? This can\'t be undone.', run: () => store.deleteList(r.k).then(() => renderAll()) });
      return;
    }
    return;
  }

  if (S.view !== 'search' && S.view !== 'list' && S.view !== 'source') return;
  const r = A.focusedRow();

  if (k === 'Enter' && r) { handled(); A.playFrom(r.k); return; }
  if ((k === 'a' || k === 'A') && r) { handled(); openOverlay('add'); return; }
  if ((k === 'g' || k === 'G') && r) { handled(); openOverlay('tag'); return; }
  if ((k === 'l' || k === 'L') && r) { handled(); A.toggleFavorite(r.k); return; }
  if ((k === 'm' || k === 'M') && !e.shiftKey && S.view !== 'source') { handled(); A.mergeSelected(); return; }
  if ((k === 'v' || k === 'V') && r && r.track) { handled(); A.findVersions(r.track, { sc: e.shiftKey }); return; }
  if ((k === 'i' || k === 'I') && r) { handled(); S.panel = !S.panel; renderAll(); return; }
  if (k === 'n' && r && S.view !== 'list') { handled(); S.panel = true; renderAll(); V.focusNote(); return; }
  if ((k === 'o' || k === 'O') && r) {
    handled();
    S.panel = true; renderAll();
    if (V.focusOpenLink()) toast('Press ⏎ to open it in a new tab');
    return;
  }

  // Colour, energy and comments belong to a track inside a playlist or set.
  if (S.view === 'search' || S.view === 'source') {
    if (/^[0-8]$/.test(k) || k === '[' || k === ']' || ((k === 'c' || k === 'C') && !e.shiftKey)) {
      handled();
      toast((k === 'c' || k === 'C' ? 'Comments' : /^[0-8]$/.test(k) ? 'Colour' : 'Energy') + ' live inside a playlist or set: press A to add this track to one, then open it');
      return;
    }
  }

  if (S.view === 'source') {
    if (k === 's' || k === 'S') { handled(); A.cycleSort(); return; }
    if (k === 'r' || k === 'R') { handled(); A.refreshSource(); return; }
    if (k === 'p' || k === 'P') { handled(); A.playAll(); return; }
    return;
  }

  if (S.view === 'search') {
    if (k === 's' || k === 'S') { handled(); A.cycleSort(); return; }
    if (k === 'f' || k === 'F') { handled(); openOverlay('filters'); return; }
    if (k === 'r' || k === 'R') { handled(); A.retrySources(); return; }
    return;
  }

  // playlist and set
  if (!p) return;
  if (/^Digit[0-5]$/.test(e.code) && e.shiftKey) { handled(); A.setEnergy(Number(e.code.slice(5)), false); return; }
  if (/^[0-8]$/.test(k) && !e.altKey) { handled(); A.setColour(Number(k)); return; }
  if (k === '[') { handled(); A.setEnergy(-0.5, true); return; }
  if (k === ']') { handled(); A.setEnergy(0.5, true); return; }
  if (k === 'Backspace' || k === 'Delete') { handled(); A.removeSelected(); return; }
  if (k === 'p' || k === 'P') { handled(); A.playAll(); return; }
  if ((k === 'u' || k === 'U') && p.kind === 'playlist') { handled(); A.suggestFor(p.id); return; }
  if ((k === 'c' || k === 'C') && r) {
    handled();
    S.panel = true; renderAll();
    if (!V.focusComment()) toast(shared.on() ? 'Comments need a track focused' : 'Comments need the shared space (Settings)');
    return;
  }
  if (k === 'n') { handled(); S.panel = true; renderAll(); V.focusNote(); return; }
  if (k === 'N') { handled(); openOverlay('prompt', { mode: 'new-set' }); return; }
  if (k === 'r' || k === 'R') { handled(); openOverlay('prompt', { mode: 'rename', id: p.id }); return; }
  if (k === 'F' && e.shiftKey && p.kind === 'playlist') { handled(); A.forkToSet(); return; }
  if ((k === 't' || k === 'T') && p.kind === 'set' && r) {
    handled();
    const i = p.entries.findIndex((x) => x.k === r.k);
    if (i >= 0 && i + 1 < p.entries.length) openOverlay('prompt', { mode: 'transition', id: p.id, k: r.k });
    else toast('The last track has no transition after it');
    return;
  }
  if (k === 'E' && e.shiftKey && p.kind === 'set') { handled(); jumpToClash(p); return; }
}

// Focus the next track whose transition into the following one is a key clash
// or a BPM jump, wrapping around.
function jumpToClash(p) {
  const cur = p.entries.findIndex((e) => e.k === A.focusKey());
  const n = p.entries.length;
  for (let s = 1; s <= n; s++) {
    const i = (cur + s) % n;
    if (i + 1 >= n) continue;
    const a = p.entries[i].track, b = p.entries[i + 1].track;
    const kc = keyCompat(a.camelot, b.camelot), bc = bpmCompat(a.bpm, b.bpm);
    if ((kc && kc.level === 'bad') || (bc && bc.level === 'bad')) { A.setFocus(p.entries[i].k); return; }
  }
  toast('No clashes or BPM jumps in this set');
}

// ---- boot ----------------------------------------------------------------------

async function boot() {
  const app = $('app');
  app.replaceChildren(
    h('header', { id: 'topbar' }),
    h('div', { id: 'body' }, h('aside', { id: 'sidebar' }), h('main', { id: 'main' }), h('aside', { id: 'panel' })),
    h('footer', { id: 'player' }),
    h('div', { id: 'overlay' }),
    h('div', { id: 'toast' }));
  V.mountTopbar($('topbar'));
  mountOverlays($('overlay'));
  setRender(renderAll);
  tracklists.setOnChange((k) => renderAll(['row:' + k]));
  await store.loadPrefs();
  player.initVolume();
  await Promise.all([store.loadLists(), store.loadNotes(), links.load()]);
  mountPlayer($('player'));
  store.onChange((what) => { if (what === 'error') renderAll(['top']); else if (what === 'lists') renderAll(['sidebar']); });
  V.setToast((text) => toast(text));
  shared.onChange((what) => {
    if (what === 'status') { renderAll(['top']); return; }
    if (what === 'links') { renderAll(['panel']); return; }
    if (what === 'arrived' && shared.status.arriving) toast(shared.status.arriving.actor + ' ' + shared.describe(shared.activity[shared.activity.length - 1]) + (S.view === 'list' ? ' · your focus stayed put' : ''));
    // Only screens that show shared data rebuild; search and favorites don't.
    if (S.view === 'list' || S.view === 'library' || S.view === 'activity') renderAll();
    else renderAll(['sidebar', 'top', 'panel']);
    // the highlight on arrived rows fades after a few seconds
    setTimeout(() => { if (S.view === 'list') renderAll(); }, 5200);
  });
  setInterval(() => renderAll(['top']), 5000);
  store.onNeedName(() => { toast('Pick a display name first: friends see it on everything you change'); openOverlay('prompt', { mode: 'name' }); });
  document.addEventListener('keydown', onKey);
  renderAll();
  if (store.prefs.lastQ) A.runSearch(store.prefs.lastQ);
  shared.start(store.me).then((ok) => {
    renderAll();
    if (ok && !store.prefs.me) openOverlay('prompt', { mode: 'name' });
  });
  loadCollection('so-favorites');
  if (store.prefs.scProfile) loadCollection('sc-likes');
  loadBeatportPlaylists();
}

boot().catch((e) => {
  console.error('[crate] boot failed', e);
  document.body.append(h('pre', { class: 'boot-error' }, 'Crate failed to start: ' + (e && e.message)));
});

