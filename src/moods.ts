// Maps Last.fm tags -> a handful of moods. Pure local recompute: `bun run moods` (no API calls),
// so the keyword table can be tuned freely without refetching tags.
import { db } from "./db.ts";

export const MOODS = ["energetic", "chill", "sad", "romantic", "happy", "party"] as const;
export type Mood = (typeof MOODS)[number];

// Substring keywords per mood. Genre tags are weaker hints than explicit mood tags.
const KEYWORDS: Record<Mood, { kw: string; w: number }[]> = {
  energetic: [{ kw: "energetic", w: 1 }, { kw: "hard rock", w: 0.7 }, { kw: "metal", w: 0.6 }, { kw: "punk", w: 0.7 }, { kw: "hardcore", w: 0.6 }, { kw: "drum and bass", w: 0.6 }, { kw: "workout", w: 0.9 }, { kw: "trap", w: 0.5 }],
  chill: [{ kw: "chill", w: 1 }, { kw: "mellow", w: 1 }, { kw: "relax", w: 1 }, { kw: "ambient", w: 0.8 }, { kw: "acoustic", w: 0.7 }, { kw: "lo-fi", w: 0.8 }, { kw: "lofi", w: 0.8 }, { kw: "indie folk", w: 0.6 }, { kw: "folk", w: 0.4 }, { kw: "easy listening", w: 0.8 }, { kw: "bossa", w: 0.6 }],
  sad: [{ kw: "sad", w: 1 }, { kw: "melanchol", w: 1 }, { kw: "heartbreak", w: 1 }, { kw: "galau", w: 1 }, { kw: "depress", w: 0.9 }, { kw: "emo", w: 0.6 }, { kw: "slowcore", w: 0.7 }, { kw: "sadcore", w: 0.9 }, { kw: "ballad", w: 0.5 }],
  romantic: [{ kw: "romantic", w: 1 }, { kw: "love", w: 0.8 }, { kw: "cinta", w: 0.8 }, { kw: "r&b", w: 0.5 }, { kw: "rnb", w: 0.5 }, { kw: "soul", w: 0.4 }, { kw: "slow", w: 0.4 }],
  happy: [{ kw: "happy", w: 1 }, { kw: "feel good", w: 1 }, { kw: "feelgood", w: 1 }, { kw: "upbeat", w: 0.9 }, { kw: "cheerful", w: 0.9 }, { kw: "fun", w: 0.6 }, { kw: "summer", w: 0.6 }, { kw: "k-pop", w: 0.4 }, { kw: "j-pop", w: 0.4 }, { kw: "pop", w: 0.3 }],
  party: [{ kw: "party", w: 1 }, { kw: "dance", w: 0.9 }, { kw: "club", w: 0.9 }, { kw: "edm", w: 0.8 }, { kw: "electronic", w: 0.5 }, { kw: "house", w: 0.6 }, { kw: "dangdut", w: 0.7 }, { kw: "koplo", w: 0.9 }, { kw: "reggaeton", w: 0.7 }, { kw: "hip-hop", w: 0.4 }, { kw: "hip hop", w: 0.4 }],
};

export function moodScores(tags: { tag: string; weight: number }[]): Record<Mood, number> {
  const raw = Object.fromEntries(MOODS.map((m) => [m, 0])) as Record<Mood, number>;
  for (const { tag, weight } of tags) {
    for (const m of MOODS) {
      // best matching keyword per tag, so one tag never counts twice within a mood
      const w = Math.max(0, ...KEYWORDS[m].filter((k) => tag.includes(k.kw)).map((k) => k.w));
      raw[m] += (weight / 100) * w;
    }
  }
  // absolute scale (not relative to the artist best mood): a lone weak "pop" tag stays weak
  for (const m of MOODS) raw[m] = raw[m] < 0.15 ? 0 : +Math.min(1, raw[m]).toFixed(3);
  return raw;
}

if (import.meta.main) {
  const ids = db.query("SELECT DISTINCT artist_id id FROM artist_tags").all() as { id: number }[];
  const getTags = db.query("SELECT tag, weight FROM artist_tags WHERE artist_id = ?");
  const put = db.prepare("INSERT OR REPLACE INTO artist_moods (artist_id, mood, score) VALUES (?, ?, ?)");
  db.transaction(() => {
    db.run("DELETE FROM artist_moods");
    for (const { id } of ids) {
      const scores = moodScores(getTags.all(id) as any);
      for (const m of MOODS) if (scores[m] > 0) put.run(id, m, scores[m]);
    }
  })();
  console.log(`recomputed moods for ${ids.length} artists`);
}
