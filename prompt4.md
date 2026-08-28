# Prompt Lanjutan untuk OpenCode — Tambah PIC, Ganti Grup, Backfill Agustus, Fix Urutan Klaim, Restrukturisasi Kolom Sheet

## Konteks
Ini gabungan dari beberapa permintaan lanjutan yang saling terkait, supaya diimplementasikan sekaligus secara konsisten:
1. Tambah mapping PIC baru ke `config/picMap.js`.
2. Ganti grup target ke grup baru.
3. Backfill histori pesan grup (tanggal mulai diatur lewat `BACKFILL_START_DATE`, lihat bagian khusus di bawah).
4. Pastikan urutan klaim "ok" konsisten kalau ada beberapa gambar dikirim beruntun.
5. Restrukturisasi kolom yang ditulis ke Google Sheets.

## 1. Tambah Mapping PIC Baru
Tambahkan mapping berikut ke `config/picMap.js` (mapping lama yang sudah ada tetap dipertahankan) — **hanya id & name yang dipakai**, field `sheet` per-PIC di data asal **tidak dipakai**, spreadsheet tetap satu yang sudah ada sekarang (`GOOGLE_SHEET_ID` di `.env`, tidak berubah):
```js
module.exports = {
  // ...mapping lama tetap ada...
  "70884224147606": "Alma",
  "84581344608298": "Azzah",
  "45552674852937": "Dhita",
  "138260047257624": "Erik",
  "61091681939696": "Ina",
  "177708701057272": "Sifa",
};
```
**Catatan format id:** id di atas berupa angka polos tanpa suffix domain (`@lid`), beda dari mapping lama yang mungkin masih pakai suffix penuh (`272468849725591@lid`). Normalisasi KEDUA sisi sebelum dicocokkan: strip suffix (`@lid`, `@s.whatsapp.net`, dsb) dari id pengirim ("participant") sebelum lookup ke `picMap`, dan pastikan semua key di `picMap` disimpan dalam format polos (tanpa suffix) yang konsisten.

## 2. Ganti Grup Target
Update `.env`:
```
TARGET_GROUP_ID=120363021369281320@g.us
# Nama grup (referensi saja): grup sales pt
```
Pastikan tidak ada sisa hardcode id grup lama di `index.js` atau `config/env.js` — ini mengganti grup target, bukan menambah target baru.

## 3. Backfill Histori (1 Agustus 2026 s.d. sekarang)
Buat script terpisah, tidak dicampur ke alur realtime `index.js` — misal `scripts/backfillHistory.js`, dijalankan manual lewat `npm run backfill`.

**PENTING — hasil test menunjukkan pendekatan pasif `syncFullHistory: true` + menunggu event `messaging-history.set` TIDAK cukup**, karena sesi `auth_info_baileys/` di project ini sudah lama ke-pair (bukan pairing baru). WhatsApp hanya mengirim bulk history dump otomatis di sekitar waktu SESI PERTAMA KALI di-pairing (scan QR) — reconnect biasa tidak memicu ulang dump itu. Jadi ganti pendekatannya ke **on-demand history request**:

- Gunakan `sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)` (maksimal 50 pesan per panggilan) untuk minta histori SEBELUM sebuah pesan yang sudah diketahui (anchor). Alurnya:
  1. Dapatkan 1 pesan anchor di grup target yang sudah diketahui lokal — misal jalankan `npm start` sebentar sampai menerima minimal 1 pesan baru di grup target (atau kirim 1 pesan test ke grup itu), simpan `key` dan `messageTimestamp`-nya.
  2. Panggil `sock.fetchMessageHistory(50, anchorKey, anchorTimestamp)`.
  3. Tunggu event `messaging-history.set` (`syncType: ON_DEMAND`), kumpulkan pesan yang masuk.
  4. Ambil pesan **paling lama** dari hasil itu sebagai anchor baru, panggil `fetchMessageHistory` lagi — ulangi (loop) sampai timestamp pesan yang didapat <= 1 Agustus 2026 00:00 WIB, atau sampai tidak ada lagi pesan baru yang masuk (histori benar-benar habis).
  5. Beri jeda 2-3 detik antar pemanggilan `fetchMessageHistory` supaya tidak dianggap spam.
