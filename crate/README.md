# Crate

Crate is a music-sourcing page for DJs that runs inside [Shim](https://shimbrowser.com). It searches several music sites at once, merges the same track from different sites into one row, and lets a group of friends keep playlists, notes and comments together.

It is a Shim *composition*: a page Shim serves on your own machine that reads each site with the session you are already signed in to. Nothing runs on a server of mine.

## What it does

- **One search, four sites.** Soundeo, Beatport, SoundCloud and YouTube are searched together. A track found on several of them becomes one row.
- **DJ plays and freshness.** Each track shows how many DJ tracklists on 1001tracklists include it, and a label (fresh, hot, peaking, rinsed, classic, sleeper) worked out from its age and that count.
- **Remixes on SoundCloud.** One button finds the remixes, edits and bootlegs of a track.
- **Suggestions that fit.** A playlist can suggest more tracks from its artists and labels, kept to its BPM range and genres.
- **BPM from the audio.** A track with no listed BPM gets one measured from its preview, shown with a question mark.
- **Playlists and sets.** Colours, energy stars, comments, and a set view that flags key clashes and BPM jumps between neighbouring tracks.
- **Shared with friends.** Playlists, notes and comments sync through a Supabase project your group owns.

## Install

1. Install [Shim](https://shimbrowser.com).
2. Download [`crate.shim`](crate.shim) from this folder.
3. In Shim, open the Library, choose **Import**, and pick the file.
4. Open Crate. Shim asks which sites it may read; allow the ones you use.

Crate uses the accounts you are signed in to in Shim:

| Site | What you need |
| --- | --- |
| Soundeo | An account, signed in at soundeo.com in a Shim tab |
| Beatport | An account, signed in at beatport.com in a Shim tab |
| SoundCloud | Nothing. Add your profile name in Crate's Settings to see your likes |
| YouTube | Nothing. Results link out; they don't play inside Crate |
| 1001tracklists | Nothing |

A site you don't use simply shows no results.

## Share playlists with friends

Without this step Crate still works, and your playlists stay on your machine.

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the project's SQL editor, paste the contents of [`supabase.sql`](supabase.sql), and run it.
3. Copy the project URL and its publishable key from the project's API settings.
4. In Shim's sidebar, open Crate's settings, find the connection named `shared`, and paste the URL and key. Reload Crate.
5. Send your friends `crate.shim` plus the same URL and key. They do step 4 on their side.

There are no accounts inside Crate. Everyone holding the key can read and change everything under whatever display name they choose, so share the key only with people you trust. Nothing can be hard-deleted through the key.

## Change it

The files Crate is made of are in [`src/`](src). They are plain JavaScript modules, CSS and one manifest, with no build step.

- To change your own copy, open Crate in Shim and describe what you want in the sidebar.
- To add a music site, look at `src/youtube.js` for the smallest example of a source: one function that searches the site and returns tracks in Crate's shape. Declare the site's host in `src/manifest.json`.

## License

MIT. See [`LICENSE`](../LICENSE).
