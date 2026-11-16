# Plan: tag mood/energi per lagu (bukan per artis)

Status: belum dikerjakan. Dibuat 2026-11-16, dilanjutkan nanti.

## Masalah
Semua fitur engine berasal dari tag Last.fm **artis** (plus era dan popularitas). Dua lagu dari artis yang sama terlihat identik, jadi
engine tidak bisa memisahkan lagu semangat dari lagu galau milik artis yang sama. Untuk radio ini terasa jelas: rundown GAS TERUS!
(pagi, butuh semangat) tetap membawa balada, misalnya dari Dewa 19, Sheila On 7, Mocca.

Ini "Known limit" di CLAUDE.md. Pengaturan `prefer:` / `avoid:` mood di rundown hanya memakai skor mood **artis**, jadi hanya
menggeser genre, bukan memilih lagu.

## Yang sudah diketahui (jangan diulang)
| Sumber | Hasil |
|---|---|
| Last.fm `track.getTopTags` | hanya 6 dari 45 lagu punya tag (lagu Barat terkenal); tidak berguna untuk lagu Indonesia |
| BPM Deezer (`bun run audio`) | hanya 33 dari 41 ribu lagu lokal punya BPM; tidak berguna |
| Kemiripan audio CLAP (`bun run embed:test`) | untuk "mirip lagu yang disukai": tidak lebih baik dari tag artis di lintas artis |
| Bahasa lirik (LRCLIB, `bun run lyrics:test`) | AUC 0,46, tidak membantu |
| `artist_moods` | dihitung dari tag artis; Hindia tidak punya skor mood sama sekali, Raisa hanya happy 0,3 dari tag "pop" |

## Yang belum diuji
1. **CLAP zero-shot**: embedding teks ("lagu upbeat semangat untuk pagi hari", "balada pelan sedih") dibandingkan dengan embedding audio lagu.
   Infrastruktur audio sudah ada di `src/embed.ts` (CLAP via transformers.js di Bun, dari preview 30 d Deezer, ~1-1,6 d per lagu).
   Perlu menambah sisi teks (tokenizer + `ClapTextModelWithProjection`). Hanya perlu untuk lagu kandidat (puluhan sampai ratusan
   per siaran: beberapa menit), bukan seluruh katalog (7-9 jam).
2. **Tema lirik**: kata galau ("rindu", "pergi", "air mata", "luka") vs kata semangat ("bangkit", "mimpi", "senang"). Lirik dari LRCLIB
   (cakupan 92%); hanya skor tema yang disimpan, lirik dibuang (seperti yang sudah dilakukan untuk bahasa).
3. **Label dari pengetahuan model** (judul + artis): gratis dan cepat, cukup baik untuk lagu terkenal, bisa keliru untuk lagu kecil.
4. **Tempo dari audio** (librosa/essentia, perlu pemasangan Python): opsional; tempo bagus, "energi" dari sinyal biasanya berisik.

## Langkah
1. **Set label.** ~40-60 lagu kandidat dari katalog (campuran artis yang sama, supaya yang diuji memang beda per lagu) dengan label
   `semangat / sedang / pelan / galau`. Saya buat draf dari pengetahuan sendiri, pemilik koreksi. Simpan di `data/song-labels.csv`.
2. **Ukur.** Untuk tiap sumber di atas, hitung kecocokan dengan label (akurasi / AUC "semangat vs bukan") dan gabungannya. Laporkan
   dengan interval, jangan satu angka (set kecil). Keputusan: sumber mana yang layak.
3. **Simpan.** Tabel baru `track_tags (track_id, tag, score, source, updated_at)`; pipeline `bun run song-tags` yang resumable dan
   hanya mengerjakan lagu yang dipakai radio (playlist kandidat), bukan seluruh katalog.
4. **Pakai.** `loadCatalog()` menggabungkan tag/mood lagu di atas tag artis (lagu menang jika ada). `prefer:` / `avoid:` di rundown
   lalu memakai skor lagu. Opsi: header `energy: semangat` yang menyaring keras.
5. **Cek ulang.** Render rundown GAS TERUS! lagi dan nilai dengan telinga; bandingkan dengan 16 lagu uji dua seed yang sekarang
   (separuhnya masih terlalu pelan).

## Keputusan yang perlu dari pemilik
- Setuju melonggarkan aturan lama "tanpa analisis audio" (hanya untuk lagu kandidat radio, di mesin ini, vektor yang disimpan).
- Model CLAP perlu diunduh jika belum ada di mesin (ratusan MB).
- Siapa melabeli set uji (draf saya + koreksi pemilik disarankan).

## Risiko
- Set label kecil: hasil dilaporkan dengan interval, bukan klaim pasti.
- CLAP dilatih dominan musik Barat; belum diketahui seberapa baik untuk pop Indonesia. Itu yang justru diuji di langkah 2.
- Lirik tidak selalu tersedia, dan lagu ceria bisa berlirik sedih (dan sebaliknya). Gabungkan dengan sumber lain, jangan berdiri sendiri.
