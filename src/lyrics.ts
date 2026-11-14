// Song language from lyrics (LRCLIB, free, no key). Lyrics are copyrighted: they are fetched, analysed in memory and DISCARDED;
// only the detected language and a couple of numbers are stored in `track_lyrics`. Personal research use.
//
//   bun run lyrics:test [n=200]   tracks real users played; prints the language mix and whether "same language as the songs the
//                                 user finished" predicts finishing better than / on top of the tag similarity the engine uses
//   bun run lyrics [limit]        every playable tagged track without a row yet, most familiar first (resumable)
//
// Language detection is a plain heuristic (script, then common-word shares), no model: ko / ja / ar / ru by script; id / jv / en by
// stop-word shares (jv = Javanese, recognised by words Indonesian does not use). Unknown stays 'und'.
import { db } from "./db.ts";
import { cfg, loadCatalog, similarity } from "./radio.ts";

db.run(`CREATE TABLE IF NOT EXISTS track_lyrics (
  track_id INTEGER PRIMARY KEY,
  has INTEGER NOT NULL,            -- 1 = lyrics found
  lang TEXT NOT NULL,              -- id | jv | en | ko | ja | ar | ru | und
  conf REAL NOT NULL,              -- share of tokens explained by the winning language (0 for script-detected)
  words INTEGER NOT NULL,          -- length of the lyrics in words
  updated_at INTEGER NOT NULL
)`);

const mode = process.argv[2] === "test" ? "test" : "all";
const arg = Number(process.argv[3] ?? (mode === "test" ? 200 : 1e9));

const W = (s: string) => new Set(s.split(/\s+/));
const ID = W("yang dan aku kamu kau tak tidak di ini itu dengan untuk ada cinta sayang hati pada dari akan saja bukan apa kita mereka sudah belum hanya bisa lagi ku mu nya dia ke pun juga atau saat ketika tapi namun hingga karena sebuah seperti setiap malam hari rindu pergi pulang selalu biar jangan kalau bila oh");
const JV = W("ora kowe sampeyan sing wis opo ojo iki kui nek neng ning karo mung gawe tresno ati dalan wae ben cah lungo ngerti mbok piye lan aku-ra dudu kabeh uwis wes tak-gawe isih kok yo ya-ra pancen rasane atiku kangen nangis omah tembung lagi-ra seng ndak gak nggak ga");
const EN = W("the you and i to my me in it is of that love your with on for be this we are was but not so all just like when what know don't i'm you're can't no baby oh yeah have do if one they her his she he");
// words shared by Indonesian and Javanese or too common to separate them are deliberately left out of JV
for (const w of ["aku-ra", "tak-gawe", "ya-ra", "lagi-ra", "ya"]) JV.delete(w);

export function detect(text: string): { lang: string; conf: number; words: number } {
  const hangul = (text.match(/[가-힯]/g) ?? []).length, kana = (text.match(/[぀-ヿ]/g) ?? []).length;
  const arab = (text.match(/[؀-ۿ]/g) ?? []).length, cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const letters = (text.match(/\p{L}/gu) ?? []).length || 1;
  const toks = text.toLowerCase().replace(/[^\p{L}'\s]/gu, " ").split(/\s+/).filter(Boolean);
  for (const [n, l] of [[hangul, "ko"], [kana, "ja"], [arab, "ar"], [cyr, "ru"]] as const) if (n / letters > 0.2) return { lang: l, conf: 0, words: toks.length };
  if (toks.length < 8) return { lang: "und", conf: 0, words: toks.length };
  const share = (set: Set<string>) => toks.filter((t) => set.has(t)).length / toks.length;
  const id = share(ID), jv = share(JV), en = share(EN);
  // Javanese lyrics also contain Indonesian words, so a clear share of Javanese-only markers decides
  if (jv >= 0.07 && jv >= 0.4 * id) return { lang: "jv", conf: jv, words: toks.length };
  const best = Math.max(id, en);
  if (best < 0.08) return { lang: "und", conf: best, words: toks.length };
  return id >= en ? { lang: "id", conf: id, words: toks.length } : { lang: "en", conf: en, words: toks.length };
}

const clean = (s: string) => s.replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s*-\s*(remaster|live|version|single|album|feat).*$/i, "").trim();
async function lyricsOf(artist: string, title: string): Promise<string | null> {
  const h = { headers: { "user-agent": "krungu-research" } };
  const q = new URLSearchParams({ artist_name: artist, track_name: clean(title) });
  let j: any = await fetch(`https://lrclib.net/api/get?${q}`, h).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!j?.plainLyrics) {
    const s: any = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${clean(title)}`)}`, h).then((x) => x.json()).catch(() => []);
    j = Array.isArray(s) ? s.find((x: any) => x.plainLyrics) ?? null : null;
  }
  return j?.plainLyrics || null;
}

