/**
 * test/testSheets.js
 * Verifikasi credential & akses Google Sheets SEBELUM menjalankan bot penuh:
 * meng-append 1 baris dummy lalu melaporkan hasilnya di console.
 *
 * Jalankan: npm run test:sheets
 */
require("dotenv").config();
const { appendToSheet } = require("../utils/sheets");
const { formatTimestamp } = require("../utils/logger");

(async () => {
  console.log("Menguji append 1 baris dummy ke Google Sheets...");

  const result = await appendToSheet({
    phone: "6281234567890",
    salesName: "Alma",
    claimMethod: "FIFO",
  });

  if (result.ok) {
    console.log(`BERHASIL: credential & akses sheet valid. Cek baris baru di spreadsheet.`);
    console.log(`Timestamp baris (format WIB): ${formatTimestamp()}`);
    process.exit(0);
  } else {
    console.error(`GAGAL: ${result.error}`);
    console.error("Periksa:");
    console.error(" 1. GOOGLE_SHEETS_WEBAPP_URL & GOOGLE_SHEETS_WEBAPP_TOKEN di .env terisi.");
    console.error(" 2. Token di .env SAMA dengan filter doPost di Apps Script.");
    console.error(" 3. Deployment web app sudah di-update ke version baru setelah ubah kode.");
    process.exit(1);
  }
})();
