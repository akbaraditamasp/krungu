// Core of the product: pick the next track from implicit feedback only (no like button, no search).
// Pure in-memory logic over the SQLite catalog, so it is easy to test with src/sim.ts.
//
// Method (what is principled and what is not):
//  - Selection is LinUCB (Li, Chu, Langford & Schapire, WWW 2010): ridge regression of reward on track features,
//    score = theta.x + alpha * sqrt(x' A^-1 x). The second term is the uncertainty bonus; it replaces epsilon-greedy.
//  - Onboarding is a Gaussian prior on theta (ridge toward theta0 instead of toward 0). It fades through A automatically
//    as data arrives, replacing the hand-written 1/(1+plays/30) weight.
//  - Era (release-year bucket) is just another feature, motivated by the reminiscence bump (Holbrook & Schindler 1989;
//    the peak age is disputed, ~17-23). No age is guessed or asked.
//  - Mood of the moment (owner: "I listen to every genre, it depends on my mood right now"): taste is treated as
//    non-stationary. On top of the slow long-term model there is a SESSION term: a kernel/kNN score over the last ~15 plays
//    with exponential forgetting (session-based nearest neighbours, Ludewig & Jannach 2018, which found such simple methods
//    competitive; forgetting in the spirit of discounted UCB, Garivier & Moulines 2011; Hansen et al. RecSys 2020 report that
//    recent/session context predicts better than static preferences). A finish pulls similar tracks up ("stay"), a spin pushes
//    them down. At session start, or after a run of spins, picks are diversified (MMR-style, Carbonell & Goldstein 1998) so the
//    mood is found in few spins. Applying forgetting this way (kNN instead of a discounted LinUCB) is my adaptation.
//  - NOT derived from theory (tuned in src/sim.ts): the reward mapping in signal()/record(), LAMBDA, ALPHA, ERA_W, FAM_W,
//    the session weights (SESS_W, gamma, artist bonus), the mood-EMA term, the artist bias, the softmax temperature, the
//    artist-variety rules and the probing threshold.
import { db } from "./db.ts";

export type Track = {
  id: number; artistId: number; artist: string; title: string;
  durationMs: number; local: boolean;
  year: number; artistYear: number;   // release year of this track / median of the artist's tracks (0 = unknown)
  rank: number; fam: number;          // Deezer popularity / "how likely is this a song the listener knows" in [0, 1]
  feats: Map<string, number>;         // "tag:pop" / "mood:sad" / "era:2005" -> weight (tags+moods L2-normalized, era added after)
  x: { i: Int32Array; v: Float64Array }; // the same features restricted to the LinUCB vocabulary (sparse)
  u: { i: Int32Array; v: Float64Array }; // unit-norm sparse vector (tags+moods+era, no popularity), sorted by index: session similarity
};
export type Rng = () => number;

const num = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
/** Mutable on purpose: src/sim.ts and src/replay.ts switch parts on and off to compare variants. */
export const cfg = {
  ltW: num("LT_W", 1),            // weight of the long-term LinUCB mean (0 = ignore long-term taste)
  sessW: num("SESS_W", 0.25),     // weight of the session kNN term (0 = off)
  sessGamma: num("SESS_GAMMA", 0.85), // forgetting per play inside a session
  sessArtist: num("SESS_ARTIST", 0.5), // extra similarity when two plays share the artist
  sessNeg: num("SESS_NEG", 1),    // scale of NEGATIVE session signals (0 = only finishes count; a spin is weak evidence for a heavy spinner)
  stay: num("STAY", 1) === 1,     // an artist whose last play was finished may come back before the 8-play block ends
  probe: num("PROBE", 1) === 1,   // diversify picks at session start / after a run of negatives
  divW: num("DIV_W", 0.5),        // diversity penalty strength while probing
  gapMs: 30 * 60_000,             // silence longer than this starts a new session
};

// ---------- feature vocabulary (LinUCB dimension) ----------

const TOP_TAGS = 100;      // keep the model small: 100 tags cover ~80% of tag weight in the current catalog
const ERA_W = 0.6;         // era feature scale relative to the L2-normalized tag vector (tuned)
const FAM_W = 0.6;         // familiarity feature scale (tuned)
const FAM_PRIOR = 1;       // prior mean: most listeners prefer songs they know (popularity prior); the user's own plays override it
const ERA_STARTS = [1990, 1995, 2000, 2005, 2010, 2015, 2020]; // buckets: <1990, then 5-year steps, 2020+
const ERA_KEYS = ["era:pre1990", ...ERA_STARTS.map((y) => `era:${y}`)].filter((k, i, a) => a.indexOf(k) === i);
export let VOCAB: string[] = [];
let INDEX = new Map<string, number>();

