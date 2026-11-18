// Local data on this machine, through window.api.storage (JSON values).
// Playlists and sets are one key each plus an index, so no value grows past the
// per-key limit. The shared database will take over playlists later; everything
// above this module talks to these functions only.

import { uid } from './util.js';
import * as shared from './shared.js';

const api = window.api;
const listeners = new Set();
export const status = { error: null };

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { for (const fn of listeners) fn(what); }

async function get(key) {
  try { return await api.storage.get(key); } catch (e) { fail(e); return null; }
}
async function set(key, value) {
  try { await api.storage.set(key, value); status.error = null; return true; } catch (e) { fail(e); return false; }
}
async function del(key) {
  try { await api.storage.delete(key); return true; } catch (e) { fail(e); return false; }
}
function fail(e) {
  status.error = (e && e.message) || String(e);
  console.warn('[crate] storage', status.error);
  emit('error');
}

// ---- prefs -------------------------------------------------------------------

export const prefs = { me: '', uid: '', volume: 0.9, sort: 'relevance', filters: {}, lastQ: '', scProfile: '' };

export async function loadPrefs() {
  const saved = await get('prefs');
  if (saved && typeof saved === 'object') Object.assign(prefs, saved);
  // Notes are yours by this id, not by your name, so a rename keeps them.
  if (!VALID_UID.test(prefs.uid || '')) { prefs.uid = uid(); await savePrefs(); }
}
export const VALID_UID = /^[A-Za-z0-9-]{8,64}$/;
export function savePrefs() { return set('prefs', prefs); }
export const me = () => prefs.me || 'Me';

// Shared rows record who made them, so nothing goes to the group under the
// placeholder name: an unnamed shared write asks for a name and is dropped.
// The prompt opens on the next tick, after any overlay the caller closes.
let askName = () => {};
export function onNeedName(fn) { askName = fn; }
export function unnamed() {
  if (prefs.me) return false;
  setTimeout(askName, 0);
  return true;
}

// ---- playlists ---------------------------------------------------------------

const lists = new Map(); // id → { id, name, kind, createdAt, updatedAt, owner, entries }

export async function loadLists() {
  const ids = (await get('pl:index')) || [];
  const loaded = await Promise.all(ids.map((id) => get('pl:' + id)));
  lists.clear();
  for (const p of loaded) if (p && p.id) lists.set(p.id, p);
}

// With the shared space connected, playlists and sets live there; the local
// ones stay on this machine until they're copied up (Settings).
export function allLists() {
  if (shared.on()) return shared.allLists();
  return localLists();
}
export const localLists = () => [...lists.values()].sort((a, b) => b.updatedAt - a.updatedAt);
export const getList = (id) => (shared.on() ? shared.getList(id) : lists.get(id) || null);

async function writeIndex() { return set('pl:index', [...lists.keys()]); }

async function save(p) {
  p.updatedAt = Date.now();
  lists.set(p.id, p);
  const ok = await set('pl:' + p.id, p);
  emit('lists');
  return ok;
}

export async function createList(name, kind, forkedFrom) {
  if (shared.on()) return unnamed() ? null : shared.createList(name || (kind === 'set' ? 'Untitled set' : 'Untitled playlist'), kind, forkedFrom);
  const p = { id: uid(), name: name || (kind === 'set' ? 'Untitled set' : 'Untitled playlist'), kind, owner: me(), createdAt: Date.now(), updatedAt: Date.now(), entries: [], forkedFrom: forkedFrom || null };
  lists.set(p.id, p);
  await writeIndex();
  await save(p);
  return p;
}

export async function renameList(id, name) {
  if (shared.on()) return unnamed() ? null : shared.renameList(id, name.trim());
  const p = lists.get(id);
  if (!p || !name.trim()) return;
  p.name = name.trim();
  await save(p);
}

export async function deleteList(id) {
  if (shared.on()) return unnamed() ? null : shared.deleteList(id);
  if (!lists.delete(id)) return;
  await writeIndex();
  await del('pl:' + id);
  emit('lists');
}

export async function forkToSet(id) {
  const src = getList(id);
  if (!src) return null;
  const p = await createList(src.name + ' · set', 'set', src.name);
  if (!p) return null;
  await addTracks(p.id, src.entries.map((e) => e.track));
  return getList(p.id);
}

