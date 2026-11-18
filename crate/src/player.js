// The player: one <audio> element, a queue, Media Session (hardware media keys
// and Now Playing), and waveforms.
//
// The page can't read audio bytes (the CSP blocks fetch), so a waveform is
// built by playing a second, silent copy of the track at 16x through Web Audio
// and measuring it: about eight seconds for a two-minute preview. Results are
// cached per audio URL.

import { cacheGet, cacheSet, prefs, savePrefs } from './store.js';
import { tempoMeter } from './bpm.js';

export const BINS = 480;
const listeners = new Set();
const audio = new Audio();
audio.preload = 'auto';
audio.volume = prefs.volume;

export const state = {
  queue: [],      // tracks
  index: -1,
  from: '',       // where the queue came from, for the player bar
  playing: false,
  time: 0,
  duration: 0,
  error: '',
  waves: new Map(), // audio path → { peaks: number[], done: boolean }
};

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// Batched to one update per frame; a hidden tab gets no frames, so it falls
// back to a timer there (media keys keep working while Crate is out of sight).
let raf = 0;
function emit() {
  if (raf) return;
  const run = () => { raf = 0; for (const fn of listeners) fn(); };
  raf = document.hidden ? setTimeout(run, 250) : requestAnimationFrame(run);
}

export const current = () => state.queue[state.index] || null;
// A full stream beats a preview clip; among equals, the order below.
export const audioOf = (t) => {
  if (!t || !t.sources) return null;
  const order = ['sc', 'so', 'bp', 'bc'];
  const have = order.map((id) => [id, t.sources[id]]).filter(([, s]) => s && s.audio);
  const pick = have.find(([, s]) => !s.clip) || have[0];
  return pick ? { source: pick[0], src: pick[1].audio, clip: !!pick[1].clip } : null;
};
export const playable = (t) => !!audioOf(t);

export function setVolume(v) {
  audio.volume = Math.min(1, Math.max(0, v));
  prefs.volume = audio.volume;
  savePrefs();
  emit();
}
export const volume = () => audio.volume;
export function initVolume() { audio.volume = Math.min(1, Math.max(0, Number(prefs.volume) || 0.9)); }

// ---- queue -------------------------------------------------------------------

export function playList(tracks, start, from) {
  const list = tracks.filter(playable);
  const first = tracks[start];
  const i = Math.max(0, list.indexOf(first));
  if (!list.length) return false;
  state.queue = list.slice();
  state.from = from || '';
  loadAt(i, true);
  return true;
}

export function playNext(tracks) {
  const add = tracks.filter(playable).filter((t) => !state.queue.includes(t));
  if (!add.length) return 0;
  if (state.index < 0) { state.queue = add; state.from = 'Queue'; loadAt(0, true); return add.length; }
  state.queue.splice(state.index + 1, 0, ...add);
  emit();
  return add.length;
}

export function removeAt(i) {
  if (i < 0 || i >= state.queue.length) return;
  if (i === state.index) {
    state.queue.splice(i, 1);
    if (state.queue.length) loadAt(Math.min(i, state.queue.length - 1), state.playing);
    else clear();
    return;
  }
  state.queue.splice(i, 1);
  if (i < state.index) state.index--;
  emit();
}

export function moveInQueue(i, d) {
  const j = i + d;
  if (i < 0 || j < 0 || i >= state.queue.length || j >= state.queue.length) return i;
  const [t] = state.queue.splice(i, 1);
  state.queue.splice(j, 0, t);
  if (state.index === i) state.index = j;
  else if (state.index === j) state.index = i;
  emit();
  return j;
}

export function clear() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.queue = [];
  state.index = -1;
  state.playing = false;
  state.time = state.duration = 0;
  updateSession();
  emit();
}

// A source can hand out preview links that expire (Soundeo signs some for a
// few days); the resolver fetches a fresh one when a link is stale or fails.
let resolver = null;
export function setResolver(r) { resolver = r; }
const retried = new Set();

async function loadAt(i, play) {
  const t = state.queue[i];
  let a = audioOf(t);
  if (!a) return;
  if (resolver && resolver.stale(a.src)) {
    state.index = i;
    state.error = 'Refreshing preview link…';
    emit();
    await resolver.fresh(t);
    if (state.queue[i] !== t) return;
    a = audioOf(t);
  }
  retried.delete(t.k);
  state.index = i;
  state.error = '';
  state.time = 0;
  state.duration = t.len && !a.clip ? t.len : 0;
  audio.src = a.src;
  if (play) start();
  updateSession();
  wave(a.src, t);
  const nt = state.queue[i + 1];
  const next = audioOf(nt);
  if (next) setTimeout(() => wave(next.src, nt), 12000);
  emit();
}