/** Soft one-hot over era buckets: the own bucket counts 1, neighbours 0.4, so adjacent eras share what is learned. */
export function eraFeats(year: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!(year > 0)) return out;
  const b = year < 1990 ? 0 : Math.min(ERA_KEYS.length - 1, 1 + Math.floor((year - 1990) / 5));
  for (const [d, w] of [[0, 1], [-1, 0.4], [1, 0.4]] as const) {
    const k = ERA_KEYS[b + d];
    if (k) out.set(k, w);
  }
  return out;
}

// ---------- catalog ----------

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };

export function loadCatalog(): Track[] {
  const feats = new Map<number, Map<string, number>>();
  const add = (id: number, key: string, w: number) => {
    if (!feats.has(id)) feats.set(id, new Map());
    feats.get(id)!.set(key, w);
  };
  for (const r of db.query("SELECT artist_id a, tag, weight w FROM artist_tags").all() as any[]) add(r.a, `tag:${r.tag}`, r.w / 100);
  // mood scores count a bit less than raw tags: they are derived, tags are observed
  for (const r of db.query("SELECT artist_id a, mood, score s FROM artist_moods").all() as any[]) add(r.a, `mood:${r.mood}`, r.s * 0.7);

  const rows = db.query(
    // yr = earliest known year among copies of the same song by the artist (reissues/compilations are dated later)
    `SELECT t.id, t.artist_id a, a.name artist, t.title, COALESCE(t.duration, 200) dur, a.local_seed ls, COALESCE(t.rank, 0) rk,
            COALESCE((SELECT MIN(t2.year) FROM tracks t2 WHERE t2.artist_id = t.artist_id AND lower(t2.title) = lower(t.title) AND t2.year > 0), 0) yr
     FROM tracks t JOIN artists a ON a.id = t.artist_id WHERE t.playable = 1`,
  ).all() as any[];

  // familiarity = half "how much of a hit is it within its artist" (percentile), half global popularity (log scale):
  // the first separates hits from deep cuts of the same artist, the second keeps a small artist's best song from looking famous
  const ranksByArtist = new Map<number, number[]>();
  for (const r of rows) (ranksByArtist.get(r.a) ?? ranksByArtist.set(r.a, []).get(r.a)!).push(r.rk);
  const famOf = (a: number, rk: number) => {
    const rs = ranksByArtist.get(a)!;
    const pct = rs.length > 1 ? rs.filter((x) => x < rk).length / (rs.length - 1) : 0.5;
    const glob = Math.min(1, Math.max(0, Math.log10(Math.max(rk, 10)) / 6));
    return 0.5 * pct + 0.5 * glob;
  };

  const years = new Map<number, number[]>();
  for (const r of rows) if (r.yr > 0) (years.get(r.a) ?? years.set(r.a, []).get(r.a)!).push(r.yr);
  const artistYear = new Map([...years].map(([a, ys]) => [a, median(ys)]));

  // vocabulary: the TOP_TAGS heaviest tags among artists that will be served, every mood, every era bucket
  const used = new Set(rows.map((r) => r.a).filter((a) => feats.get(a)?.size));
  const tagWeight = new Map<string, number>();
  const moods = new Set<string>();
  for (const a of used) for (const [k, v] of feats.get(a)!) {
    if (k.startsWith("tag:")) tagWeight.set(k, (tagWeight.get(k) ?? 0) + v);
    else moods.add(k);
  }
  VOCAB = [
    ...[...tagWeight].sort((a, b) => b[1] - a[1]).slice(0, TOP_TAGS).map(([k]) => k),
    ...[...moods].sort(), ...(process.env.NO_ERA ? [] : ERA_KEYS), // NO_ERA / NO_FAM: ablation switches for src/sim.ts
    ...(process.env.NO_FAM ? [] : ["pop:fam"]),
  ];
  INDEX = new Map(VOCAB.map((k, i) => [k, i]));

  const out: Track[] = [];
  for (const r of rows) {
    const f = feats.get(r.a);
    if (!f || f.size === 0) continue; // untagged artists cannot be matched yet
    const norm = Math.sqrt([...f.values()].reduce((s, v) => s + v * v, 0)) || 1;
    const fm = new Map([...f].map(([k, v]) => [k, v / norm] as [string, number]));
    for (const [k, v] of eraFeats(r.yr)) fm.set(k, v * ERA_W); // era and familiarity are appended after normalization on purpose
    const fam = famOf(r.a, r.rk);
    fm.set("pop:fam", fam * FAM_W);
    const idx: number[] = [], val: number[] = [];
    for (const [k, v] of fm) { const i = INDEX.get(k); if (i !== undefined) { idx.push(i); val.push(v); } }
    const ord = idx.map((i, a) => [i, val[a]!, VOCAB[i]!] as const).filter((e) => e[2] !== "pop:fam").sort((a, b) => a[0] - b[0]);
    const un = Math.sqrt(ord.reduce((t, e) => t + e[1] * e[1], 0)) || 1;
    out.push({
      u: { i: Int32Array.from(ord.map((e) => e[0])), v: Float64Array.from(ord.map((e) => e[1] / un)) },
      id: r.id, artistId: r.a, artist: r.artist, title: r.title, durationMs: r.dur * 1000, local: !!r.ls,
      year: r.yr, artistYear: artistYear.get(r.a) ?? 0, rank: r.rk, fam,
      feats: fm, x: { i: Int32Array.from(idx), v: Float64Array.from(val) },
    });
  }
  return out;
}