- Pastikan `shouldSyncHistoryMessage` di konfigurasi socket me-return `true` untuk semua syncType termasuk `ON_DEMAND` — kalau di-set `false` atau tidak return true, request ini ditolak diam-diam oleh Baileys tanpa error yang jelas.
- Filter pesan dengan timestamp >= 1 Agustus 2026 00:00 WIB dari hasil yang terkumpul.
- Urutkan pesan dari **paling lama ke paling baru** sebelum diproses — wajib, supaya logic antrian FIFO & klaim "ok" jalan kronologis seperti kalau terjadi real-time (lihat bagian 4).
- Untuk tiap pesan gambar: download media → OCR → extract nomor → masuk antrian pending, sama seperti alur di `index.js`.
- Untuk tiap pesan teks "ok"/"oke"/"siap"/"ready": jalankan logic klaim yang sama (reply-quote atau FIFO fallback) terhadap antrian hasil histori.
- Tulis hasil klaim ke sheet yang sama, mengikuti struktur kolom baru di bagian 5.

**Hal yang perlu diantisipasi:**
- **Batasan mendasar (bukan soal kode)**: cara ini hanya bisa narik histori kalau nomor WA yang dipakai bot memang SUDAH jadi anggota grup itu (dan histori itu tersimpan di HP utama sesi ini) sejak sebelum tanggal yang mau di-backfill. Kalau nomor itu baru gabung setelah 1 Agustus, histori sebelum itu memang tidak akan pernah bisa didapat lewat cara apapun — batasan enkripsi end-to-end WhatsApp.
- **Kemungkinan bug versi Baileys**: ada laporan (versi rc terbaru per awal 2026) di mana `fetchMessageHistory()` berhasil terkirim tapi event `messaging-history.set` tidak pernah muncul balik. Kalau sudah pakai anchor message yang valid tapi tetap 0 hasil terus, cek versi Baileys terpasang (`npm list baileys`) dan coba update ke versi terbaru sebelum debug lebih lanjut.
- **Media kadaluarsa**: gambar dari awal Agustus kemungkinan sudah tidak bisa didownload karena WhatsApp menghapus media dari CDN setelah periode tertentu. Kalau `downloadMediaMessage` gagal, log error dan skip pesan itu (non-blocking) — jangan hentikan proses backfill keseluruhan.
- **Cegah duplikasi run**: simpan daftar message id yang sudah diproses (misal `data/backfillProcessed.json`), skip id yang sudah pernah diproses kalau script dijalankan ulang.
- **Rate limit Sheets API**: kalau histori cukup banyak, beri jeda kecil antar baris, atau kirim beberapa baris sekaligus dalam satu pemanggilan `values.append`.

## 3B. Alternatif Backfill: Import dari Export Chat Manual WhatsApp
**Latar belakang**: pendekatan on-demand `fetchMessageHistory()` di bagian 3 sudah dicoba beberapa kali dan konsisten mengembalikan 0 pesan relevan meski request berhasil terkirim & dapat balasan — ini keterbatasan dukungan on-demand history khusus untuk grup di Baileys, bukan salah konfigurasi. Kalau update Baileys ke versi terbaru (`npm install baileys@latest`) juga tidak membantu, pakai jalur ini sebagai gantinya.

**Alur:**
1. Dari HP yang jadi anggota grup, export chat manual: buka grup → titik tiga → Lainnya → Ekspor Chat → **Sertakan Media** (wajib, supaya gambar screenshot ikut ter-export, bukan cuma teks). Hasilnya file `.zip` berisi `_chat.txt` + folder media.
2. Pindahkan & extract file zip itu ke project, misal ke folder `import/` (tambahkan `import/` ke `.gitignore`).
3. Buat script baru `scripts/importExportedChat.js`, dijalankan manual lewat `npm run import-chat -- <path-ke-folder-export>`.

