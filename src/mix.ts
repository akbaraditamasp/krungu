// Radio mixing experiment: announcer voice <-> song transitions, with a song chosen by the Krungu engine.
//   bun run mix [voiceFile] [artists] [genres]
//   e.g. bun run mix scripts/2026-11-16/VOICE-1.mp3 "Hindia,Nadin Amizah,Juicy Luicy,Raisa"
// Writes out/mix/{voice-to-song-fade,voice-to-song-talkover,song-to-voice}.mp3 (excerpts, to judge the transitions by ear).
// Tunables (env): OVERLAP (s of voice tail over the song intro), DUCK (song gain under the voice), RAMP (s to bring the
// song back up), BED (s of song outro under the next voice), BEDG (song gain under that voice), EXCERPT / TAIL (s of song kept),
// VOICE_LUFS / SONG_LUFS (loudness targets).
// Song audio comes from the same yt-dlp path as the player: personal testing only (YouTube ToS).
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildPlaylist } from "./playlist.ts";
import { matchTrack } from "./youtube.ts";

import { P, bin, run, duration, fetchSong, f, norm } from "./mixer.ts";

async function ffmpeg(inputs: string[][], graph: string, out: string) {
  await run([bin("ffmpeg"), "-y", "-v", "error", ...inputs.flat(), "-filter_complex", graph, "-map", "[o]", "-ac", "2", "-ar", "44100", "-b:a", "192k", out]);
}

/** Voice, then the song starts after the voice ends (plain fade-in, no overlap). */
async function voiceToSongFade(voice: string, song: string, out: string) {
  const g = `[0:a]${norm(P.voiceLufs)}[v];[1:a]${norm(P.songLufs)},afade=t=in:d=1.5[s];[v][s]concat=n=2:v=0:a=1[o]`;
  await ffmpeg([["-i", voice], ["-t", String(P.excerpt), "-i", song]], g, out);
}

/** Song starts `overlap` s before the voice ends, ducked under it, then rises to full level (talk-over intro). */
async function voiceToSongTalkover(voice: string, song: string, out: string) {
  const dv = await duration(voice);
  const ov = Math.min(P.overlap, dv - 0.5);
  const delay = Math.round((dv - ov) * 1000);
  const gain = `if(lt(t,${f(ov)}),${P.duck},${P.duck}+${f(1 - P.duck)}*min(1,(t-${f(ov)})/${f(P.ramp)}))`;
  const g = `[0:a]${norm(P.voiceLufs)}[v];` +
    `[1:a]${norm(P.songLufs)},afade=t=in:d=0.4,volume='${gain}':eval=frame,adelay=${delay}|${delay}[s];` +
    `[v][s]amix=inputs=2:duration=longest:normalize=0[o]`;
  await ffmpeg([["-i", voice], ["-t", String(P.excerpt + ov), "-i", song]], g, out);
}

/** The song outro drops to a bed `bed` s before its end and the voice comes in over it. */
async function songToVoice(voice: string, song: string, out: string) {
  const ds = await duration(song);
  const tail = Math.min(P.tail, ds);
  const L = tail, B = L - P.bed, A = B - 1.5;
  const gain = `if(lt(t,${f(A)}),1,if(lt(t,${f(B)}),1-${f(1 - P.bedg)}*(t-${f(A)})/1.5,${P.bedg}))`;
  const delay = Math.round(B * 1000);
  const g = `[0:a]${norm(P.songLufs)},volume='${gain}':eval=frame,afade=t=out:st=${f(L - 3)}:d=3[s];` +
    `[1:a]${norm(P.voiceLufs)},adelay=${delay}|${delay}[v];[s][v]amix=inputs=2:duration=longest:normalize=0[o]`;
  await ffmpeg([["-ss", f(ds - tail), "-i", song], ["-i", voice]], g, out);
}

async function main() {
const [voiceArg = "scripts/2026-11-16/VOICE-1.mp3", artists = "Hindia,Nadin Amizah,Juicy Luicy,Raisa", genres = ""] = process.argv.slice(2);
const voice = resolve(voiceArg);
if (!existsSync(voice)) throw new Error(`voice file not found: ${voice}`);
const outDir = resolve(import.meta.dir, "../out/mix");
mkdirSync(`${outDir}/songs`, { recursive: true });

// 1. the engine picks the segment playlist; take the first song that has a usable YouTube match
const list = buildPlaylist({ artists: artists.split(",").filter(Boolean), genres: genres.split(",").filter(Boolean), n: 8, minFam: 0.4 });
console.log("segment playlist:\n" + list.map((t, i) => `  ${i + 1}. ${t.artist} - ${t.title}`).join("\n"));
let songFile = "";
for (const t of list) {
  const m = await matchTrack({ id: t.id, artist: t.artist, title: t.title, durationMs: t.durationMs }).catch(() => null);
  if (!m) continue;
  try { songFile = await fetchSong(t.id, m.videoId, `${outDir}/songs`); console.log(`mixing with: ${t.artist} - ${t.title}`); break; }
  catch (e) { console.warn(`skip ${t.title}: ${(e as Error).message}`); }
}
if (!songFile) throw new Error("no playable song found");

// 2. the three transitions
await voiceToSongFade(voice, songFile, `${outDir}/voice-to-song-fade.mp3`);
await voiceToSongTalkover(voice, songFile, `${outDir}/voice-to-song-talkover.mp3`);
await songToVoice(voice, songFile, `${outDir}/song-to-voice.mp3`);
console.log(`done -> ${outDir}`);
}
if (import.meta.main) await main();