// ---------- implicit signal ----------

/** Turn a listen into a score in [-1, 1]. Spin timing is the main signal; there is no explicit rating. */
export function signal(action: "spin" | "complete", listenedMs: number, durationMs: number): number {
  const ratio = listenedMs / durationMs;
  if (action === "complete" || ratio >= 0.9) return 0.5; // heard it through
  if (ratio >= 0.8) return 0.1; // skipped near the end: roughly neutral
  if (listenedMs < 15_000) return -1; // early skip: strong rejection
  return -0.4; // mid-song skip: mild rejection
}

// ---------- user profile ----------

const LAMBDA = Number(process.env.LAMBDA ?? 4);  // ridge strength = how much the onboarding prior is trusted (tuned)
export const ALPHA = Number(process.env.ALPHA ?? 0.5); // width of the UCB uncertainty bonus (tuned)

/** Cosine of two tracks' unit vectors (+ a bonus when the artist is the same): "do these two sound like the same mood". */
export function similarity(a: Track, b: Track): number {
  let i = 0, j = 0, dot = 0;
  const ai = a.u.i, bi = b.u.i;
  while (i < ai.length && j < bi.length) {
    if (ai[i]! === bi[j]!) { dot += a.u.v[i]! * b.u.v[j]!; i++; j++; } else if (ai[i]! < bi[j]!) i++; else j++;
  }
  return dot + (a.artistId === b.artistId ? cfg.sessArtist : 0);
}

type Played = { t: Track; s: number; at: number }; // one listen: the track, the relative signal it produced, when

export class Profile {
  prior = new Map<string, number>([["pop:fam", FAM_PRIOR]]); // onboarding picks = prior mean theta0 (cold start) + popularity prior
  artist = new Map<number, number>();  // behavior, per artist (not part of the linear model)
  mood = new Map<string, number>();    // short window: what fits right now
  recent: Track[] = [];                // last plays, newest last
  plays = 0;
  spins = 0;
  baseline = 0.55;                     // running average outcome of this user (see record)
  spinStreak = 0;
  hist: Played[] = [];                 // last 20 listens with their signal and time (the session is a suffix of this)
  // LinUCB state: A^-1 (d x d, row-major) and b = lambda*theta0 + sum(reward * x)
  private ainv = new Float64Array(0);
  private b = new Float64Array(0);
  private th: Float64Array | null = null; // cached theta, invalidated on every update

  constructor() { this.initModel(); }

  private initModel() {
    const d = VOCAB.length;
    this.ainv = new Float64Array(d * d);
    for (let i = 0; i < d; i++) this.ainv[i * d + i] = 1 / LAMBDA;
    this.b = new Float64Array(d);
    for (const [k, v] of this.prior) { const i = INDEX.get(k); if (i !== undefined) this.b[i] = LAMBDA * v; }
    this.th = null;
  }