**Format asli `_chat.txt` ini sudah dicek langsung, PAKAI DETAIL INI (jangan tebak-tebak lagi):**
- Header baris pesan: `M/D/YY, H:MM AM/PM - Nama Pengirim: isi pesan` (contoh: `8/6/26, 1:58 PM - Pak Tomi Atmadiredja (Owner): ...`). Ada karakter *narrow no-break space* (U+202F) di antara jam dan AM/PM, bukan spasi biasa — regex harus pakai `\s` (bukan literal `" "`) supaya tetap match. Pola regex yang sudah tervalidasi cocok untuk file ini:
  ```js
  /^(\d{1,2}\/\d{1,2}\/\d{2}),\s*(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*([^:]+?):\s?(.*)$/
  ```
  Ada juga baris notifikasi sistem tanpa pesan (`... created group "..."`, `... added you`, dst) — pola di atas tidak akan match sempurna untuk baris ini (tidak ada `:`), boleh diskip/diabaikan, bukan customer/klaim.
- **Kata kunci lampiran gambar yang BENAR untuk export ini: `(file attached)`** — BUKAN `<attached: ...>`. Format lengkapnya: nama file dulu, baru keterangan, contoh: `IMG-20260806-WA0015.jpg (file attached)`. Regex untuk mendeteksi ini dari isi pesan (bagian setelah "Nama Pengirim: "):
  ```js
  /^(.+\.(?:jpg|jpeg|png|webp))\s*\(file attached\)$/i
  ```
  Ambil grup 1 sebagai nama file, cari file itu di folder yang sama dengan `_chat.txt` hasil extract.
- **Baris lanjutan (multi-line message) WAJIB ditangani**: banyak pesan di chat ini ditulis multi-baris (enter di tengah pesan). Di export, HANYA baris pertama yang punya prefix "tanggal, jam - pengirim:"; baris-baris berikutnya polos tanpa prefix sama sekali. **Setiap baris yang TIDAK match regex header di atas harus digabungkan (append, dengan newline) ke pesan SEBELUMNYA**, bukan diproses sebagai pesan baru berdiri sendiri — kalau tidak, baris lanjutan yang isinya cuma kata "ok"/nama orang bisa salah kebaca sebagai klaim baru dengan sender/waktu yang salah.
- Filter pesan (yang sudah lengkap digabung) dengan timestamp >= 1 Agustus 2026 00:00 WIB.
- Urutkan kronologis (paling lama ke paling baru) — file export ini sudah urut begitu secara default, tapi tetap divalidasi di kode.
- Untuk pesan yang match pola lampiran gambar: cari file itu di folder hasil extract, jalankan lewat OCR + extractPhone yang sama seperti alur biasa, masukkan ke antrian pending.
- Untuk pesan teks "ok"/"oke"/"siap"/"ready" (match persis, bukan sekadar mengandung kata itu di tengah kalimat panjang): jalankan logic klaim FIFO yang sama seperti bagian 4.
- Tulis hasil klaim ke sheet, format 4 kolom sama seperti bagian 5.
- **Catatan mapping nama sales**: nama pengirim di export ini berformat `Sales <Nama> (Pelangi Teknik)` untuk sales yang tersimpan sebagai kontak (contoh: `Sales Alma (Pelangi Teknik)`, `Sales Ina (Pelangi Teknik)`), dan berupa nomor mentah (`+62 856-1056-255`) untuk yang tidak tersimpan sebagai kontak. Cocokkan `picMap`/`picMapExport` dengan cek apakah nama pengirim **mengandung** salah satu nama sales yang dikenal (case-insensitive substring match: `"Sales Alma (Pelangi Teknik)".includes("alma")`), bukan exact match — supaya tidak gagal cocok gara-gara embel-embel "(Pelangi Teknik)".