function start() {
  ensureContext();
  audio.play().catch((e) => {
    // A load failure is handled by the error listener; a new src aborts the old play().
    if (e.name === 'NotSupportedError' || e.name === 'AbortError') return;
    state.error = e.message;
    emit();
  });
}

export function toggle() {
  if (!current()) return;
  if (audio.paused) start(); else audio.pause();
}
export function play() { if (current() && audio.paused) start(); }
export function pause() { audio.pause(); }

export function next() {
  if (state.index + 1 < state.queue.length) loadAt(state.index + 1, true);
  else { audio.pause(); audio.currentTime = 0; }
}

// ⏮ restarts the track; a second press within 3s goes to the previous one.
export function prev() {
  if (audio.currentTime > 3 || state.index <= 0) { audio.currentTime = 0; return; }
  loadAt(state.index - 1, true);
}

export function seek(sec) {
  if (!current() || !Number.isFinite(sec)) return;
  const d = audio.duration || state.duration;
  audio.currentTime = Math.max(0, Math.min(d ? d - 0.1 : sec, sec));
  state.time = audio.currentTime;
  emit();
}
export const seekBy = (d) => seek(audio.currentTime + d);
export const seekFraction = (f) => seek(f * (audio.duration || state.duration || 0));

audio.addEventListener('play', () => { state.playing = true; setPlaybackState(); emit(); });
audio.addEventListener('pause', () => { state.playing = false; setPlaybackState(); emit(); });
audio.addEventListener('timeupdate', () => { state.time = audio.currentTime; setPosition(); emit(); });
audio.addEventListener('loadedmetadata', () => { state.duration = audio.duration; setPosition(); emit(); });
audio.addEventListener('ended', () => next());
audio.addEventListener('error', async () => {
  const t = current();
  if (!t || !audio.getAttribute('src')) return;
  if (resolver && !retried.has(t.k)) {
    retried.add(t.k);
    state.error = 'Refreshing preview link…';
    emit();
    const src = await resolver.fresh(t);
    if (src && current() === t) {
      state.error = '';
      audio.src = src;
      start();
      wave(src, t);
      emit();
      return;
    }
  }
  if (current() !== t) return;
  state.error = 'This preview didn\'t load';
  emit();
  if (state.index + 1 < state.queue.length) setTimeout(() => { if (state.error && current() === t) next(); }, 1500);
});

// ---- Media Session -----------------------------------------------------------

const artCache = new Map();

// Now Playing takes only http(s), data or blob artwork, so the cover (served
// from our own origin) is drawn onto a canvas and handed over as a data URL.
function artworkData(src) {
  if (!src) return Promise.resolve('');
  if (artCache.has(src)) return artCache.get(src);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 512;
        c.getContext('2d').drawImage(img, 0, 0, 512, 512);
        resolve(c.toDataURL('image/jpeg', 0.86));
      } catch { resolve(''); }
    };
    img.onerror = () => resolve('');
    img.src = src;
  });
  artCache.set(src, p);
  return p;
}

const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
if (ms) {
  const handlers = {
    play: () => play(),
    pause: () => pause(),
    nexttrack: () => next(),
    previoustrack: () => prev(),
    seekbackward: (d) => seekBy(-(d.seekOffset || 10)),
    seekforward: (d) => seekBy(d.seekOffset || 10),
    seekto: (d) => seek(d.seekTime),
  };
  for (const [name, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(name, fn); } catch { /* unsupported action */ }
  }
}

async function updateSession() {
  if (!ms) return;
  const t = current();
  if (!t) { ms.metadata = null; ms.playbackState = 'none'; return; }
  const meta = { title: t.title + (t.mix ? ' (' + t.mix + ')' : ''), artist: t.artist, album: t.label || t.release || '' };
  ms.metadata = new MediaMetadata(meta);
  const data = await artworkData(t.art500 || t.art50);
  if (data && current() === t) ms.metadata = new MediaMetadata({ ...meta, artwork: [{ src: data, sizes: '512x512', type: 'image/jpeg' }] });
}
function setPlaybackState() { if (ms) ms.playbackState = audio.paused ? 'paused' : 'playing'; }
function setPosition() {
  if (!ms || !ms.setPositionState || !audio.duration || !Number.isFinite(audio.duration)) return;
  try { ms.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 }); } catch { /* not ready */ }
}

