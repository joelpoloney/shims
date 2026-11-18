// Lists that live on a source, read-only in Crate: Soundeo favorites now;
// SoundCloud likes and Beatport playlists join the same list later.

import * as soundeo from './soundeo.js';
import * as soundcloud from './soundcloud.js';
import * as beatport from './beatport.js';
import { prefs } from './store.js';
import { S, render } from './state.js';

export const COLLECTIONS = [
  { id: 'so-favorites', source: 'so', name: 'Favorites', title: 'Soundeo favorites', url: 'https://soundeo.com/account/favorites', load: soundeo.favorites },
  { id: 'sc-likes', source: 'sc', name: 'Likes', title: 'SoundCloud likes', get url() { return 'https://soundcloud.com/' + (prefs.scProfile || '') + '/likes'; }, load: () => soundcloud.likes(prefs.scProfile), needs: () => !!prefs.scProfile },
];

export const getCollection = (id) => COLLECTIONS.find((c) => c.id === id) || null;

// Your Beatport playlists, each its own list under From your sources.
export async function loadBeatportPlaylists() {
  try {
    const pls = await beatport.playlists();
    S.bpAuth = { state: 'ok', error: '' };
    for (let i = COLLECTIONS.length - 1; i >= 0; i--) if (COLLECTIONS[i].dynamic === 'bp') COLLECTIONS.splice(i, 1);
    for (const p of pls) {
      COLLECTIONS.push({
        id: 'bp-pl-' + p.id, source: 'bp', dynamic: 'bp', name: p.name, title: 'Beatport · ' + p.name, count: p.count,
        url: 'https://www.beatport.com/library/playlists/' + p.id, load: () => beatport.playlistTracks(p.id),
      });
    }
  } catch (e) {
    S.bpAuth = { state: 'todo', error: (e && e.message) || 'Beatport didn\'t answer' };
    console.warn('[crate] beatport playlists', e && e.message);
  }
  render();
}

export function collectionState(id) {
  if (!S.collections[id]) S.collections[id] = { state: 'idle', tracks: [], error: '', loadedAt: 0 };
  return S.collections[id];
}

export async function loadCollection(id, force) {
  const c = getCollection(id);
  const st = collectionState(id);
  if (!c || st.state === 'loading' || (st.state === 'done' && !force)) return;
  st.state = 'loading';
  st.error = '';
  render();
  try {
    st.tracks = await c.load();
    st.state = 'done';
    st.loadedAt = Date.now();
  } catch (e) {
    st.state = 'error';
    st.error = (e && e.message) || String(e);
  }
  render();
}