**Perbedaan penting dari bagian 3 (wajib diperhatikan):**
- **Tidak ada reply-quote di export**: format teks export WhatsApp tidak menyimpan referensi "pesan ini reply ke pesan mana" secara terstruktur. Untuk data dari import ini, **hanya FIFO fallback yang dipakai** untuk semua klaim "ok" — reply-quote detection tidak berlaku di jalur import ini.
- **Sender muncul sebagai nama kontak/nomor, bukan id internal (`@lid`)**: export chat menampilkan nama kontak tersimpan di HP (kalau ada) atau nomor telepon, bukan id `@lid` yang dipakai `picMap.js`. Buat mapping tambahan berbasis nama/nomor untuk jalur import ini (misal `config/picMapExport.js`), atau — kalau nama yang muncul di export PERSIS sama dengan nama di `picMap` (misal "Alma", "Azzah") — bisa langsung dicocokkan by name, dengan fallback isi `"-"` kalau tidak cocok.
- **Cegah duplikasi dengan data dari bagian 3 (kalau sempat dapat beberapa pesan)**: cek `data/backfillProcessed.json` yang sudah ada, skip entri yang kontennya sama (nomor HP + timestamp berdekatan) supaya tidak dobel tercatat di sheet.

## 4. Ganti Strategi Matching jadi "Gambar Paling Baru" (LIFO), Bukan Antrian Biasa (FIFO)
**Masalah nyata yang ditemukan**: strategi "ambil entry PALING LAMA yang belum diklaim" (antrian biasa/FIFO) menyebabkan nomor lama yang nyangkut lama di antrian sering salah keklaim oleh "ok" yang sebenarnya ditujukan untuk gambar yang BARU SAJA dikirim. Percobaan menambal ini pakai window kadaluarsa (bagian 6 versi sebelumnya, buang entry tua otomatis) malah menyebabkan masalah baru: data yang telat dibalas sedikit (tapi tetap valid) ikut terbuang/tidak tercatat sama sekali ("data yang terlewat").

**Fix yang benar**: pola normal komunikasinya itu berpasangan berurutan — gambar (berisi nomor +62) dikirim, lalu SEGERA dibalas "ok", lalu gambar berikutnya dikirim, dibalas "ok" lagi, dst. Untuk meniru pola ini dengan akurat, ganti aturan pengambilan dari antrian untuk "ok" polos (tanpa reply/quote spesifik):

- Ambil entry **PALING BARU** (terakhir dimasukkan ke antrian) yang masih berstatus belum diklaim — BUKAN paling lama.
- **Reply/quote spesifik tetap prioritas tertinggi** di atas aturan ini — kalau "ok" reply langsung ke gambar tertentu, match ke situ, apapun posisinya/usianya di antrian.
- **Jangan buang/expire entry tua secara otomatis dari antrian** — hapus logic pembuangan paksa itu (lihat bagian 6, sudah di-deprecate). Biarkan entry lama tetap ada di antrian selama belum diklaim, supaya kalau memang suatu saat itu yang dimaksud (tidak ada entry lain yang lebih baru), tetap bisa diklaim dan tercatat — bukan hilang diam-diam.

Proses ambil-tandai-keluarkan tetap harus **sinkron** seperti sebelumnya, cuma sumber pengambilannya diganti dari depan antrian (`shift`, paling lama) jadi dari belakang (`pop`, paling baru):
```js
const entry = queue.pop(); // ambil entry PALING BARU yang belum diklaim, sinkron
if (entry) {
  entry.claimedBy = senderId;
  await appendToSheet(entry); // async boleh di sini, setelah entry sudah "terkunci"
}
```