// Keyboard media keys reach the page directly while it is focused.
document.addEventListener('keydown', (e) => {
  if (e.key === 'MediaPlayPause') { e.preventDefault(); toggle(); }
  else if (e.key === 'MediaTrackNext') { e.preventDefault(); next(); }
  else if (e.key === 'MediaTrackPrevious') { e.preventDefault(); prev(); }
});

// ---- waveforms -----------------------------------------------------------------

// A source that publishes its own waveform answers here first; otherwise the
// track is measured with the silent 16x pass.
let waveProvider = null;
export function setWaveProvider(fn) { waveProvider = fn; }

let ctx = null;
function ensureContext() {
  if (!ctx) { try { ctx = new AudioContext(); } catch { ctx = null; } }
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

const waveJobs = [];
let waveBusy = false;

function encode(peaks) { return peaks.map((p) => Math.round(p * 99)).join(','); }
function decode(s) { return s.split(',').map((n) => Number(n) / 99); }

// Keyed without the signature query; a source's own waveform by its track id.
const waveKey = (src, t) => {
  const a = t && audioOf(t);
  if (a && a.source === 'sc') return 'sc:' + t.sources.sc.id;
  return (src || '').split('?')[0];
};
export function waveFor(src, t) { return state.waves.get(waveKey(src, t)) || null; }

async function wave(src, t) {
  const key = waveKey(src, t);
  if (src && t) { waveTracks.set(key, t); tempo(src, t); }
  if (!src || state.waves.has(key)) return;
  const cached = await cacheGet('wave:' + key);
  if (typeof cached === 'string' && cached) {
    state.waves.set(key, { peaks: decode(cached), done: true });
    emit();
    return;
  }
  state.waves.set(key, { peaks: new Array(BINS).fill(0), done: false });
  if (waveProvider && t) {
    const peaks = await waveProvider(t, BINS);
    if (peaks) {
      state.waves.set(key, { peaks, done: true });
      cacheSet('wave:' + key, encode(peaks));
      emit();
      return;
    }
  }
  if (/^sc:/.test(key)) { state.waves.delete(key); return; } // a stream is never measured at 16x
  waveJobs.push(src);
  runWaves();
}

// ---- tempo -----------------------------------------------------------------------
// A track with no BPM gets one from its audio. A preview is measured during
// its waveform pass; anything else (a stream, a preview whose waveform is
// already saved) gets a short silent pass of its own from a third of the way
// in, where the drums usually are. Answers are remembered, misses too.

const waveTracks = new Map(); // wave key → the track it belongs to
const tempoAsked = new Set();
const tempoJobs = [];
let tempoSink = () => {};
export function setTempoSink(fn) { tempoSink = fn; }
const TEMPO_RATE = 8, TEMPO_SEC = 40, SURE = 0.08;

function gotTempo(key, r) {
  const t = waveTracks.get(key);
  // Too little audio to judge (a load that failed) isn't an answer: ask again later.
  if (!r) { tempoAsked.delete(key); return; }
  const ok = r.sure >= SURE;
  console.debug('[crate] tempo', key, r.bpm + ' (' + r.exact + ', sure ' + r.sure.toFixed(2) + ')', t && t.bpm ? 'listed ' + t.bpm : '');
  cacheSet('tempo:' + key, ok ? r.bpm : 0);
  if (ok && t && !t.bpm) tempoSink(t, r.bpm);
}

async function tempo(src, t) {
  const key = waveKey(src, t);
  // A placeholder for a link not fetched yet can't be loaded: wait until it plays.
  if (t.bpm || tempoAsked.has(key) || (resolver && resolver.stale(src))) return;
  tempoAsked.add(key);
  const saved = await cacheGet('tempo:' + key);
  if (typeof saved === 'number') { if (saved && !t.bpm) tempoSink(t, saved); return; }
  // A preview with no waveform yet is about to be measured anyway.
  if (!/^sc:/.test(key) && !state.waves.get(key)?.done) return;
  tempoJobs.push([src, key]);
  runWaves();
}

// Measure a track's tempo without playing it (its details are open).
export async function tempoOf(t) {
  if (!t || t.bpm || !resolver) return;
  let a = audioOf(t);
  if (!a) return;
  if (tempoAsked.has(waveKey(a.src, t))) return;
  if (resolver.stale(a.src)) { await resolver.fresh(t); a = audioOf(t); }
  if (!a || resolver.stale(a.src)) return;
  waveTracks.set(waveKey(a.src, t), t);
  tempo(a.src, t);
}

function measureTempo(c, src, key) {
  return new Promise((resolve) => {
    const el = new Audio();
    el.preservesPitch = false;
    el.src = src;
    const node = c.createMediaElementSource(el);
    const proc = c.createScriptProcessor(512, 1, 1);
    const silent = c.createGain();
    silent.gain.value = 0;
    node.connect(proc); proc.connect(silent); silent.connect(c.destination);
    const meter = tempoMeter(c.sampleRate, TEMPO_RATE);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(giveUp);
      proc.onaudioprocess = null;
      try { node.disconnect(); proc.disconnect(); silent.disconnect(); } catch { /* already gone */ }
      el.pause(); el.removeAttribute('src'); el.load();
      gotTempo(key, meter.result());
      resolve();
    };
    const giveUp = setTimeout(finish, 30000);
    proc.onaudioprocess = (ev) => {
      if (el.paused || el.seeking) return;
      meter.feed(ev.inputBuffer.getChannelData(0));
      if (meter.seconds() >= TEMPO_SEC) finish();
    };
    el.addEventListener('ended', finish);
    el.addEventListener('error', finish);
    el.addEventListener('loadedmetadata', () => {
      const d = Number.isFinite(el.duration) ? el.duration : 0;
      if (d > TEMPO_SEC * 1.5) el.currentTime = Math.min(d - TEMPO_SEC - 5, d * 0.33);
      el.playbackRate = TEMPO_RATE;
    });
    el.play().catch(finish);
  });
}

