// SoundCloud: search and public likes through api-v2 with the public client_id
// SoundCloud embeds in its own scripts (read once, cached, re-read when it
// stops working). Streams are HLS; the media route rewrites their chunks, so
// <audio> plays a playlist's /_media/ path directly. Waveforms come from
// SoundCloud's own waveform JSON.

import { splitLabel, trackKey } from './util.js';
import { cacheGet, cacheSet } from './store.js';
import { mediaPath } from './soundeo.js';
import { streamOk, waveOk } from './safe.js';

const API = 'api-v2.soundcloud.com';
export const ID = 'sc';
const CLIENT_KEY = 'sc:client_id';
let clientPromise = null;

async function readClientId() {
  const home = await window.api.fetch('soundcloud.com', '/');
  if (!home.ok) throw new Error('soundcloud.com didn\'t answer (' + (home.error || home.status) + ')');
  const scripts = [...home.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => /a-v2\.sndcdn\.com/.test(s));
  for (const src of scripts.reverse()) {
    const u = new URL(src);
    const b = await window.api.fetch('a-v2.sndcdn.com', u.pathname + u.search);
    const m = b.ok && b.text.match(/client_id\s*:\s*"([a-zA-Z0-9]{20,})"/);
    if (m) { await cacheSet(CLIENT_KEY, m[1]); return m[1]; }
  }
  throw new Error('SoundCloud\'s page changed, so Crate can\'t find its key');
}