  /**
   * The user's own habit: share of plays ended by a spin, smoothed toward a typical 35% so the first
   * few plays don't swing it. A spin means little from someone who spins constantly, and a lot from
   * someone who almost never does, so signals are judged relative to this.
   */
  get spinRate() { return (this.spins + 0.35 * 10) / (this.plays + 10); }

  /** Onboarding: favourite artists and/or genre tags seed the prior mean of the model (call before any play). */
  seed(artists: Track[], genres: string[] = []) {
    const eraSum = new Map<string, number>();
    for (const t of artists) {
      for (const [k, v] of t.feats) if (k.startsWith("tag:")) this.prior.set(k, (this.prior.get(k) ?? 0) + v);
      // the artist's era = median year of its tracks, so one reissued/compilation track doesn't decide it
      for (const [k, v] of eraFeats(t.artistYear)) eraSum.set(k, (eraSum.get(k) ?? 0) + v);
    }
    for (const g of genres) this.prior.set(`tag:${g}`, (this.prior.get(`tag:${g}`) ?? 0) + 1);
    const tagKeys = [...this.prior.keys()].filter((k) => k.startsWith("tag:"));
    const max = Math.max(1, ...tagKeys.map((k) => this.prior.get(k)!));
    for (const k of tagKeys) this.prior.set(k, this.prior.get(k)! / max);
    // era prior = mean over the picked artists: a unanimous era reaches 1, mixed eras dilute (honest uncertainty)
    for (const [k, v] of eraSum) this.prior.set(k, v / Math.max(1, artists.length));
    this.initModel();
  }

  /** Posterior mean theta = A^-1 b. */
  private getTheta(): Float64Array {
    if (this.th) return this.th;
    const d = VOCAB.length, th = new Float64Array(d);
    for (let i = 0; i < d; i++) { let s = 0; for (let j = 0; j < d; j++) s += this.ainv[i * d + j]! * this.b[j]!; th[i] = s; }
    return (this.th = th);
  }

  /** Learned preference per feature (posterior mean, prior included). */
  get learned(): Map<string, number> {
    const th = this.getTheta();
    return new Map(VOCAB.map((k, i) => [k, th[i]!] as [string, number]).filter(([, v]) => Math.abs(v) > 1e-6));
  }

  /** Expected reward and uncertainty of a track under the current model. */
  estimate(t: Track): { mean: number; sd: number } {
    const th = this.getTheta(), { i, v } = t.x, d = VOCAB.length;
    let mean = 0, q = 0;
    for (let a = 0; a < i.length; a++) {
      mean += th[i[a]!]! * v[a]!;
      let row = 0;
      for (let c = 0; c < i.length; c++) row += this.ainv[i[a]! * d + i[c]!]! * v[c]!;
      q += v[a]! * row;
    }
    return { mean, sd: Math.sqrt(Math.max(0, q)) };
  }

  /** Short-window mood fit (last ~5-10 plays), added on top of the long-term model. */
  moodFit(t: Track): number {
    let s = 0;
    for (const [k, v] of t.feats) if (k.startsWith("mood:")) s += v * (this.mood.get(k) ?? 0);
    return 0.5 * s;
  }

  /** The part of the current session: listens since the last silence longer than cfg.gapMs, newest last. */
  session(now: number = Date.now()): Played[] {
    const out: Played[] = [];
    let next = now;
    for (let i = this.hist.length - 1; i >= 0 && out.length < 15; i--) {
      const h = this.hist[i]!;
      if (next - h.at > cfg.gapMs) break;
      out.push(h); next = h.at;
    }
    return out.reverse();
  }

  /**
   * Session kNN: sum over the session's listens of gamma^age * signal * similarity(track, listen).
   * A finished song pulls similar tracks up, a spun one pushes them down, and older listens fade.
   */
  sessionScore(t: Track, sess: Played[]): number {
    if (!cfg.sessW || !sess.length) return 0;
    let s = 0;
    for (let k = 0; k < sess.length; k++) {
      const h = sess[sess.length - 1 - k]!; // k = 0 is the latest listen
      s += Math.pow(cfg.sessGamma, k) * (h.s < 0 ? h.s * cfg.sessNeg : h.s) * similarity(t, h.t);
    }
    return cfg.sessW * s;
  }

