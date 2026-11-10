// Offline replay on REAL listening logs (the `events` table): re-run each user's history through the engine and ask,
// before each play, "how high did the engine rank the track that was actually served?". AUC separates the plays the
// user finished from the ones they spun (0.5 = no better than chance).
//
// Honest limits: (1) only tracks the old engine happened to serve are scored, never the ones it did not;
// (2) few finished plays, so every number comes with a bootstrap 90% interval, read the interval, not the point;
// (3) it measures ranking of served tracks, not the effect of serving different ones.
// Usage: bun run replay [minEvents=20]
import { db } from "./db.ts";
import { cfg, loadCatalog, Profile, type Track } from "./radio.ts";

const minEvents = Number(process.argv[2] ?? 20);
const catalog = loadCatalog();
const byId = new Map(catalog.map((t) => [t.id, t]));
const base = { ...cfg };

type Ev = { track_id: number; action: string; listened_ms: number; created_at: number };
const users = (db.query("SELECT u.id, u.profile FROM users u WHERE (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id) >= ?").all(minEvents) as { id: string; profile: string }[]);

const auc = (pos: number[], neg: number[]) => {
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
};
function bootstrap(scores: number[], labels: boolean[], rounds = 400): [number, number, number] {
  const idx = scores.map((_, i) => i);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const point = auc(idx.filter((i) => labels[i]).map((i) => scores[i]!), idx.filter((i) => !labels[i]).map((i) => scores[i]!));
  const res: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const s = idx.map(() => idx[Math.floor(rnd() * idx.length)]!);
    const pos = s.filter((i) => labels[i]).map((i) => scores[i]!), neg = s.filter((i) => !labels[i]).map((i) => scores[i]!);
    if (pos.length && neg.length) res.push(auc(pos, neg));
  }
  res.sort((a, b) => a - b);
  return [point, res[Math.floor(res.length * 0.05)]!, res[Math.floor(res.length * 0.95)]!];
}

const VARIANTS: Record<string, { cfg?: Partial<typeof cfg>; score?: (t: Track) => number }> = {
  "long-term model only (engine before the session change)": { cfg: { sessW: 0 } },
  "session kNN only": { cfg: { ltW: 0 } },
  "blend (current default)": {},
  "reference: older release year": { score: (t) => -(t.year || 2015) },
  "reference: global popularity": { score: (t) => t.fam },
};

for (const u of users) {
  const evs = (db.query("SELECT track_id, action, listened_ms, created_at FROM events WHERE user_id = ? ORDER BY id").all(u.id) as Ev[]).filter((e) => byId.has(e.track_id));
  const prior = JSON.parse(u.profile).prior as [string, number][];
  const done = evs.filter((e) => e.action === "complete").length;
  console.log(`\nuser ${u.id.slice(0, 8)}: ${evs.length} plays, ${done} finished (${Math.round((100 * done) / evs.length)}%); scoring plays 11..${evs.length}`);
  for (const [name, v] of Object.entries(VARIANTS)) {
    Object.assign(cfg, base, v.cfg ?? {});
    const p = Profile.fromPrior(prior);
    const scores: number[] = [], labels: boolean[] = [];
    evs.forEach((e, i) => {
      const t = byId.get(e.track_id)!, at = e.created_at * 1000;
      if (i >= 10) { scores.push(v.score ? v.score(t) : p.meanScore(t, p.session(at))); labels.push(e.action === "complete"); }
      p.record(t, e.action as "spin" | "complete", e.listened_ms, at);
    });
    if (!labels.some(Boolean) || labels.every(Boolean)) { console.log(`  ${name}: needs both finished and spun plays`); continue; }
    const [a, lo, hi] = bootstrap(scores, labels);
    console.log(`  AUC ${a.toFixed(2)}  [90% ${lo.toFixed(2)} .. ${hi.toFixed(2)}]  ${name}`);
  }
}
Object.assign(cfg, base);
if (!users.length) console.log(`no user with >= ${minEvents} events`);