**Catatan perubahan behavior (penting)**: kalau ada 2 gambar dikirim beruntun cepat SEBELUM sempat ada yang balas "ok" ke keduanya, lalu menyusul 2 "ok" beruntun tanpa reply spesifik — sekarang "ok" PERTAMA yang masuk akan match ke gambar TERAKHIR/TERBARU yang dikirim (bukan gambar pertama seperti spesifikasi sebelumnya), dan "ok" kedua match ke gambar yang tersisa (gambar pertama). Ini kebalikan dari spesifikasi FIFO sebelumnya — perubahan ini disengaja untuk mengatasi masalah salah-klaim yang jauh lebih sering terjadi di kondisi sehari-hari (bukan cuma di kasus 2-gambar-beruntun yang jarang terjadi).

(Opsional, housekeeping saja, TIDAK memengaruhi matching) Kalau mau memantau lead yang kelamaan tidak pernah diklaim sama sekali (misal >7 hari), boleh ditambahkan log/report terpisah untuk itu — tapi jangan menghapus data dari antrian atau melewatkan pencatatan ke sheet karena alasan usia semata.

## 5. Restrukturisasi Kolom Google Sheets (REVISI FINAL)
Ganti struktur kolom yang ditulis ke sheet menjadi 4 kolom saja, urutannya:
1. **Tanggal** (format hari, tanggal, jam WIB — sesuai fix format sebelumnya)
2. **Nomor Customer** (nomor HP hasil OCR)
3. **Nama Sales** — HARUS persis salah satu dari 6 nilai yang sudah disiapkan di dropdown data validation kolom ini di spreadsheet: `Alma`, `Azzah`, `Dhita`, `Erik`, `Ina`, `Sifa`. **Jangan tulis raw sender text lagi** (contoh lama yang salah: `"Sales Alma (Pelangi Teknik)"`) — harus sudah bersih persis salah satu dari 6 nama itu (case-sensitive match ke opsi dropdown). Kalau sales tidak ketemu di `picMap`/`picMapExport`, **kosongkan cell ini** (jangan isi `"-"` atau teks lain) supaya tidak melanggar validasi dropdown yang sudah dibuat manual di sheet — biarkan kosong untuk dipilih manual nanti.
4. **Metode Klaim** — isi `Reply` kalau klaim didapat lewat reply-quote spesifik ke gambar, atau `FIFO` kalau didapat lewat fallback antrian biasa (lihat bagian 4). Untuk data dari jalur import export chat (bagian 3B), selalu isi `FIFO` (karena reply-quote tidak tersedia di jalur itu).

Kolom "Nomor Sales" (id/nomor mentah) yang ada di revisi sebelumnya **dihapus**, tidak dipakai lagi — cukup 4 kolom di atas. Berlaku sama untuk data dari `index.js` (realtime), bagian 3 (backfill on-demand), dan bagian 3B (import export chat) — semua nulis ke struktur 4 kolom yang sama ini.

- Update fungsi `appendToSheet` supaya menerima `{ timestamp, phone, salesName, claimMethod }` dan menulis 4 kolom dalam urutan di atas.
- Update header di spreadsheet (manual) jadi: `Tanggal | Nomor Customer | Nama Sales | Metode Klaim`.
- Update `test/testSheets.js` supaya data dummy-nya sesuai format kolom baru ini (termasuk salah satu nama dropdown yang valid untuk `salesName`, dan `Reply`/`FIFO` untuk `claimMethod`).
- Simpan kolom **Nomor Customer** sebagai **teks**, bukan angka murni, supaya tidak berisiko tampil sebagai notasi ilmiah atau kehilangan digit.

## 6. [DIHAPUS/DEPRECATED] Kadaluarsa Antrian (CLAIM_WINDOW_MINUTES)
Pendekatan buang-entry-tua-otomatis di revisi sebelumnya **dibatalkan** — ternyata menyebabkan data yang telat dibalas sedikit (tapi valid) ikut hilang tidak tercatat. Sudah digantikan oleh fix di bagian 4 (ambil entry paling BARU, bukan paling lama) yang menyelesaikan masalah salah-klaim tanpa perlu membuang data apapun.

