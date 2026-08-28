# Prompt Lanjutan untuk OpenCode — Deteksi Klaim "OK" + Integrasi Google Sheets (PIC Tracking)

## Konteks
Aplikasi WhatsApp bot (Baileys + OCR nomor HP) di prompt sebelumnya sudah jalan dan berhasil log pesan masuk dari grup target secara realtime. Sekarang saya ingin menambahkan fitur lanjutan:

Ketika ada anggota grup yang membalas **"ok"** (menandakan lead/nomor HP customer tersebut sudah diambil alih untuk ditindaklanjuti), tangkap **ID pengirim "ok"** tersebut sebagai **PIC (Person In Charge)**, lalu simpan pasangan **nomor HP customer + PIC** ke **Google Sheets**.

Contoh nyata: pengirim dengan id `272468849725591@lid` membalas "ok" di grup `NOTIFIKASI SALES BIGDATA` setelah gambar dengan nomor HP customer dikirim → baris baru masuk ke spreadsheet berikut:
`https://docs.google.com/spreadsheets/d/16ZEbdYPe1yqKwdjkwPfN7va3Cc95vS9jMAJ8XSjB0bI/edit#gid=0`

## ⚠️ Catatan Keamanan (wajib dilakukan sebelum lanjut)
- Service account key JSON yang sempat saya share di chat **harus dianggap sudah bocor**. Sebelum testing fitur ini:
  1. Revoke key lama di Google Cloud Console (IAM & Admin → Service Accounts → Keys).
  2. Generate key baru, simpan sebagai file lokal `credentials/service-account.json` — **jangan** ditempel ke prompt, dokumentasi, chat, atau commit ke git.
  3. Pastikan `credentials/` masuk `.gitignore`.
  4. Share spreadsheet target ke email service account (`...@merchant-center-1616071801490.iam.gserviceaccount.com`) dengan akses **Editor**, kalau belum.
- Kode harus membaca credential dari **file path** (env var), bukan hardcode isi key di `.env` atau di source code.

## Tech Stack Tambahan
- `googleapis` — client resmi Google API (termasuk Sheets API v4 dan auth JWT dari service account)

## Struktur Folder Tambahan
```
project/
├── credentials/
│   └── service-account.json   # taruh manual, JANGAN commit
├── config/
│   └── picMap.js               # mapping id pengirim -> nama sales
├── utils/
│   └── sheets.js                # fungsi appendToSheet()
├── data/
│   └── pendingPhones.json       # antrian nomor HP yang belum diklaim (persist state)
```

## Environment Variables Tambahan (.env)
```
GOOGLE_SERVICE_ACCOUNT_PATH=./credentials/service-account.json
GOOGLE_SHEET_ID=16ZEbdYPe1yqKwdjkwPfN7va3Cc95vS9jMAJ8XSjB0bI
GOOGLE_SHEET_TAB=Sheet1            # sesuaikan dengan nama tab asli (cek nama tab di gid=0)
OK_KEYWORDS=ok,oke,siap,ready       # kata trigger klaim, case-insensitive, pisahkan koma
CLAIM_WINDOW_MINUTES=60             # opsional: nomor kadaluarsa kalau tak diklaim dalam durasi ini
```

## Fitur yang Harus Ditambahkan

### 1. Deteksi Balasan Klaim
- Untuk setiap pesan teks masuk dari grup target, cek apakah isi teks (setelah `trim()` + `toLowerCase()`) cocok dengan salah satu kata di `OK_KEYWORDS`.
- Ambil `participant` (id pengirim di dalam grup) sebagai kandidat PIC. Formatnya bisa berupa `@lid` (contoh: `272468849725591@lid`) — ini adalah format LID (Linked ID) WhatsApp terbaru untuk privasi grup, **bukan** nomor telepon langsung, jadi jangan diasumsikan bisa langsung dibaca sebagai nomor HP.

### 2. Mencocokkan "ok" dengan Nomor HP yang Tepat
Gunakan strategi berlapis, prioritaskan yang paling akurat lebih dulu:

