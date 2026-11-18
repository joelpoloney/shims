// The shared space: playlists, sets, comments and the activity log in the
// group's Supabase project, through Shim's "shared" connection. The key lives
// in Shim; this page only ever sees rows.
//
// Reads are cached here and refreshed by polling the activity log (one small
// query every 5s while Crate is on screen, 30s while it's hidden). Activity
// rows are written by database triggers, so a change and its feed entry land
// together. Writes update the cache first and roll back if the database
// refuses them; a write that reports no changed rows is a refusal too.

import { cleanTrack } from './safe.js';

const conn = () => window.api.db.connection('shared');
const listeners = new Set();
export const status = {
  mode: 'checking',     // checking | on | off | error
  error: '',            // why the connection isn't usable
  lastSync: 0,          // when a poll last answered
  writeError: '',       // the last refused write, until the next good one
  arriving: null,       // { actor, text, at } for the top bar
};

const lists = new Map();    // id → list, same shape as local lists
const comments = new Map(); // playlist id → [{ id, k, author, body, at }]
export const links = new Map(); // 'a|b' (a < b) → { kind, by, at }
const notes = new Map();    // track ref → [{ ref, authorId, author, title, body, tags, updatedAt }]
let notesMode = 'off';      // 'on' once the notes table has answered
let notesSince = 0;         // newest server time seen on a note
let polls = 0;
export const activity = [];  // newest last
let cursor = 0;
let pollTimer = 0;
let me = () => 'Me';

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { for (const fn of listeners) fn(what); }

export const on = () => status.mode === 'on';
export const allLists = () => [...lists.values()].sort((a, b) => b.updatedAt - a.updatedAt);
export const getList = (id) => lists.get(id) || null;
export const commentsFor = (id, k) => (comments.get(id) || []).filter((c) => c.k === k);
export const commentCount = (id, k) => commentsFor(id, k).length;
export const members = () => [...new Set(activity.map((a) => a.actor).filter((n) => n && n !== '?'))];

const ms = (iso) => (iso ? Date.parse(iso) : 0);
const iso = () => new Date().toISOString();

// ---- boot and polling ---------------------------------------------------------

export async function start(getMe) {
  me = getMe;
  const probe = await conn().from('activity').select('id').order('id', { ascending: false }).limit(1);
  if (!probe.ok) {
    const err = String(probe.error || '');
    status.mode = /not-configured/.test(err) ? 'off' : 'error';
    status.error = err;
    emit('status');
    return false;
  }
  status.mode = 'on';
  await loadAll();
  await loadActivity();
  status.lastSync = Date.now();
  emit('lists');
  schedule();
  document.addEventListener('visibilitychange', () => { clearTimeout(pollTimer); schedule(0); });
  return true;
}

function schedule(delay) {
  clearTimeout(pollTimer);
  const wait = delay != null ? delay : document.hidden ? 30000 : 5000;
  pollTimer = setTimeout(poll, wait);
}

// Reads come back capped, so long tables are read a page at a time.
async function readAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await build().range(from, from + 999);
    if (!res.ok) throw new Error(res.error || 'read failed');
    rows.push(...res.rows);
    if (res.rows.length < 1000) return rows;
  }
}

function toList(p) {
  return {
    id: p.id, name: p.name, kind: p.kind, owner: p.owner, forkedFrom: p.forked_from,
    createdAt: ms(p.created_at), updatedAt: ms(p.updated_at), entries: [], shared: true,
  };
}

function toEntry(r) {
  return {
    k: r.track_key, track: cleanTrack(r.track), position: Number(r.position) || 0,
    addedAt: ms(r.added_at), addedBy: r.added_by,
    color: r.color || 0, colorBy: r.color_by || '',
    energy: Number(r.energy) || 0, energyBy: r.energy_by || '',
    note: r.note || '', noteBy: r.note_by || '',
    updatedAt: ms(r.updated_at),
  };
}

async function loadAll() {
  const ps = await readAll(() => conn().from('playlists').select('*').is('deleted_at', null).order('created_at'));
  const ts = await readAll(() => conn().from('playlist_tracks').select('*').is('removed_at', null).order('position'));
  const cs = await readAll(() => conn().from('comments').select('*').order('created_at'));
  lists.clear();
  for (const p of ps) lists.set(p.id, toList(p));
  for (const t of ts) { const l = lists.get(t.playlist_id); if (l) l.entries.push(toEntry(t)); }
  comments.clear();
  for (const c of cs) addComment(c);
  // Fixes are an extra: if they can't be read, playlists still load.
  await loadLinks().catch((e) => console.warn('[crate] match fixes', e && e.message));
  // So are notes: a space without the notes table keeps notes on this machine.
  await loadNotes().catch((e) => { notesMode = 'off'; console.warn('[crate] track notes', e && e.message); });
}

