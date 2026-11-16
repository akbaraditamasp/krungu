// Radio mixer: joins voice and song clips into one programme with transitions chosen by the neighbours of each clip.
//   voice -> song : the song starts `overlap` s before the voice ends, ducked under it, then rises (talk-over intro)
//   song  -> song : crossfade of `xfade` s
//   song  -> voice: the song outro drops to a bed `bed` s before its end, the voice enters over it, the song fades out
//   voice -> voice: back to back with a short gap
// All timing comes from clip durations; the parameters are fixed defaults (same for every song), tunable by env.
// Not song-aware yet (no vocal-start / outro-shape detection), see CLAUDE.md.
import { existsSync } from "node:fs";
import { matchTrack } from "./youtube.ts";

const num = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
export const P = {
  overlap: num("OVERLAP", 6),   // s of voice tail over the song intro
  duck: num("DUCK", 0.3),       // song gain under the voice
  ramp: num("RAMP", 1.5),       // s to bring the song back up after the voice
  bed: num("BED", 6),           // s of song outro under the next voice
  bedg: num("BEDG", 0.25),      // song gain under that voice
  xfade: num("XFADE", 4),       // song -> song crossfade
  finalFade: num("FINAL_FADE", 3),
  gap: num("VOICE_GAP", 0.4),   // voice -> voice gap
  excerpt: num("EXCERPT", 45), tail: num("TAIL", 30), // only used by the mix.ts experiment
  voiceLufs: num("VOICE_LUFS", -16), songLufs: num("SONG_LUFS", -18), bumperLufs: num("BUMPER_LUFS", -17),
  bedGain: num("BED_GAIN", 0.18),   // music bed under a voice, linear gain after normalizing to songLufs (0.18 = -15 dB)
  bedLead: num("BED_LEAD", 1.5),    // s the bed starts before the voice
  bedTail: num("BED_TAIL", 1.5),    // s the bed stays (fading) after the voice ends
};
export type Params = typeof P;

const WINGET = `${process.env.LOCALAPPDATA ?? ""}/Microsoft/WinGet/Links`;
export const bin = (n: string) => process.env[n.toUpperCase()] ?? Bun.which(n) ?? `${WINGET}/${n}.exe`;
const YTDLP = process.env.YTDLP ?? `${import.meta.dir}/../.venv/${process.platform === "win32" ? "Scripts/yt-dlp.exe" : "bin/yt-dlp"}`;

export async function runBoth(cmd: string[]): Promise<{ out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} failed: ${err.trim().split(/\r?\n/).slice(-4).join("\n")}`);
  return { out, err };
}
export const run = async (cmd: string[]) => (await runBoth(cmd)).out;

export const duration = async (file: string) =>
  Number((await run([bin("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])).trim());

/**
 * Where the music really starts and ends: YouTube audio often has ~1 s of silence at the start and 3-7 s at the end, and
 * mixing by file length would then start crossfades inside that silence (dead air, next song comes in late).
 */
export async function musicBounds(file: string, total: number, floorDb = Number(process.env.SILENCE_DB ?? -42)): Promise<{ start: number; end: number }> {
  const { err } = await runBoth([bin("ffmpeg"), "-hide_banner", "-nostats", "-i", file, "-af", `silencedetect=noise=${floorDb}dB:d=0.3`, "-f", "null", "-"]);
  return parseBounds(err, total);
}

export function parseBounds(log: string, total: number): { start: number; end: number } {
  let start = 0, end = total;
  const re = /silence_start: (-?[\d.]+)|silence_end: ([\d.]+)/g;
  let open: number | null = null, m: RegExpExecArray | null;
  while ((m = re.exec(log))) {
    if (m[1] !== undefined) open = Math.max(0, Number(m[1]));
    else if (m[2] !== undefined && open !== null) {
      const e = Number(m[2]);
      if (open <= 0.05) start = e;                 // silence from the very start
      else if (e >= total - 0.25) end = open;      // silence running to the end of the file
      open = null;
    }
  }
  if (open !== null && open > 0.05) end = open;    // silence never closed = runs to the end
  return end - start > 5 ? { start, end } : { start: 0, end: total };
}

export const f = (x: number) => x.toFixed(3);
export const norm = (lufs: number) => `loudnorm=I=${lufs}:TP=-1.5:LRA=11`;

/** Download (cached) the audio of a YouTube video as <dir>/<id>.<ext>. Personal testing only (YouTube ToS). */
export async function fetchSong(id: number, videoId: string, dir: string): Promise<string> {
  const base = `${dir}/${id}`;
  const exts = ["m4a", "webm", "opus", "mp3"];
  for (const ext of exts) if (existsSync(`${base}.${ext}`)) return `${base}.${ext}`;
  await run([YTDLP, "--no-warnings", "--no-playlist", "-f", "bestaudio[ext=m4a]/bestaudio", "-o", `${base}.%(ext)s`, `https://www.youtube.com/watch?v=${videoId}`]);
  for (const ext of exts) if (existsSync(`${base}.${ext}`)) return `${base}.${ext}`;
  throw new Error("yt-dlp produced no file");
}