function clientId(fresh) {
  if (fresh) clientPromise = null;
  if (!clientPromise) {
    clientPromise = (async () => (!fresh && (await cacheGet(CLIENT_KEY))) || readClientId())();
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

// GET on api-v2 with the key; a refused key is re-read once.
async function api(path) {
  for (const fresh of [false, true]) {
    const id = await clientId(fresh);
    const res = await window.api.fetch(API, path + (path.includes('?') ? '&' : '?') + 'client_id=' + encodeURIComponent(id), { headers: { Accept: 'application/json' } });
    if ((res.status === 401 || res.status === 403) && !fresh) continue;
    if (!res.ok) throw new Error('SoundCloud answered ' + (res.error || res.status));
    try { return JSON.parse(res.text); } catch { throw new Error('SoundCloud sent something Crate can\'t read'); }
  }
  throw new Error('SoundCloud refused its key');
}

// Prefer a plain-AAC HLS stream; never an encrypted one.
function pickTranscoding(t) {
  const list = (t.media && t.media.transcodings) || [];
  const plain = list.filter((x) => !/encrypted|ctr|cbc/i.test((x.preset || '') + (x.format && x.format.mime_type || '')));
  return plain.find((x) => x.format.protocol === 'hls' && x.preset === 'aac_160k')
    || plain.find((x) => x.format.protocol === 'progressive')
    || plain.find((x) => x.format.protocol === 'hls' && /mp4|aac|mpeg/.test(x.format.mime_type))
    || null;
}

function art(url, size) {
  if (!url) return '';
  return mediaPath(url.replace(/-large(\.\w+)$/, '-' + size + '$1'));
}

export function toTrack(t) {
  if (!t || t.kind !== 'track') return null;
  const meta = t.publisher_metadata || {};
  const parsed = splitLabel(t.title || '');
  // "Artist - Title (Mix)" is the usual SoundCloud title; the uploader is the
  // fallback artist when the title has no dash.
  const artist = parsed.artist || meta.artist || (t.user && t.user.username) || '';
  const title = parsed.title;
  const tc = pickTranscoding(t);
  const bpm = /\b(\d{2,3})\s?bpm\b/i.exec((t.title || '') + ' ' + (t.tag_list || ''));
  return {
    k: trackKey(artist, title, parsed.mix),
    artist, title, mix: parsed.mix,
    label: t.label_name || meta.p_line || '',
    genre: t.genre || '',
    released: String(t.release_date || t.display_date || t.created_at || '').slice(0, 10),
    len: Math.round((t.full_duration || t.duration || 0) / 1000) || null,
    bpm: bpm ? Number(bpm[1]) : null,
    bpmGuess: !!bpm,
    camelot: '',
    isrc: meta.isrc || '',
    art50: art(t.artwork_url || (t.user && t.user.avatar_url), 't67x67'),
    art500: art(t.artwork_url || (t.user && t.user.avatar_url), 't500x500'),
    sources: {
      sc: {
        id: String(t.id),
        url: t.permalink_url || '',
        uploader: t.user ? t.user.username : '',
        stream: tc ? tc.url : '',
        auth: t.track_authorization || '',
        wave: t.waveform_url || '',
        audio: tc ? 'sc:' + t.id : '',
        clip: !!(t.policy === 'SNIP' || (tc && tc.snipped)),
        free: !!(t.downloadable || (t.purchase_title && /free/i.test(t.purchase_title))),
        plays: t.playback_count || 0,
        likes: t.likes_count || 0,
      },
    },
  };
}

export async function search(q) {
  const j = await api('/search/tracks?q=' + encodeURIComponent(q) + '&limit=50');
  return withTempos((j.collection || []).map(toTrack).filter((t) => t && t.sources.sc.audio));
}

// A BPM Crate measured from the audio before fills the gap again.
async function withTempos(tracks) {
  await Promise.all(tracks.filter((t) => !t.bpm).map(async (t) => {
    const bpm = await cacheGet('tempo:sc:' + t.sources.sc.id);
    if (bpm) { t.bpm = bpm; t.bpmGuess = true; t.bpmFrom = 'audio'; }
  }));
  return tracks;
}

// Remixes, edits and bootlegs live under many spellings, so ask a few ways and
// keep each upload once.
export async function versions(lead, title) {
  const asks = [[lead, title].filter(Boolean).join(' '), title + ' remix', title + ' bootleg', title + ' edit'];
  const seen = new Set();
  const out = [];
  for (const q of asks) {
    const j = await api('/search/tracks?q=' + encodeURIComponent(q) + '&limit=50');
    for (const item of j.collection || []) {
      const t = toTrack(item);
      if (!t || !t.sources.sc.audio || seen.has(t.sources.sc.id)) continue;
      seen.add(t.sources.sc.id);
      out.push(t);
    }
  }
  return withTempos(out);
}

// ---- likes, read from a public profile --------------------------------------------

export async function likes(profile) {
  const name = (profile || '').trim().replace(/^https?:\/\/(www\.)?soundcloud\.com\//, '').replace(/\/.*$/, '');
  if (!name) throw new Error('add your SoundCloud profile name in Settings');
  const user = await api('/resolve?url=' + encodeURIComponent('https://soundcloud.com/' + name));
  if (!user || user.kind !== 'user') throw new Error('no SoundCloud profile called “' + name + '”');
  const out = [];
  let next = '/users/' + user.id + '/track_likes?limit=200&linked_partitioning=1';
  for (let page = 0; next && page < 10; page++) {
    const j = await api(next);
    for (const item of j.collection || []) { const t = toTrack(item.track); if (t && t.sources.sc.audio) out.push(t); }
    next = j.next_href ? new URL(j.next_href).pathname + new URL(j.next_href).search.replace(/([?&])client_id=[^&]*&?/, '$1') : '';
  }
  return out;
}

// ---- streams and waveforms ----------------------------------------------------------

// A placeholder (sc:<id>) or a signed playlist past its expiry needs a fresh link.
export function stale(src) {
  if (/^sc:/.test(src || '')) return true;
  if (!/\/_media\/playback\.media-streaming\.soundcloud\.cloud\//.test(src || '')) return false;
  const m = /[?&]expires=(\d{9,})/.exec(src);
  return !!m && Number(m[1]) * 1000 < Date.now() + 60000;
}

export async function freshAudio(track) {
  const sc = track.sources && track.sources.sc;
  if (!sc || !streamOk(sc.stream)) return '';
  try {
    const u = new URL(sc.stream);
    const j = await api(u.pathname + (sc.auth ? '?track_authorization=' + encodeURIComponent(sc.auth) : ''));
    const src = j && j.url ? mediaPath(j.url) : '';
    if (src) sc.audio = src;
    return src;
  } catch (e) {
    console.warn('[crate] soundcloud stream', e && e.message);
    return '';
  }
}

// SoundCloud's waveform JSON ({ width, height, samples }) resampled to `bins`.
export async function waveform(track, bins) {
  const sc = track.sources && track.sources.sc;
  if (!sc || !waveOk(sc.wave)) return null;
  try {
    const u = new URL(sc.wave);
    if (!/\.json$/.test(u.pathname)) u.pathname = u.pathname.replace(/\.png$/, '.json');
    const res = await window.api.fetch(u.host, u.pathname);
    if (!res.ok) return null;
    const j = JSON.parse(res.text);
    const s = j.samples || [];
    const max = j.height || Math.max(1, ...s);
    if (!s.length) return null;
    return Array.from({ length: bins }, (_, i) => {
      const from = Math.floor(i / bins * s.length), to = Math.max(from + 1, Math.floor((i + 1) / bins * s.length));
      let m = 0;
      for (let k = from; k < to; k++) m = Math.max(m, s[k]);
      return Math.min(1, m / max);
    });
  } catch { return null; }
}
