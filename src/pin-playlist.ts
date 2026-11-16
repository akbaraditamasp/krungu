// Pin a segment playlist to a file, so a script can name the songs and the render plays exactly those.
//   bun run playlist:pin <out.json> "Artist1,Artist2" <n> [seed] ["Excluded Artist,Another"]
// Picks with buildPlaylist (taste mode, announceable titles), keeps only songs that have an acceptable YouTube match
// (checked here, nothing is downloaded), and writes [{id, artist, title, durationMs}] in play order.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPlaylist, cleanTitle } from "./playlist.ts";
import { matchTrack } from "./youtube.ts";

const [outArg, artists = "", n = "14", seed = "1", exclude = ""] = process.argv.slice(2);
if (!outArg) throw new Error('usage: bun run playlist:pin <out.json> "Artist1,Artist2" <n> [seed]');
const want = Number(n);
const cand = buildPlaylist({ artists: artists.split(",").map((s) => s.trim()).filter(Boolean), n: want * 3, minFam: 0.4, announce: true, seed: Number(seed), exclude: exclude.split(",").map((s) => s.trim()).filter(Boolean) });
const pinned: { id: number; artist: string; title: string; durationMs: number }[] = [];
for (const t of cand) {
  if (pinned.length >= want) break;
  const m = await matchTrack({ id: t.id, artist: t.artist, title: t.title, durationMs: t.durationMs }).catch(() => null);
  if (m) pinned.push({ id: t.id, artist: t.artist, title: cleanTitle(t.title), durationMs: t.durationMs });
}
if (pinned.length < want) throw new Error(`only ${pinned.length} of ${want} playable songs found`);
writeFileSync(resolve(outArg), JSON.stringify(pinned, null, 2));
pinned.forEach((t, i) => console.log(`${String(i + 1).padStart(2)}. ${t.artist} - ${t.title}  (${Math.round(t.durationMs / 60000 * 10) / 10} min)`));
console.log(`total ${Math.round(pinned.reduce((a, t) => a + t.durationMs, 0) / 60000)} min of music -> ${resolve(outArg)}`);
