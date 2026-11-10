// Seed curated Indonesian artists from data/id-artists.txt: Deezer search -> artist + top tracks.
import { db } from "./db.ts";
import * as dz from "./deezer.ts";

const names = [...new Set(
  (await Bun.file("data/id-artists.txt").text())
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
)];
const now = () => Math.floor(Date.now() / 1000);
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

const upsertArtist = db.prepare(
  `INSERT INTO artists (id, name, fans, source, local_seed, updated_at) VALUES (?1, ?2, ?3, 'seed_id', 1, ?4)
   ON CONFLICT(id) DO UPDATE SET fans = ?3, local_seed = 1, updated_at = ?4`,
);
const upsertTrack = db.prepare(
  `INSERT INTO tracks (id, artist_id, title, rank, duration, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
   ON CONFLICT(id) DO UPDATE SET title = ?3, rank = ?4, duration = ?5, updated_at = ?6`,
);

let ok = 0;
const missing: string[] = [];
for (const name of names) {
  try {
    const hits = await dz.searchArtist(name);
    // exact (normalized) name match only, most fans wins; avoids wrong namesakes
    const best = hits.filter((h) => norm(h.name) === norm(name)).sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0];
    if (!best) { missing.push(name); continue; }
    upsertArtist.run(best.id, best.name, best.nb_fan ?? null, now());
    const tracks = await dz.artistTop(best.id, 30);
    db.transaction(() => {
      for (const t of tracks) {
        // featured artists may not be in the table yet
        db.run(`INSERT OR IGNORE INTO artists (id, name, source, updated_at) VALUES (?, ?, 'chart', ?)`, [t.artist.id, t.artist.name, now()]);
        upsertTrack.run(t.id, t.artist.id, t.title, t.rank ?? null, t.duration ?? null, now());
      }
    })();
    ok++;
  } catch (e) {
    console.warn(`error ${name}:`, (e as Error).message);
    missing.push(name);
  }
}
console.log(`seeded ${ok}/${names.length} artists`);
if (missing.length) console.log("not matched:", missing.join(", "));
