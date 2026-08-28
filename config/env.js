/**
 * config/env.js
 * Memuat & memvalidasi environment variables dari file .env
 */
require("dotenv").config();

const config = {
  // ID grup WA target, contoh: 120363021369281320@g.us
  targetGroupId: process.env.TARGET_GROUP_ID || "120363021369281320@g.us",

  // true = log juga ditulis ke logs/YYYY-MM-DD.log
  logToFile: String(process.env.LOG_TO_FILE || "true").toLowerCase() === "true",

  // Bahasa OCR Tesseract, contoh: ind+eng (Indonesia + English)
  ocrLanguage: process.env.OCR_LANGUAGE || "ind+eng",

  // ==== Google Sheets (PIC tracking) ====
  // Path FILE service account JSON — isi key TIDAK boleh hardcode di sini
  googleServiceAccountPath:
    process.env.GOOGLE_SERVICE_ACCOUNT_PATH || "./credentials/service-account.json",

  // ID spreadsheet target & nama tab di dalamnya
  googleSheetId: process.env.GOOGLE_SHEET_ID || "",
  googleSheetTab: process.env.GOOGLE_SHEET_TAB || "Sheet1",
  googleSheetTabLeads: process.env.GOOGLE_SHEET_TAB_LEADS || "Sheet5",

  // Kata trigger klaim (case-insensitive), dipisah koma di .env
  okKeywords: String(process.env.OK_KEYWORDS || "ok,oke,siap,ready")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Nomor di antrian kadaluarsa setelah sekian menit tak diklaim (0 = fitur mati)
  claimWindowMinutes: parseInt(process.env.CLAIM_WINDOW_MINUTES || "30", 10),
};

if (!config.targetGroupId) {
  console.error("[CONFIG] TARGET_GROUP_ID belum diisi di file .env");
  process.exit(1);
}

// Sengaja TIDAK exit: kegagalan Sheets tidak boleh menghentikan bot
if (!config.googleSheetId) {
  console.error("[CONFIG] Peringatan: GOOGLE_SHEET_ID kosong — klaim PIC tidak akan ditulis ke Sheets.");
}

module.exports = config;