- **Reply/quote detection (prioritas utama)** — Jika pesan "ok" adalah balasan langsung ke pesan gambar tertentu, cek `message.extendedTextMessage.contextInfo.stanzaId` dan cocokkan dengan message id gambar yang sudah diproses OCR sebelumnya. Kalau cocok, pakai nomor HP dari gambar itu.
- **FIFO queue (fallback)** — Kalau user cuma ketik "ok" tanpa reply/quote: simpan tiap nomor HP hasil OCR ke antrian in-memory (dan idealnya juga ditulis ke `data/pendingPhones.json` supaya tidak hilang saat restart), berstatus "belum diklaim", beserta timestamp & message id gambar sumbernya. Saat "ok" masuk, ambil entri **paling lama** yang masih berstatus belum diklaim, tandai diklaim oleh pengirim tsb, keluarkan dari antrian.
- Satu nomor HP hanya boleh diklaim **satu kali** (first come first served) — "ok" berikutnya tidak boleh mengklaim ulang nomor yang sama.
- (Opsional) Nomor yang tidak diklaim dalam `CLAIM_WINDOW_MINUTES` dianggap kadaluarsa dan dikeluarkan dari antrian tanpa dicatat ke sheet.

### 3. Mapping ID Pengirim ke Nama PIC
Karena id `@lid` tidak informatif dan tim sales biasanya jumlahnya terbatas & tetap, buat `config/picMap.js`:
```js
module.exports = {
  "272468849725591@lid": "Nama Sales A",
  // tambahkan mapping anggota grup lain di sini
};
```
- Kalau id pengirim tidak ditemukan di map, fallback catat id mentahnya sebagai PIC (tetap tercatat, bisa dipetakan manual belakangan).

### 4. Integrasi Google Sheets
Buat `utils/sheets.js`:
- Auth menggunakan `google-auth-library`/`googleapis` `JWT` client, baca credential dari file di path `GOOGLE_SERVICE_ACCOUNT_PATH` (via `fs.readFileSync` + `JSON.parse`), **bukan** hardcode.
- Fungsi `appendToSheet({ phone, pic, groupName, messageId })` yang append 1 baris baru ke `GOOGLE_SHEET_ID`, tab `GOOGLE_SHEET_TAB`, menggunakan `sheets.spreadsheets.values.append` dengan `valueInputOption: "USER_ENTERED"`.
- Kolom minimal yang wajib: **No HP Customer**, **PIC**. Rekomendasi tambahan (opsional, boleh dihapus kalau mau simpel): Timestamp, Group, Message ID.
- Tangani error API (auth invalid, rate limit, dsb) dengan try/catch — jangan sampai bot crash, cukup log error dan lanjut jalan.

### 5. Update Log Realtime
Tambahkan log event klaim baru:
```
[timestamp] ========== KLAIM PIC ==========
[timestamp] CLAIMED_BY   : <id pengirim ok>
[timestamp] PIC_NAME     : <nama dari picMap, atau id mentah kalau tak ada mapping>
[timestamp] PHONE        : <nomor HP yang diklaim>
[timestamp] SHEET_STATUS : success / failed
[timestamp] ================================
```

### 6. Testing
- Instruksi manual: kirim screenshot ke grup target → tunggu OCR & nomor muncul di log → dari akun lain di grup, balas "ok" → cek log klaim muncul → cek baris baru masuk ke Google Sheet.
- (Opsional) Buat script kecil `test/testSheets.js` yang append 1 baris dummy ke sheet, untuk verifikasi credential & akses sheet valid sebelum menjalankan bot penuh.

## Catatan Tambahan
- Kegagalan Sheets API tidak boleh menghentikan proses OCR/log pesan lain — tetap non-blocking.
- Beri komentar jelas di bagian: parsing `contextInfo`/`quotedMessage`, logic antrian FIFO, dan pemanggilan Sheets API — supaya mudah dimodifikasi nanti.