// Export raw simulated play logs to CSV for manual analysis (Excel / Sheets / pandas).
// Usage: bun run export [plays=200] [seed=1]   -> out/sim-<scenario>-<taste>.csv + out/sim-all.csv
import { mkdirSync } from "node:fs";
import { mulberry32, simulate, TASTES } from "./sim.ts";

const q = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
const HEADER = "scenario,taste,play,mode,track_id,artist,title,tags,moods,listened_s,duration_s,finished,signal,spin_streak";

// Listener behaviour presets. maxFinish = cap on the chance of finishing even a loved song,
// earlySpin = share of skips that happen under 15s.
const SCENARIOS = {
  normal: { maxFinish: 0.75, earlySpin: 0.7 },
  sering_next: { maxFinish: 0.3, earlySpin: 0.85 },
} as const;

if (process.argv[2] === "--child") {
  // Child mode: sim.ts reads MAX_FINISH / EARLY_SPIN at load time, so each scenario runs in its own process.
  const [, , , scName, plays, seed] = process.argv;
  for (const [taste, profile] of Object.entries(TASTES)) {
    let streak = 0;
    simulate(taste, profile, true, mulberry32(Number(seed)), (p) => {
      streak = p.finished ? 0 : streak + 1;
      const keys = [...p.track.feats];
      const tags = keys.filter(([k]) => k.startsWith("tag:")).map(([k]) => k.slice(4)).join("|");
      const moods = keys.filter(([k]) => k.startsWith("mood:")).map(([k, v]) => `${k.slice(5)}=${v.toFixed(2)}`).join("|");
      console.log([
        q(scName!), q(taste), p.i, p.mode, p.track.id, q(p.track.artist), q(p.track.title), q(tags), q(moods),
        (p.listenedMs / 1000).toFixed(1), (p.track.durationMs / 1000).toFixed(0), p.finished ? 1 : 0, p.signal, streak,
      ].join(","));
    }, Number(plays));
  }
  process.exit(0);
}

const plays = Number(process.argv[2] ?? 200);
const seed = Number(process.argv[3] ?? 1);
mkdirSync("out", { recursive: true });
const all: string[] = [HEADER];

for (const [scName, sc] of Object.entries(SCENARIOS)) {
  const proc = Bun.spawnSync(["bun", "run", import.meta.path, "--child", scName, String(plays), String(seed)], {
    env: { ...process.env, MAX_FINISH: String(sc.maxFinish), EARLY_SPIN: String(sc.earlySpin) },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  const rows = proc.stdout.toString().trim().split("\n");
  all.push(...rows);
  for (const taste of Object.keys(TASTES)) {
    const mine = rows.filter((r) => r.startsWith(`${q(scName)},${q(taste)},`));
    await Bun.write(`out/sim-${scName}-${taste.replace(/[^a-z]+/gi, "_")}.csv`, [HEADER, ...mine].join("\n") + "\n");
  }
}
await Bun.write("out/sim-all.csv", all.join("\n") + "\n");
console.log(`wrote out/sim-all.csv (${all.length - 1} rows) + one file per scenario/taste`);