async function runWaves() {
  if (waveBusy) return;
  waveBusy = true;
  while (waveJobs.length || tempoJobs.length) {
    const c = ensureContext();
    if (!waveJobs.length) {
      const [src, key] = tempoJobs.shift();
      if (!c || c.state !== 'running') { tempoAsked.delete(key); continue; }
      await measureTempo(c, src, key);
      continue;
    }
    const src = waveJobs.shift();
    if (!c || c.state !== 'running') { state.waves.delete(waveKey(src)); continue; }
    try { await measure(c, src); } catch (e) { console.warn('[crate] waveform', e && e.message); state.waves.delete(waveKey(src)); }
  }
  waveBusy = false;
}

function measure(c, src) {
  return new Promise((resolve, reject) => {
    const entry = state.waves.get(waveKey(src));
    const sums = new Float64Array(BINS), counts = new Uint32Array(BINS);
    const el = new Audio();
    el.preservesPitch = false;
    el.src = src;
    const node = c.createMediaElementSource(el);
    const proc = c.createScriptProcessor(512, 1, 1);
    const silent = c.createGain();
    silent.gain.value = 0;
    node.connect(proc); proc.connect(silent); silent.connect(c.destination);
    let last = 0;
    const meter = tempoMeter(c.sampleRate, 16);
    proc.onaudioprocess = (ev) => {
      const d = el.duration;
      if (!d || !Number.isFinite(d)) return;
      const data = ev.inputBuffer.getChannelData(0);
      meter.feed(data);
      const b = Math.min(BINS - 1, Math.floor(el.currentTime / d * BINS));
      let s = 0;
      for (let i = 0; i < data.length; i++) s += data[i] * data[i];
      sums[b] += s; counts[b] += data.length;
      if (performance.now() - last > 250) { last = performance.now(); publish(false); }
    };
    const publish = (done) => {
      const rms = Array.from(sums, (s, i) => (counts[i] ? Math.sqrt(s / counts[i]) : 0));
      // fill bins the 16x pass stepped over
      for (let i = 1; i < BINS; i++) if (!counts[i] && counts[i - 1] && done) rms[i] = rms[i - 1];
      const max = Math.max(0.0001, ...rms);
      entry.peaks = rms.map((v) => Math.pow(v / max, 0.8));
      entry.done = done;
      emit();
    };
    const finish = () => {
      proc.onaudioprocess = null;
      try { node.disconnect(); proc.disconnect(); silent.disconnect(); } catch { /* already gone */ }
      el.removeAttribute('src'); el.load();
    };
    el.addEventListener('ended', () => {
      publish(true);
      finish();
      cacheSet('wave:' + waveKey(src), encode(entry.peaks));
      gotTempo(waveKey(src), meter.result());
      resolve();
    });
    el.addEventListener('error', () => { finish(); reject(new Error('audio failed')); });
    el.addEventListener('loadedmetadata', () => { el.playbackRate = 16; });
    el.play().catch((e) => { finish(); reject(e); });
  });
}
