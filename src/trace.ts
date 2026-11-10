// Print the simulated play order so you can read it like a radio log.
// Usage: bun run trace [tasteIndex=0] [plays=40] [seed=1]     (NO_ONBOARDING=1 for pure cold start)
import { catalog, mulberry32, simulate, TASTES } from "./sim.ts";

const names = Object.keys(TASTES);
const idx = Number(process.argv[2] ?? 0);
const plays = Number(process.argv[3] ?? 40);
const seed = Number(process.argv[4] ?? 1);
const name = names[idx];
if (!name) { console.log("taste index 0-" + (names.length - 1) + ":", names.map((n, i) => `${i}=${n}`).join(", ")); process.exit(1); }

const log: string[] = [];
let streak = 0, maxStreak = 0, explores = 0, finished = 0;
const res = simulate(name, TASTES[name]!, true, mulberry32(seed), (p) => {
  const verdict = p.finished ? "✓ selesai" : `✗ spin @${(p.listenedMs / 1000).toFixed(0)}s`;
  streak = p.finished ? 0 : streak + 1;
  maxStreak = Math.max(maxStreak, streak);
  if (p.mode === "explore") explores++;
  if (p.finished) finished++;
  const tags = [...p.track.feats.keys()].filter((k) => k.startsWith("tag:")).slice(0, 3).map((k) => k.slice(4)).join("/");
  log.push(
    `${String(p.i).padStart(3)} ${p.mode === "explore" ? "?" : " "} ${(p.track.artist + " - " + p.track.title).slice(0, 52).padEnd(52)} ${verdict.padEnd(12)} ${tags}`,
  );
}, plays);

console.log(`Selera tersembunyi: ${name}   (onboarding: ${res.favNames.join(", ") || "tidak ada"})`);
console.log(`Katalog: ${catalog.length} lagu | "?" = putaran eksplorasi | seed ${seed}\n`);
console.log("  # E Lagu                                                 Hasil        Tag artis");
console.log(log.join("\n"));
console.log(`
Ringkasan: selesai ${finished}/${plays} (${Math.round((finished / plays) * 100)}%), spin beruntun terpanjang ${maxStreak}, eksplorasi ${explores}/${plays}`);
