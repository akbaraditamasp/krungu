// Render a programme from a rundown file: the order of voices, songs, bumpers, stingers and beds for one slot.
//   bun run rundown scripts/2026-11-16/07_30-08_30.rundown.txt
// Writes out/rundown/<name>.mp3 and prints the as-run timeline.
//
// Rundown format (one item per line, '#' starts a comment):
//   artists: Hindia,Nadin Amizah,Juicy Luicy,Raisa   # taste of the segment: the Krungu engine picks the songs
//   genres: pop                                      # optional, extra seed tags
//   minFam: 0.4                                      # optional, only songs at least this familiar
//   energy: 4                                        # optional: only songs labeled energy >= 4 (1-5) in data/song-tags.csv
//   hits: 12                                         # optional: only each seed artist's top-12 songs on Last.fm (real popularity; Deezer rank is unreliable)
//   only: seeds                                      # optional: only songs BY the seed artists
//   prefer: happy,energetic                         # optional, moods pushed up (artist-level, from Last.fm tags)
//   avoid: sad,romantic,chill                        # optional, moods pushed down
//   exclude: Haddad Alwi,Ashanty                     # optional, artists never picked (human veto over the tag-based engine)
//   playlist: 07_30-08_30.playlist.json              # optional: the exact songs, in order (from `bun run playlist:pin`), so a
//                                                    # script can name them; relative to the rundown folder. Replaces artists/genres.
//   bumper intro-gas-terus                           # assets/bumpers/<name>.mp3
//   voice VOICE-1 bed=morning-1 up=8                 # <rundown folder>/VOICE-1.mp3, optional music bed assets/beds/<name>.mp3;
//                                                    # up=8: the bed plays alone 8 s first (an intro that keeps going under the voice
//                                                    # until the first song comes in)
//   song 2                                           # next 2 songs from the engine's playlist (default 1)
//   stinger whoosh-1                                 # assets/stingers/<name>.mp3, laid over the cut into the next item
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { buildPlaylist, seedArtists } from "./playlist.ts";
import { ensurePop } from "./pop.ts";
import { renderSequence, resolveSongs, type Clip } from "./mixer.ts";

type Item = { kind: "voice" | "bumper" | "stinger"; file: string; label: string; bed?: string; up?: number } | { kind: "song"; n: number };

const root = resolve(import.meta.dir, "..");
const [fileArg] = process.argv.slice(2);
if (!fileArg) throw new Error("usage: bun run rundown <rundown file>");
const file = resolve(fileArg);
const dir = dirname(file);

const asset = (folder: string, name: string) => {
  const f = `${root}/assets/${folder}/${name}.mp3`;
  if (!existsSync(f)) throw new Error(`asset not found: ${f}`);
  return f;
};

const head: Record<string, string> = {};
const items: Item[] = [];
readFileSync(file, "utf8").split(/\r?\n/).forEach((raw, ln) => {
  const line = raw.replace(/#.*$/, "").trim();
  if (!line) return;
  const kv = line.match(/^(artists|genres|minFam|energy|hits|only|exclude|prefer|avoid|playlist):\s*(.*)$/);
  if (kv) { head[kv[1]!] = kv[2]!.trim(); return; }
  const [kind, arg = "", ...opts] = line.split(/\s+/);
  const opt = Object.fromEntries(opts.map((o) => o.split("=") as [string, string]));
  switch (kind) {
    case "voice": {
      const v = `${dir}/${arg}.mp3`;
      if (!existsSync(v)) throw new Error(`line ${ln + 1}: voice file not found: ${v}`);
      items.push({ kind: "voice", file: v, label: arg, bed: opt.bed ? asset("beds", opt.bed) : undefined, up: opt.up ? Number(opt.up) : undefined });
      break;
    }
    case "bumper": items.push({ kind: "bumper", file: asset("bumpers", arg), label: `bumper ${arg}` }); break;
    case "stinger": items.push({ kind: "stinger", file: asset("stingers", arg), label: `stinger ${arg}` }); break;
    case "song": items.push({ kind: "song", n: arg ? Number(arg) : 1 }); break;
    default: throw new Error(`line ${ln + 1}: unknown item "${kind}"`);
  }
});

// songs: one playlist for the whole slot (so the engine keeps it coherent), handed out in order
const totalSongs = items.reduce((n, i) => n + (i.kind === "song" ? i.n : 0), 0);
const outDir = `${root}/out/rundown`;
mkdirSync(`${root}/out/mix/songs`, { recursive: true });
mkdirSync(outDir, { recursive: true });
let songs: Clip[] = [];
if (totalSongs) {
  const seedNames = (head.artists ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (head.hits) await ensurePop(seedArtists(seedNames)); // fetch Last.fm top songs once (cached 30 days)
  const tracks = head.playlist
    ? (JSON.parse(readFileSync(resolve(dir, head.playlist), "utf8")) as { id: number; artist: string; title: string; durationMs: number }[])
    : buildPlaylist({
        artists: (head.artists ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        genres: (head.genres ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        n: totalSongs * 2 + 4, minFam: Number(head.minFam ?? 0.4),
        seedsOnly: head.only === "seeds", hits: head.hits ? Number(head.hits) : undefined, minEnergy: head.energy ? Number(head.energy) : undefined,
        prefer: (head.prefer ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        avoid: (head.avoid ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        exclude: (head.exclude ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      });
  songs = await resolveSongs(tracks, totalSongs, `${root}/out/mix/songs`);
  if (songs.length < totalSongs) throw new Error(`only ${songs.length} of ${totalSongs} songs found`);
  if (head.playlist && songs.some((c, i) => !c.label?.startsWith(`${(tracks as any)[i].artist} - `))) throw new Error("a pinned song could not be resolved: re-pin the playlist (the script names these songs)");
}

const clips: Clip[] = items.flatMap((i): Clip[] => i.kind === "song" ? songs.splice(0, i.n) : [i]);
const out = `${outDir}/${basename(file).replace(/\.rundown\.txt$|\.txt$/, "")}.mp3`;
const { timeline, total } = await renderSequence(clips, out);

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
for (const t of timeline) console.log(`${fmt(t.start).padStart(5)} - ${fmt(t.end).padStart(5)}  ${t.kind.padEnd(7)} ${t.label ?? basename(t.file)}`);
console.log(`total ${fmt(total)} -> ${out}`);
