const BASE = "https://ws.audioscrobbler.com/2.0/";
const GAP_MS = 250; // ~4 req/s, under Last.fm's informal 5 req/s limit
let last = 0;

const KEY = process.env.LASTFM_API_KEY;
if (!KEY) throw new Error("LASTFM_API_KEY missing in .env");

export type LfmTag = { name: string; count: number };

/** Returns null when Last.fm does not know the artist (error 6). Prefers mbid, which is unambiguous. */
export async function artistTopTags(name: string, mbid?: string | null, allowNameLookup = true): Promise<LfmTag[] | null> {
  // Name lookups can hit a namesake (e.g. Indonesian Tulus vs a Norwegian black metal band).
  // Callers pass allowNameLookup=false for local artists that have no verified mbid.
  if (!mbid && !allowNameLookup) return null;
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  last = Date.now();
  const p = new URLSearchParams({ method: "artist.gettoptags", api_key: KEY!, format: "json", autocorrect: "1" });
  if (mbid) p.set("mbid", mbid);
  else p.set("artist", name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}?${p}`);
    const json = (await res.json()) as any;
    if (json.error === 29) { await Bun.sleep(5000); continue; } // rate limited
    if (json.error === 6) {
      if (mbid && allowNameLookup) return artistTopTags(name, null, allowNameLookup);
      return null;
    }
    if (json.error) throw new Error(`Last.fm ${json.error}: ${json.message}`);
    return (json.toptags?.tag ?? []).map((t: any) => ({ name: String(t.name).toLowerCase(), count: Number(t.count) }));
  }
  throw new Error("Last.fm rate limit retries exhausted");
}
