// Minimal HTTP API around the radio engine. Playback is the client's job: this only says WHAT to play next
// and receives what happened. Deliberately no search/browse endpoint; /onboarding is the only catalog listing.
// Run: bun run serve   (PORT=3000, HOST=127.0.0.1 by default)
import { db } from "./db.ts";
import { learnedWeights, loadCatalog, pickNext, Profile, type Track } from "./radio.ts";
import { forgetUrl, matchTrack, streamUrl } from "./youtube.ts";

const catalog = loadCatalog();
const byId = new Map(catalog.map((t) => [t.id, t]));
const byArtist = new Map<number, Track>();
for (const t of catalog) if (!byArtist.has(t.artistId)) byArtist.set(t.artistId, t);
console.log(`catalog: ${catalog.length} tracks, ${byArtist.size} artists`);

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const now = () => Math.floor(Date.now() / 1000);

// Tracks with no acceptable YouTube match are never served again (remembered in yt_matches).
const blocked = new Set((db.query("SELECT track_id FROM yt_matches WHERE video_id IS NULL").all() as { track_id: number }[]).map((r) => r.track_id));

// ---------- onboarding options (computed once) ----------
const GENRES = ["pop", "rock", "indie", "alternative", "hip-hop", "rnb", "electronic", "edm", "dance", "metal", "jazz", "k-pop", "j-pop", "acoustic", "ballad", "folk", "reggae", "punk", "soul", "country", "dangdut", "koplo", "campursari", "indonesian"];
const genreCount = new Map<string, number>();
for (const a of byArtist.values()) for (const k of a.feats.keys()) if (k.startsWith("tag:")) {
  const g = k.slice(4);
  if (GENRES.includes(g)) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
}
const bestTrack = new Map<number, Track>(); // most familiar track per artist (the one shown as a suggestion)
for (const t of catalog) { const b = bestTrack.get(t.artistId); if (!b || t.fam > b.fam) bestTrack.set(t.artistId, t); }
const songView = (t: Track) => ({ id: t.id, artist: t.artist, title: t.title });
const onboarding = {
  genres: GENRES.filter((g) => (genreCount.get(g) ?? 0) >= 4), // legacy (POST /users still accepts genres/artistIds)
  artists: (db.query(
    `SELECT id, name, local_seed ls FROM artists WHERE id IN (${[...byArtist.keys()].join(",") || "0"})
     ORDER BY local_seed DESC, fans DESC NULLS LAST LIMIT 80`,
  ).all() as { id: number; name: string; ls: number }[]).map((a) => ({ id: a.id, name: a.name })),
};
// Onboarding is picking SONGS: a few suggestions (famous songs of the top artists) plus a search that exists only for this step.
const suggestions = onboarding.artists.slice(0, 40).map((a) => bestTrack.get(a.id)).filter((t): t is Track => !!t).map(songView);
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const haystack = catalog.map((t) => ({ t, h: norm(`${t.artist} ${t.title}`) }));
function searchSongs(q: string, limit = 20) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  return haystack.filter((x) => words.every((w) => x.h.includes(w)) && !blocked.has(x.t.id))
    .sort((a, b) => b.t.fam - a.t.fam).slice(0, limit).map((x) => songView(x.t));
}
const PICKS = 5; // songs asked at onboarding

// ---------- profiles ----------
const cache = new Map<string, Profile>();
function loadProfile(id: string): Profile | null {
  const hit = cache.get(id);
  if (hit) return hit;
  const row = db.query("SELECT profile FROM users WHERE id = ?").get(id) as { profile: string } | null;
  if (!row) return null;
  const p = Profile.fromJSON(JSON.parse(row.profile), byId);
  // what this user already heard recently (for the cooldown); a fresh profile has no events yet
  p.hydratePlayed(db.query("SELECT track_id, MAX(created_at) at FROM events WHERE user_id = ? AND created_at > ? GROUP BY track_id").all(id, now() - 7 * 86400) as { track_id: number; at: number }[]);
  cache.set(id, p);
  return p;
}
const saveProfile = (id: string, p: Profile) =>
  db.run("UPDATE users SET profile = ?, updated_at = ? WHERE id = ?", [JSON.stringify(p.toJSON()), now(), id]);

