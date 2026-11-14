// Song-level audio embeddings (CLAP) from the 30 s Deezer preview, computed ON THIS MACHINE (ONNX runtime, no Python).
// The server never runs the model: vectors are stored in `track_emb` and only cosines are computed at serve time.
//
//   bun run embed:test [n=200]   quick experiment: embeds ~n tracks that real users played (finished AND spun), prints speed and an
//                                ETA for the whole catalog, nearest neighbours across artists, and whether audio similarity to a
//                                user's other finished songs predicts finishing better than the tag similarity the engine uses
//   bun run embed [limit]        embeds every playable, tagged track that has no vector yet (resumable; Ctrl+C is safe)
//
// Env: MODEL (default Xenova/larger_clap_music_and_speech; Xenova/clap-htsat-unfused is the general-audio one), WIN (10 s windows
// per preview, default 1 = the middle of the preview; 3 = the whole preview, 3x slower).
// Terms: previews are fetched for personal research only (same status as the YouTube note in CLAUDE.md), nothing is stored but the vector.
import { AutoProcessor, ClapAudioModelWithProjection } from "@huggingface/transformers";
import { MPEGDecoder } from "mpg123-decoder";
import { db } from "./db.ts";
import { loadCatalog, similarity } from "./radio.ts";

const MODEL = process.env.MODEL ?? "Xenova/larger_clap_music_and_speech";
const WIN = Number(process.env.WIN ?? 1);
const SR = 48000, WINLEN = 10 * SR;

db.run(`CREATE TABLE IF NOT EXISTS track_emb (
  track_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,               -- float32, L2-normalized
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, model)    -- one vector per track PER MODEL (it used to be track_id alone, so a second model overwrote the first)
)`);
if ((db.query("PRAGMA table_info(track_emb)").all() as { pk: number }[]).filter((c) => c.pk > 0).length === 1) {
  db.run("ALTER TABLE track_emb RENAME TO track_emb_old");
  db.run(`CREATE TABLE track_emb (track_id INTEGER NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (track_id, model))`);
  db.run("INSERT INTO track_emb SELECT track_id, model, dim, vec, updated_at FROM track_emb_old");
  db.run("DROP TABLE track_emb_old");
}

const mode = process.argv[2] === "test" ? "test" : "all";
const arg = Number(process.argv[3] ?? (mode === "test" ? 200 : 1e9));

// ---------- audio ----------
async function preview(trackId: number): Promise<Uint8Array | null> {
  const meta: any = await fetch(`https://api.deezer.com/track/${trackId}`).then((r) => r.json()).catch(() => null);
  await Bun.sleep(150);
  if (!meta?.preview) return null;
  const r = await fetch(meta.preview).catch(() => null);
  return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}
async function decode(mp3: Uint8Array): Promise<Float32Array> {
  const decoder = new MPEGDecoder(); // one decoder per clip: reusing one through reset() produced MPG123_ERR
  await decoder.ready;
  const { channelData, sampleRate } = decoder.decode(mp3);
  decoder.free();
  if (!channelData[0]?.length) throw new Error("empty decode");
  const mono = new Float32Array(channelData[0]!.length);
  for (const ch of channelData) for (let i = 0; i < mono.length; i++) mono[i]! += ch[i]! / channelData.length;
  if (sampleRate === SR) return mono;
  const out = new Float32Array(Math.floor((mono.length * SR) / sampleRate)); // linear resample to 48 kHz
  for (let i = 0; i < out.length; i++) {
    const x = (i * sampleRate) / SR, a = Math.floor(x), f = x - a;
    out[i] = mono[a]! * (1 - f) + (mono[Math.min(a + 1, mono.length - 1)] ?? 0) * f;
  }
  return out;
}

// ---------- model ----------
console.log(`loading ${MODEL} (first run downloads it)...`);
const processor = await AutoProcessor.from_pretrained(MODEL);
const model = await ClapAudioModelWithProjection.from_pretrained(MODEL, { dtype: "q8" });

async function embed(pcm: Float32Array): Promise<Float32Array> {
  // WIN windows of 10 s centred in the preview (the CLAP feature extractor takes 10 s); their embeddings are averaged
  const starts = WIN <= 1 ? [Math.max(0, Math.floor((pcm.length - WINLEN) / 2))] : Array.from({ length: WIN }, (_, k) => Math.min(Math.max(0, pcm.length - WINLEN), k * WINLEN));
  let acc: Float32Array | null = null;
  for (const s of starts) {
    const inputs = await processor(pcm.subarray(s, s + WINLEN));
    const { audio_embeds } = await model(inputs);
    const v = audio_embeds.data as Float32Array;
    const n = Math.hypot(...v) || 1;
    if (!acc) acc = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) acc[i]! += v[i]! / n;
  }
  const n = Math.hypot(...acc!) || 1;
  return acc!.map((x) => x / n);
}

const save = db.prepare("INSERT OR REPLACE INTO track_emb (track_id, model, dim, vec, updated_at) VALUES (?, ?, ?, ?, ?)");
const load = (id: number) => {
  const r = db.query("SELECT vec FROM track_emb WHERE track_id = ? AND model = ?").get(id, MODEL) as { vec: Uint8Array } | null;
  return r ? new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) : null;
};

