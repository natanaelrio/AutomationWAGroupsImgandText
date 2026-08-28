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
    console.error(" 1. File credentials/service-account.json ada & valid.");
    console.error(" 2. Spreadsheet sudah di-share ke email service account dengan akses Editor.");
    console.error(" 3. GOOGLE_SHEET_ID & GOOGLE_SHEET_TAB di .env benar.");
    process.exit(1);
  }
})();
