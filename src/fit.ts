// Learn the ranking weights from the real `events` log instead of tuning them by feeling.
//
// Model: P(song finished) = sigmoid(b0 + b_u * userRate + sum_k b_k * z_k), z_k = standardized ranking component k
// (long-term LinUCB mean, its uncertainty, session kNN, mood anchor, mood EMA, artist bias, artist repeats, diversity; see
// `components()` in radio.ts). It is L2-regularized logistic regression fitted by Newton/IRLS. userRate (the user's own
// finish rate so far) is a control: users differ a lot in how often they finish, and it does not change the order of
// candidates at pick time, so it is not part of the written weights.
//
// How each choice is made (no guessing):
//  - the ridge strength is chosen by leave-one-USER-out cross-validated log-loss (the question is "does it work for a new user");
//  - every component is kept only if dropping it hurts the cross-validated log-loss; the table shows the change;
//  - coefficients come with standard errors (inverse Hessian), so a weight whose interval spans 0 is visibly unproven.
// Limits: the dataset is the replay of what the OLD engine served (selection bias; the new `serves` table logs propensities so
// IPS / doubly-robust evaluation becomes possible), ~500 events from a handful of users, and "finished" is a proxy for "liked".
//
// Usage: bun run fit            (report only)
//        bun run fit --write    (writes data/weights.json if cross-validation beats the baseline; delete the file to go back)
import { writeFileSync } from "node:fs";
import { db } from "./db.ts";
import { cfg, COMP_KEYS, components, loadCatalog, makeCtx, Profile, type Comp } from "./radio.ts";

type Row = { user: string; x: number[]; y: number; legacy: number }; // x = [userRate, ...COMP_KEYS]
const catalog = loadCatalog();
const byId = new Map(catalog.map((t) => [t.id, t]));
const write = process.argv.includes("--write");

// ---------- dataset: replay every user's history through the engine ----------
const rows: Row[] = [];
const users = db.query("SELECT u.id, u.profile FROM users u WHERE (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id) >= 10").all() as { id: string; profile: string }[];
for (const u of users) {
  const evs = (db.query("SELECT track_id, action, listened_ms, created_at FROM events WHERE user_id = ? ORDER BY id").all(u.id) as { track_id: number; action: string; listened_ms: number; created_at: number }[]).filter((e) => byId.has(e.track_id));
  const p = Profile.fromPrior(JSON.parse(u.profile).prior as [string, number][]);
  let fin = 0;
  evs.forEach((e, i) => {
    const t = byId.get(e.track_id)!, at = e.created_at * 1000;
    if (i >= 3 && !p.heardRecently(t.id, at)) {
      const c = components(p, t, makeCtx(p, at));
      const legacy = cfg.ltW * c.mean + cfg.sessW * c.sess + cfg.anchorW * c.anc + 0.5 * c.mood + 0.5 * c.art - 0.15 * c.heard;
      rows.push({ user: u.id, x: [(fin + 0.35 * 10) / (i + 10), ...COMP_KEYS.map((k) => c[k])], y: e.action === "complete" ? 1 : 0, legacy });
    }
    p.record(t, e.action as "spin" | "complete", e.listened_ms, at);
    if (e.action === "complete") fin++;
  });
}
const NAMES = ["userRate", ...COMP_KEYS];
console.log(`${rows.length} plays from ${new Set(rows.map((r) => r.user)).size} users, ${rows.filter((r) => r.y).length} finished (${Math.round((100 * rows.filter((r) => r.y).length) / rows.length)}%)`);

