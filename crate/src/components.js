// Small presentational pieces shared by the views.

import { h, initial, keyCompat, bpmCompat, worst } from './util.js';

export const SOURCES = [
  { id: 'so', code: 'SO', name: 'Soundeo', how: 'Shim session', ready: true },
  { id: 'bp', code: 'BP', name: 'Beatport', how: 'Shim session', ready: true },
  { id: 'sc', code: 'SC', name: 'SoundCloud', how: 'site key', ready: true },
  { id: 'yt', code: 'YT', name: 'YouTube', how: 'site search, opens in a tab', ready: true },
  { id: 'bc', code: 'BC', name: 'Bandcamp', how: 'public pages', ready: false },
];
export const READY = SOURCES.filter((s) => s.ready);

export function chip(id, opts = {}) {
  const s = SOURCES.find((x) => x.id === id);
  return h('span', { class: 'chip chip-' + id + (opts.large ? ' chip-lg' : '') + (opts.dim ? ' chip-dim' : '') + (opts.unset ? ' chip-unset' : ''), title: s ? s.name : id }, s ? s.code : id.toUpperCase());
}

// One fixed lane per set-up source, so each chip always sits in the same column.
export function chipLanes(track) {
  return h('span', { class: 'lanes' }, READY.map((s) => h('span', { class: 'lane' }, track.sources && track.sources[s.id] ? chip(s.id) : null)));
}

export function art(src, size) {
  const box = h('span', { class: 'art', style: { width: size + 'px', height: size + 'px' } });
  if (src) {
    const img = h('img', { src, alt: '', loading: 'lazy', width: size, height: size });
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

export function energy(value, opts = {}) {
  const v = Math.max(0, Math.min(5, value || 0));
  return h('span', { class: 'energy' + (opts.large ? ' energy-lg' : ''), title: 'Energy ' + v + ' / 5' },
    h('span', { class: 'energy-empty' }, '★★★★★'),
    h('span', { class: 'energy-fill', style: { width: (v / 5 * 100) + '%' } }, '★★★★★'));
}

export function swatch(color, by) {
  return h('span', { class: 'swatch' + (color ? '' : ' swatch-none'), style: color ? { background: 'var(--tcs' + color + ')' } : null, title: color ? 'Colour ' + color + (by ? ' · ' + by : '') : 'No colour' },
    color && by ? initial(by) : '');
}

export function avatar(name) {
  return h('span', { class: 'avatar', title: name || '' }, initial(name));
}

export function keycap(...keys) {
  return keys.map((k) => h('kbd', null, k));
}

export function section(title, right) {
  return h('div', { class: 'sec-head' }, h('span', null, title), right ? h('span', { class: 'sec-right' }, right) : null);
}

// The compatibility strip between two neighbouring tracks in a set.
export function compat(a, b, note, opts = {}) {
  const k = keyCompat(a.camelot, b.camelot);
  const bpm = bpmCompat(a.bpm, b.bpm);
  const level = worst(k && k.level, bpm && bpm.level);
  const mark = { ok: '✓', mid: '~', bad: '✕' };
  return h('div', { class: 'compat' + (opts.focused ? ' is-focus' : ''), dataset: { from: a.k } },
    h('span', { class: 'rail rail-' + (k || bpm ? level : 'none') }),
    k ? h('span', { class: 'cmp-key cmp-' + k.level }, a.camelot + ' → ' + b.camelot + ' ' + k.text + ' ' + mark[k.level])
      : h('span', { class: 'cmp-key cmp-none' }, 'key unknown'),
    bpm ? h('span', { class: 'cmp-bpm cmp-' + bpm.level }, bpm.text) : h('span', { class: 'cmp-bpm cmp-none' }, 'BPM unknown'),
    opts.editing ? opts.editing
      : note ? h('span', { class: 'cmp-note' }, '✎ ' + note.text, h('span', { class: 'dim' }, ' · ' + note.by))
        : h('span', { class: 'cmp-note cmp-empty' }, '+ transition note ', h('kbd', null, 'T')));
}