export type SongTrack = { id: number; artist: string; title: string; durationMs: number };
/**
 * voice   : announcer; `bed` (file) puts a looped music bed under it (skipped when a song's outro already plays under it).
 *           `up` = seconds the bed plays alone at full level first (an intro that never ends: it ducks under the voice and
 *           keeps going until the next song comes in, instead of switching to a different bed)
 * song    : trimmed to where the music really is
 * bumper  : jingle / station ID / program intro-outro: takes timeline time like a song
 * stinger : short effect laid over the cut into the NEXT clip, takes no timeline time
 */
export type Clip = { kind: "voice" | "song" | "bumper" | "stinger"; file: string; label?: string; bed?: string; up?: number };

/** First `count` tracks that have an acceptable YouTube match and download fine, as ready-to-mix song clips. */
export async function resolveSongs(tracks: SongTrack[], count: number, dir: string): Promise<Clip[]> {
  const out: Clip[] = [];
  for (const t of tracks) {
    if (out.length >= count) break;
    const m = await matchTrack(t).catch(() => null);
    if (!m) continue;
    try { out.push({ kind: "song", file: await fetchSong(t.id, m.videoId, dir), label: `${t.artist} - ${t.title}` }); }
    catch (e) { console.warn(`skip ${t.title}: ${(e as Error).message}`); }
  }
  return out;
}

export type Placed = Omit<Clip, "kind"> & { kind: Clip["kind"] | "bed"; start: number; end: number };

/** Seconds that `b` starts before `a` ends (negative = a gap). `da` = duration of a. */
function overlapOf(a: Clip, b: Clip, da: number, p: Params): number {
  switch (`${a.kind}>${b.kind}`) {
    case "voice>song": return Math.min(p.overlap, da - 0.5);   // talk-over intro
    case "voice>bumper": return 0.3;
    case "voice>voice": return -p.gap;
    case "song>song": return p.xfade;
    case "song>voice": return Math.min(p.bed, da - 1);         // outro bed under the voice
    case "song>bumper": return 1.5;
    case "bumper>voice": return Math.min(2, da - 1);           // announcer talks up over the jingle tail
    case "bumper>song": return 1;
    default: return 0;
  }
}

