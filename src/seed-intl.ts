// Balance the catalog with international music: Deezer genre charts (tracks + artists) plus data/intl-artists.txt
// and their related artists. Artists get source 'intl' (local_seed stays 0). Rerun anytime; upserts only.
// Usage: bun run seed:intl [maxArtists=250]
import { db } from "./db.ts";
import * as dz from "./deezer.ts";

const maxArtists = Number(process.argv[2] ?? 250);
const now = () => Math.floor(Date.now() / 1000);
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

const insArtist = db.prepare("INSERT OR IGNORE INTO artists (id, name, fans, source, updated_at) VALUES (?, ?, ?, 'intl', ?)");
const upTrack = db.prepare(
  `INSERT INTO tracks (id, artist_id, title, rank, duration, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
   ON CONFLICT(id) DO UPDATE SET title = ?3, rank = ?4, duration = ?5, updated_at = ?6`,
);
const save = (tracks: dz.DzTrack[]) => db.transaction(() => {
  for (const t of tracks) {
    insArtist.run(t.artist.id, t.artist.name, null, now());
    upTrack.run(t.id, t.artist.id, t.title, t.rank ?? null, t.duration ?? null, now());
  }
})();

const queue: number[] = [];
const seen = new Set((db.query("SELECT id FROM artists WHERE source = 'intl' OR local_seed = 1").all() as { id: number }[]).map((r) => r.id));
const enqueue = (id: number) => { if (!seen.has(id)) { seen.add(id); queue.push(id); } };

// 1. genre charts (skip "All" = 0; genre 0 is covered by seed.ts)
for (const g of await dz.genres()) {
  if (g.id === 0 || /kids|indian|brazil|african|films|games|classical|opera|comedy|spiritual|christian/i.test(g.name)) continue;
  try {
    save(await dz.genreChartTracks(g.id));
    for (const a of await dz.genreChartArtists(g.id)) enqueue(a.id);
    console.log(`genre ${g.name}`);
  } catch (e) { console.warn(`genre ${g.id}:`, (e as Error).message); }
}

// 2. curated international artists
const file = Bun.file("data/intl-artists.txt");
const names = (await file.exists() ? (await file.text()).split("\n") : []).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
for (const name of names) {
  try {
    const hit = (await dz.searchArtist(name)).filter((h) => norm(h.name) === norm(name)).sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0];
    if (hit) { insArtist.run(hit.id, hit.name, hit.nb_fan ?? null, now()); queue.unshift(hit.id); seen.add(hit.id); }
    else console.log("not matched:", name);
  } catch (e) { console.warn(`${name}:`, (e as Error).message); }
}

// 3. top tracks per artist, related artists feed the queue until the cap
let done = 0;
while (queue.length && done < maxArtists) {
  const id = queue.shift()!;
  try {
    save(await dz.artistTop(id, 30));
    if (queue.length < maxArtists) for (const r of await dz.relatedArtists(id, 5)) enqueue(r.id);
  } catch (e) { console.warn(`artist ${id}:`, (e as Error).message); }
  if (++done % 25 === 0) console.log(`${done} artists`);
}
const n = db.query("SELECT COUNT(*) n FROM artists WHERE source = 'intl'").get() as { n: number };
console.log(`intl artists in db: ${n.n}. Next: bun run tags && bun run clean && bun run moods`);