async function loadLinks() {
  const ls = await readAll(() => conn().from('track_links').select('*').neq('kind', 'none').order('a'));
  links.clear();
  for (const l of ls) links.set(l.a + '|' + l.b, { kind: l.kind, by: l.made_by, at: ms(l.updated_at) });
}
const LINK_VERBS = ['matched', 'split', 'unlinked'];

// ---- track notes ------------------------------------------------------------------

export const notesOn = () => notesMode === 'on';
export const notesFor = (refs) => refs.flatMap((r) => notes.get(r) || []);
export const myNotes = (authorId) => [...notes.values()].flat().filter((n) => n.authorId === authorId);
// Your note on a track: the newest one with something in it, across its sources.
export function myNote(refs, authorId) {
  return notesFor(refs).filter((n) => n.authorId === authorId && (n.body || n.tags.length))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
}

function parseTags(v) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function putNote(r, at) {
  const n = { ref: r.track_ref, authorId: r.author_id, author: r.author, title: r.title || '', body: r.body || '', tags: parseTags(r.tags), updatedAt: at };
  notes.set(n.ref, [...(notes.get(n.ref) || []).filter((x) => x.authorId !== n.authorId), n]);
}

// All notes, or only those changed since the newest one already here.
async function loadNotes(changedOnly) {
  const since = changedOnly && notesSince ? new Date(notesSince + 1).toISOString() : '';
  const rows = await readAll(() => {
    const q = conn().from('track_notes').select('*');
    return (since ? q.gt('updated_at', since) : q).order('updated_at');
  });
  if (!since) notes.clear();
  for (const r of rows) { const at = ms(r.updated_at); putNote(r, at); if (at > notesSince) notesSince = at; }
  notesMode = 'on';
  return rows.length;
}

export async function setNote(ref, authorId, title, body, tags) {
  const before = notes.get(ref);
  putNote({ track_ref: ref, author_id: authorId, author: me(), title, body, tags }, Date.now());
  emit('notes');
  const res = await write('note', conn().from('track_notes').upsert({ track_ref: ref, author_id: authorId, author: me(), title, body, tags }, { onConflict: 'track_ref,author_id' }), null);
  if (!res) { if (before) notes.set(ref, before); else notes.delete(ref); emit('notes'); }
  return !!res;
}

function addComment(c) {
  if (!comments.has(c.playlist_id)) comments.set(c.playlist_id, []);
  const arr = comments.get(c.playlist_id);
  if (!arr.some((x) => x.id === c.id)) arr.push({ id: c.id, k: c.track_key, author: c.author, body: c.body, at: ms(c.created_at) });
}

async function reloadList(id) {
  const p = await conn().from('playlists').select('*').eq('id', id).limit(1);
  if (!p.ok) return;
  const row = p.rows && p.rows[0];
  if (!row || row.deleted_at) { lists.delete(id); comments.delete(id); return; }
  const ts = await readAll(() => conn().from('playlist_tracks').select('*').eq('playlist_id', id).is('removed_at', null).order('position'));
  const l = toList(row);
  l.entries = ts.map(toEntry);
  lists.set(id, l);
  const cs = await readAll(() => conn().from('comments').select('*').eq('playlist_id', id).order('created_at'));
  comments.set(id, []);
  for (const c of cs) addComment(c);
}

function toActivity(a) {
  return { id: Number(a.id), at: ms(a.at), actor: a.actor, verb: a.verb, listId: a.playlist_id, k: a.track_key, detail: a.detail || {} };
}

async function loadActivity() {
  const res = await conn().from('activity').select('*').order('id', { ascending: false }).limit(300);
  if (!res.ok) return;
  activity.length = 0;
  activity.push(...res.rows.map(toActivity).reverse());
  cursor = activity.length ? activity[activity.length - 1].id : 0;
}

// Keys that just changed by someone else, for the "arrived" highlight.
export const arrived = new Map(); // `${listId}|${k}` → time

