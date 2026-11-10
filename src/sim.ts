// Simulated listener with a hidden taste: checks that the radio learns from spins alone.
// Usage: bun run sim [plays=400] [seed=1]
import { loadCatalog, pickNext, Profile, type Rng, type Track } from "./radio.ts";

const PLAYS = import.meta.main ? Number(process.argv[2] ?? 400) : 400;
export const MAX_FINISH = Number(process.env.MAX_FINISH ?? 1);
export const EARLY_SPIN = Number(process.env.EARLY_SPIN ?? 0.7);
const SEED = Number(process.argv[3] ?? 1);

export function mulberry32(a: number): Rng {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const catalog = loadCatalog();

// Hidden taste profiles. The radio never sees these, only the spin behaviour they produce.
export const TASTES: Record<string, Record<string, number>> = {
  "indo pop + ballad": { "tag:indonesian": 1, "tag:pop": 1, "tag:ballad": 0.8, "tag:indonesia": 0.6 },
  "rock / metal": { "tag:rock": 1, "tag:metal": 1, "tag:alternative rock": 0.8, "tag:hard rock": 0.8, "tag:nu metal": 0.8 },
  "dance / edm": { "tag:electronic": 1, "tag:dance": 1, "tag:edm": 1, "tag:house": 0.8 },
  // Same genre, different generation: only the era tells them apart (the case era features exist for).
  // Needs tracks.year filled (bun run years); era weights are large on purpose because era is a 0.6-scaled feature.
  "pop, 2000s nostalgia": { "tag:pop": 0.3, "tag:indonesian": 0.3, "era:2000": 2, "era:2005": 2 },
  "pop, 2020s": { "tag:pop": 0.3, "tag:indonesian": 0.3, "era:2020": 2, "era:2015": 2 },
  // Listener who only finishes songs they know (hits); a different listener than the others, who ignore popularity.
  "indo pop, hits only": { "tag:indonesian": 0.2, "pop:fam": 1 },
};

export const affinity = (taste: Record<string, number>, t: Track) => {
  let s = 0;
  for (const [k, v] of t.feats) s += v * (taste[k] ?? 0);
  return s;
};

export type PlayLog = { i: number; track: Track; mode: "exploit" | "explore"; finished: boolean; listenedMs: number; signal: number };
export function simulate(name: string, taste: Record<string, number>, useRadio: boolean, rng: Rng, onPlay?: (p: PlayLog) => void, plays = PLAYS) {
  const profile = new Profile();
  const favNames: string[] = [];
  // Onboarding: the user picks 3 favourite artists (their best-matching ones)
  const byArtist = new Map<number, Track>();
  for (const t of catalog) byArtist.set(t.artistId, t);
  const favs = [...byArtist.values()].sort((a, b) => affinity(taste, b) - affinity(taste, a)).slice(0, 3);
  if (!process.env.NO_ONBOARDING) { profile.seed(favs); favNames.push(...favs.map((t) => t.artist)); }

  const blocks: number[] = [];
  let done = 0, block = 0, explored = 0, exploredOk = 0, clock = 0;
  for (let i = 1; i <= plays; i++) {
    clock += 30_000; // virtual time: every play takes ~30 s, so one continuous session
    const pick = useRadio ? pickNext(catalog, profile, rng, clock) : { track: catalog[Math.floor(rng() * catalog.length)]!, mode: "exploit" as const };
    const t = pick.track;
    // Hidden listener: probability of finishing the song rises with true affinity.
    // MAX_FINISH caps how often even a loved song is finished (0.75 = normal listener, 0.3 = presses next a lot)
    const like = MAX_FINISH / (1 + Math.exp(-6 * (affinity(taste, t) - 0.35)));
    const finishes = rng() < like;
    const listened = finishes ? t.durationMs : rng() < EARLY_SPIN ? 5_000 + rng() * 8_000 : t.durationMs * (0.2 + rng() * 0.5);
    const sig = useRadio ? profile.record(t, finishes ? "complete" : "spin", listened, clock) : 0;
    onPlay?.({ i, track: t, mode: pick.mode, finished: finishes, listenedMs: listened, signal: sig });
    if (finishes) { done++; block++; }
    if (pick.mode === "explore") { explored++; if (finishes) exploredOk++; }
    if (i % 50 === 0) { blocks.push(block / 50); block = 0; }
  }
  return { name, blocks, rate: done / plays, explored, exploredOk, favNames };
}

/**
 * A listener whose taste is not fixed but follows their mood: every 20-40 plays the mood switches to a different hidden taste
 * (half of the switches also come with a >30 min silence = new session). Onboarding = one favourite artist of each of 3 moods.
 * Reports completion overall, in the first 8 plays after a switch (how fast the radio finds the new mood) and after that.
 * Circular like the rest of the simulator (the moods use the features the engine sees): it shows the mechanism, not real behaviour.
 */
export function simulateMoody(rng: Rng, useRadio = true, plays = 400) {
  const names = Object.keys(TASTES);
  const profile = new Profile();
  const byArtist = new Map<number, Track>();
  for (const t of catalog) byArtist.set(t.artistId, t);
  const favs = [0, 1, 2].map((k) => {
    const taste = TASTES[names[Math.floor(rng() * names.length)]!]!;
    return [...byArtist.values()].sort((a, b) => affinity(taste, b) - affinity(taste, a))[k]!;
  });
  if (!process.env.NO_ONBOARDING) profile.seed(favs);

  let cur = names[0]!, left = 0, clock = 0, sincePlay = 0;
  const early = { n: 0, ok: 0 }, late = { n: 0, ok: 0 };
  for (let i = 1; i <= plays; i++) {
    if (left <= 0) {
      const others = names.filter((n) => n !== cur);
      cur = others[Math.floor(rng() * others.length)]!;
      left = 20 + Math.floor(rng() * 21);
      sincePlay = 0;
      if (rng() < 0.5) clock += 40 * 60_000; // came back later: a new session
    }
    clock += 30_000; left--; sincePlay++;
    const taste = TASTES[cur]!;
    const t = useRadio ? pickNext(catalog, profile, rng, clock).track : catalog[Math.floor(rng() * catalog.length)]!;
    const like = MAX_FINISH / (1 + Math.exp(-6 * (affinity(taste, t) - 0.35)));
    const finishes = rng() < like;
    const listened = finishes ? t.durationMs : rng() < EARLY_SPIN ? 5_000 + rng() * 8_000 : t.durationMs * (0.2 + rng() * 0.5);
    if (useRadio) profile.record(t, finishes ? "complete" : "spin", listened, clock);
    const bucket = sincePlay <= 8 ? early : late;
    bucket.n++; if (finishes) bucket.ok++;
  }
  return { overall: (early.ok + late.ok) / plays, early: early.ok / early.n, late: late.ok / late.n };
}

if (import.meta.main) {
  console.log(`catalog: ${catalog.length} tracks, ${new Set(catalog.map((t) => t.artistId)).size} artists`);
}
const fmt = (n: number) => `${Math.round(n * 100)}%`.padStart(4);
if (import.meta.main) for (const [name, taste] of Object.entries(TASTES)) {
  const base = simulate(name, taste, false, mulberry32(SEED));
  const radio = simulate(name, taste, true, mulberry32(SEED));
  console.log(`\n== hidden taste: ${name}`);
  console.log(`completion per 50 plays  random: ${base.blocks.map(fmt).join("")}   (overall ${fmt(base.rate)})`);
  console.log(`                         radio : ${radio.blocks.map(fmt).join("")}   (overall ${fmt(radio.rate)})`);
  console.log(`exploration plays: ${radio.explored}, of which finished: ${radio.exploredOk}`);
}
