const BASE = "https://musicbrainz.org/ws/2";
const UA = "krungu/0.1 (research prototype)"; // MusicBrainz requires an identifying User-Agent
let last = 0;

export type MbArtist = { id: string; name: string; score: number; country?: string };

export async function searchArtist(name: string): Promise<MbArtist[]> {
  const wait = last + 1100 - Date.now(); // hard limit: 1 request/second
  if (wait > 0) await Bun.sleep(wait);
  last = Date.now();
  const q = encodeURIComponent(`artist:"${name.replace(/"/g, "")}"`);
  const res = await fetch(`${BASE}/artist/?query=${q}&fmt=json&limit=10`, { headers: { "User-Agent": UA } });
  if (res.status === 503) { await Bun.sleep(5000); return searchArtist(name); }
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
  const json = (await res.json()) as { artists?: MbArtist[] };
  return json.artists ?? [];
}
