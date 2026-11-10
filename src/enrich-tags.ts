// Fetch Last.fm top tags per artist (local seeds first). Resumable: skips artists fetched within MAX_AGE_DAYS.
import { db } from "./db.ts";
import { artistTopTags } from "./lastfm.ts";

const limit = Number(process.argv[2] ?? 100000);
const MAX_AGE_DAYS = 90;
const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 86400;

const rows = db.query(
  `SELECT id, name, mbid, local_seed FROM artists WHERE tags_checked IS NULL OR tags_checked < ?
   ORDER BY local_seed DESC, fans DESC NULLS LAST LIMIT ?`,
).all(cutoff, limit) as { id: number; name: string; mbid: string | null; local_seed: number }[];

const del = db.prepare("DELETE FROM artist_tags WHERE artist_id = ?");
const ins = db.prepare("INSERT OR REPLACE INTO artist_tags (artist_id, tag, weight) VALUES (?, ?, ?)");
const mark = db.prepare("UPDATE artists SET tags_checked = ? WHERE id = ?");

// Last.fm sometimes merges a local artist with a foreign namesake (Tulus -> Norwegian black metal band),
// even when queried by mbid. For local artists, a foreign nationality tag in the top 5 means the data is wrong.
const FOREIGN = ["norwegian", "korean", "k-pop", "french", "american", "british", "german", "swedish", "japanese", "finnish", "canadian", "australian", "puerto rican", "slovenian"];
const looksForeign = (tags: { name: string }[]) => tags.slice(0, 5).some((t) => FOREIGN.includes(t.name) && !t.name.includes("indonesia"));

// Local artist without a verified mbid: look up by name, but trust the result only if the tags say Indonesian.
const ID_MARKERS = ["indonesian", "indonesia", "indo pop", "indo", "dangdut", "koplo", "javanese", "jawa", "campursari", "pop indonesia", "malay", "melayu"];
const looksIndonesian = (tags: { name: string }[]) => tags.slice(0, 8).some((t) => ID_MARKERS.some((m) => t.name === m || t.name.includes("indonesia")));

let n = 0;
let unknown = 0;
for (const r of rows) {
  try {
    let tags = await artistTopTags(r.name, r.mbid, true);
    if (r.local_seed && !r.mbid && tags && !looksIndonesian(tags)) tags = null; // probably a foreign namesake
    if (r.local_seed && tags && looksForeign(tags)) { console.log(`dropped foreign-looking tags: ${r.name}`); tags = null; }
    db.transaction(() => {
      del.run(r.id);
      // weight < 10 is mostly noise; keep top 15
      for (const t of (tags ?? []).filter((t) => t.count >= 10).slice(0, 15)) ins.run(r.id, t.name, t.count);
      mark.run(Math.floor(Date.now() / 1000), r.id);
    })();
    if (!tags?.length) unknown++;
  } catch (e) {
    console.warn(`skip ${r.name}:`, (e as Error).message); // not marked, so it is retried next run
  }
  if (++n % 50 === 0) console.log(`${n}/${rows.length}`);
}
console.log(`done: ${n} artists, ${unknown} without tags`);