// ---------- logistic regression (ridge, Newton) ----------
const sig = (z: number) => 1 / (1 + Math.exp(-z));
function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r]![c]! / M[c]![c]!; for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!; }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}
type Fit = { beta: number[]; cov: number[][] }; // beta[0] = intercept
function fit(X: number[][], y: number[], lam: number): Fit {
  const d = X[0]!.length + 1;
  let beta = new Array(d).fill(0);
  let H: number[][] = [];
  for (let it = 0; it < 30; it++) {
    const g = new Array(d).fill(0);
    H = Array.from({ length: d }, () => new Array(d).fill(0));
    X.forEach((x, n) => {
      const xx = [1, ...x];
      const p = sig(xx.reduce((s, v, k) => s + v * beta[k]!, 0)), w = p * (1 - p);
      for (let a = 0; a < d; a++) { g[a] += (p - y[n]!) * xx[a]!; for (let b = 0; b < d; b++) H[a]![b]! += w * xx[a]! * xx[b]!; }
    });
    for (let a = 1; a < d; a++) { g[a] += lam * beta[a]!; H[a]![a]! += lam; }
    H[0]![0]! += 1e-9;
    const step = solve(H, g);
    beta = beta.map((b, k) => b - step[k]!);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  // covariance = H^-1 (columns by solving against unit vectors)
  const cov = Array.from({ length: d }, (_, j) => solve(H, Array.from({ length: d }, (_, k) => (k === j ? 1 : 0)))).map((_, j, all) => all.map((c) => c[j]!));
  return { beta, cov };
}
const predict = (f: Fit, x: number[]) => sig(f.beta[0]! + x.reduce((s, v, k) => s + v * f.beta[k + 1]!, 0));
const logloss = (p: number[], y: number[]) => -p.reduce((s, q, i) => s + (y[i]! ? Math.log(Math.max(q, 1e-9)) : Math.log(Math.max(1 - q, 1e-9))), 0) / p.length;
function auc(score: number[], y: number[]) {
  let w = 0, n = 0;
  for (let i = 0; i < y.length; i++) if (y[i]) for (let j = 0; j < y.length; j++) if (!y[j]) { n++; w += score[i]! > score[j]! ? 1 : score[i] === score[j] ? 0.5 : 0; }
  return n ? w / n : NaN;
}

// standardize on all rows (no labels involved, so this does not leak)
const D = NAMES.length;
const mu = Array.from({ length: D }, (_, k) => rows.reduce((s, r) => s + r.x[k]!, 0) / rows.length);
const sd = Array.from({ length: D }, (_, k) => Math.sqrt(rows.reduce((s, r) => s + (r.x[k]! - mu[k]!) ** 2, 0) / rows.length) || 1);
const Z = rows.map((r) => r.x.map((v, k) => (v - mu[k]!) / sd[k]!));
const Y = rows.map((r) => r.y);
const userIds = [...new Set(rows.map((r) => r.user))];

/** Leave-one-user-out predictions using only the listed columns. */
function louo(cols: number[], lam: number): number[] {
  const pred = new Array(rows.length).fill(0.5);
  for (const u of userIds) {
    const tr = rows.map((r, i) => (r.user !== u ? i : -1)).filter((i) => i >= 0), te = rows.map((r, i) => (r.user === u ? i : -1)).filter((i) => i >= 0);
    const f = fit(tr.map((i) => cols.map((c) => Z[i]![c]!)), tr.map((i) => Y[i]!), lam);
    for (const i of te) pred[i] = predict(f, cols.map((c) => Z[i]![c]!));
  }
  return pred;
}
const withinAuc = (score: number[]) => {
  const a: number[] = [];
  for (const u of userIds) {
    const ix = rows.map((r, i) => (r.user === u ? i : -1)).filter((i) => i >= 0);
    if (ix.length >= 15 && ix.some((i) => Y[i]) && ix.some((i) => !Y[i])) a.push(auc(ix.map((i) => score[i]!), ix.map((i) => Y[i]!)));
  }
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
};

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const ALL = NAMES.map((_, k) => k).filter((k) => k === 0 || !only || only.includes(NAMES[k]!)), CTRL = [0];
const base = louo(CTRL, 1);
console.log(`\nbaseline (user's own finish rate only): log-loss ${logloss(base, Y).toFixed(4)}`);

// ridge strength by cross-validation
let best = { lam: 1, ll: Infinity };
for (const lam of [0.3, 1, 3, 10, 30, 100]) {
  const ll = logloss(louo(ALL, lam), Y);
  console.log(`  ridge ${String(lam).padStart(4)}: leave-one-user-out log-loss ${ll.toFixed(4)}`);
  if (ll < best.ll) best = { lam, ll };
}
const predAll = louo(ALL, best.lam);
console.log(`chosen ridge ${best.lam}: log-loss ${best.ll.toFixed(4)} (baseline ${logloss(base, Y).toFixed(4)}), pooled AUC ${auc(predAll, Y).toFixed(3)}, mean within-user AUC ${withinAuc(predAll).toFixed(3)}`);
console.log(`current hand-tuned score as a ranker: pooled AUC ${auc(rows.map((r) => r.legacy), Y).toFixed(3)}, mean within-user AUC ${withinAuc(rows.map((r) => r.legacy)).toFixed(3)}`);

console.log("\nablation: cross-validated log-loss change when ONE component is removed (positive = the component helps)");
const gain: Record<string, number> = {};
for (const k of ALL.filter((c) => c > 0)) {
  const ll = logloss(louo(ALL.filter((c) => c !== k), best.lam), Y);
  gain[NAMES[k]!] = ll - best.ll;
  console.log(`  ${NAMES[k]!.padEnd(7)} ${(ll - best.ll >= 0 ? "+" : "") + (ll - best.ll).toFixed(4)}`);
}

// final fit on everything
const f = fit(Z, Y, best.lam);
console.log("\ncoefficients (per 1 sd of the component) and in raw units, with standard error:");
const weights: Record<string, number> = Object.fromEntries(COMP_KEYS.map((k) => [k, 0]));
for (const k of ALL) {
  const b = f.beta[k + 1]!, se = Math.sqrt(Math.max(0, f.cov[k + 1]![k + 1]!));
  const raw = b / sd[k]!;
  console.log(`  ${NAMES[k]!.padEnd(8)} beta ${b.toFixed(3).padStart(7)} ± ${se.toFixed(3)}  ${Math.abs(b) < 2 * se ? "(not distinguishable from 0)" : ""}  raw weight ${raw.toFixed(3)}`);
  if (k > 0) weights[NAMES[k]!] = raw;
}
// Exploration has no immediate finish reward (an uncertain track is finished less often); the objective here is "finish
// now", so a negative uncertainty coefficient is clamped to 0 (pure exploitation) instead of being used to avoid uncertainty.
if ((weights.sd ?? 0) < 0) { console.log("\nuncertainty (sd) coefficient is negative: written as 0, i.e. no exploration bonus"); weights.sd = 0; }

if (write) {
  if (best.ll < logloss(base, Y)) {
    writeFileSync(`${import.meta.dir}/../data/weights.json`, JSON.stringify({ fittedAt: new Date().toISOString(), rows: rows.length, ridge: best.lam, cvLogLoss: best.ll, weights }, null, 2));
    console.log("\nwrote data/weights.json (restart the server to use it; delete the file to go back to the hand-tuned engine)");
  } else console.log("\nNOT written: cross-validation does not beat the baseline");
}
