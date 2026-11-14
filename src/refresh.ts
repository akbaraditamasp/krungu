// Keep the catalog current and complete. Two jobs, both incremental and resumable:
//  A) discovery: Deezer playlists matching data/id-playlists.txt + the Indonesia chart -> new Indonesian artists
//     (artists.source = 'pl_id', local_seed = 1; `bun run tags` drops those whose tags show a foreign nationality).
//  B) albums: per local artist, scan /artist/:id/albums and import tracks of albums not yet seen
//     (new releases, and with --full the whole discography). tracks.year is set from the album release_date.
// Usage: bun run refresh [--full] [--skip-discovery] [maxArtists=400]
//   default: only albums released since the artist's last scan (minus 14 days); --full: every album (first run, dangdut coverage).
// Run weekly (e.g. Windows Task Scheduler: `bun run refresh && bun run country && bun run tags && bun run clean && bun run moods`).
// Afterwards run `bun run tags`, `bun run clean`, `bun run moods`; `bun run years` is only needed for old rows without a year.
import { db } from "./db.ts";
import * as dz from "./deezer.ts";

const args = process.argv.slice(2);
const full = args.includes("--full");
const skipDiscovery = args.includes("--skip-discovery");
const maxArtists = Number(args.find((a) => /^\d+$/.test(a)) ?? 400);
const now = () => Math.floor(Date.now() / 1000);
const SLACK = 14 * 86400;

const insLocal = db.prepare(
  `INSERT INTO artists (id, name, fans, source, local_seed, updated_at) VALUES (?1, ?2, NULL, 'pl_id', 1, ?3)
   ON CONFLICT(id) DO NOTHING`,
);
const insAny = db.prepare("INSERT OR IGNORE INTO artists (id, name, source, updated_at) VALUES (?, ?, 'chart', ?)");
const upTrack = db.prepare(
  `INSERT INTO tracks (id, artist_id, title, rank, duration, year, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
   ON CONFLICT(id) DO UPDATE SET title = ?3, rank = ?4, duration = ?5, updated_at = ?7,
     year = CASE WHEN tracks.year IS NULL OR tracks.year = 0 THEN ?6 ELSE tracks.year END`,
);

// A) discovery of new Indonesian artists
if (!skipDiscovery) {
  const file = Bun.file("data/id-playlists.txt");
  const queries = (await file.exists() ? (await file.text()).split("\n") : []).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const lists = new Set<number>([dz.IDN_CHART_PLAYLIST]);
  for (const q of queries) {
    try { for (const p of (await dz.searchPlaylists(q, 3)).filter((p) => p.nb_tracks >= 15)) lists.add(p.id); }
    catch (e) { console.warn(`playlist search "${q}":`, (e as Error).message); }
  }
  let newArtists = 0;
  for (const id of lists) {
    try {
      const tracks = await dz.playlistTracks(id);
      db.transaction(() => {
        for (const t of tracks) {
          // the Indonesia chart is mostly international: only count its artists as candidates for tags, not as local
          const exists = db.query("SELECT 1 FROM artists WHERE id = ?").get(t.artist.id);
          if (!exists) {
            if (id === dz.IDN_CHART_PLAYLIST) insAny.run(t.artist.id, t.artist.name, now());
            else { insLocal.run(t.artist.id, t.artist.name, now()); newArtists++; }
          }
          upTrack.run(t.id, t.artist.id, t.title, t.rank ?? null, t.duration ?? null, null, now());
        }
      })();
    } catch (e) { console.warn(`playlist ${id}:`, (e as Error).message); }
  }
  console.log(`discovery: ${lists.size} playlists, ${newArtists} new local-candidate artists`);
}

// B) album scan, least recently scanned first
const artists = db.query(
  `SELECT id, name, albums_checked ck FROM artists WHERE local_seed = 1 OR country = 'ID'
   ORDER BY albums_checked IS NOT NULL, albums_checked ASC LIMIT ?`,
).all(maxArtists) as { id: number; name: string; ck: number | null }[];
const done = db.prepare("UPDATE artists SET albums_checked = ? WHERE id = ?");
let albumsRead = 0, tracksAdded = 0;
for (const a of artists) {
  try {
    const since = full || !a.ck ? "" : new Date((a.ck - SLACK) * 1000).toISOString().slice(0, 10);
    const albums = (await dz.artistAlbums(a.id, 200)).filter((al) => !since || (al.release_date ?? "") >= since);
    for (const al of albums) {
      const year = Number(al.release_date?.slice(0, 4)) || null;
      const tracks = await dz.albumTracks(al.id);
      albumsRead++;
      db.transaction(() => {
        for (const t of tracks) {
          // keep only the scanned artist's own tracks (skip features where the artist is a guest on others' albums is fine: artist = t.artist)
          insAny.run(t.artist.id, t.artist.name, now());
          const isNew = !db.query("SELECT 1 FROM tracks WHERE id = ?").get(t.id);
          upTrack.run(t.id, t.artist.id, t.title, t.rank ?? null, t.duration ?? null, year, now());
          if (isNew) tracksAdded++;
        }
      })();
    }
    done.run(now(), a.id);
  } catch (e) { console.warn(`albums ${a.name}:`, (e as Error).message); }
}
const fresh = db.query("SELECT COUNT(*) n FROM tracks WHERE year >= ?").get(new Date().getFullYear() - 1) as { n: number };
console.log(`albums: ${artists.length} artists scanned, ${albumsRead} albums read, ${tracksAdded} new tracks (tracks from last 2 years in db: ${fresh.n})`);
console.log("Next: bun run country && bun run tags && bun run clean && bun run moods");
