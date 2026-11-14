import { Database } from "bun:sqlite";

export const db = new Database("krungu.db", { create: true });
db.run("PRAGMA journal_mode = WAL");

db.run(`
CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY,          -- Deezer artist id
  name TEXT NOT NULL,
  fans INTEGER,
  source TEXT,                     -- which seed brought it in (chart_id, chart_global, related)
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,          -- Deezer track id
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  title TEXT NOT NULL,
  rank INTEGER,                    -- Deezer popularity
  duration INTEGER,
  isrc TEXT,                       -- filled lazily (needs one call per track)
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS artists_updated ON artists(updated_at);
`);

// Lightweight migrations for columns added after the first version.
const cols = (db.query("PRAGMA table_info(artists)").all() as { name: string }[]).map((c) => c.name);
for (const [col, ddl] of [
  ["local_seed", "INTEGER NOT NULL DEFAULT 0"], // 1 = came from data/id-artists.txt
  ["country", "TEXT"],                          // ISO code from MusicBrainz (e.g. ID)
  ["mbid", "TEXT"],
  ["country_checked", "INTEGER"],               // unix time of the last MusicBrainz lookup
  ["explored_at", "INTEGER"],                   // unix time related artists were last expanded (src/explore.ts)
  ["albums_checked", "INTEGER"],                // unix time of the last album/new-release scan (src/refresh.ts)
] as const) {
  if (!cols.includes(col)) db.run(`ALTER TABLE artists ADD COLUMN ${col} ${ddl}`);
}

db.run("PRAGMA busy_timeout = 5000"); // several scripts may write at once
db.run(`
CREATE TABLE IF NOT EXISTS artist_tags (
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  tag TEXT NOT NULL,
  weight INTEGER NOT NULL,         -- Last.fm relative count, 0-100
  PRIMARY KEY (artist_id, tag)
);
CREATE TABLE IF NOT EXISTS artist_moods (
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  mood TEXT NOT NULL,
  score REAL NOT NULL,             -- 0-1, normalized per artist
  PRIMARY KEY (artist_id, mood)
);
`);
if (!(db.query("PRAGMA table_info(artists)").all() as { name: string }[]).some((c) => c.name === "tags_checked")) {
  db.run("ALTER TABLE artists ADD COLUMN tags_checked INTEGER"); // unix time of last Last.fm fetch
}

if (!(db.query("PRAGMA table_info(tracks)").all() as { name: string }[]).some((c) => c.name === "playable")) {
  db.run("ALTER TABLE tracks ADD COLUMN playable INTEGER NOT NULL DEFAULT 1"); // 0 = hidden from radio (see src/clean.ts)
}

if (!(db.query("PRAGMA table_info(tracks)").all() as { name: string }[]).some((c) => c.name === "year")) {
  db.run("ALTER TABLE tracks ADD COLUMN year INTEGER"); // release year from Deezer; NULL = not fetched yet, 0 = unknown (see src/years.ts)
}

for (const col of ["bpm", "gain"]) {
  if (!(db.query("PRAGMA table_info(tracks)").all() as { name: string }[]).some((c) => c.name === col)) {
    db.run(`ALTER TABLE tracks ADD COLUMN ${col} REAL`); // Deezer song-level audio fields (src/audio-feats.ts); NULL = not fetched, 0 = Deezer has none
  }
}

// Per-user state and the raw behavior log. events is the long-term asset: it is what a collaborative
// recommender across users will be trained on (user_id is a random pseudonym, no personal data).
db.run(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,           -- Profile.toJSON()
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  track_id INTEGER NOT NULL,
  artist_id INTEGER NOT NULL,
  action TEXT NOT NULL,            -- 'spin' | 'complete'
  listened_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  mode TEXT,                       -- 'exploit' | 'explore' as served
  signal REAL NOT NULL,            -- relative signal the engine applied
  hour INTEGER,                    -- local hour 0-23, for time-of-day context
  dow INTEGER,                     -- day of week 0-6
  created_at INTEGER NOT NULL
);
-- One row per track the engine served: the exact probability it had of picking it (propensity, for off-policy evaluation:
-- IPS / doubly robust) and the ranking components at that moment (what src/fit.ts regresses on). Join to events by
-- (user_id, track_id) = the first event after served_at.
CREATE TABLE IF NOT EXISTS serves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  track_id INTEGER NOT NULL,
  mode TEXT,
  propensity REAL NOT NULL,
  policy TEXT NOT NULL,            -- 'legacy' | 'learned'
  comps TEXT NOT NULL,             -- JSON of the ranking components
  served_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS serves_user ON serves(user_id, served_at);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, created_at);
CREATE INDEX IF NOT EXISTS events_track ON events(track_id);
`);
