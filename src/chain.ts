// Full on-air chain through the mixer: VOICE a -> song(s) -> VOICE b, one file with radio-style transitions.
//   bun run chain [voiceA] [voiceB] [artists] [songs]
//   e.g. bun run chain scripts/2026-11-16/VOICE-1.mp3 scripts/2026-11-16/VOICE-2.mp3 "Hindia,Nadin Amizah,Juicy Luicy,Raisa" 2
// Writes out/mix/chain.mp3. Transition rules and tunables (OVERLAP, DUCK, RAMP, BED, BEDG, XFADE, ...) live in mixer.ts.
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildPlaylist } from "./playlist.ts";
import { renderSequence, resolveSongs } from "./mixer.ts";

const [vaArg = "scripts/2026-11-16/VOICE-1.mp3", vbArg = "scripts/2026-11-16/VOICE-2.mp3",
  artists = "Hindia,Nadin Amizah,Juicy Luicy,Raisa", nSongs = "2"] = process.argv.slice(2);
const va = resolve(vaArg), vb = resolve(vbArg);
for (const v of [va, vb]) if (!existsSync(v)) throw new Error(`voice file not found: ${v}`);
const outDir = resolve(import.meta.dir, "../out/mix");
mkdirSync(`${outDir}/songs`, { recursive: true });

const tracks = buildPlaylist({ artists: artists.split(",").filter(Boolean), n: 10, minFam: 0.4 });
const songs = await resolveSongs(tracks, Number(nSongs), `${outDir}/songs`);
if (!songs.length) throw new Error("no playable song found");

const { timeline, total } = await renderSequence(
  [{ kind: "voice", file: va, label: "VOICE 1" }, ...songs, { kind: "voice", file: vb, label: "VOICE 2" }],
  `${outDir}/chain.mp3`,
);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
for (const t of timeline) console.log(`${t.kind.padEnd(5)} ${fmt(t.start)} - ${fmt(t.end)}  ${t.label ?? t.file}`);
console.log(`total ${fmt(total)} -> ${outDir}/chain.mp3`);
