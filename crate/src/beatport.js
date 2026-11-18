// Beatport: search, previews and your playlists, through api.beatport.com with
// the token Beatport's own site uses (minted by Shim from the user's signed-in
// session at www.beatport.com/api/auth/session; never seen by this page).
// Beatport carries the richest metadata: BPM, key, ISRC, genre, label.

import { trackKey, cleanCamelot } from './util.js';
import { mediaPath } from './soundeo.js';

const HOST = 'api.beatport.com';
export const ID = 'bp';

async function get(path) {
  const res = await window.api.fetch(HOST, path, { headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new Error('not signed in to Beatport in Shim');
  if (!res.ok) throw new Error('Beatport answered ' + (res.error || res.status));
  try { return JSON.parse(res.text); } catch { throw new Error('Beatport sent something Crate can\'t read'); }
}

const names = (list, key) => (Array.isArray(list) ? list : []).map((a) => (a && (a[key] || a.name)) || '').filter(Boolean).join(', ');

// "A Minor" / "A♭ Major" → Camelot.
const NAME_TO_CAMELOT = {
  'g# minor': '1A', 'ab minor': '1A', 'd# minor': '2A', 'eb minor': '2A', 'a# minor': '3A', 'bb minor': '3A', 'f minor': '4A',
  'c minor': '5A', 'g minor': '6A', 'd minor': '7A', 'a minor': '8A', 'e minor': '9A', 'b minor': '10A', 'f# minor': '11A',
  'gb minor': '11A', 'c# minor': '12A', 'db minor': '12A',
  'b major': '1B', 'f# major': '2B', 'gb major': '2B', 'c# major': '3B', 'db major': '3B', 'g# major': '4B', 'ab major': '4B',
  'd# major': '5B', 'eb major': '5B', 'a# major': '6B', 'bb major': '6B', 'f major': '7B', 'c major': '8B', 'g major': '9B',
  'd major': '10B', 'a major': '11B', 'e major': '12B',
};

function camelotOf(t) {
  const k = t.key;
  if (k && typeof k === 'object') {
    if (k.camelot_number && k.camelot_letter) return cleanCamelot(k.camelot_number + k.camelot_letter);
    if (k.name) return NAME_TO_CAMELOT[k.name.toLowerCase().replace('♯', '#').replace('♭', 'b')] || '';
  }
  const name = typeof k === 'string' ? k : t.key_name || '';
  return cleanCamelot(name) || NAME_TO_CAMELOT[name.toLowerCase().replace('♯', '#').replace('♭', 'b').replace(/\s+/g, ' ').trim()] || '';
}

function image(t) {
  const r = t.release || {};
  const img = r.image || t.image || {};
  const uri = img.uri || r.release_image_uri || t.release_image_uri || '';
  const dyn = img.dynamic_uri || r.release_image_dynamic_uri || '';
  const at = (size) => (dyn ? dyn.replace('{w}x{h}', size + 'x' + size) : uri);
  return { art50: at(95) ? mediaPath(at(95)) : '', art500: at(500) ? mediaPath(at(500)) : '' };
}

// Both shapes Beatport serves: the v4 catalog track and the search/v1 track.
export function toTrack(t) {
  if (!t) return null;
  const id = String(t.id || t.track_id || '');
  const title = t.name || t.track_name || '';
  if (!id || !title) return null;
  const artist = names(t.artists, 'artist_name');
  const mix = t.mix_name || '';
  const bpm = Number(t.bpm);
  const genre = (t.genre && (t.genre.name || t.genre.genre_name)) || names(t.genre, 'genre_name') || '';
  const label = (t.release && t.release.label && t.release.label.name) || (t.label && (t.label.name || t.label.label_name)) || '';
  const len = t.length_ms ? Math.round(t.length_ms / 1000) : (typeof t.length === 'number' ? Math.round(t.length / 1000) : null);
  const slug = t.slug || title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track';
  // Search hits carry no sample_url, but their guid names the same preview file.
  const sample = t.sample_url || (t.guid ? 'https://geo-samples.beatport.com/track/' + t.guid + '.LOFI.mp3' : '');
  return {
    k: trackKey(artist, title, mix),
    artist, title, mix,
    label, genre,
    released: String(t.publish_date || t.new_release_date || t.release_date || '').slice(0, 10),
    len,
    bpm: Number.isFinite(bpm) && bpm >= 40 && bpm <= 250 ? Math.round(bpm) : null,
    camelot: camelotOf(t),
    isrc: t.isrc || '',
    ...image(t),
    sources: {
      bp: {
        id,
        url: 'https://www.beatport.com/track/' + slug + '/' + id,
        audio: sample ? mediaPath(sample) : '',
        sample,
        clip: true,
        price: t.price && (t.price.display || (t.price.value != null ? t.price.value + ' ' + (t.price.code || '') : '')),
      },
    },
  };
}

export async function search(q) {
  const j = await get('/search/v1/tracks/?q=' + encodeURIComponent(q) + '&count=50');
  const data = (j && j.data) || [];
  return (Array.isArray(data) ? data : []).map(toTrack).filter(Boolean);
}

// ---- your playlists -------------------------------------------------------------------

export async function playlists() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await get('/v4/my/playlists/?page=' + page + '&per_page=100');
    out.push(...(j.results || []).map((p) => ({ id: String(p.id), name: p.name, count: p.track_count || 0 })));
    if (!j.next) break;
  }
  return out;
}

export async function playlistTracks(id) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const j = await get('/v4/my/playlists/' + encodeURIComponent(id) + '/tracks/?page=' + page + '&per_page=100');
    for (const item of j.results || []) { const t = toTrack(item.track || item); if (t) out.push(t); }
    if (!j.next) break;
  }
  return out;
}
