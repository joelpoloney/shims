-- Crate shared space. One Supabase project per friend group.
--
-- Trust model: no accounts. Everyone in the group uses the project's anon key
-- (kept encrypted in each person's Shim, never in page code), and identity is
-- a display name. So the database enforces shape, not people:
--   * nothing can be hard-deleted through the API (removals are soft),
--   * comments and the activity log are append-only,
--   * the activity log is written only by triggers, so every change and its
--     feed entry land together and clients poll one table.

-- ---------------------------------------------------------------- tables

create table public.playlists (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('playlist', 'set')),
  name        text not null check (length(name) between 1 and 200),
  owner       text not null check (length(owner) between 1 and 64),
  forked_from text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  deleted_at  timestamptz
);

create table public.playlist_tracks (
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  track_key   text not null check (length(track_key) between 1 and 512),
  track       jsonb not null,            -- artist, title, mix, bpm, key, sources…
  position    double precision not null, -- fractional, last write wins
  added_by    text not null,
  added_at    timestamptz not null default now(),
  moved_by    text,
  color       smallint not null default 0 check (color between 0 and 8),
  color_by    text,
  energy      real not null default 0 check (energy between 0 and 5),
  energy_by   text,
  note        text check (note is null or length(note) <= 2000), -- transition into the next track
  note_by     text,
  removed_at  timestamptz,
  removed_by  text,
  updated_at  timestamptz not null default now(),
  primary key (playlist_id, track_key)
);

create table public.comments (
  id          uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  track_key   text not null,
  author      text not null check (length(author) between 1 and 64),
  body        text not null check (length(body) between 1 and 4000),
  created_at  timestamptz not null default now()
);
create index comments_track_idx on public.comments (playlist_id, track_key, created_at);

create table public.activity (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       text not null,
  verb        text not null,
  playlist_id uuid references public.playlists (id) on delete cascade,
  track_key   text,
  detail      jsonb not null default '{}'::jsonb
);
create index activity_playlist_idx on public.activity (playlist_id);

-- ---------------------------------------------------------------- triggers

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger playlists_touch before update on public.playlists
  for each row execute function public.touch_updated_at();
create trigger playlist_tracks_touch before update on public.playlist_tracks
  for each row execute function public.touch_updated_at();