// Only the fields a list needs to show and play a track travel with it.
export function snapshot(t) {
  const { k, artist, title, mix, label, genre, bpm, camelot, len, released, art50, art500, isrc } = t;
  const sources = { ...t.sources };
  // A SoundCloud stream link is signed and short-lived; keep the placeholder.
  if (sources.sc) sources.sc = { ...sources.sc, audio: 'sc:' + sources.sc.id };
  return { k, artist, title, mix, label, genre, bpm, ...(t.bpmGuess ? { bpmGuess: true, bpmFrom: t.bpmFrom || '' } : {}), camelot, len, released, art50, art500, isrc, sources };
}

export function contains(id, k) {
  const p = getList(id);
  return !!p && p.entries.some((e) => e.k === k);
}

export async function addTracks(id, tracks) {
  if (shared.on()) return unnamed() ? null : shared.addTracks(id, tracks, snapshot);
  const p = lists.get(id);
  if (!p) return 0;
  let added = 0;
  for (const t of tracks) {
    if (p.entries.some((e) => e.k === t.k)) continue;
    p.entries.push({ k: t.k, track: snapshot(t), addedAt: Date.now(), addedBy: me(), color: 0, colorBy: '', energy: 0, energyBy: '', note: '', noteBy: '' });
    added++;
  }
  if (added) await save(p);
  return added;
}

export async function removeTracks(id, keys) {
  if (shared.on()) return unnamed() ? null : shared.removeTracks(id, keys);
  const p = lists.get(id);
  if (!p) return;
  const drop = new Set(keys);
  p.entries = p.entries.filter((e) => !drop.has(e.k));
  await save(p);
}

export async function updateEntry(id, k, patch) {
  if (shared.on()) return unnamed() ? null : shared.updateEntry(id, k, patch);
  const p = lists.get(id);
  const e = p && p.entries.find((x) => x.k === k);
  if (!e) return;
  Object.assign(e, patch);
  await save(p);
}

export async function moveEntry(id, k, delta) {
  const p = getList(id);
  if (!p) return false;
  const i = p.entries.findIndex((e) => e.k === k);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= p.entries.length) return false;
  if (shared.on()) return unnamed() ? null : shared.moveTo(id, k, j);
  const [e] = p.entries.splice(i, 1);
  p.entries.splice(j, 0, e);
  await save(p);
  return true;
}

// Drag-and-drop: put k just before beforeK (or at the end).
export async function moveBefore(id, k, beforeK) {
  const p = getList(id);
  if (!p || k === beforeK) return false;
  const from = p.entries.findIndex((e) => e.k === k);
  if (from < 0) return false;
  const rest = p.entries.filter((e) => e.k !== k);
  const to = beforeK ? rest.findIndex((e) => e.k === beforeK) : rest.length;
  if (shared.on()) return unnamed() ? null : shared.moveTo(id, k, to < 0 ? rest.length : to);
  const [e] = p.entries.splice(from, 1);
  p.entries.splice(to < 0 ? p.entries.length : to, 0, e);
  await save(p);
  return true;
}

// Copy this machine's playlists and sets into the shared space.
export async function copyLocalToShared() {
  let n = 0;
  if (unnamed()) return n;
  for (const p of localLists()) {
    if (p.copiedTo) continue;
    const l = await shared.createList(p.name, p.kind, p.forkedFrom);
    if (!l) break;
    if (p.entries.length) await shared.addTracks(l.id, p.entries.map((e) => e.track), snapshot);
    for (const e of p.entries) {
      const patch = {};
      if (e.color) Object.assign(patch, { color: e.color, colorBy: e.colorBy || me() });
      if (e.energy) Object.assign(patch, { energy: e.energy, energyBy: e.energyBy || me() });
      if (e.note) Object.assign(patch, { note: e.note, noteBy: e.noteBy || me() });
      if (Object.keys(patch).length) await shared.updateEntry(l.id, e.k, patch);
    }
    p.copiedTo = l.id;
    await set('pl:' + p.id, p);
    n++;
  }
  return n;
}
export const uncopiedLocal = () => localLists().filter((p) => !p.copiedTo);

export async function setEntryTrack(id, k, track) {
  if (shared.on()) return unnamed() ? false : shared.setEntryTrack(id, k, snapshot(track));
  const p = lists.get(id);
  const e = p && p.entries.find((x) => x.k === k);
  if (!e) return false;
  e.track = snapshot(track);
  return set('pl:' + p.id, p);
}

// Fresh details (BPM / key) found later are written back into saved entries.
export async function refreshTrack(t) {
  if (shared.on()) return prefs.me ? shared.refreshTrack(t, snapshot) : undefined;
  for (const p of lists.values()) {
    const e = p.entries.find((x) => x.k === t.k);
    if (!e) continue;
    const before = JSON.stringify(e.track);
    e.track = { ...e.track, ...Object.fromEntries(Object.entries(snapshot(t)).filter(([, v]) => v != null && v !== '')) };
    if (JSON.stringify(e.track) !== before) { lists.set(p.id, p); await set('pl:' + p.id, p); }
  }
}