// ---------- which tracks ----------
const catalog = loadCatalog();
const byId = new Map(catalog.map((t) => [t.id, t]));
let ids: number[];
if (mode === "test") {
  // tracks real users actually played: finished and spun, so the experiment can check whether audio predicts finishing
  const rows = db.query(`SELECT track_id FROM events GROUP BY track_id ORDER BY MAX(id) DESC`).all() as { track_id: number }[];
  ids = rows.map((r) => r.track_id).filter((i) => byId.has(i)).slice(0, arg);
} else {
  const have = new Set((db.query("SELECT track_id FROM track_emb WHERE model = ?").all(MODEL) as { track_id: number }[]).map((r) => r.track_id));
  ids = catalog.filter((t) => !have.has(t.id)).sort((a, b) => b.fam - a.fam).map((t) => t.id).slice(0, arg); // most familiar songs first
}
console.log(`${ids.length} tracks to embed (${mode})`);

// ---------- run (the next preview downloads while the current one is embedded) ----------
let done = 0, failed = 0;
const t0 = Date.now();
let next = ids.length ? preview(ids[0]!) : null;
for (let k = 0; k < ids.length; k++) {
  const id = ids[k]!, cur = next!;
  next = k + 1 < ids.length ? preview(ids[k + 1]!) : null;
  if (load(id)) { done++; continue; }
  try {
    const mp3 = await cur;
    if (!mp3) { failed++; continue; }
    const v = await embed(await decode(mp3));
    save.run(id, MODEL, v.length, Buffer.from(v.buffer), Math.floor(Date.now() / 1000));
    done++;
  } catch (e) { failed++; if (failed <= 3) console.warn(`  ${id}: ${(e as Error).message}`); }
  if ((k + 1) % 10 === 0 || k + 1 === ids.length) {
    const per = (Date.now() - t0) / (k + 1) / 1000;
    console.log(`  ${k + 1}/${ids.length}  ${per.toFixed(2)} s/track  failed ${failed}  ETA for ${ids.length}: ${((per * (ids.length - k - 1)) / 60).toFixed(1)} min`);
  }
}
const per = (Date.now() - t0) / Math.max(1, ids.length) / 1000;
console.log(`\ndone ${done}, failed ${failed} (no preview/decode error). ${per.toFixed(2)} s/track => whole catalog (${catalog.length} tracks) ~ ${((per * catalog.length) / 3600).toFixed(1)} h`);

if (mode === "test") report(ids);

// ---------- test report ----------
function report(ids: number[]) {
  const vec = new Map<number, Float32Array>();
  for (const i of ids) { const v = load(i); if (v) vec.set(i, v); }
  const cos = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
  const have = [...vec.keys()];
  console.log(`\n== nearest neighbours by AUDIO (other artists only), ${have.length} embedded tracks`);
  const finished = db.query("SELECT DISTINCT track_id FROM events WHERE action = 'complete'").all() as { track_id: number }[];
  const probes = finished.map((r) => r.track_id).filter((i) => vec.has(i)).sort(() => Math.random() - 0.5).slice(0, 8);
  for (const i of probes) {
    const t = byId.get(i)!;
    const nn = have.filter((j) => byId.get(j)!.artistId !== t.artistId).map((j) => ({ j, c: cos(vec.get(i)!, vec.get(j)!) })).sort((a, b) => b.c - a.c).slice(0, 5);
    console.log(`\n${t.artist} - ${t.title}`);
    for (const n of nn) { const u = byId.get(n.j)!; console.log(`    ${n.c.toFixed(3)}  ${u.artist} - ${u.title}   (tag similarity ${similarity(t, u).toFixed(2)})`); }
  }

  // does similarity to the user's OTHER finished songs predict finishing? (leave-one-out within user; audio vs the engine's tag similarity)
  console.log("\n== does it predict finishing? (AUC within user: score = mean similarity to the user's other finished songs)");
  const auc = (pos: number[], neg: number[]) => { let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0; return w / (pos.length * neg.length); };
  const users = db.query("SELECT user_id FROM events GROUP BY user_id HAVING COUNT(*) >= 20").all() as { user_id: string }[];
  const sums = { audio: [] as number[], tag: [] as number[] };
  for (const { user_id } of users) {
    const evs = (db.query("SELECT track_id, action FROM events WHERE user_id = ?").all(user_id) as { track_id: number; action: string }[]).filter((e) => vec.has(e.track_id));
    const fin = [...new Set(evs.filter((e) => e.action === "complete").map((e) => e.track_id))];
    const res: Record<"audio" | "tag", { pos: number[]; neg: number[] }> = { audio: { pos: [], neg: [] }, tag: { pos: [], neg: [] } };
    for (const e of evs) {
      const others = fin.filter((f) => f !== e.track_id);
      if (!others.length) continue;
      const a = others.reduce((s, f) => s + cos(vec.get(e.track_id)!, vec.get(f)!), 0) / others.length;
      const g = others.reduce((s, f) => s + similarity(byId.get(e.track_id)!, byId.get(f)!), 0) / others.length;
      (e.action === "complete" ? res.audio.pos : res.audio.neg).push(a);
      (e.action === "complete" ? res.tag.pos : res.tag.neg).push(g);
    }
    if (res.audio.pos.length < 5 || res.audio.neg.length < 5) continue;
    const a = auc(res.audio.pos, res.audio.neg), g = auc(res.tag.pos, res.tag.neg);
    sums.audio.push(a); sums.tag.push(g);
    console.log(`  user ${user_id.slice(0, 8)}: ${res.audio.pos.length} finished / ${res.audio.neg.length} spun   audio AUC ${a.toFixed(2)}   tag AUC ${g.toFixed(2)}`);
  }
  const m = (x: number[]) => (x.length ? (x.reduce((s, v) => s + v, 0) / x.length).toFixed(3) : "n/a");
  console.log(`  mean over ${sums.audio.length} users: audio ${m(sums.audio)}   tag ${m(sums.tag)}   (0.5 = chance; few users and songs, read as a first look, not proof)`);
}