`CLAIM_WINDOW_MINUTES` di `.env` **tidak perlu dipakai lagi** untuk logic pembuangan/expire — boleh dihapus dari `.env`, atau dibiarkan tidak terpakai. Jangan ada lagi kode yang membuang entry dari antrian berdasarkan durasi waktu.

## Konfigurasi Tanggal Mulai Backfill/Import
Ganti tanggal cutoff dari 1 Agustus 2026 jadi **11 Agustus 2026 00:00 WIB** — berlaku untuk bagian 3 (backfill on-demand) maupun bagian 3B (import export chat).

Supaya ke depannya gampang diubah tanpa perlu edit kode/prompt lagi, jadikan ini konfigurasi lewat `.env`:
```
BACKFILL_START_DATE=2026-08-11
```
Baca variabel ini di kedua script (`scripts/backfillHistory.js` dan `scripts/importExportedChat.js`) sebagai batas awal filter tanggal, ganti semua referensi hardcode "1 Agustus 2026" yang ada di kode sebelumnya supaya ambil dari env var ini.

## 7. Fitur Baru: Deteksi Pesan Notifikasi Lead Terstruktur → Tab Sheet Terpisah
**Konteks**: selain screenshot gambar dari chat customer, grup ini juga menerima pesan TEKS notifikasi otomatis (kemungkinan dari widget chat/form di website), formatnya seperti ini:
```
==| Rabu, 5 Agustus 2026, jam 16:12 |==

Hallo Sifa, ada yang mengajukan penawaran
info:
- Nama Customer: Oktavia Rahmawati
- Nomor Telp: 85691721625
- Email: oktaviapeyeeew@gmail.com
- Product: Charger Aki 20 Amper Champion CT 20A
- Link: https://www.pelangiteknik.com/product/charger-aki-20-amper-champion-ct-20a
- PIC Sales: Sifa

#GoHard
```
Pesan jenis ini dideteksi & diproses **terpisah** dari alur gambar+ok yang sudah ada (bagian 4), dan datanya ditulis ke **tab sheet lain** (bukan tab klaim gambar+ok), karena strukturnya beda total.

**Deteksi**: sebuah pesan teks dianggap "notifikasi lead" kalau mengandung SEMUA label berikut (per baris; jangan bergantung ke format header "==|...|==" karena formatnya bisa berubah-ubah — pakai keberadaan label ini sebagai penentu, bukan header):
- `Nama Customer:`
- `Nomor Telp:`
- `Email:`
- `Product:`
- `PIC Sales:`

**Ekstraksi field** (regex per baris):
```js
const namaCustomer = text.match(/Nama Customer:\s*(.+)/i)?.[1]?.trim();
const nomorTelpRaw = text.match(/Nomor Telp:\s*(.+)/i)?.[1]?.trim();
const email = text.match(/Email:\s*(.+)/i)?.[1]?.trim();
const product = text.match(/Product:\s*(.+)/i)?.[1]?.trim();
const picSalesRaw = text.match(/PIC Sales:\s*(.+)/i)?.[1]?.trim();
```
- `Nomor Telp` di format ini tanpa awalan `0`/`62`/`+62` (contoh: `85691721625`) — normalisasi tetap pakai aturan yang sama seperti nomor lain di sistem ini: tambahkan prefix `62` kalau belum ada, buang karakter non-digit.
- **Tanggal**: pakai timestamp pesan WhatsApp asli (waktu pesan ini diterima/tercatat di chat), diformat sama seperti kolom Tanggal di tab lain (hari, tanggal, jam WIB) — BUKAN parsing teks "Rabu, 5 Agustus 2026, jam 16:12" dari dalam isi pesan, supaya sumber timestamp konsisten di seluruh sistem.
- **Nama Sales**: ambil dari `PIC Sales: Sifa`, lalu **cocokkan (case-insensitive) ke daftar nama sales yang sudah dikenal** (`Alma, Azzah, Dhita, Erik, Ina, Sifa`) sebelum ditulis — pakai fungsi pencocokan nama yang sama seperti di `picMapExport` (bagian 3B). Kalau tidak ketemu, kosongkan cell (konsisten dengan aturan dropdown di bagian 5).

