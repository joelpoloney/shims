// Small shared helpers: element builder, formatting, track identity, Camelot.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function fmtLen(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function fmtTotal(sec) {
  const m = Math.round((sec || 0) / 60);
  return m >= 60 ? Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm' : m + ' min';
}

export function fmtClock(sec) {
  const m = Math.floor((sec || 0) / 60);
  return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
}

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

export function parseLen(text) {
  const m = /^(\d+):(\d{2})$/.exec((text || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// "Artist A, Artist B - Title (Extended Mix)" → parts. The mix is the last
// parenthetical; a title with no mix reads as the original.
export function splitLabel(label) {
  const text = (label || '').trim();
  const dash = text.indexOf(' - ');
  const artist = dash > 0 ? text.slice(0, dash).trim() : '';
  let rest = dash > 0 ? text.slice(dash + 3).trim() : text;
  let mix = '';
  const m = /\(([^()]*)\)\s*$/.exec(rest);
  if (m) { mix = m[1].trim(); rest = rest.slice(0, m.index).trim(); }
  return { artist, title: rest, mix };
}

function fold(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function stripFeat(s) {
  return s.replace(/\s*[([]?\b(feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]?/g, ' ');
}

function words(s) {
  return fold(s).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// One identity per recording: artists as a sorted set, title without "feat.",
// mix with "original" folded to empty. Matching ignores punctuation and case.
export function trackKey(artist, title, mix) {
  const artists = stripFeat(fold(artist)).split(/\s*(?:,|&|\band\b|\bx\b|\bvs\.?)\s*/)
    .map(words).filter(Boolean).sort().join('+');
  let m = words(mix);
  if (m === 'original mix' || m === 'original') m = '';
  return artists + '|' + words(stripFeat(fold(title))) + '|' + m;
}

// ---- Camelot -----------------------------------------------------------------

const MUSICAL = {
  '1A': 'A♭m', '2A': 'E♭m', '3A': 'B♭m', '4A': 'Fm', '5A': 'Cm', '6A': 'Gm',
  '7A': 'Dm', '8A': 'Am', '9A': 'Em', '10A': 'Bm', '11A': 'F♯m', '12A': 'D♭m',
  '1B': 'B', '2B': 'F♯', '3B': 'D♭', '4B': 'A♭', '5B': 'E♭', '6B': 'B♭',
  '7B': 'F', '8B': 'C', '9B': 'G', '10B': 'D', '11B': 'A', '12B': 'E',
};
// Soundeo's keyFilter takes names like "Emin" / "Cmaj".
const FILTER_NAME = {
  '1A': 'G#min', '2A': 'D#min', '3A': 'A#min', '4A': 'Fmin', '5A': 'Cmin', '6A': 'Gmin',
  '7A': 'Dmin', '8A': 'Amin', '9A': 'Emin', '10A': 'Bmin', '11A': 'F#min', '12A': 'C#min',
  '1B': 'Bmaj', '2B': 'F#maj', '3B': 'C#maj', '4B': 'G#maj', '5B': 'D#maj', '6B': 'A#maj',
  '7B': 'Fmaj', '8B': 'Cmaj', '9B': 'Gmaj', '10B': 'Dmaj', '11B': 'Amaj', '12B': 'Emaj',
};

// "9A", "9a", or "3B (D&#9837;MAJ)" → "3B"; anything else → "".
export function cleanCamelot(k) {
  const m = /\b(1[0-2]|[1-9])\s*([AB])\b/i.exec(String(k || ''));
  return m ? m[1] + m[2].toUpperCase() : '';
}

export function parseCamelot(k) {
  const m = /^(1[0-2]|[1-9])([AB])$/i.exec((k || '').trim());
  return m ? { n: Number(m[1]), l: m[2].toUpperCase() } : null;
}
export const musicalKey = (k) => MUSICAL[(k || '').toUpperCase()] || '';
export const keyFilterName = (k) => FILTER_NAME[(k || '').toUpperCase()] || '';

const wheel = (n, d) => ((n - 1 + d + 120) % 12) + 1;

// The keys one step away on the wheel, plus the relative major/minor.
export function neighbours(k) {
  const c = parseCamelot(k);
  if (!c) return [];
  const other = c.l === 'A' ? 'B' : 'A';
  return [c.n + c.l, wheel(c.n, 1) + c.l, wheel(c.n, -1) + c.l, c.n + other];
}

export function keyCompat(a, b) {
  const x = parseCamelot(a), y = parseCamelot(b);
  if (!x || !y) return null;
  const d = ((y.n - x.n) % 12 + 12) % 12;
  if (x.l === y.l) {
    if (d === 0) return { level: 'ok', text: 'same key' };
    if (d === 1) return { level: 'ok', text: '+1' };
    if (d === 11) return { level: 'ok', text: '−1' };
    if (d === 2) return { level: 'mid', text: 'lift +2' };
    if (d === 10) return { level: 'mid', text: 'drop −2' };
    if (d === 7) return { level: 'mid', text: '+7' };
    return { level: 'bad', text: 'key clash' };
  }
  if (d === 0) return { level: 'ok', text: y.l === 'B' ? 'to major' : 'to minor' };
  return { level: 'bad', text: 'key clash' };
}

export function bpmCompat(a, b) {
  if (!a || !b) return null;
  const diff = b - a;
  const pct = Math.abs(diff) / a * 100;
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
  const delta = sign + Math.abs(Math.round(diff * 10) / 10);
  if (Math.abs(diff) <= 3) return { level: 'ok', text: a + ' → ' + b + ' ' + delta };
  if (Math.abs(diff) <= 6) return { level: 'mid', text: 'stretch ' + pct.toFixed(1) + '%' };
  return { level: 'bad', text: 'BPM jump ' + pct.toFixed(1) + '%' };
}

const RANK = { ok: 0, mid: 1, bad: 2 };
export function worst(...levels) {
  return levels.filter(Boolean).reduce((w, l) => (RANK[l] > RANK[w] ? l : w), 'ok');
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

// ---- versions of a track -------------------------------------------------------

export const titleWords = (s) => words(stripFeat(fold(s)).replace(/\[[^\]]*\]/g, ' '));
export const artistSet = (s) => new Set(stripFeat(fold(s)).split(/\s*(?:,|&|\band\b|\bx\b|\bvs\.?)\s*/).map(words).filter(Boolean));

const EDIT = /\b(edit|bootleg|boot|vip|flip|refix|rework|re ?work|mashup|blend|dub)\b/;
const REMIX = /\b(remix|rmx|remode|re ?mix|mix)\b/;
const CUT = /^(|original|original mix|extended|extended mix|radio|radio edit|radio mix|club mix|instrumental|clean|dirty)$/;

// Which group a search row falls in when looking for versions of a track, or
// '' when its title isn't this track's. Order: original, remix, edit, other.
export function versionKind(t, v) {
  const tw = titleWords(t.title);
  if (!(tw === v.title || (v.title.includes(' ') && (' ' + tw + ' ').includes(' ' + v.title + ' ')))) return '';
  const mix = words(t.mix || '');
  const extra = (' ' + tw + ' ').replace(' ' + v.title + ' ', ' ').trim();
  const tag = (mix + ' ' + extra).trim();
  const shares = [...artistSet(t.artist)].some((a) => v.artists.has(a));
  if (EDIT.test(tag) && !/^radio edit$/.test(mix)) return 'edit';
  if (REMIX.test(tag) && !CUT.test(mix)) return 'remix';
  if (CUT.test(mix) && !extra) return shares ? 'original' : 'other';
  return shares ? 'remix' : 'other';
}
// A mix name for matching across sites: "Extended Mix" and "Original Mix" are
// the plain track, "Odd Mob Extended Remix" is "odd mob remix".
export function mixKey(mix) {
  const m = words(mix).replace(/\b(extended|original|radio|club)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(mix|edit|version|cut)?$/.test(m) ? '' : m;
}
export const VERSION_GROUPS = [['original', 'ORIGINAL & CUTS'], ['remix', 'REMIXES'], ['edit', 'EDITS, BOOTLEGS & VIPS'], ['other', 'SAME TITLE, OTHER ARTISTS']];
