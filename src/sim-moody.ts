// Compare engine variants on a mood-switching listener (see simulateMoody in sim.ts).
// Usage: bun run sim:moody [seeds=8] [plays=400]   (MAX_FINISH / EARLY_SPIN env work as in sim.ts)
import { cfg } from "./radio.ts";
import { mulberry32, simulateMoody } from "./sim.ts";

const seeds = Number(process.argv[2] ?? 8), plays = Number(process.argv[3] ?? 400);
const base = { ...cfg };
const only = process.argv[4]; // optional substring filter on variant names
const VARIANTS: Record<string, Partial<typeof cfg>> = {
  "old: long-term only (no session, stay, probe)": { sessW: 0, stay: false, probe: false },
  "+ session kNN only": { stay: false, probe: false },
  "+ stay only": { sessW: 0, probe: false },
  "+ probe only": { sessW: 0, stay: false },
  "all on (default)": {},
  "all on, long-term weight 0.5": { ltW: 0.5 },
  "all on, session weight 0.5": { sessW: 0.5 },
  "all on, no anchor (previous default)": { anchorW: 0, anchorAlpha: 1 },
  "all on, negatives x0.3": { sessNeg: 0.3 },
  "all on, negatives x0 (finishes only)": { sessNeg: 0 },
  "all on, weight 0.75, negatives x0.3": { sessW: 0.75, sessNeg: 0.3 },
};
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const run = (label: string, radio: boolean) => {
  const r = Array.from({ length: seeds }, (_, s) => simulateMoody(mulberry32(s + 1), radio, plays));
  console.log(`${label.padEnd(48)} overall ${pct(mean(r.map((x) => x.overall)))}   first 8 after a mood switch ${pct(mean(r.map((x) => x.early)))}   later ${pct(mean(r.map((x) => x.late)))}`);
};
run("random baseline", false);
for (const [label, v] of Object.entries(VARIANTS)) {
  if (only && !label.includes(only) && !label.startsWith("old")) continue; Object.assign(cfg, base, v); run(label, true); }
