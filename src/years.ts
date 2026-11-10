// Backfill tracks.year (and isrc) from Deezer /track/:id. Resumable: only rows with year IS NULL are fetched.
// Caveat: release_date is the date of the album the track was seeded from, so a compilation/reissue can show a
// later year than the original release. Track-level era is therefore noisy; the onboarding prior uses the artist's
// median year instead (Track.artistYear in src/radio.ts).
// Usage: bun run years [max]
import { db } from "./db.ts";
import { track } from "./deezer.ts";

const max = Number(process.argv[2] ?? 100000);
const todo = db.query(
  "SELECT id FROM tracks WHERE year IS NULL ORDER BY playable DESC, rank DESC NULLS LAST LIMIT ?",
).all(max) as { id: number }[];
const upd = db.prepare("UPDATE tracks SET year = ?, isrc = COALESCE(isrc, ?) WHERE id = ?");

let done = 0;
for (const { id } of todo) {
  try {
    const r = await track(id);
    const y = Number(r.release_date?.slice(0, 4));
    upd.run(y >= 1900 && y <= new Date().getFullYear() ? y : 0, r.isrc ?? null, id);
  } catch (e) {
    const msg = (e as Error).message;
    if (/no data|not found/i.test(msg)) upd.run(0, null, id); // track gone from Deezer: mark unknown, don't retry forever
    else console.warn(`track ${id}: ${msg}`);
  }
  if (++done % 200 === 0) console.log(`${done}/${todo.length}`);
}
console.log(`filled ${done} tracks`);
const dist = db.query("SELECT (year/5)*5 AS bucket, COUNT(*) n FROM tracks WHERE year > 0 AND playable = 1 GROUP BY bucket ORDER BY bucket").all();
console.log("playable tracks by 5-year bucket:", dist);
