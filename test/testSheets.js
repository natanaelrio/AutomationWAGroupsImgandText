require("dotenv").config();
const { appendToSheet, appendLeadToSheet } = require("../utils/sheets");
const { formatTimestamp } = require("../utils/logger");

async function testLabel(label, fn) {
  console.log(`\n--- ${label} ---`);
  const result = await fn();
  if (result.ok) {
    console.log(`BERHASIL: baris dummy ditulis (Sumber Lead sudah ikut).`);
    console.log(`Timestamp (WIB): ${formatTimestamp()}`);
    return true;
  }
  console.error(`GAGAL: ${result.error}`);
  console.error("Periksa:");
  console.error(" 1. GOOGLE_SHEETS_WEBAPP_URL & GOOGLE_SHEETS_WEBAPP_TOKEN di .env terisi.");
  console.error(" 2. Token di .env SAMA dengan filter doPost di Apps Script.");
  console.error(" 3. Deployment web app sudah di-update ke version baru setelah ubah kode.");
  return false;
}

(async () => {
  console.log("Menguji append 1 baris dummy untuk tiap alur ke Google Sheets...");

  const claimOk = await testLabel("Alur KLAIM (diharapkan Sumber Lead = GRUP SALES PT)", () =>
    appendToSheet({
      phone: "6281234567890",
      salesName: "Alma",
      claimMethod: "FIFO",
    })
  );

  const leadOk = await testLabel("Alur LEAD (diharapkan Sumber Lead = WEB PELANGI)", () =>
    appendLeadToSheet({
      phone: "6289123456789",
      email: "test@example.com",
      product: "Test",
      salesName: "Azzah",
    })
  );

  process.exit(claimOk && leadOk ? 0 : 1);
})();