// Each table's columns: which show, in what order, and how wide. Only what
// you changed is kept (the hidden ones, an order, the widths you dragged), so
// a column added later shows up in its usual place until you move or hide it.

import * as store from './store.js';

// [id, name, always shown]
export const TABLES = {
  search: [['artist', 'Artist', true], ['title', 'Title', true], ['mix', 'Mix'], ['note', 'Notes'], ['label', 'Label'], ['genre', 'Genre'], ['bpm', 'BPM'], ['key', 'Key'], ['len', 'Length'], ['released', 'Released'], ['plays', 'DJ plays'], ['fresh', 'Freshness'], ['sources', 'Sources']],
  playlist: [['artist', 'Artist', true], ['title', 'Title', true], ['mix', 'Mix'], ['note', 'Notes'], ['genre', 'Genre'], ['bpm', 'BPM'], ['key', 'Key'], ['len', 'Length'], ['plays', 'DJ plays'], ['fresh', 'Freshness'], ['added', 'Added'], ['cmt', 'Comments'], ['energy', 'Energy'], ['sources', 'Sources']],
};
export const MIN_WIDTH = 28;

const saved = (key, table, empty) => ((store.prefs[key] || {})[table] || empty);
const keep = (key, table, value) => { store.prefs[key] = { ...(store.prefs[key] || {}), [table]: value }; return store.savePrefs(); };
const ids = (table) => TABLES[table].map((c) => c[0]);
const always = (table, id) => TABLES[table].some((c) => c[0] === id && c[2]);

export const isOn = (table, id) => always(table, id) || !saved('colsOff', table, []).includes(id);
export function toggle(table, id) {
  if (always(table, id)) return Promise.resolve();
  const off = saved('colsOff', table, []);
  return keep('colsOff', table, off.includes(id) ? off.filter((x) => x !== id) : [...off, id]);
}

// Every column of the table, in your order; ones you never placed keep their usual spot.
export function order(table) {
  const all = ids(table);
  const mine = saved('colsOrder', table, []).filter((id) => all.includes(id));
  const out = mine.slice();
  all.forEach((id, i) => {
    if (out.includes(id)) return;
    const after = all.slice(0, i).reverse().find((x) => out.includes(x));
    out.splice(after ? out.indexOf(after) + 1 : 0, 0, id);
  });
  return out;
}
export const shown = (table) => order(table).filter((id) => isOn(table, id));

// Put a column just before another one (or last).
export function move(table, id, beforeId) {
  if (id === beforeId) return Promise.resolve();
  const next = order(table).filter((x) => x !== id);
  const at = beforeId ? next.indexOf(beforeId) : -1;
  next.splice(at < 0 ? next.length : at, 0, id);
  return keep('colsOrder', table, next);
}

export const width = (table, id) => saved('colsW', table, {})[id] || 0;
export function setWidth(table, id, px) {
  const next = { ...saved('colsW', table, {}) };
  if (px) next[id] = Math.max(MIN_WIDTH, Math.round(px)); else delete next[id];
  return keep('colsW', table, next);
}

export const changed = (table) => saved('colsOrder', table, []).length > 0 || Object.keys(saved('colsW', table, {})).length > 0;
export async function reset(table) {
  await keep('colsOrder', table, []);
  return keep('colsW', table, {});
}
