// Decide which tracks the radio may play. Non-destructive: sets tracks.playable, never deletes rows.
// Hidden: instrumental/karaoke/live/remix/sped-up/slowed/demo/cover-style versions, very short tracks,
// and duplicates (same artist + same normalized title) where the most popular copy wins.
import { db } from "./db.ts";

const BAD = /\b(instrumental|karaoke|live|remix|sped up|speed up|slowed|reverb|demo|tribute|cover|medley|acapella|a cappella|8d|nightcore|ringtone|intro|outro|skit|interlude)\b/i;
// "Remastered", "Album Version", "Radio Edit", "Studio Version", "2011 Mix" etc. are the SAME song: strip for dedupe
const VERSION_WORDS = /\b(remaster(ed)?( \d{4})?|\d{4} remaster(ed)?|album version|single version|radio edit|radio version|studio version|original version|original mix|explicit|clean|mono|stereo|version|edit|bonus track|deluxe)\b/gi;
const HAS_VERSION = new RegExp(VERSION_WORDS.source, "i"); // non-global: .test() on a /g regex keeps state between calls

export const normTitle = (title: string) =>
  title
    .replace(/[\(\[][^\)\]]*[\)\]]/g, (m) => (HAS_VERSION.test(m) ? " " : m)) // drop bracketed version notes only
    .replace(/\s+-\s+.*(remaster|version|edit|mix).*$/i, "")                    // "Song - 2011 Remaster"
    .toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

const rows = db.query("SELECT id, artist_id a, title, rank, duration FROM tracks").all() as
  { id: number; a: number; title: string; rank: number | null; duration: number | null }[];

const best = new Map<string, { id: number; rank: number }>();
const bad = new Set<number>();
for (const r of rows) {
  if (BAD.test(r.title) || (r.duration != null && r.duration < 60)) { bad.add(r.id); continue; }
  const key = `${r.a}|${normTitle(r.title)}`;
  const cur = best.get(key);
  if (!cur || (r.rank ?? 0) > cur.rank) best.set(key, { id: r.id, rank: r.rank ?? 0 });
}
const keep = new Set([...best.values()].map((b) => b.id));

db.transaction(() => {
  db.run("UPDATE tracks SET playable = 0");
  const on = db.prepare("UPDATE tracks SET playable = 1 WHERE id = ?");
  for (const id of keep) on.run(id);
})();

console.log(`tracks: ${rows.length} total, ${keep.size} playable, ${bad.size} hidden as versions, ${rows.length - keep.size - bad.size} hidden as duplicates`);
