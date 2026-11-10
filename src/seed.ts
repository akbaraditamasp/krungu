import { db } from "./db.ts";
import * as dz from "./deezer.ts";

const MAX_ARTISTS = Number(process.argv[2] ?? 200);
const now = () => Math.floor(Date.now() / 1000);

const upsertArtist = db.prepare(
  `INSERT INTO artists (id, name, fans, source, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
   ON CONFLICT(id) DO UPDATE SET name = ?2, fans = COALESCE(?3, fans), updated_at = ?5`,
);
const upsertTrack = db.prepare(
  `INSERT INTO tracks (id, artist_id, title, rank, duration, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
   ON CONFLICT(id) DO UPDATE SET title = ?3, rank = ?4, duration = ?5, updated_at = ?6`,
);

function saveTracks(tracks: dz.DzTrack[], source: string) {
  db.transaction(() => {
    for (const t of tracks) {
      upsertArtist.run(t.artist.id, t.artist.name, null, source, now());
      upsertTrack.run(t.id, t.artist.id, t.title, t.rank ?? null, t.duration ?? null, now());
    }
  })();
}

// 1. Seed artists from charts (Indonesia first, then global)
saveTracks(await dz.playlistTracks(dz.IDN_CHART_PLAYLIST), "chart_id");
saveTracks(await dz.globalChart(), "chart_global");

// 2. Expand breadth-first: top tracks per artist + related artists, capped at MAX_ARTISTS
const queue = (db.query("SELECT id FROM artists ORDER BY source = 'chart_id' DESC").all() as { id: number }[]).map((r) => r.id);
const seen = new Set(queue);
let done = 0;

while (queue.length && done < MAX_ARTISTS) {
  const id = queue.shift()!;
  try {
    saveTracks(await dz.artistTop(id), "chart");
    if (seen.size < MAX_ARTISTS) {
      for (const r of await dz.relatedArtists(id)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        upsertArtist.run(r.id, r.name, r.nb_fan ?? null, "related", now());
        queue.push(r.id);
      }
    }
  } catch (e) {
    console.warn(`skip artist ${id}:`, (e as Error).message);
  }
  if (++done % 25 === 0) console.log(`${done} artists processed`);
}

const a = db.query("SELECT COUNT(*) n FROM artists").get() as { n: number };
const t = db.query("SELECT COUNT(*) n FROM tracks").get() as { n: number };
console.log(`done: ${a.n} artists, ${t.n} tracks`);