  /** Everything except the uncertainty bonus: long-term mean + session + mood EMA + artist bias. */
  meanScore(t: Track, sess: Played[] = this.session()): number {
    return cfg.ltW * this.estimate(t).mean + this.sessionScore(t, sess) + this.moodFit(t) + 0.5 * (this.artist.get(t.artistId) ?? 0);
  }

  score(t: Track): number { return this.meanScore(t); }

  /** Feed back one listen. Learns attributes (not just the single track) and the short-term mood. */
  record(t: Track, action: "spin" | "complete", listenedMs: number, now: number = Date.now()) {
    const raw = signal(action, listenedMs, t.durationMs);
    // Baseline subtraction: judge this listen against what THIS user usually does. outcome 0 = early skip ... 1 = finished.
    // A habitual spinner (baseline ~0.15) skipping is expected (small negative) while finishing is a strong positive;
    // a user who rarely spins is the opposite. Signals average to ~0 per user, so negatives cannot pile up on every tag.
    const outcome = (raw + 1) / 1.5;
    const s = (outcome - this.baseline) * 1.5;
    this.baseline += Math.max(1 / (this.plays + 5), 0.03) * (outcome - this.baseline);

    // LinUCB update (Sherman-Morrison on A^-1) with reward s
    const d = VOCAB.length, { i, v } = t.x;
    const u = new Float64Array(d); // u = A^-1 x
    for (let r = 0; r < d; r++) { let acc = 0; for (let a = 0; a < i.length; a++) acc += this.ainv[r * d + i[a]!]! * v[a]!; u[r] = acc; }
    let xu = 0;
    for (let a = 0; a < i.length; a++) xu += v[a]! * u[i[a]!]!;
    const k = 1 / (1 + xu);
    for (let r = 0; r < d; r++) { const ur = u[r]! * k; if (ur !== 0) for (let c = 0; c < d; c++) this.ainv[r * d + c]! -= ur * u[c]!; }
    for (let a = 0; a < i.length; a++) this.b[i[a]!]! += s * v[a]!;
    this.th = null;

    for (const [key, val] of t.feats) {
      if (key.startsWith("mood:")) this.mood.set(key, clamp(0.8 * (this.mood.get(key) ?? 0) + 0.2 * s * val * 3, -1, 1));
    }
    this.artist.set(t.artistId, clamp((this.artist.get(t.artistId) ?? 0) + 0.3 * s, -2, 2));
    this.spinStreak = s < 0 ? this.spinStreak + 1 : 0;
    this.recent.push(t);
    if (this.recent.length > 30) this.recent.shift();
    this.hist.push({ t, s, at: now });
    if (this.hist.length > 20) this.hist.shift();
    if (action === "spin") this.spins++;
    this.plays++;
    return s;
  }

  toJSON() {
    const d = VOCAB.length, tri: number[] = [];
    for (let r = 0; r < d; r++) for (let c = r; c < d; c++) tri.push(Math.round(this.ainv[r * d + c]! * 1e5) / 1e5);
    return {
      prior: [...this.prior], artist: [...this.artist], mood: [...this.mood],
      hist: this.hist.map((h) => ({ id: h.t.id, s: Math.round(h.s * 1000) / 1000, at: h.at })),
      recent: this.recent.map((t) => t.id), plays: this.plays, spins: this.spins, baseline: this.baseline, spinStreak: this.spinStreak,
      model: { vocab: VOCAB, lambda: LAMBDA, ainv: tri, b: [...this.b].map((x) => Math.round(x * 1e5) / 1e5) },
    };
  }

  /** Fresh profile with a saved onboarding prior (used by src/replay.ts to re-run a real user's history). */
  static fromPrior(prior: [string, number][]) { const p = new Profile(); p.prior = new Map(prior); p.initModel(); return p; }

