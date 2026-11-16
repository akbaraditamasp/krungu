// Song popularity from Last.fm `artist.getTopTracks` (real listener counts), cached in `lfm_top_tracks`.
//   bun run pop "The Changcuters,Sheila On 7"   fetch (or refresh) the top 50 songs of these artists and print the top 10
// Why: Deezer's `tracks.rank` is useless as popularity here: 47% of all tracks sit exactly on 100000 (a ceiling/default), so for
// The Changcuters it ranked "Tangguh" and "Raharja" above Racun Dunia and I Love U Bibeh (owner: "I know none of these songs").
// Last.fm is per artist, matched to catalog tracks by normalized title ("(Album Version)", "- Remastered" etc. are stripped).
import { db } from "./db.ts";

db.run(`CREATE TABLE IF NOT EXISTS lfm_top_tracks (
  artist_id INTEGER NOT NULL,
  title_norm TEXT NOT NULL,
  title TEXT NOT NULL,
  listeners INTEGER NOT NULL,
  pos INTEGER NOT NULL,            -- 1 = the artist's most listened song on Last.fm
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (artist_id, title_norm)
)`);

export const normTitle = (t: string) =>
  t.toLowerCase().normalize("NFKD").replace(/[\(\[][^\)\]]*[\)\]]/g, " ").replace(/\s+-\s+.*$/, "").replace(/[^a-z0-9]+/g, " ").trim();

export type Hit = { listeners: number; pos: number };

/** Cached top songs of an artist, keyed by normalized title. Empty map = nothing cached (run ensurePop first). */
export function hitsOf(artistId: number, top: number): Map<string, Hit> {
  const rows = db.query("SELECT title_norm, listeners, pos FROM lfm_top_tracks WHERE artist_id = ? AND pos <= ?").all(artistId, top) as
    { title_norm: string; listeners: number; pos: number }[];
  return new Map(rows.map((r) => [r.title_norm, { listeners: r.listeners, pos: r.pos }]));
}

/** Fetch the top 50 songs for artists whose cache is missing or older than `maxAgeDays`. Only artist names leave the machine. */
export async function ensurePop(artists: { id: number; name: string }[], maxAgeDays = 30): Promise<void> {
  const key = process.env.LASTFM_API_KEY;
  const fresh = db.query("SELECT MAX(fetched_at) t FROM lfm_top_tracks WHERE artist_id = ?");
  for (const a of artists) {
    const last = (fresh.get(a.id) as { t: number | null }).t;
    if (last && Date.now() / 1000 - last < maxAgeDays * 86400) continue;
    if (!key) { console.warn(`no LASTFM_API_KEY: cannot fetch popularity for ${a.name}`); continue; }
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.gettoptracks&artist=${encodeURIComponent(a.name)}&limit=50&autocorrect=1&format=json&api_key=${key}`;
    const j: any = await fetch(url).then((r) => r.json()).catch(() => null);
    const tracks: any[] = j?.toptracks?.track ?? [];
    if (!tracks.length) { console.warn(`Last.fm has no top tracks for ${a.name}`); continue; }
    db.run("DELETE FROM lfm_top_tracks WHERE artist_id = ?", [a.id]);
    const ins = db.prepare("INSERT OR IGNORE INTO lfm_top_tracks VALUES (?, ?, ?, ?, ?, ?)");
    tracks.forEach((t, i) => ins.run(a.id, normTitle(t.name), t.name, Number(t.listeners) || 0, i + 1, Math.floor(Date.now() / 1000)));
    await Bun.sleep(250); // Last.fm rate limit
  }
}

// bun run pop:all [--refresh]   every local artist that has playable songs (~700, about 4 minutes, resumable: artists fetched in the
// last 30 days are skipped unless --refresh). Needs LASTFM_API_KEY in .env; only artist names are sent to Last.fm.
if (import.meta.main && process.argv[2] === "all") {
  const force = process.argv.includes("--refresh");
  const artists = db.query(
    `SELECT a.id, a.name FROM artists a WHERE a.local_seed = 1 AND EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id AND t.playable = 1) ORDER BY a.id`,
  ).all() as { id: number; name: string }[];
  console.log(`${artists.length} local artists with playable songs${force ? " (refreshing all)" : ""}`);
  const t0 = Date.now();
  let i = 0;
  for (const a of artists) {
    await ensurePop([a], force ? 0 : 30);
    if (++i % 25 === 0 || i === artists.length) {
      const left = Math.round(((Date.now() - t0) / i) * (artists.length - i) / 1000);
      console.log(`${i}/${artists.length}  (~${left}s left)`);
    }
  }
  const n = db.query("SELECT COUNT(DISTINCT artist_id) n FROM lfm_top_tracks").get() as { n: number };
  console.log(`done: ${n.n} artists have Last.fm popularity cached`);
} else if (import.meta.main) {
  const { seedArtists } = await import("./playlist.ts");
  const names = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const arts = seedArtists(names);
  await ensurePop(arts);
  for (const a of arts) {
    const rows = db.query("SELECT title, listeners FROM lfm_top_tracks WHERE artist_id = ? ORDER BY pos LIMIT 10").all(a.id) as { title: string; listeners: number }[];
    console.log(`${a.name}: ${rows.map((r) => `${r.title} (${r.listeners})`).join(" | ") || "none"}`);
  }
}
