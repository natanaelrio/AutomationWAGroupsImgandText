# Prompt Lanjutan untuk OpenCode — Fix Format Timestamp, Mapping PIC, dan Kolom Grup

## Masalah
Data yang masuk ke Google Sheets masih berantakan di 2 kolom:
1. Kolom **PIC** masih menampilkan `"Nama Sales A"` — ini placeholder contoh dari dokumentasi sebelumnya, bukan data asli. Mapping id ke nama sales belum diisi.
2. Kolom **Timestamp** ditulis dalam format ISO 8601 UTC mentah (`2026-08-21T09:43:59.656Z`), susah dibaca dan bukan waktu lokal (WIB) — mau diganti ke format hari, tanggal, jam.

## Perbaikan yang Diminta

### 1. Update `config/picMap.js` dengan data asli
Ganti isi placeholder dengan mapping id → nama sales yang sebenarnya, contoh:
```js
module.exports = {
  "272468849725591@lid": "Ridwan",
  // tambahkan mapping id anggota grup lain di sini
};
```
Hapus entri contoh `"Nama Sales A"` yang masih placeholder.

### 2. Format timestamp ke lokal WIB — hari, tanggal, jam
- Ganti value yang ditulis ke kolom Timestamp: jangan pakai `new Date().toISOString()` langsung, buat helper `formatTimestamp(date)` yang mengonversi ke zona waktu `Asia/Jakarta`.
- Format output yang diinginkan, konsisten dengan gaya log realtime yang sudah ada (`[DD/MM/YYYY, HH.mm.ss]`), tambah nama hari di depan, contoh:
  ```
  Jumat, 21/08/2026, 16.43.59
  ```
- Bisa pakai `Intl.DateTimeFormat('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta', ... })` untuk nama hari, lalu gabungkan dengan format tanggal/jam yang sudah dipakai di `utils/logger.js` supaya style-nya seragam di seluruh aplikasi.
- Terapkan helper ini di semua tempat yang menulis timestamp ke sheet (`utils/sheets.js` / `appendToSheet()`, dan `test/testSheets.js`).

### 3. Verifikasi kolom Grup
- Pastikan value yang ditulis ke kolom Grup selalu diambil dari `groupName` hasil `sock.groupMetadata()` (variabel dinamis), bukan string hardcode — supaya kalau bot dipasang di grup lain nanti, kolom ini otomatis ikut benar tanpa perlu ubah kode.

## Catatan
- Kolom lain (No HP Customer, Message ID) tidak perlu diubah — tetap seperti sekarang.
- Setelah kode diperbaiki, hapus manual baris-baris test lama di spreadsheet (baris data dengan `TEST-SCRIPT` / `Nama Sales A`) supaya histori data bersih, lalu jalankan `npm run test:sheets` ulang untuk verifikasi format baru sebelum lanjut test end-to-end di grup asli.