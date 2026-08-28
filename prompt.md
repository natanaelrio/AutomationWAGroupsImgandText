# Prompt untuk OpenCode — Bot WhatsApp Realtime Logger + OCR Nomor Telepon

Buatkan saya aplikasi Node.js yang terhubung ke WhatsApp menggunakan library **Baileys** (`baileys`, sebelumnya `@whiskeysockets/baileys`) untuk memantau pesan masuk secara realtime dari satu grup WhatsApp tertentu. Aplikasi ini akan saya jalankan **secara lokal di laptop/PC (tanpa VPS)** untuk tahap development — jadi jangan buat sesuatu yang bergantung pada resource server eksternal atau paid API pihak ketiga.

## Tech Stack
- Node.js v20+
- `baileys` — koneksi ke WhatsApp Web murni via WebSocket, tanpa headless browser (lebih ringan dibanding `whatsapp-web.js` yang butuh Puppeteer/Chromium)
- `qrcode-terminal` — menampilkan QR login di terminal
- `tesseract.js` — OCR untuk ekstrak teks dari gambar
- `pino` — logger (dependency wajib Baileys)
- `dotenv` — konfigurasi environment

## Struktur Folder
```
project/
├── index.js
├── config/
│   └── env.js
├── utils/
│   ├── logger.js
│   ├── ocr.js
│   └── extractPhone.js
├── media/               # gambar yang didownload disimpan di sini
├── logs/                # log harian (opsional)
├── auth_info_baileys/   # session login, WAJIB masuk .gitignore
├── .env
├── .gitignore
└── package.json
```

## Konteks Gambar yang Akan Diproses
Gambar yang dikirim ke grup target adalah **screenshot chat WhatsApp**. Nomor telepon customer muncul jelas di bagian **header/atas screenshot**, dengan format seperti `+62 8xx-xxxx-xxxx` (pakai spasi & strip sebagai pemisah). Isi chat di bawahnya (pertanyaan customer, jam seperti `11.47`, harga, dsb) **tidak relevan** dan harus diabaikan — jangan sampai angka jam atau harga ikut kebaca sebagai nomor telepon. Fokus ekstraksi hanya pada pola nomor HP yang valid.

## Fitur yang Harus Ada

### 1. Koneksi & Autentikasi
- Gunakan `useMultiFileAuthState` agar session tersimpan lokal di folder `auth_info_baileys/`, sehingga tidak perlu scan ulang QR setiap kali aplikasi restart.
- Tampilkan QR code di terminal saat pertama kali login.
- Tambahkan auto-reconnect ketika koneksi terputus (cek `DisconnectReason`, kecuali kalau memang logout manual).

### 2. Filter Grup Tertentu
- Ambil `TARGET_GROUP_ID` dari file `.env` (lihat nilai aslinya di bagian Environment Variables di bawah).
- Semua proses (log, OCR, ekstraksi nomor) hanya berjalan untuk pesan yang datang dari grup ini. Pesan dari chat/grup lain diabaikan.
- (Opsional) Ambil nama grup dengan `sock.groupMetadata(TARGET_GROUP_ID)` supaya log menampilkan nama grup, bukan cuma ID mentah.

### 3. Log Realtime ke Console
Setiap pesan masuk dari grup target dicetak realtime ke terminal dengan format berikut (referensi dari contoh saya):
```
[DD/MM/YYYY, HH.mm.ss] ========== PESAN MASUK ==========
[DD/MM/YYYY, HH.mm.ss] TYPE       : notify
[DD/MM/YYYY, HH.mm.ss] GROUP      : <group_id>@g.us
[DD/MM/YYYY, HH.mm.ss] GROUP_NAME : <nama grup, opsional>
[DD/MM/YYYY, HH.mm.ss] FROM       : <sender_id>
[DD/MM/YYYY, HH.mm.ss] FROM ME    : true/false
[DD/MM/YYYY, HH.mm.ss] TEXT       : <isi teks pesan / caption>
[DD/MM/YYYY, HH.mm.ss] HAS_IMAGE  : true/false
[DD/MM/YYYY, HH.mm.ss] ==================================
```

### 4. Deteksi & OCR Gambar
- Jika pesan bertipe `imageMessage`, download buffer gambar dengan `downloadMediaMessage`.
- Simpan gambar ke folder `media/` dengan nama file `<timestamp>_<sender>.jpg`.
- Jalankan OCR dengan `tesseract.js` (bahasa: Indonesian + English) untuk mengekstrak seluruh teks dari gambar (versi awal cukup OCR seluruh gambar, tidak perlu crop area tertentu — regex ketat di langkah berikutnya sudah cukup memfilter angka yang bukan nomor HP).
- Tambahkan log setelah OCR selesai:
```
[timestamp] OCR_TEXT     : <hasil OCR lengkap>
[timestamp] PHONE_FOUND  : <nomor yang ditemukan, atau "-" kalau tidak ada>
```

### 5. Ekstraksi Nomor Telepon
- Buat fungsi `extractPhone(text)` di `utils/extractPhone.js` yang mencari nomor HP Indonesia dari hasil OCR menggunakan regex. Nomor di screenshot biasanya berformat dengan spasi/strip sebagai pemisah (contoh pola: `+62 8xx-xxxx-xxxx`), jadi regex harus toleran terhadap spasi (` `) dan strip (`-`) di antara digit, bukan cuma digit yang menempel terus:
  ```js
  /(?:\+62|62|0)[\s-]?8[0-9]{2}[\s-]?[0-9]{3,4}[\s-]?[0-9]{3,4}/g
  ```
- Setelah dapat match, buang semua karakter selain digit (spasi, strip, tanda `+`), lalu normalisasi ke format `62xxxxxxxxxx`.
- Karena angka jam (`11.47`) atau harga di isi chat tidak akan match pola nomor HP ini, cukup ambil **match pertama** yang ditemukan sebagai `PHONE_FOUND` utama. Kalau ada match lain, simpan sebagai array cadangan tapi tidak perlu ditampilkan sebagai hasil utama.

### 6. Logging ke File (disarankan)
- Selain ke console, tulis juga semua log ke file harian `logs/YYYY-MM-DD.log`, supaya histori tidak hilang saat aplikasi restart.
- Tangani error saat OCR gagal / gambar corrupt tanpa membuat aplikasi crash.

## Environment Variables (.env)
```
TARGET_GROUP_ID=120363411343925143@g.us
# Nama grup (referensi saja, bukan dipakai untuk filter): NOTIFIKASI SALES BIGDATA
LOG_TO_FILE=true
OCR_LANGUAGE=ind+eng
```

## Catatan Penting
- Saya **belum punya VPS**, jadi aplikasi ini harus 100% bisa jalan lokal (`node index.js`) dulu untuk testing. Kalau nanti sudah stabil, folder yang sama tinggal dipindah ke VPS/hosting tanpa perlu ubah kode.
- Jangan pakai `whatsapp-web.js` — pakai Baileys karena murni WebSocket, tidak butuh Chromium/Puppeteer, dan lebih ringan dijalankan di laptop.
- Sertakan `package.json` lengkap dengan semua dependency di atas, dan `.gitignore` yang mengecualikan `auth_info_baileys/`, `node_modules/`, `media/`, dan `logs/`.
- Beri komentar di bagian-bagian penting kode (koneksi, filter grup, OCR, regex nomor telepon) supaya saya bisa modifikasi sendiri nanti.