const catalog = loadCatalog();
const byId = new Map(catalog.map((t) => [t.id, t]));
let ids: number[];
if (mode === "test") {
  const rows = db.query("SELECT track_id FROM events GROUP BY track_id ORDER BY MAX(id) DESC").all() as { track_id: number }[];
  ids = rows.map((r) => r.track_id).filter((i) => byId.has(i)).slice(0, arg);
} else {
  const have = new Set((db.query("SELECT track_id FROM track_lyrics").all() as { track_id: number }[]).map((r) => r.track_id));
  ids = catalog.filter((t) => !have.has(t.id)).sort((a, b) => b.fam - a.fam).map((t) => t.id).slice(0, arg);
}
console.log(`${ids.length} tracks (${mode})`);
const save = db.prepare("INSERT OR REPLACE INTO track_lyrics (track_id, has, lang, conf, words, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
const known = new Set((db.query("SELECT track_id FROM track_lyrics").all() as { track_id: number }[]).map((r) => r.track_id));
const t0 = Date.now();
let k = 0;
for (const id of ids) {
  k++;
  if (!known.has(id)) {
    const t = byId.get(id)!;
    const txt = await lyricsOf(t.artist, t.title);
    const d = txt ? detect(txt) : { lang: "und", conf: 0, words: 0 };
    save.run(id, txt ? 1 : 0, d.lang, d.conf, d.words, Math.floor(Date.now() / 1000));
    await Bun.sleep(150);
  }
  if (k % 25 === 0 || k === ids.length) console.log(`  ${k}/${ids.length}  ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

if (mode === "test") report(ids);

function report(ids: number[]) {
  const row = new Map<number, { has: number; lang: string }>();
  for (const i of ids) { const r = db.query("SELECT has, lang FROM track_lyrics WHERE track_id = ?").get(i) as { has: number; lang: string } | null; if (r) row.set(i, r); }
  const mix: Record<string, number> = {};
  for (const r of row.values()) mix[r.has ? r.lang : "no-lyrics"] = (mix[r.has ? r.lang : "no-lyrics"] ?? 0) + 1;
  console.log("\nlanguage mix of the tested tracks:", mix);
  console.log("\nsample (check the labels yourself):");
  for (const i of [...row.keys()].sort(() => Math.random() - 0.5).slice(0, 14)) { const t = byId.get(i)!; console.log(`  ${(row.get(i)!.has ? row.get(i)!.lang : "-").padEnd(4)} ${t.artist} - ${t.title}`); }

  cfg.sessArtist = 0; // no same-artist bonus on tags, so the comparison is fair
  const auc = (p: number[], n: number[]) => { let w = 0; for (const a of p) for (const b of n) w += a > b ? 1 : a === b ? 0.5 : 0; return w / (p.length * n.length); };
  const users = db.query("SELECT user_id FROM events GROUP BY user_id HAVING COUNT(*) >= 20").all() as { user_id: string }[];
  type S = { p: number[]; n: number[] };
  const per: { tag: S; lang: S; both: S }[] = [];
  for (const { user_id } of users) {
    const evs = (db.query("SELECT track_id, action FROM events WHERE user_id = ?").all(user_id) as { track_id: number; action: string }[]).filter((e) => row.get(e.track_id)?.has);
    const fin = [...new Set(evs.filter((e) => e.action === "complete").map((e) => e.track_id))];
    const raw: { y: boolean; tag: number; lang: number }[] = [];
    for (const e of evs) {
      const others = fin.filter((f) => f !== e.track_id);
      if (!others.length) continue;
      const lg = row.get(e.track_id)!.lang;
      const lang = others.reduce((s, f) => s + (row.get(f)!.lang === lg && lg !== "und" ? 1 : 0), 0) / others.length;
      const tag = others.reduce((s, f) => s + similarity(byId.get(e.track_id)!, byId.get(f)!), 0) / others.length;
      raw.push({ y: e.action === "complete", tag, lang });
    }
    if (raw.filter((r) => r.y).length < 5 || raw.filter((r) => !r.y).length < 5) continue;
    const sd = (x: number[]) => { const m = x.reduce((s, v) => s + v, 0) / x.length; return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length) || 1; };
    const st = sd(raw.map((r) => r.tag)), sl = sd(raw.map((r) => r.lang));
    const mk = (f: (r: (typeof raw)[number]) => number): S => ({ p: raw.filter((r) => r.y).map(f), n: raw.filter((r) => !r.y).map(f) });
    per.push({ tag: mk((r) => r.tag), lang: mk((r) => r.lang), both: mk((r) => r.tag / st + r.lang / sl) });
  }
  const mean = (k: "tag" | "lang" | "both") => (per.reduce((s, u) => s + auc(u[k].p, u[k].n), 0) / per.length).toFixed(3);
  console.log(`\n== AUC within user (score = mean similarity to the user's OTHER finished songs), ${per.length} users with enough lyrics:`);
  console.log(`   tag ${mean("tag")}   language-match ${mean("lang")}   tag + language ${mean("both")}   (0.5 = chance; tiny sample, a first look only)`);
}
