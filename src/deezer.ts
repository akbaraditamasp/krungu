const BASE = "https://api.deezer.com";
const GAP_MS = 150; // stay well under Deezer's ~50 req / 5 s limit
let last = 0;

async function get<T>(path: string): Promise<T> {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  last = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(BASE + path);
    const json = (await res.json()) as any;
    // Deezer reports quota errors inside a 200 response body
    if (json?.error?.code === 4) { await Bun.sleep(5000); continue; }
    if (json?.error) throw new Error(`${path}: ${json.error.message}`);
    return json as T;
  }
  throw new Error(`${path}: quota retries exhausted`);
}

export type DzArtist = { id: number; name: string; nb_fan?: number };
export type DzTrack = {
  id: number; title: string; rank?: number; duration?: number;
  artist: { id: number; name: string };
};

export const IDN_CHART_PLAYLIST = 1116188761; // "Top Indonesia" by Deezer Charts

export const playlistTracks = (id: number) =>
  get<{ data: DzTrack[] }>(`/playlist/${id}/tracks?limit=100`).then((r) => r.data);
export const globalChart = () =>
  get<{ data: DzTrack[] }>(`/chart/0/tracks?limit=100`).then((r) => r.data);
export const artistTop = (id: number, limit = 20) =>
  get<{ data: DzTrack[] }>(`/artist/${id}/top?limit=${limit}`).then((r) => r.data);
export const relatedArtists = (id: number, limit = 10) =>
  get<{ data: DzArtist[] }>(`/artist/${id}/related?limit=${limit}`).then((r) => r.data);
export const artist = (id: number) => get<DzArtist>(`/artist/${id}`);
/** Full track record: the only Deezer endpoint here that carries release_date (and isrc). */
export const track = (id: number) => get<{ id: number; release_date?: string; isrc?: string; bpm?: number; gain?: number }>(`/track/${id}`);
export const searchArtist = (q: string) =>
  get<{ data: DzArtist[] }>(`/search/artist?q=${encodeURIComponent(q)}&limit=5`).then((r) => r.data);