**Tulis ke tab terpisah**: buat fungsi baru `appendLeadToSheet({ timestamp, phone, email, product, salesName })`, target ke tab baru bernama **"Sheet5"** (bukan tab klaim gambar+ok) — tambahkan env var baru `GOOGLE_SHEET_TAB_LEADS=Sheet5` (`GOOGLE_SHEET_ID` tetap sama, cuma beda tab). Kolom & urutannya:
1. Tanggal
2. Nomor Customer
3. Email
4. Product
5. Nama Sales

Update header tab "Sheet5" (manual, di spreadsheet) jadi: `Tanggal | Nomor Customer | Email | Product | Nama Sales`.

**Terapkan di semua jalur** (realtime `index.js`, backfill bagian 3, DAN import export chat bagian 3B) — pesan notifikasi lead seperti ini kemungkinan juga ada di histori Agustus yang sudah/akan di-backfill, jadi jangan cuma ditangani di realtime supaya data historisnya ikut lengkap.

**Catatan state tracking**: karena ini kategori pesan baru yang sebelumnya tidak pernah dicek sama sekali, message id yang sudah kadung tercatat "sudah diproses" di `data/backfillProcessed.json`/`data/importProcessedClaims.json` dari run-run sebelumnya perlu di-reset (kosongkan file itu) supaya semua pesan di-scan ulang dan tidak ada notifikasi lead lama yang kelewat gara-gara dianggap "sudah pernah diproses" (padahal belum pernah dicek untuk pola ini).

## Testing Tambahan
- Kirim 2 gambar dengan nomor HP berbeda secara beruntun cepat, lalu dari 2 device berbeda balas "ok" beruntun cepat juga (tanpa reply spesifik). Verifikasi (behavior baru): "ok" pertama → gambar TERAKHIR/terbaru yang dikirim, "ok" kedua → gambar pertama yang tersisa. Tidak tertukar/dobel klaim.
- Kirim 1 gambar, JANGAN diklaim dulu (biarkan beberapa saat/menit), lalu kirim gambar KEDUA dan langsung balas "ok" polos — verifikasi "ok" itu match ke gambar KEDUA (paling baru), bukan gambar pertama yang masih menunggu.
- Kirim 1 gambar, tunggu cukup lama (misal 1+ jam, atau simulasikan delay), baru balas "ok" — dengan catatan TIDAK ADA gambar lain masuk di antara itu — verifikasi tetap berhasil diklaim dan tercatat ke sheet (tidak hilang/dianggap kadaluarsa, karena fitur expire sudah dihapus).
- Jalankan `npm run backfill` sekali, cek data Agustus lama masuk ke sheet dengan struktur kolom baru, lalu jalankan sekali lagi dan pastikan tidak ada duplikasi baris.
- Cek kolom Nama Sales di sheet selalu berisi salah satu dari 6 nama dropdown (atau kosong), tidak pernah lagi berisi raw text seperti "Sales Alma (Pelangi Teknik)".
- Cek kolom Metode Klaim terisi benar: "Reply" untuk yang direply langsung, "FIFO" untuk yang lewat antrian biasa.
- Kirim pesan format notifikasi lead (contoh format di bagian 7) ke grup. Cek baris baru muncul di tab "Sheet5" (bukan tab klaim gambar+ok) dengan 5 kolom terisi benar, termasuk Nama Sales yang sudah dicocokkan ke salah satu dari 6 nama dikenal (bukan raw "Sifa" mentah kalau kapitalisasi/formatnya beda).

## Catatan
- Alur realtime (`index.js`) tetap jalan seperti biasa untuk pesan baru; backfill (bagian 3) hanya dijalankan manual sekali untuk mengisi data historis.