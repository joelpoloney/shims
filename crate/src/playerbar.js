// The persistent player bar: now playing, transport, waveform with seek, and
// volume / queue / add on the right.

import { h, fmtLen, musicalKey } from './util.js';
import * as player from './player.js';
import { chip, art } from './components.js';
import { openOverlay } from './overlays.js';
import { S } from './state.js';

let ui = null;
let shownTrack = undefined;
const colours = {};

function token(name) {
  if (!colours[name]) colours[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  return colours[name];
}

export function mountPlayer(el) {
  const canvas = h('canvas', { class: 'wave' });
  const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', class: 'vol', tabindex: '-1', title: 'Volume (− / =)' });
  vol.addEventListener('input', () => player.setVolume(Number(vol.value)));
  vol.addEventListener('change', () => vol.blur());
  ui = {
    el,
    left: h('div', { class: 'p-left' }),
    playBtn: h('button', { class: 'p-play', title: 'Play / pause (Space)', tabindex: '-1', onclick: () => player.toggle() }),
    elapsed: h('span', { class: 'mono small p-time' }),
    totalEl: h('span', { class: 'mono small p-time' }),
    canvas,
    waveNote: h('span', { class: 'wave-note mono' }),
    bpmKey: h('span', { class: 'mono p-bpm' }),
    vol,
    queueBtn: h('button', { class: 'btn btn-quiet', tabindex: '-1', onclick: () => openOverlay('queue') }, 'Queue ', h('kbd', null, 'Q')),
    addBtn: h('button', { class: 'btn btn-quiet', tabindex: '-1', onclick: () => { if (player.current()) openOverlay('add', { tracks: [player.current()] }); } }, 'Add ', h('kbd', null, 'A')),
    keys: h('div', { class: 'p-keys mono' }),
  };
  const center = h('div', { class: 'p-center' },
    h('div', { class: 'p-controls' },
      h('button', { class: 'p-skip', tabindex: '-1', title: 'Restart / previous (J)', onclick: () => player.prev() }, '⏮', h('kbd', null, 'J')),
      ui.playBtn,
      h('button', { class: 'p-skip', tabindex: '-1', title: 'Next (K)', onclick: () => player.next() }, h('kbd', null, 'K'), '⏭'),
      h('span', { class: 'hints p-hint' }, h('kbd', null, 'Space'), ' play · ', h('kbd', null, '←→'), ' seek 10s')),
    h('div', { class: 'p-wave' }, ui.elapsed, h('div', { class: 'wave-box' }, canvas, ui.waveNote), ui.totalEl));
  const right = h('div', { class: 'p-right' }, ui.bpmKey, h('span', { class: 'p-vol' }, h('span', { class: 'dim' }, '🔈'), vol), ui.queueBtn, ui.addBtn, ui.keys);
  el.append(ui.left, center, right);

  let dragging = false;
  const seekAt = (e) => {
    const r = canvas.getBoundingClientRect();
    player.seekFraction(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  canvas.addEventListener('mousedown', (e) => { if (!player.current()) return; dragging = true; seekAt(e); });
  window.addEventListener('mousemove', (e) => { if (dragging) seekAt(e); });
  window.addEventListener('mouseup', () => { dragging = false; });
  new ResizeObserver(() => draw()).observe(canvas);
  player.onChange(updatePlayer);
  updatePlayer();
}

export function updatePlayer() {
  if (!ui) return;
  const t = player.current();
  const st = player.state;
  if (t !== shownTrack) {
    shownTrack = t;
    if (!t) {
      ui.left.replaceChildren(h('span', { class: 'art art-empty', style: { width: '48px', height: '48px' } }),
        h('div', { class: 'p-meta' }, h('div', { class: 'fg2' }, 'Nothing playing.'), h('div', { class: 'fg3 small' }, '⏎ on any track to start.')));
    } else {
      const a = player.audioOf(t);
      ui.left.replaceChildren(art(t.art500 || t.art50, 48),
        h('div', { class: 'p-meta' },
          h('div', { class: 'ellip p-title' }, t.title, t.mix ? h('span', { class: 'fg2' }, ' (' + t.mix + ')') : null),
          h('div', { class: 'ellip fg2 small' }, t.artist),
          h('div', { class: 'p-src small' }, chip(a.source), h('span', { class: 'fg3 mono' }, a.clip ? ' preview clip' : ' full stream'), h('span', { class: 'fg3 mono p-pos' }))));
    }
    ui.bpmKey.textContent = t ? [t.bpm, t.camelot ? t.camelot + (musicalKey(t.camelot) ? ' ' + musicalKey(t.camelot) : '') : ''].filter(Boolean).join(' · ') : '';
  }
  const pos = ui.left.querySelector('.p-pos');
  if (pos) pos.textContent = ' · ' + (st.index + 1) + ' / ' + st.queue.length + (st.from ? ' · ' + st.from : '');
  ui.playBtn.textContent = st.playing ? '❚❚' : '▶';
  ui.playBtn.disabled = !t;
  ui.elapsed.textContent = t ? fmtLen(st.time) || '0:00' : '';
  ui.totalEl.textContent = t ? fmtLen(st.duration) : '';
  if (document.activeElement !== ui.vol) ui.vol.value = String(player.volume());
  ui.queueBtn.classList.toggle('is-on', !!(S.overlay && S.overlay.kind === 'queue'));
  ui.keys.replaceChildren(...(t
    ? [h('div', { class: 'accent' }, '● Media keys → Crate'), h('div', { class: 'fg3' }, '⏯ play · ⏭ next · ⏮ prev')]
    : [h('div', { class: 'fg3' }, '○ Media keys'), h('div', { class: 'fg3' }, 'follow the last tab to play')]));
  if (st.error) ui.waveNote.textContent = st.error;
  draw();
  const main = document.getElementById('main');
  if (main) for (const row of main.querySelectorAll('[data-track]')) {
    const on = !!t && row.dataset.track === t.k;
    if (on !== row.classList.contains('is-playing') || on) refreshGlyph(row, on, st.playing);
  }
}

function refreshGlyph(row, on, playing) {
  row.classList.toggle('is-playing', on);
  const g = row.querySelector('.c-play');
  if (g) g.textContent = on ? (playing ? '▶' : '❚❚') : row.classList.contains('is-focus') ? '▷' : '';
}

function draw() {
  if (!ui) return;
  const c = ui.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, hgt = c.clientHeight;
  if (!w || !hgt) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hgt);
  const t = player.current();
  const st = player.state;
  const frac = st.duration ? Math.min(1, st.time / st.duration) : 0;
  const a = t && player.audioOf(t);
  const wave = a ? player.waveFor(a.src, t) : null;
  if (!st.error) ui.waveNote.textContent = wave && !wave.done ? 'building waveform…' : '';
  const bars = Math.floor(w / 3);
  const mid = hgt / 2;
  for (let i = 0; i < bars; i++) {
    let p = 0;
    if (wave) {
      const from = Math.floor(i / bars * player.BINS), to = Math.max(from + 1, Math.floor((i + 1) / bars * player.BINS));
      for (let b = from; b < to; b++) p = Math.max(p, wave.peaks[b] || 0);
    }
    const bh = Math.max(1, p * (hgt - 2));
    g.fillStyle = t && i / bars < frac ? token('--wave-played') : token('--wave');
    g.fillRect(i * 3, mid - bh / 2, 2, bh);
  }
}

