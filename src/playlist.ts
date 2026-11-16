// Playlist for a broadcast segment. A segment ("GAS TERUS!" 07:30-08:30, say) has a taste spec (seed artists and/or genre tags).
// Default mode "taste": fixed taste, songs closest to the seed artists (see tastePlaylist). Mode "drift": the Krungu session
// engine acts as one listener with that taste and every pick is recorded as finished; kept for comparison, it wanders off.
import { db } from "./db.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hitsOf, normTitle } from "./pop.ts";

/** Per-song labels (energy 1-5, mood, confidence) from data/song-tags.csv, keyed by normalized artist + title. */
export type SongTag = { energy: number; mood: string; conf: string };
export function loadSongTags(file = resolve(import.meta.dir, "../data/song-tags.csv")): Map<string, SongTag> {
  const m = new Map<string, SongTag>();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/).slice(1)) {
    const [artist, title, energy, mood, conf] = line.split(",").map((x) => x?.trim() ?? "");
    if (artist && title && energy) m.set(`${normTitle(artist)}|${normTitle(title)}`, { energy: Number(energy), mood: mood ?? "", conf: conf ?? "" });
  }
  return m;
}
import { cfg, loadCatalog, pickNext, Profile, similarity, type Track } from "./radio.ts";

export type SegmentSpec = {
  artists?: string[];   // seed artists by name (their best-known song seeds the profile)
  genres?: string[];    // seed tags, e.g. "pop", "indonesian"
  n: number;            // number of songs
  minFam?: number;      // only songs at least this familiar (0-1); morning shows usually want hits
  seed?: number;        // for reproducible picks
  minEnergy?: number;   // only songs whose label in data/song-tags.csv has energy >= this (1-5); unlabeled songs are skipped
  hits?: number;        // only each seed artist's top-N songs on Last.fm (real popularity; needs `ensurePop`); implies seedsOnly, ignores minFam
  seedsOnly?: boolean;  // only songs BY the seed artists (otherwise tag similarity lets related artists in, e.g. ballads of unrelated singers)
  prefer?: string[];    // moods to push up (artist-level, from tags), e.g. ["happy","energetic"]
  avoid?: string[];     // moods to push down, e.g. ["sad","romantic","chill"] (a morning show should not drift into ballads)
  exclude?: string[];   // artist names never to pick (the engine only sees artist tags, so some mismatches need a human veto)
  announce?: boolean;   // only songs a presenter can say on air: short, plain-Latin title and artist (no "(feat. ...)", no symbols)
  mode?: "taste" | "drift"; // taste (default): stay close to the seed artists; drift: engine session that follows its own finished picks
};

const mulberry32 = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Title as an announcer would say it: no "(Live)" / "(feat. X)" / "- Remastered" parts. */
export const cleanTitle = (t: string) => t.replace(/[\(\[][^\)\]]*[\)\]]/g, " ").replace(/\s+-\s+.*$/, "").replace(/\s+/g, " ").trim();