const trackView = (t: Track, mode: string) => ({
  trackId: t.id, // Deezer track id: resolve playback however you like
  artistId: t.artistId, artist: t.artist, title: t.title, durationMs: t.durationMs, mode,
});

Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4020),
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const path = url.pathname.replace(/\/+$/, "");

    if (req.method === "GET" && (path === "" || path === "/")) {
      return new Response(Bun.file(`${import.meta.dir}/ui.html`), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    const au = path.match(/^\/tracks\/(\d+)\/audio$/);
    if (req.method === "GET" && au) {
      const t = byId.get(Number(au[1]));
      if (!t) return json({ error: "unknown track" }, 404);
      try {
        const m = await matchTrack(t);
        if (!m) { blocked.add(t.id); return json({ error: "no acceptable match" }, 404); }
        await streamUrl(m.videoId); // resolve now so the stream route below is instant (and failures show up here)
        // Same-origin proxy URL: googlevideo itself rejects browser requests (see /stream below)
        return json({ url: `/tracks/${t.id}/stream`, videoId: m.videoId, durationMs: m.durationS * 1000, matchedTitle: m.title });
      } catch (e) {
        console.warn(`audio ${t.artist} - ${t.title}:`, (e as Error).message);
        return json({ error: "resolve failed, try again" }, 502);
      }
    }

    // Audio proxy. googlevideo answers 403 (and sends no CORS headers) to the open-ended `Range: bytes=0-` that browsers
    // send for <audio>; it only accepts bounded ranges. So translate every browser range into a bounded one (max 4 MB).
    const st = path.match(/^\/tracks\/(\d+)\/stream$/);
    if (req.method === "GET" && st) {
      const t = byId.get(Number(st[1]));
      const m = t ? await matchTrack(t).catch(() => null) : null;
      if (!t || !m) return json({ error: "no stream" }, 404);
      const CHUNK = 4 * 1024 * 1024;
      const rg = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
      const start = rg?.[1] ? Number(rg[1]) : 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const upstream = await streamUrl(m.videoId);
        const total = Number(new URL(upstream).searchParams.get("clen")) || 0;
        if (total && start >= total) return new Response(null, { status: 416, headers: { ...CORS, "content-range": `bytes */${total}` } });
        let end = rg?.[2] ? Math.min(Number(rg[2]), start + CHUNK - 1) : start + CHUNK - 1;
        if (total) end = Math.min(end, total - 1);
        const up = await fetch(upstream, { headers: { Range: `bytes=${start}-${end}` } }).catch(() => null);
        if (!up || !up.ok) { forgetUrl(m.videoId); continue; } // expired or rejected: resolve a fresh URL once
        const h: Record<string, string> = { ...CORS, "content-type": "audio/mp4", "accept-ranges": "bytes", "cache-control": "no-store" };
        const cr = up.headers.get("content-range"), cl = up.headers.get("content-length");
        if (cr) h["content-range"] = cr;
        if (cl) h["content-length"] = cl;
        return new Response(up.body, { status: 206, headers: h });
      }
      return json({ error: "upstream failed" }, 502);
    }

    if (req.method === "GET" && path === "/health") return json({ ok: true, tracks: catalog.length });
    if (req.method === "GET" && path === "/onboarding") return json({ ...onboarding, picks: PICKS, songs: suggestions });
    if (req.method === "GET" && path === "/onboarding/search") return json({ songs: searchSongs(url.searchParams.get("q") ?? "") });

    if (req.method === "POST" && path === "/users") {
      const body = (await req.json().catch(() => ({}))) as { genres?: string[]; artistIds?: number[]; trackIds?: number[] };
      const songs = [...new Set(body.trackIds ?? [])].slice(0, PICKS).map((id) => byId.get(id)).filter((t): t is Track => !!t);
      const picks = [...songs, ...(body.artistIds ?? []).map((id) => byArtist.get(id)).filter((t): t is Track => !!t)];
      const genres = (body.genres ?? []).filter((g) => GENRES.includes(g));
      if (!picks.length && !genres.length) return json({ error: "pick at least one song" }, 400);
      const p = new Profile();
      p.seed(picks, genres);
      const id = crypto.randomUUID();
      db.run("INSERT INTO users (id, profile, created_at, updated_at) VALUES (?, ?, ?, ?)", [id, JSON.stringify(p.toJSON()), now(), now()]);
      cache.set(id, p);
      return json({ userId: id }, 201);
    }

    const m = path.match(/^\/users\/([0-9a-f-]{36})\/(next|events|debug)$/);
    if (!m) return json({ error: "not found" }, 404);
    const [, userId, action] = m as unknown as [string, string, string];
    const profile = loadProfile(userId);
    if (!profile) return json({ error: "unknown user" }, 404);

    if (req.method === "GET" && action === "next") {
      const pick = pickNext(blocked.size ? catalog.filter((t) => !blocked.has(t.id)) : catalog, profile);
      db.run("INSERT INTO serves (user_id, track_id, mode, propensity, policy, comps, served_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [userId, pick.track.id, pick.mode, pick.prop, learnedWeights ? "learned" : "legacy", JSON.stringify(pick.comps), now()]);
      return json(trackView(pick.track, pick.mode));
    }

    if (req.method === "POST" && action === "events") {
      const b = (await req.json().catch(() => null)) as { trackId?: number; action?: string; listenedMs?: number; mode?: string } | null;
      const t = b?.trackId != null ? byId.get(b.trackId) : undefined;
      if (!t || (b!.action !== "spin" && b!.action !== "complete") || !Number.isFinite(b!.listenedMs)) {
        return json({ error: "need trackId (a served track), action 'spin'|'complete', listenedMs" }, 400);
      }
      const listened = Math.max(0, Math.min(b!.listenedMs!, t.durationMs));
      const sig = profile.record(t, b!.action as "spin" | "complete", listened);
      const d = new Date();
      db.run(
        `INSERT INTO events (user_id, track_id, artist_id, action, listened_ms, duration_ms, mode, signal, hour, dow, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, t.id, t.artistId, b!.action!, Math.round(listened), t.durationMs, b!.mode ?? null, sig, d.getHours(), d.getDay(), now()],
      );
      saveProfile(userId, profile);
      return json({ signal: +sig.toFixed(3) });
    }

    if (req.method === "GET" && action === "debug") {
      const top = (m: Map<string, number>, n: number, sign: 1 | -1) =>
        [...m].filter(([, v]) => v * sign > 0).sort((a, b) => sign * (b[1] - a[1])).slice(0, n).map(([k, v]) => `${k}=${v.toFixed(2)}`);
      return json({
        plays: profile.plays, spinRate: +profile.spinRate.toFixed(2), baseline: +profile.baseline.toFixed(2), spinStreak: profile.spinStreak,
        likes: top(profile.learned, 10, 1), dislikes: top(profile.learned, 10, -1), prior: top(profile.prior, 8, 1),
        recent: profile.recent.slice(-10).map((t) => `${t.artist} - ${t.title}`),
      });
    }
    return json({ error: "method not allowed" }, 405);
  },
});
console.log(`radio API on http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 4020}`);
