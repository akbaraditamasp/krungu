// Song-level audio fields from Deezer /track/:id (free, already one call per track): bpm (tempo) and gain (loudness, dB).
// Resumable: only rows with bpm IS NULL. 0 = Deezer has no value. Order: tracks that real users were served first.
// Usage: bun run audio [events|all]   (default events: only tracks that appear in the events table)
import { db } from "./db.ts";
import { track } from "./deezer.ts";

const scope = process.argv[2] ?? "events";
const todo = db.query(
  scope === "all"
    ? "SELECT id FROM tracks WHERE bpm IS NULL ORDER BY (id IN (SELECT track_id FROM events)) DESC, playable DESC, rank DESC NULLS LAST"
    : "SELECT id FROM tracks WHERE bpm IS NULL AND id IN (SELECT track_id FROM events)",
).all() as { id: number }[];
const upd = db.prepare("UPDATE tracks SET bpm = ?, gain = ? WHERE id = ?");
let n = 0;
for (const { id } of todo) {
  try {
    const r = await track(id);
    upd.run(r.bpm && r.bpm > 0 ? r.bpm : 0, typeof r.gain === "number" ? r.gain : null, id);
  } catch (e) {
    const msg = (e as Error).message;
    if (/no data|not found/i.test(msg)) upd.run(0, null, id); else console.warn(`track ${id}: ${msg}`);
  }
  if (++n % 200 === 0) console.log(`${n}/${todo.length}`);
}
console.log(`filled ${n} tracks`, db.query("SELECT COUNT(*) have, SUM(bpm > 0) bpm_ok FROM tracks WHERE bpm IS NOT NULL").get());