async function poll() {
  try {
    const res = await conn().from('activity').select('*').gt('id', cursor).order('id').limit(200);
    if (!res.ok) throw new Error(res.error || 'poll failed');
    status.lastSync = Date.now();
    // Notes change without always reaching the feed (edits soon after the
    // first save don't), so they're also re-read every few polls.
    const noted = res.rows.some((a) => a.verb === 'track-noted' && a.actor !== me());
    if (notesOn() && (noted || ++polls % 6 === 0) && (await loadNotes(true).catch(() => 0))) emit('notes');
    if (res.rows.length) {
      const fresh = res.rows.map(toActivity);
      cursor = fresh[fresh.length - 1].id;
      activity.push(...fresh);
      if (activity.length > 500) activity.splice(0, activity.length - 500);
      const theirs = fresh.filter((a) => a.actor !== me());
      const touched = new Set(theirs.map((a) => a.listId).filter(Boolean));
      for (const id of touched) await reloadList(id);
      if (theirs.some((a) => LINK_VERBS.includes(a.verb))) { await loadLinks().catch(() => {}); emit('links'); }
      for (const a of theirs) if (a.k) arrived.set(a.listId + '|' + a.k, Date.now());
      if (theirs.length) {
        const last = theirs[theirs.length - 1];
        status.arriving = { actor: last.actor, count: theirs.length, at: Date.now(), text: describe(last) };
        emit('arrived');
      }
      emit('lists');
    } else emit('status');
  } catch (e) {
    console.warn('[crate] shared poll', e && e.message);
  }
  schedule();
}

export function describe(a) {
  const title = a.detail && a.detail.title ? '“' + a.detail.title + '”' : '';
  const list = lists.get(a.listId);
  const where = list ? list.name : (a.detail && a.detail.name) || 'a playlist';
  switch (a.verb) {
    case 'created': return 'made ' + ((a.detail && a.detail.kind) === 'set' ? 'set ' : 'playlist ') + where;
    case 'renamed': return 'renamed ' + (a.detail.from || '') + ' to ' + (a.detail.to || '');
    case 'deleted': return 'deleted ' + where;
    case 'added': return 'added ' + title + ' to ' + where;
    case 'removed': return 'removed ' + title + ' from ' + where;
    case 'moved': return 'moved ' + title + ' in ' + where;
    case 'coloured': return 'coloured ' + title + ' ' + (a.detail.color || 'none') + ' in ' + where;
    case 'energy': return 'set ' + title + ' to energy ' + a.detail.energy + ' in ' + where;
    case 'noted': return 'noted the transition after ' + title + ' in ' + where;
    case 'commented': return 'commented on ' + title + ' in ' + where;
    case 'track-noted': return 'wrote a note on ' + (title || 'a track');
    case 'matched': return 'joined two rows of ' + (title || 'a track') + ' as the same track';
    case 'split': return 'split ' + (title || 'a track') + ': two different tracks';
    case 'unlinked': return 'undid a match fix on ' + (title || 'a track');
    default: return a.verb + ' ' + title;
  }
}

// ---- writes ----------------------------------------------------------------------

// Every write: optimistic cache change, then the database; on refusal put the
// list back as the database has it and say so.
async function write(what, op, listId) {
  const res = await op;
  const ok = res && res.ok && (res.changes == null || res.changes > 0);
  if (ok) { status.writeError = ''; emit('status'); return res; }
  status.writeError = res && res.ok ? 'the database accepted no rows' : (res && res.error) || 'refused';
  console.warn('[crate] shared write refused:', what, status.writeError);
  if (listId) await reloadList(listId);
  emit('lists');
  emit('status');
  return null;
}

export async function createList(name, kind, forkedFrom) {
  const res = await write('create', conn().from('playlists').insert({ kind, name, owner: me(), forked_from: forkedFrom || null }).select('*'));
  if (!res || !res.rows || !res.rows[0]) return null;
  const l = toList(res.rows[0]);
  lists.set(l.id, l);
  emit('lists');
  return l;
}

export async function renameList(id, name) {
  const l = lists.get(id);
  if (!l) return;
  l.name = name; l.updatedAt = Date.now();
  emit('lists');
  await write('rename', conn().from('playlists').update({ name, updated_by: me() }).eq('id', id), id);
}

export async function deleteList(id) {
  if (!lists.has(id)) return;
  lists.delete(id);
  emit('lists');
  await write('delete', conn().from('playlists').update({ deleted_at: iso(), updated_by: me() }).eq('id', id), id);
}

