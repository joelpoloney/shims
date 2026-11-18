// App state shared by the views, plus the render hook the app installs.

export const S = {
  view: 'search',        // search | library | list | settings
  listId: null,          // the open playlist or set
  q: '',
  results: [],           // merged tracks, in source order
  searched: false,
  searching: false,
  suggest: null,         // { listId, name, lo, hi, artists, labels, genres }: search shows suggestions for a playlist
  versions: null,        // { q, k, title, artists, label }: search shows versions of one track
  sources: { so: { state: 'idle', count: 0, error: '' }, sc: { state: 'idle', count: 0, error: '' }, bp: { state: 'idle', count: 0, error: '' }, yt: { state: 'idle', count: 0, error: '' } },
  focus: {},             // per list scope: focused key
  sel: new Set(),        // selected keys in the current list
  anchor: null,          // where a shift-selection started
  panel: false,          // track detail open
  overlay: null,         // { kind, ... }
  sourceId: null,        // the open source collection (Soundeo favorites…)
  collections: {},       // per collection: { state, tracks, error, loadedAt }
  libFilter: 'all',
  groupByColour: false,
  toast: null,
};

let renderFn = () => {};
export function setRender(fn) { renderFn = fn; }
export function render(...parts) { renderFn(parts.length ? parts : null); }

let toastTimer = 0;
export function toast(text, kind) {
  S.toast = { text, kind: kind || '' };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = null; render('toast'); }, 3200);
  render('toast');
}
