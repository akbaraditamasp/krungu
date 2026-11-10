// Fill artists.country (ISO code) + mbid from MusicBrainz. 1 req/s, so run it in the background.
import { db } from "./db.ts";
import { searchArtist } from "./musicbrainz.ts";

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const limit = Number(process.argv[2] ?? 100000);
// local seeds first, then by popularity; never re-check a row that already has a result
const rows = db.query(
  `SELECT id, name, local_seed FROM artists WHERE country_checked IS NULL
   ORDER BY local_seed DESC, fans DESC NULLS LAST LIMIT ?`,
).all(limit) as { id: number; name: string; local_seed: number }[];

const set = db.prepare("UPDATE artists SET country = ?, mbid = ?, country_checked = ? WHERE id = ?");
let n = 0;
for (const r of rows) {
  try {
    const hits = await searchArtist(r.name);
    const exact = hits.filter((h) => h.score >= 90 && norm(h.name) === norm(r.name));
    // Local seeds: only accept a namesake that MusicBrainz places in Indonesia. The top hit is often a
    // foreign artist with the same name (Tulus -> NO, Padi -> KR), which would poison tags downstream.
    const m = r.local_seed ? exact.find((h) => h.country === "ID") : exact[0];
    set.run(m?.country ?? null, m?.id ?? null, Math.floor(Date.now() / 1000), r.id);
  } catch (e) {
    console.warn(`skip ${r.name}:`, (e as Error).message);
  }
  if (++n % 50 === 0) console.log(`${n}/${rows.length}`);
}
const stats = db.query("SELECT country, COUNT(*) n FROM artists GROUP BY country ORDER BY n DESC LIMIT 8").all();
console.log(stats);
