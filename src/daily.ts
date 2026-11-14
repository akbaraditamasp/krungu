// One-command daily growth job. Every step is incremental/resumable, so a failed step never blocks the rest.
// Usage: bun run daily      Log: logs/daily-YYYY-MM-DD.log
// Schedule (Windows, 09:00): schtasks /Create /SC DAILY /ST 09:00 /TN KrunguDaily /TR "cmd /c cd /d D:\private\krungu && bun run daily"
import { mkdirSync, appendFileSync } from "node:fs";

mkdirSync("logs", { recursive: true });
const log = `logs/daily-${new Date().toISOString().slice(0, 10)}.log`;
const say = (s: string) => { console.log(s); appendFileSync(log, s + "\n"); };

const steps: [string, string[]][] = [
  ["new releases + discovery", ["run", "src/refresh.ts", "150"]],   // 150 least-recently scanned local artists per day
  ["frontier expansion", ["run", "src/explore.ts", "60", "0.5"]],
  ["country", ["run", "src/country.ts"]],
  ["tags", ["run", "src/enrich-tags.ts"]],
  ["years (new rows)", ["run", "src/years.ts", "1500"]],
  ["clean", ["run", "src/clean.ts"]],
  ["moods", ["run", "src/moods.ts"]],
];
for (const [name, args] of steps) {
  const t0 = Date.now();
  say(`\n== ${name} (${new Date().toISOString()})`);
  const p = Bun.spawn(["bun", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  appendFileSync(log, out + err);
  say(`${code === 0 ? "ok" : "FAILED (" + code + ")"} in ${Math.round((Date.now() - t0) / 1000)}s: ${out.trim().split("\n").slice(-2).join(" | ")}`);
}
const q = (sql: string) => (Bun.spawnSync(["bun", "-e", `import {db} from "./src/db.ts";console.log(JSON.stringify(db.query(${JSON.stringify(sql)}).get()))`]).stdout.toString().trim());
say("\ncatalog: " + q("SELECT COUNT(*) playable, SUM(a.local_seed) local, SUM(t.year >= strftime('%Y','now')-1) recent FROM tracks t JOIN artists a ON a.id = t.artist_id WHERE t.playable = 1"));
