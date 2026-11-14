// Daily frontier expansion: take the artists least recently expanded (explored_at), fetch their Deezer related
// artists, and add each new one with its top tracks. Local and international parents are expanded in a fixed ratio
// so the catalog does not drift toward one side. Children of a local parent get source 'related_id' (tags/country
// treat them as local candidates), children of an international parent get 'intl'.
// Usage: bun run explore [parents=60] [localShare=0.5]
import { db } from "./db.ts";
import * as dz from "./deezer.ts";

const parents = Number(process.argv[2] ?? 60);
const localShare = Number(process.argv[3] ?? 0.5);
const now = () => Math.floor(Date.now() / 1000);

const pick = (local: boolean, n: number) => db.query(
  `SELECT id FROM artists WHERE ${local ? "(local_seed = 1 OR country = 'ID' OR source = 'related_id')" : "local_seed = 0 AND COALESCE(country, '') <> 'ID' AND source <> 'related_id'"}
   AND tags_checked IS NOT NULL ORDER BY explored_at IS NOT NULL, explored_at ASC, fans DESC NULLS LAST LIMIT ?`,
).all(n) as { id: number }[];

const known = new Set((db.query("SELECT id FROM artists").all() as { id: number }[]).map((r) => r.id));
const insArtist = db.prepare("INSERT OR IGNORE INTO artists (id, name, fans, source, local_seed, updated_at) VALUES (?, ?, ?, ?, 0, ?)");
const upTrack = db.prepare(
  `INSERT INTO tracks (id, artist_id, title, rank, duration, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
   ON CONFLICT(id) DO UPDATE SET title = ?3, rank = ?4, duration = ?5, updated_at = ?6`,
);
const mark = db.prepare("UPDATE artists SET explored_at = ? WHERE id = ?");

let added = 0;
const run = async (list: { id: number }[], source: string) => {
  for (const p of list) {
    try {
      for (const r of await dz.relatedArtists(p.id, 10)) {
        if (known.has(r.id)) continue;
        const tracks = await dz.artistTop(r.id, 30);
        if (!tracks.length) continue;
        known.add(r.id);
        db.transaction(() => {
          insArtist.run(r.id, r.name, r.nb_fan ?? null, source, now());
          for (const t of tracks) {
            insArtist.run(t.artist.id, t.artist.name, null, source, now());
            upTrack.run(t.id, t.artist.id, t.title, t.rank ?? null, t.duration ?? null, now());
          }
        })();
        added++;
      }
      mark.run(now(), p.id);
    } catch (e) { console.warn(`explore ${p.id}:`, (e as Error).message); }
  }
};
const nLocal = Math.round(parents * localShare);
await run(pick(true, nLocal), "related_id");
await run(pick(false, parents - nLocal), "intl");
console.log(`explore: ${added} new artists`);