  static fromJSON(j: ReturnType<Profile["toJSON"]>, byId: Map<number, Track>) {
    const p = new Profile();
    p.prior = new Map(j.prior); p.artist = new Map(j.artist); p.mood = new Map(j.mood);
    if (!p.prior.has("pop:fam")) p.prior.set("pop:fam", FAM_PRIOR); // profiles saved before the familiarity feature
    p.recent = j.recent.map((id) => byId.get(id)).filter((t): t is Track => !!t); // tracks hidden since then are dropped
    p.hist = ((j as any).hist ?? []).flatMap((h: { id: number; s: number; at: number }) => { const t = byId.get(h.id); return t ? [{ t, s: h.s, at: h.at }] : []; });
    p.plays = j.plays; p.spins = j.spins; p.baseline = j.baseline ?? 0.55; p.spinStreak = j.spinStreak;
    p.initModel(); // from the prior; the learned part is restored below only if the vocabulary and lambda still match
    const m = (j as any).model as { vocab: string[]; lambda: number; ainv: number[]; b: number[] } | undefined;
    if (m && m.lambda === LAMBDA && m.vocab.length === VOCAB.length && m.vocab.every((k, i) => k === VOCAB[i])) {
      const d = VOCAB.length;
      let n = 0;
      for (let r = 0; r < d; r++) for (let c = r; c < d; c++) { const x = m.ainv[n++]!; p.ainv[r * d + c] = x; p.ainv[c * d + r] = x; }
      p.b = Float64Array.from(m.b);
    } // else: profile saved by an older engine or another vocabulary: behavior must be re-learned from the prior
    return p;
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---------- next track ----------

export type Pick = { track: Track; mode: "exploit" | "explore" };

export function pickNext(catalog: Track[], p: Profile, rng: Rng = Math.random, now: number = Date.now()): Pick {
  const lastIds = new Set(p.recent.map((t) => t.id));

  // Medium artist variety: the same artist is not repeated within 8 plays, and artists heard a lot recently are nudged down.
  // "Stay": an artist whose latest play in that window was finished (and who has been played < 3 times in it) is exempt,
  // because after a hit the right move is more of the same mood, not an artist the listener just rejected or never heard.
  const latest = new Map<number, number>(), count = new Map<number, number>();
  for (const h of p.hist.slice(-8)) { latest.set(h.t.artistId, h.s); count.set(h.t.artistId, (count.get(h.t.artistId) ?? 0) + 1); }
  const lastArtists = new Set<number>();
  for (const t of p.recent.slice(-8)) {
    const stays = cfg.stay && (latest.get(t.artistId) ?? -1) > 0.2 && (count.get(t.artistId) ?? 0) < 3;
    if (!stays) lastArtists.add(t.artistId);
  }
  const pool = catalog.filter((t) => !lastIds.has(t.id) && !lastArtists.has(t.artistId));
  const heard = new Map<number, number>();
  for (const t of p.recent) heard.set(t.artistId, (heard.get(t.artistId) ?? 0) + 1);

  // Probing: when we do not know the current mood (new session) or the last picks keep failing, spread the next picks over
  // different styles (MMR-style penalty against the last few served tracks) so the mood is found in few spins.
  const sess = p.session(now);
  const probing = cfg.probe && (sess.length < 3 || p.spinStreak >= 3);
  const lastServed = p.recent.slice(-4);

  // LinUCB: rank by expected reward + ALPHA * uncertainty. Exploration therefore targets what the model is unsure about
  // (new eras/genres), not random tracks, and fades on its own as those directions get data.
  const cand = pool.map((t) => {
    const e = p.estimate(t);
    const lt = cfg.ltW * e.mean;
    const extra = p.sessionScore(t, sess) + p.moodFit(t) + 0.5 * (p.artist.get(t.artistId) ?? 0) - 0.15 * (heard.get(t.artistId) ?? 0);
    let div = 0;
    if (probing) for (const l of lastServed) div = Math.max(div, similarity(t, l));
    return { t, mean: lt + extra, rank: lt + ALPHA * e.sd + extra - cfg.divW * div };
  });
  cand.sort((a, b) => b.rank - a.rank);
  const top = cand.slice(0, 40);
  // mode is reported for the event log: "explore" = this pick is here because of its uncertainty bonus or diversity,
  // i.e. it is not among the 10 best by expected reward alone
  const meanCut = [...cand].sort((a, b) => b.mean - a.mean)[Math.min(9, cand.length - 1)]?.mean ?? -Infinity;

  // Sample (not argmax) from the best candidates, so it still feels like a radio, not a playlist.
  const temp = 0.25;
  const w = top.map((x) => Math.exp((x.rank - top[0]!.rank) / temp));
  let r = rng() * w.reduce((a, b) => a + b, 0);
  let chosen = top[0]!;
  for (let i = 0; i < top.length; i++) {
    r -= w[i]!;
    if (r <= 0) { chosen = top[i]!; break; }
  }
  return { track: chosen.t, mode: chosen.mean >= meanCut ? "exploit" : "explore" };
}
