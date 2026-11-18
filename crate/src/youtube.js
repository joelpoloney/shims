// YouTube: search only, read from the site's own results page with your
// session. Nothing plays here: a row's YouTube source is a link that opens in
// a tab. The results page carries its data as one JSON object in a script.

import { splitLabel, trackKey } from './util.js';
import { mediaPath } from './soundeo.js';

const HOST = 'www.youtube.com';
export const ID = 'yt';
const VIDEOS_ONLY = 'EgIQAQ%3D%3D'; // the site's own "Type: Video" filter

function pageData(html) {
  const at = html.indexOf('ytInitialData = ');
  const end = at < 0 ? -1 : html.indexOf(';</script>', at);
  if (end < 0) return null;
  try { return JSON.parse(html.slice(at + 'ytInitialData = '.length, end)); } catch { return null; }
}

// Every video in the page data, in page order, wherever the layout put it.
function videos(data, max) {
  const out = [];
  const stack = [data];
  const seen = new Set();
  while (stack.length && out.length < max) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.videoRenderer && node.videoRenderer.videoId && !seen.has(node.videoRenderer.videoId)) {
      seen.add(node.videoRenderer.videoId);
      out.push(node.videoRenderer);
      continue;
    }
    const kids = Array.isArray(node) ? node : Object.values(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

const textOf = (x) => (x ? x.simpleText || (x.runs || []).map((r) => r.text).join('') : '');

// "4:05" or "1:02:33" → seconds
function seconds(text) {
  const parts = (text || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((s, n) => s * 60 + n, 0) || null;
}

// What uploaders add to a title that isn't part of the track's name.
const NOISE = /\s*[([](?:official\s+)?(?:music\s+|lyrics?\s+|audio\s+)?(?:video|audio|visuali[sz]er|lyrics?)(?:\s+(?:hd|hq|4k))?[)\]]|\s*[([](?:hd|hq|4k|free\s+(?:download|dl)|out\s+now|premiere)[)\]]/gi;

export function toTrack(v) {
  const channel = textOf(v.ownerText || v.longBylineText).replace(/\s+-\s+Topic$/, '');
  const parsed = splitLabel(textOf(v.title).replace(NOISE, '').replace(/\s+/g, ' ').trim());
  const artist = parsed.artist || channel;
  if (!parsed.title) return null;
  const views = Number((textOf(v.viewCountText).match(/[\d,.]+/) || [''])[0].replace(/[,.]/g, '')) || 0;
  return {
    k: trackKey(artist, parsed.title, parsed.mix),
    artist, title: parsed.title, mix: parsed.mix,
    label: '', genre: '', released: '',
    len: seconds(textOf(v.lengthText)),
    bpm: null, camelot: '', isrc: '',
    art50: mediaPath('https://i.ytimg.com/vi/' + v.videoId + '/default.jpg'),
    art500: mediaPath('https://i.ytimg.com/vi/' + v.videoId + '/hqdefault.jpg'),
    sources: {
      yt: { id: v.videoId, url: 'https://www.youtube.com/watch?v=' + v.videoId, uploader: channel, views, age: textOf(v.publishedTimeText) },
    },
  };
}

export async function search(q) {
  const res = await window.api.fetch(HOST, '/results?search_query=' + encodeURIComponent(q) + '&sp=' + VIDEOS_ONLY);
  if (!res.ok) throw new Error('YouTube answered ' + (res.error || res.status));
  const data = pageData(res.text || '');
  if (!data) throw new Error('YouTube\'s page changed, so Crate can\'t read its results');
  return videos(data, 40).map(toTrack).filter(Boolean);
}