// ---- notes and tags ----------------------------------------------------------
// A note belongs to a track and to you. With the shared space on it is a row
// in track_notes under one of the track's source tracks ("so:123"): the group
// reads it, and the Track Notes shim on the site itself writes the same row.
// A note you keep private, and every note while the shared space is off,
// stays on this machine under the track's key.

const notes = new Map(); // k → { body, tags: [], updatedAt, priv? }
export const DEFAULT_TAGS = ['opener', 'peak', 'closer', 'vocal'];
const EMPTY = { body: '', tags: [], updatedAt: 0 };
const SOURCE_ORDER = ['so', 'bp', 'sc', 'yt'];
const rank = (ref) => { const i = SOURCE_ORDER.indexOf(ref.split(':')[0]); return i < 0 ? 9 : i; };

export const refsOf = (t) => Object.entries((t && t.sources) || {})
  .map(([id, s]) => (s && s.id ? id + ':' + s.id : '')).filter(Boolean)
  .sort((a, b) => rank(a) - rank(b));
const labelOf = (t) => (t.artist + ' - ' + t.title + (t.mix ? ' (' + t.mix + ')' : '')).slice(0, 400);

export async function loadNotes() {
  const saved = (await get('notes')) || {};
  notes.clear();
  for (const [k, v] of Object.entries(saved)) notes.set(k, v);
}
async function saveNotes() {
  const ok = await set('notes', Object.fromEntries(notes));
  emit('notes');
  return ok;
}

// Can this track's note live in the shared space?
export const canShareNote = (t) => shared.on() && shared.notesOn() && refsOf(t).length > 0;
export const isPrivate = (t) => !!(notes.get(t.k) || EMPTY).priv;
const local = (t) => isPrivate(t) || !canShareNote(t);

export function noteFor(t) {
  if (local(t)) return notes.get(t.k) || EMPTY;
  return shared.myNote(refsOf(t), prefs.uid) || EMPTY;
}

// What the rest of the group wrote about this track.
export const othersNotes = (t) => (canShareNote(t)
  ? shared.notesFor(refsOf(t)).filter((n) => n.authorId !== prefs.uid && (n.body || n.tags.length)) : []);

async function writeNote(t, body, tags) {
  if (local(t)) {
    notes.set(t.k, { ...(notes.get(t.k) || EMPTY), body, tags, updatedAt: Date.now() });
    return saveNotes();
  }
  if (unnamed()) return false;
  const cur = shared.myNote(refsOf(t), prefs.uid);
  const ok = await shared.setNote((cur && cur.ref) || refsOf(t)[0], prefs.uid, labelOf(t), body, tags);
  emit('notes');
  return ok;
}

export const setNote = (t, body) => writeNote(t, body, noteFor(t).tags);

export async function toggleTag(tracks, tag) {
  const on = !tracks.every((t) => noteFor(t).tags.includes(tag));
  for (const t of tracks) {
    const n = noteFor(t);
    await writeNote(t, n.body, on ? [...new Set([...n.tags, tag])] : n.tags.filter((x) => x !== tag));
  }
  return on;
}

// Move a track's note between this machine and the shared space. Going
// private empties the shared row; a refused write leaves the note where it was.
export async function setPrivate(t, on) {
  const cur = noteFor(t);
  if (on) {
    if (cur.ref && !(await shared.setNote(cur.ref, prefs.uid, labelOf(t), '', []))) return false;
    notes.set(t.k, { body: cur.body, tags: cur.tags, updatedAt: Date.now(), priv: true });
    return saveNotes();
  }
  notes.delete(t.k);
  if (!(await writeNote(t, cur.body, cur.tags))) { notes.set(t.k, cur); emit('notes'); return false; }
  return saveNotes();
}

export function allTags() {
  const used = new Map();
  const count = (n) => { for (const t of n.tags || []) used.set(t, (used.get(t) || 0) + 1); };
  for (const n of notes.values()) count(n);
  if (shared.on()) for (const n of shared.myNotes(prefs.uid)) count(n);
  for (const t of DEFAULT_TAGS) if (!used.has(t)) used.set(t, 0);
  return [...used.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

// ---- caches (detail lookups, waveforms) --------------------------------------

export const cacheGet = (key) => get('c:' + key);
export const cacheSet = (key, v) => set('c:' + key, v);
