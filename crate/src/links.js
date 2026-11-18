// Match fixes. Search joins rows from different sources automatically (ISRC,
// then the preview file, then artist / title / mix); when that guess is wrong
// you can say two source tracks are the same ('same') or not ('split').
// A fix names the two source tracks ("so:123", "bp:456"), never the rows, so it
// holds for every later search. Fixes live in the shared space when it's on
// (the whole group sees them), else on this machine.

import * as shared from './shared.js';

const api = window.api;
let local = {}; // 'a|b' → { kind, by, at }

export const refOf = (source, s) => (s && s.id ? source + ':' + s.id : '');
export const refsOf = (t) => Object.entries(t.sources || {}).map(([id, s]) => refOf(id, s)).filter(Boolean);
const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const table = () => (shared.on() ? shared.links : null);

export async function load() {
  try { local = (await api.storage.get('links')) || {}; } catch { local = {}; }
}

export function linkOf(x, y) {
  if (!x || !y || x === y) return null;
  const key = pair(x, y).join('|');
  const t = table();
  return (t ? t.get(key) : local[key]) || null;
}

const kindOf = (x, y) => { const l = linkOf(x, y); return l ? l.kind : ''; };
export const isSplit = (x, y) => kindOf(x, y) === 'split';
export const isSame = (x, y) => kindOf(x, y) === 'same';

// Any of a row's source tracks split from this one?
export const splitFrom = (t, ref) => refsOf(t).some((q) => isSplit(q, ref));
export const sameAs = (t, ref) => refsOf(t).some((q) => isSame(q, ref));

// The fix that explains why two source tracks are (not) together, for the panel.
export function fixBetween(t, ref) {
  for (const q of refsOf(t)) { const l = linkOf(q, ref); if (l) return l; }
  return null;
}

export async function set(x, y, kind, title, by) {
  const [a, b] = pair(x, y);
  if (shared.on()) return shared.setLink(a, b, kind, title);
  const key = a + '|' + b;
  if (kind === 'none') delete local[key]; else local[key] = { kind, by, at: Date.now() };
  try { await api.storage.set('links', local); return true; } catch (e) { console.warn('[crate] links', e && e.message); return false; }
}

// Every fix that touches a row's source tracks: [{ a, b, kind, by }].
export function fixesFor(t) {
  const mine = new Set(refsOf(t));
  const all = table() ? [...table().entries()] : Object.entries(local);
  return all.filter(([key]) => key.split('|').some((r) => mine.has(r)))
    .map(([key, l]) => { const [a, b] = key.split('|'); return { a, b, kind: l.kind, by: l.by }; });
}