/** Render the clips in order into one file. Returns the timeline (seconds) for logging / as-run records. */
export async function renderSequence(all: Clip[], out: string, p: Params = P): Promise<{ timeline: Placed[]; total: number }> {
  if (!all.length) throw new Error("nothing to mix");
  // stingers are overlays on the cut into the next clip; a trailing one has nothing to cut into and is dropped
  const clips: Clip[] = [];
  const stingers = new Map<number, Clip[]>();
  let pending: Clip[] = [];
  for (const c of all) {
    if (c.kind === "stinger") { pending.push(c); continue; }
    if (pending.length) { stingers.set(clips.length, pending); pending = []; }
    clips.push(c);
  }
  if (!clips.length) throw new Error("nothing to mix (only stingers)");

  // songs are trimmed to where the music really is; everything else is used as it is (a voice's own pauses are intentional)
  const bounds = await Promise.all(clips.map(async (c) => {
    const total = await duration(c.file);
    return c.kind === "song" ? { total, ...(await musicBounds(c.file, total)) } : { total, start: 0, end: total };
  }));
  // a voice with an intro bed: the clip starts with `up` seconds of bed alone, then the voice enters
  const ups = clips.map((c, i) => (c.kind === "voice" && c.bed && c.up && clips[i - 1]?.kind !== "song" ? c.up : 0));
  const durs = bounds.map((b, i) => b.end - b.start + ups[i]!);
  const starts: number[] = [];
  clips.forEach((c, i) => { starts.push(i === 0 ? 0 : starts[i - 1]! + durs[i - 1]! - overlapOf(clips[i - 1]!, c, durs[i - 1]!, p)); });

  const ms = (s: number) => Math.round(s * 1000);
  const inputs: string[] = [];
  const parts: string[] = [];
  const labels: string[] = [];
  const timeline: Placed[] = [];
  const addInput = (file: string, loop = false) => { inputs.push(...(loop ? ["-stream_loop", "-1"] : []), "-i", file); return inputs.filter((x) => x === "-i").length - 1; };
  const emit = (idx: number, chain: string[]) => { const l = `c${labels.length}`; parts.push(`[${idx}:a]${chain.join(",")}[${l}]`); labels.push(`[${l}]`); };

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!, L = durs[i]!, prev = clips[i - 1], next = clips[i + 1], b = bounds[i]!;
    const delay = `adelay=${ms(starts[i]! + ups[i]!)}|${ms(starts[i]! + ups[i]!)}`;
    timeline.push({ ...c, start: starts[i]! + ups[i]!, end: starts[i]! + L });

    if (c.kind === "voice") {
      emit(addInput(c.file), [norm(p.voiceLufs), delay]);
      if (c.bed && prev?.kind !== "song") {
        const up = ups[i]!, lead = up > 0 ? 0 : Math.min(p.bedLead, starts[i]!), bedStart = starts[i]! - lead;
        // the bed lives until the next song has come in (then fades under it), otherwise a short tail after the voice
        const fade = next?.kind === "song" ? 3 : p.bedTail;
        const end = next?.kind === "song" ? starts[i + 1]! + 3 : starts[i]! + L + p.bedTail;
        const span = end - bedStart;
        const gain = up > 0 ? `volume='if(lt(t,${f(up)}),1,${p.bedGain}+${f(1 - p.bedGain)}*max(0,1-(t-${f(up)})/1.2))':eval=frame` : `volume=${p.bedGain}`;
        emit(addInput(c.bed, true), [`atrim=end=${f(span)}`, "asetpts=PTS-STARTPTS", norm(p.songLufs), gain,
          `afade=t=in:d=${up > 0 ? 0.05 : 1}`, `afade=t=out:st=${f(span - fade)}:d=${fade}`, `adelay=${ms(bedStart)}|${ms(bedStart)}`]);
        timeline.push({ kind: "bed", file: c.bed, label: `bed under ${c.label ?? "voice"}`, start: bedStart, end });
      }
    } else {
      const song = c.kind === "song";
      const chain = [b.start > 0 || b.end < b.total ? `atrim=start=${f(b.start)}:end=${f(b.end)},asetpts=PTS-STARTPTS` : "anull", norm(song ? p.songLufs : p.bumperLufs)];
      const exprs: string[] = [];
      const inO = prev ? overlapOf(prev, c, durs[i - 1]!, p) : 0;
      const outO = next ? overlapOf(c, next, L, p) : 0;
      if (prev?.kind === "voice" && song) { // under the end of the voice, then up
        chain.push("afade=t=in:d=0.4");
        exprs.push(`if(lt(t,${f(inO)}),${p.duck},${p.duck}+${f(1 - p.duck)}*min(1,(t-${f(inO)})/${f(p.ramp)}))`);
      } else chain.push(`afade=t=in:d=${inO > 0 ? inO : song ? 1.5 : 0.05}`);
      if (next?.kind === "voice" && song) { // outro drops to a bed under the voice, then fades out
        const B = L - outO, A = B - 1.5;
        exprs.push(`if(lt(t,${f(A)}),1,if(lt(t,${f(B)}),1-${f(1 - p.bedg)}*(t-${f(A)})/1.5,${p.bedg}))`);
        chain.push(`afade=t=out:st=${f(L - p.finalFade)}:d=${p.finalFade}`);
      } else if (next?.kind === "voice") { // jingle tail ducked under the announcer
        const A = L - outO;
        exprs.push(`if(lt(t,${f(A)}),1,1-0.65*min(1,(t-${f(A)})/${f(outO)}))`);
        chain.push(`afade=t=out:st=${f(L - Math.min(1, outO))}:d=${f(Math.min(1, outO))}`);
      } else if (next && outO > 0) chain.push(`afade=t=out:st=${f(L - outO)}:d=${f(outO)}`);
      else { const fin = Math.min(L / 2, song ? p.finalFade : 0.3); chain.push(`afade=t=out:st=${f(L - fin)}:d=${f(fin)}`); }
      if (exprs.length) chain.push(`volume='${exprs.join("*")}':eval=frame`);
      chain.push(delay);
      emit(addInput(c.file), chain);
    }

    for (const s of stingers.get(i) ?? []) { // laid over the cut into this clip
      const d = await duration(s.file), at = Math.max(0, starts[i]! - 0.3);
      emit(addInput(s.file), [norm(p.songLufs), `afade=t=out:st=${f(Math.max(0, d - 0.3))}:d=0.3`, `adelay=${ms(at)}|${ms(at)}`]);
      timeline.push({ ...s, start: at, end: at + d });
    }
  }
  parts.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95[o]`);

  await run([bin("ffmpeg"), "-y", "-v", "error", ...inputs, "-filter_complex", parts.join(";"), "-map", "[o]", "-ac", "2", "-ar", "44100", "-b:a", "192k", out]);
  timeline.sort((a, b) => a.start - b.start);
  return { timeline, total: Math.max(...timeline.map((t) => t.end)) };
}