-- Activity is derived from the change itself. security definer so the anon
-- role never needs insert on activity.
create function public.log_playlist() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity (actor, verb, playlist_id, detail)
    values (new.owner, 'created', new.id, jsonb_build_object('name', new.name, 'kind', new.kind));
  elsif new.deleted_at is not null and old.deleted_at is null then
    insert into public.activity (actor, verb, playlist_id, detail)
    values (coalesce(new.updated_by, new.owner), 'deleted', new.id, jsonb_build_object('name', new.name));
  elsif new.name is distinct from old.name then
    insert into public.activity (actor, verb, playlist_id, detail)
    values (coalesce(new.updated_by, new.owner), 'renamed', new.id, jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  return new;
end $$;

create trigger playlists_log after insert or update on public.playlists
  for each row execute function public.log_playlist();

create function public.log_playlist_track() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  title text := new.track ->> 'title';
begin
  if tg_op = 'INSERT' or (old.removed_at is not null and new.removed_at is null) then
    insert into public.activity (actor, verb, playlist_id, track_key, detail)
    values (new.added_by, 'added', new.playlist_id, new.track_key, jsonb_build_object('title', title));
    return new;
  end if;
  if new.removed_at is not null and old.removed_at is null then
    insert into public.activity (actor, verb, playlist_id, track_key, detail)
    values (coalesce(new.removed_by, '?'), 'removed', new.playlist_id, new.track_key, jsonb_build_object('title', title));
    return new;
  end if;
  if new.position is distinct from old.position then
    insert into public.activity (actor, verb, playlist_id, track_key, detail)
    values (coalesce(new.moved_by, '?'), 'moved', new.playlist_id, new.track_key, jsonb_build_object('title', title));
  end if;
  if new.color is distinct from old.color then
    insert into public.activity (actor, verb, playlist_id, track_key, detail)
    values (coalesce(new.color_by, '?'), 'coloured', new.playlist_id, new.track_key, jsonb_build_object('title', title, 'color', new.color));
  end if;
  if new.energy is distinct from old.energy then
    insert into public.activity (actor, verb, playlist_id, track_key, detail)
    values (coalesce(new.energy_by, '?'), 'energy', new.playlist_id, new.track_key, jsonb_build_object('title', title, 'energy', new.energy));
  end if;
  if new.note is distinct from old.note then
    insert into public.activity (actor, verb, playlist_id, track_key, detail)
    values (coalesce(new.note_by, '?'), 'noted', new.playlist_id, new.track_key, jsonb_build_object('title', title, 'note', left(coalesce(new.note, ''), 200)));
  end if;
  return new;
end $$;

create trigger playlist_tracks_log after insert or update on public.playlist_tracks
  for each row execute function public.log_playlist_track();

create function public.log_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.activity (actor, verb, playlist_id, track_key, detail)
  values (new.author, 'commented', new.playlist_id, new.track_key, jsonb_build_object('comment_id', new.id, 'body', left(new.body, 200)));
  return new;
end $$;

create trigger comments_log after insert on public.comments
  for each row execute function public.log_comment();

-- The trigger functions are only for triggers.
revoke execute on function public.touch_updated_at(), public.log_playlist(), public.log_playlist_track(), public.log_comment() from public, anon, authenticated;

-- ---------------------------------------------------------------- access

alter table public.playlists       enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.comments        enable row level security;
alter table public.activity        enable row level security;

-- Supabase grants everything on new public tables to anon; narrow it.
revoke all on public.playlists, public.playlist_tracks, public.comments, public.activity from anon, authenticated;

grant select, insert, update on public.playlists       to anon;
grant select, insert, update on public.playlist_tracks to anon;
grant select, insert         on public.comments        to anon;
grant select                 on public.activity        to anon;

-- The group shares one key, so the policies admit the anon role as a whole;
-- the grants above are what keep deletes and log edits out.
create policy playlists_read   on public.playlists for select to anon using (true);
create policy playlists_write  on public.playlists for insert to anon with check (true);
create policy playlists_edit   on public.playlists for update to anon using (true) with check (true);

create policy tracks_read      on public.playlist_tracks for select to anon using (true);
create policy tracks_write     on public.playlist_tracks for insert to anon with check (true);
create policy tracks_edit      on public.playlist_tracks for update to anon using (true) with check (true);

create policy comments_read    on public.comments for select to anon using (true);
create policy comments_write   on public.comments for insert to anon with check (true);

create policy activity_read    on public.activity for select to anon using (true);

-- ---------------------------------------------------------------- track notes
-- Notes on a track, one per person per source track. The note follows the
-- source track ("so:123", "bp:456", "sc:789") everywhere it shows up, in Crate
-- and in the Track Notes shim on the site itself. Clearing a note empties its
-- body; rows are never deleted through the API.
create table public.track_notes (
  track_ref  text not null check (track_ref ~ '^[a-z]{2,8}:[A-Za-z0-9._~-]{1,128}$'),
  author_id  text not null check (author_id ~ '^[A-Za-z0-9-]{8,64}$'),
  author     text not null check (length(author) between 1 and 64),
  title      text not null default '' check (length(title) <= 400),
  body       text not null default '' check (length(body) <= 4000),
  tags       jsonb not null default '[]'::jsonb check (jsonb_typeof(tags) = 'array' and pg_column_size(tags) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (track_ref, author_id)
);
create index track_notes_updated_idx on public.track_notes (updated_at);

create trigger track_notes_touch before update on public.track_notes
  for each row execute function public.touch_updated_at();

-- The feed gets one entry when a note is first written, and again only when it
-- changes after sitting for a while, so typing doesn't flood it. A note
-- inserted with an old created_at is a backfill and stays out of the feed.
create function public.log_track_note() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.body = '' then return new; end if;
  if (tg_op = 'INSERT' and new.created_at > now() - interval '5 minutes')
     or (tg_op = 'UPDATE' and new.body is distinct from old.body
         and (old.body = '' or old.updated_at < now() - interval '10 minutes')) then
    insert into public.activity (actor, verb, track_key, detail)
    values (new.author, 'track-noted', new.track_ref,
            jsonb_build_object('title', new.title, 'note', left(new.body, 200), 'author_id', new.author_id));
  end if;
  return new;
end $$;

create trigger track_notes_log after insert or update on public.track_notes
  for each row execute function public.log_track_note();
revoke execute on function public.log_track_note() from public, anon, authenticated;

alter table public.track_notes enable row level security;
revoke all on public.track_notes from anon, authenticated;
grant select, insert, update on public.track_notes to anon;

create policy track_notes_read  on public.track_notes for select to anon using (true);
create policy track_notes_write on public.track_notes for insert to anon with check (true);
create policy track_notes_edit  on public.track_notes for update to anon using (true) with check (true);
