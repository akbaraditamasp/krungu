// Grow the catalog around local artists: Deezer "related artists" of every local seed, top tracks for each new one.
// Usage: bun run seed:related [maxNew=250]
import { db } from "./db.ts";
import * as dz from "./deezer.ts";

const maxNew = Number(process.argv[2] ?? 250);
const now = () => Math.floor(Date.now() / 1000);

const seeds = db.query(
  "SELECT id FROM artists WHERE local_seed = 1 OR country = 'ID' ORDER BY fans DESC NULLS LAST",
).all() as { id: number }[];
const known = new Set((db.query("SELECT id FROM artists").all() as { id: number }[]).map((r) => r.id));

const insArtist = db.prepare("INSERT OR IGNORE INTO artists (id, name, fans, source, updated_at) VALUES (?, ?, ?, 'related_id', ?)");
const upTrack = db.prepare(
  `INSERT INTO tracks (id, artist_id, title, rank, duration, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
   ON CONFLICT(id) DO UPDATE SET title = ?3, rank = ?4, duration = ?5, updated_at = ?6`,
);

let added = 0;
for (const s of seeds) {
  if (added >= maxNew) break;
  try {
    for (const r of await dz.relatedArtists(s.id, 10)) {
      if (known.has(r.id) || added >= maxNew) continue;
      known.add(r.id);
      // artistTop returns the artist's own top tracks, so fans come from the related listing
      const tracks = await dz.artistTop(r.id, 30);
      if (!tracks.length) continue;
      db.transaction(() => {
        insArtist.run(r.id, r.name, r.nb_fan ?? null, now());
        for (const t of tracks) {
          insArtist.run(t.artist.id, t.artist.name, null, now()); // features: INSERT OR IGNORE keeps existing rows
          upTrack.run(t.id, t.artist.id, t.title, t.rank ?? null, t.duration ?? null, now());
        }
      })();
      added++;
    }
  } catch (e) {
    console.warn(`skip seed ${s.id}:`, (e as Error).message);
  }
  if (added && added % 25 === 0) console.log(`${added} new artists`);
}
console.log(`added ${added} related artists`);
