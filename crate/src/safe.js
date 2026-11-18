// A saved track is data from somewhere else: a playlist in the shared space
// was written by whoever holds the group's key. Crate follows a track's links
// with your signed-in sessions (a preview, a fresh stream link, a waveform),
// so every link is checked against where that source's links can point, and
// anything else is dropped before the track is used.

const MEDIA_HOSTS = ['preview.sndstatic.com', 'covers.sndstatic.com', 'geo-samples.beatport.com', 'geo-media.beatport.com', 'i1.sndcdn.com', 'i.ytimg.com', 'playback.media-streaming.soundcloud.cloud'];

// A /_media/ path on a host that only serves media, never a site's own pages.
// The browser tidies a path before loading it ("a/../b" becomes "b"), so the
// check runs on the tidied path and refuses any path that tidying changes.
export function mediaOk(path) {
  if (typeof path !== 'string' || /[\\\s]/.test(path)) return false;
  let u;
  try { u = new URL(path, 'https://crate.invalid'); } catch { return false; }
  if (u.origin !== 'https://crate.invalid' || u.pathname + u.search + u.hash !== path) return false;
  const m = /^\/_media\/([^/]+)\//.exec(u.pathname);
  return !!m && MEDIA_HOSTS.includes(m[1]);
}

const https = (u, host, path) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && host.test(x.hostname) && path.test(x.pathname) && !x.username && !x.password;
  } catch { return false; }
};

const LINKS = {
  so: (u) => https(u, /^soundeo\.com$/, /^\/track\/[\w.~%-]+$/),
  bp: (u) => https(u, /^www\.beatport\.com$/, /^\/track\//),
  sc: (u) => https(u, /^(www\.|m\.|on\.)?soundcloud\.com$/, /^\//),
  yt: (u) => https(u, /^www\.youtube\.com$/, /^\/watch$/),
};
// The page a source's "Open" link may go to, or '' when it isn't that source's.
export const openUrl = (id, url) => (LINKS[id] && typeof url === 'string' && LINKS[id](url) ? url : '');

export const streamOk = (u) => typeof u === 'string' && https(u, /^api-v2\.soundcloud\.com$/, /^\/media\/[\w:./-]+$/);
export const waveOk = (u) => typeof u === 'string' && https(u, /^wave\.sndcdn\.com$/, /^\/[\w.-]+$/);
const idOk = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

function cleanSource(id, s) {
  if (!s || typeof s !== 'object' || !LINKS[id] || !idOk(s.id)) return null;
  const out = { ...s, url: openUrl(id, s.url) };
  if (id === 'sc') {
    out.audio = /^sc:\d+$/.test(s.audio || '') || mediaOk(s.audio) ? s.audio : '';
    out.stream = streamOk(s.stream) ? s.stream : '';
    out.wave = waveOk(s.wave) ? s.wave : '';
  } else {
    out.audio = mediaOk(s.audio) ? s.audio : '';
    if ('sample' in s) out.sample = https(s.sample, /^geo-samples\.beatport\.com$/, /^\//) ? s.sample : '';
  }
  return out;
}

export function cleanTrack(t) {
  if (!t || typeof t !== 'object') return { sources: {} };
  const sources = {};
  for (const [id, s] of Object.entries(t.sources && typeof t.sources === 'object' ? t.sources : {})) {
    const c = cleanSource(id, s);
    if (c) sources[id] = c;
  }
  return { ...t, art50: mediaOk(t.art50) ? t.art50 : '', art500: mediaOk(t.art500) ? t.art500 : '', sources };
}
