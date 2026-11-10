# krungu

Radio musik personal: tanpa search, tanpa tombol like. Pengguna hanya punya tombol **SPIN** (lagu berikutnya), dan engine (LinUCB + konteks sesi) belajar selera dari waktu dengar. Katalog berisi musik komersial termasuk lagu Indonesia, diambil dari API gratis (Deezer, Last.fm, MusicBrainz) ke SQLite.

Detail desain engine ada di [CLAUDE.md](CLAUDE.md).

> Pemutaran audio memakai yt-dlp untuk mengambil stream YouTube. Ini melanggar ToS YouTube: **hanya untuk pengujian pribadi**.

## Prasyarat

| Kebutuhan | Keterangan |
|---|---|
| [Bun](https://bun.com) >= 1.4 | runtime dan package manager |
| Python 3.10+ | hanya untuk memasang yt-dlp di venv |
| Last.fm API key | gratis di https://www.last.fm/api/account/create |
| Koneksi internet | untuk Deezer, Last.fm, MusicBrainz, YouTube |

## Setup dari nol

```bash
# 1. dependensi JS
bun install

# 2. yt-dlp (untuk streaming audio) di virtualenv proyek
python -m venv .venv
# Windows:
.venv/Scripts/python -m pip install yt-dlp
# Linux/macOS:
.venv/bin/python -m pip install yt-dlp

# 3. environment
echo "LASTFM_API_KEY=isi_key_anda" > .env
```

`krungu.db` dibuat otomatis saat script pertama dijalankan. `.env`, `.venv/`, `krungu.db*`, dan `out/` ada di `.gitignore`.

## Membangun katalog (pipeline data)

Jalankan **berurutan**. Semua script bisa dilanjutkan (resumable) dan memakai rate limit, jadi aman dihentikan dan dijalankan ulang. Total waktu: sekitar 1-2 jam, sebagian besar karena rate limit MusicBrainz dan Deezer.

```bash
bun run seed            # 1. artis dari chart Deezer (opsional: bun run seed 500)
bun run seed:id         # 2. artis Indonesia dari data/id-artists.txt
bun run seed:related    # 3. perluas dengan artis terkait (opsional: bun run seed:related 300)
bun run country         # 4. negara + mbid dari MusicBrainz (paling lambat, 1,1 dtk/artis)
bun run tags            # 5. tag Last.fm (butuh LASTFM_API_KEY)
bun run clean           # 6. tandai lagu yang layak diputar (buang karaoke/live/remix/duplikat)
bun run years           # 7. tahun rilis per lagu (~11 menit per 4 ribu lagu)
bun run moods           # 8. hitung skor mood dari tag (lokal, tanpa API)
```

Catatan:

- Urutan `seed:related` sebelum `country` dan `tags` itu penting: kedua script itu mengisi baris baru yang dibuat `seed:related`.
- Untuk menambah artis Indonesia, edit [data/id-artists.txt](data/id-artists.txt), lalu jalankan ulang langkah 2, 4, 5, 6, 7, 8.
- Setelah seeding apa pun, jalankan ulang `clean` dan `years`.
- Langkah `bun run audio` **tidak dipakai** engine; lewati saja.

## Menjalankan server

```bash
bun run serve
```

Buka http://127.0.0.1:3000. Alurnya: pilih genre dan artis (onboarding), lalu pemutar dengan tombol SPIN.

| Env | Default | Fungsi |
|---|---|---|
| `HOST` | `127.0.0.1` | alamat bind (pakai `0.0.0.0` agar bisa diakses dari luar) |
| `PORT` | `3000` | port |
| `YTDLP` | `.venv/.../yt-dlp` | path yt-dlp kustom |

Jaga yt-dlp tetap baru, karena YouTube sering berubah: `.venv/Scripts/python -m pip install -U yt-dlp` (Linux/macOS: `.venv/bin/python ...`).

Belum ada autentikasi, jadi jangan buka server ke internet publik apa adanya.

## Deploy

Anda tidak perlu mengulang pipeline di server. Salin `krungu.db` (kecil, < 1 MB) ke server, lalu jalankan langkah setup (`bun install`, venv + yt-dlp, `.env`) dan `bun run serve`.

Awas: tabel `users` dan `events` ada di file db yang sama. Menimpa `krungu.db` di server berarti menghapus data pengguna di sana. Salin db hanya saat deploy pertama atau saat memang ingin mengganti katalog. Hentikan server sebelum menyalin, dan sertakan `krungu.db-wal` bila ada (atau jalankan `sqlite3 krungu.db "PRAGMA wal_checkpoint(TRUNCATE)"` dulu).

## Perintah lain

```bash
bun check                 # typecheck
bun run sim               # simulasi pendengar vs baseline acak
bun run sim:moody         # simulasi selera yang berganti-ganti
bun run replay            # uji ulang engine dengan log nyata (tabel events)
bun run trace             # cetak log simulasi yang mudah dibaca
bun run export            # tulis CSV simulasi ke out/
```

## Troubleshooting

- **`tags` melewati banyak artis**: normal. Artis lokal tanpa mbid terverifikasi atau dengan tag kebangsaan asing sengaja dibuang (namesake).
- **Lagu tidak bisa diputar / 403**: perbarui yt-dlp. Lagu yang tidak ketemu di YouTube dicache sebagai negatif dan tidak akan disajikan lagi.
- **Katalog kosong atau kecil**: engine hanya memuat lagu `playable = 1` dari artis yang punya tag; pastikan `tags` dan `clean` sudah dijalankan.
- **Error `LASTFM_API_KEY`**: pastikan `.env` ada di root proyek.