/** Short and plain enough to read out: at most 6 words, basic Latin letters only (TTS and listeners both stumble on the rest). */
export function announceable(t: Track): boolean {
  const title = cleanTitle(t.title), plain = /^[A-Za-z0-9 .,'!?&-]+$/;
  return title.length > 0 && title.split(" ").length <= 6 && plain.test(title) && plain.test(t.artist);
}

/** Tracks with no acceptable YouTube match are unplayable; the table may not exist yet. */
function blockedIds(): Set<number> {
  try {
    return new Set((db.query("SELECT track_id FROM yt_matches WHERE video_id IS NULL").all() as { track_id: number }[]).map((r) => r.track_id));
  } catch { return new Set(); }
}

/**
 * "taste" mode: the segment has a FIXED taste (its seed artists), it does not walk. Every candidate is scored by how close it is
 * (tags + moods + era, `similarity()`) to the seed artists' best-known songs, averaged over the two closest seeds so a song
 * has to sound like the seed set and not just one artist, plus a little popularity. The next song is sampled from the best 40,
 * never from an artist used in the last 6 picks. Why not the session engine: it re-centres on each finished pick, so over
 * 5-10 songs the playlist random-walks away from the seeds (observed: pop-indie seeds ended in gospel and campursari).
 */
function tastePlaylist(all: Track[], catalog: Track[], seeds: Track[], spec: SegmentSpec, rng: () => number): Track[] {
  const seedSongs = new Map<number, Track[]>();
  for (const s of seeds) {
    const top = all.filter((t) => t.artistId === s.artistId).sort((a, b) => b.fam - a.fam).slice(0, 3);
    seedSongs.set(s.artistId, top);
  }
  if (!seedSongs.size) throw new Error("taste mode needs at least one seed artist found in the catalog");
  const near = (t: Track) => {
    const per = [...seedSongs.values()].map((ss) => Math.max(...ss.map((x) => similarity(t, x))));
    per.sort((a, b) => b - a);
    const top = per.slice(0, 2);
    return top.reduce((a, b) => a + b, 0) / top.length;
  };
  // mood steer: artist-level only (Last.fm tags), so it separates genres of mood, not single songs
  const moodOf = (t: Track, ms: string[] = []) => Math.max(0, ...ms.map((m) => (t.feats.get(`mood:${m}`) ?? 0) / 0.7));
  const seedIds = new Set(seeds.map((x) => x.artistId));
  const hitMaps = new Map([...seedIds].map((id) => [id, hitsOf(id, spec.hits ?? 0)] as const));
  const useHits = !!spec.hits && [...hitMaps.values()].some((m) => m.size);
  if (spec.hits && !useHits) console.warn("no Last.fm popularity cached for the seed artists (run `bun run pop`): falling back to Deezer familiarity");
  const pool0 = spec.seedsOnly || useHits ? catalog.filter((t) => seedIds.has(t.artistId)) : catalog;
  // hits mode: a candidate is a catalog track whose title matches one of the artist's top-N Last.fm songs; one copy per song
  // (the most recent-looking: highest Deezer rank), scored by its place in the artist's list and by global listeners
  const tags = loadSongTags();
  const hitScore = new Map<Track, number>();
  if (useHits) {
    const seen = new Map<string, Track>();
    for (const t of pool0) {
      const h = hitMaps.get(t.artistId)?.get(normTitle(t.title));
      if (!h) continue;
      if (spec.minEnergy && (tags.get(`${normTitle(t.artist)}|${normTitle(t.title)}`)?.energy ?? 0) < spec.minEnergy) continue;
      const k = `${t.artistId}|${normTitle(t.title)}`;
      if (!seen.has(k) || t.rank > seen.get(k)!.rank) seen.set(k, t);
      hitScore.set(t, 0.6 * (1 - (h.pos - 1) / spec.hits!) + 0.4 * Math.min(1, Math.log10(Math.max(h.listeners, 10)) / 5));
    }
    for (const t of [...hitScore.keys()]) if (seen.get(`${t.artistId}|${normTitle(t.title)}`) !== t) hitScore.delete(t);
  }
  const base = useHits ? [...hitScore.keys()] : pool0;
  const scored = base.map((t) => ({ t, score: (useHits ? hitScore.get(t)! : near(t) + 0.8 * t.fam) + 0.4 * moodOf(t, spec.prefer) - 0.6 * moodOf(t, spec.avoid) }));
  const out: Track[] = [];
  const recentArtists: number[] = [];
  // the same artist may not come back within `window` picks; with only a few seed artists the window must stay below their count
  const window = spec.seedsOnly || useHits ? Math.max(1, Math.min(6, Math.floor(seedIds.size / 2))) : 6;
  for (let i = 0; i < spec.n; i++) {
    const cap = Math.ceil(spec.n / seedIds.size) + 1; // no seed artist dominates just because it has the most qualifying songs
    const pool = scored.filter((x) => !recentArtists.includes(x.t.artistId) && !out.includes(x.t) && out.filter((o) => o.artistId === x.t.artistId).length < cap).sort((a, b) => b.score - a.score).slice(0, 40);
    if (!pool.length) break;
    const w = pool.map((x) => Math.exp((x.score - pool[0]!.score) / 0.08));
    let r = rng() * w.reduce((a, b) => a + b, 0), k = 0;
    for (; k < w.length - 1; k++) { r -= w[k]!; if (r <= 0) break; }
    out.push(pool[k]!.t);
    recentArtists.push(pool[k]!.t.artistId);
    if (recentArtists.length > window) recentArtists.shift();
  }
  return out;
}

/** The artists behind the seed names (the catalog artist with the best-known song of that name). */
export function seedArtists(names: string[], all: Track[] = loadCatalog()): { id: number; name: string }[] {
  const out: { id: number; name: string }[] = [];
  for (const name of names) {
    const q = name.toLowerCase();
    const best = (xs: Track[]) => xs.sort((a, b) => b.fam - a.fam)[0];
    const hit = best(all.filter((t) => t.artist.toLowerCase() === q)) ?? best(all.filter((t) => t.artist.toLowerCase().includes(q)));
    if (hit) out.push({ id: hit.artistId, name: hit.artist }); else console.warn(`seed artist not in the playable catalog: ${name}`);
  }
  return out;
}

export function buildPlaylist(spec: SegmentSpec): Track[] {
  const all = loadCatalog();
  const blocked = blockedIds();
  const catalog = all.filter((t) => !blocked.has(t.id) && t.fam >= (spec.hits ? 0 : spec.minFam ?? 0) && (!spec.announce || announceable(t)) && !(spec.exclude ?? []).some((x) => x.toLowerCase() === t.artist.toLowerCase()));

  const seeds: Track[] = [];
  for (const name of spec.artists ?? []) {
    const q = name.toLowerCase();
    const byFam = (a: Track, b: Track) => b.fam - a.fam;
    const exact = all.filter((t) => t.artist.toLowerCase() === q).sort(byFam)[0];
    const loose = all.filter((t) => t.artist.toLowerCase().includes(q)).sort(byFam)[0];
    const hit = exact ?? loose;
    if (hit) seeds.push(hit); else console.warn(`seed artist not in the playable catalog: ${name}`);
  }
  const rng = mulberry32(spec.seed ?? Date.now());
  if ((spec.mode ?? "taste") === "taste" && seeds.length) return tastePlaylist(all, catalog, seeds, spec, rng);

  const p = new Profile();
  p.seed(seeds, spec.genres ?? []);

  let now = Date.now();
  const out: Track[] = [];
  const stay = cfg.stay;
  cfg.stay = false; // a listener may replay a favourite artist, a broadcast should not play 3 songs of one artist in a row
  try {
    for (let i = 0; i < spec.n; i++) {
      const { track } = pickNext(catalog, p, rng, now);
      out.push(track);
      p.record(track, "complete", track.durationMs, now);
      now += track.durationMs + 5_000; // consecutive songs: one session
    }
  } finally { cfg.stay = stay; }
  return out;
}

if (import.meta.main) {
  // bun run src/playlist.ts "Tulus,Hindia" pop 5
  const [artists = "", genres = "", n = "5"] = process.argv.slice(2);
  const list = buildPlaylist({ artists: artists.split(",").filter(Boolean), genres: genres.split(",").filter(Boolean), n: Number(n), minFam: 0.4 });
  for (const t of list) console.log(`${t.id}\t${t.artist} - ${t.title}\t${Math.round(t.durationMs / 1000)}s\tfam ${t.fam.toFixed(2)}`);
}