export async function addTracks(id, tracks, snapshot) {
  const l = lists.get(id);
  if (!l) return 0;
  const fresh = tracks.filter((t) => !l.entries.some((e) => e.k === t.k));
  if (!fresh.length) return 0;
  let pos = l.entries.reduce((m, e) => Math.max(m, e.position), 0);
  const rows = fresh.map((t) => ({
    playlist_id: id, track_key: t.k, track: snapshot(t), position: (pos += 1),
    added_by: me(), removed_at: null, removed_by: null,
  }));
  for (const r of rows) l.entries.push(toEntry({ ...r, added_at: iso(), updated_at: iso() }));
  l.updatedAt = Date.now();
  emit('lists');
  const res = await write('add', conn().from('playlist_tracks').upsert(rows, { onConflict: 'playlist_id,track_key' }), id);
  return res ? fresh.length : 0;
}

export async function removeTracks(id, keys) {
  const l = lists.get(id);
  if (!l) return;
  l.entries = l.entries.filter((e) => !keys.includes(e.k));
  emit('lists');
  await write('remove', conn().from('playlist_tracks').update({ removed_at: iso(), removed_by: me() }).eq('playlist_id', id).in('track_key', keys), id);
}

const COLUMN = { color: 'color', colorBy: 'color_by', energy: 'energy', energyBy: 'energy_by', note: 'note', noteBy: 'note_by' };

export async function updateEntry(id, k, patch) {
  const l = lists.get(id);
  const e = l && l.entries.find((x) => x.k === k);
  if (!e) return;
  Object.assign(e, patch);
  const row = {};
  for (const [key, v] of Object.entries(patch)) if (COLUMN[key]) row[COLUMN[key]] = v;
  emit('lists');
  if (!Object.keys(row).length) return;
  await write('update', conn().from('playlist_tracks').update(row).eq('playlist_id', id).eq('track_key', k), id);
}

// Order is a fractional position, so a move writes one row.
export async function moveTo(id, k, toIndex) {
  const l = lists.get(id);
  if (!l) return false;
  const from = l.entries.findIndex((e) => e.k === k);
  if (from < 0) return false;
  const [e] = l.entries.splice(from, 1);
  const at = Math.max(0, Math.min(l.entries.length, toIndex));
  l.entries.splice(at, 0, e);
  const before = l.entries[at - 1], after = l.entries[at + 1];
  e.position = before && after ? (before.position + after.position) / 2 : before ? before.position + 1 : after ? after.position - 1 : 1;
  emit('lists');
  await write('move', conn().from('playlist_tracks').update({ position: e.position, moved_by: me() }).eq('playlist_id', id).eq('track_key', k), id);
  return true;
}

// Replace an entry's saved track (a split took a source off it).
export async function setEntryTrack(id, k, track) {
  const l = lists.get(id);
  const e = l && l.entries.find((x) => x.k === k);
  if (!e) return false;
  e.track = track;
  emit('lists');
  return !!(await write('split', conn().from('playlist_tracks').update({ track }).eq('playlist_id', id).eq('track_key', k), id));
}

export async function refreshTrack(t, snapshot) {
  for (const l of lists.values()) {
    const e = l.entries.find((x) => x.k === t.k);
    if (!e) continue;
    const next = { ...e.track, ...Object.fromEntries(Object.entries(snapshot(t)).filter(([, v]) => v != null && v !== '')) };
    if (JSON.stringify(next) === JSON.stringify(e.track)) continue;
    e.track = next;
    await write('refresh', conn().from('playlist_tracks').update({ track: next }).eq('playlist_id', l.id).eq('track_key', t.k), null);
  }
}

// A match fix between two source tracks (see links.js). One row per pair.
export async function setLink(a, b, kind, title) {
  const key = a + '|' + b;
  const before = links.get(key);
  if (kind === 'none') links.delete(key); else links.set(key, { kind, by: me(), at: Date.now() });
  emit('links');
  const res = await write('link', conn().from('track_links').upsert({ a, b, kind, made_by: me(), detail: { title: title || '' } }, { onConflict: 'a,b' }), null);
  if (!res) { if (before) links.set(key, before); else links.delete(key); emit('links'); }
  return !!res;
}

export async function addComment_(id, k, body) {
  const res = await write('comment', conn().from('comments').insert({ playlist_id: id, track_key: k, author: me(), body }).select('*'), id);
  if (res && res.rows && res.rows[0]) { addComment(res.rows[0]); emit('lists'); return true; }
  return false;
}
export { addComment_ as postComment };
