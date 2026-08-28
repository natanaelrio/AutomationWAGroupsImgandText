/**
 * utils/logger.js
 * Logger sederhana: cetak ke console + simpan ke file harian logs/YYYY-MM-DD.log
 * Format timestamp mengikuti contoh: [DD/MM/YYYY, HH.mm.ss]
 */
const fs = require("fs");
const path = require("path");
const config = require("../config/env");

const LOGS_DIR = path.join(__dirname, "..", "logs");

// Format: DD/MM/YYYY, HH.mm.ss (jam pakai titik, sesuai contoh)
function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const dd = pad(date.getDate());
  const mm = pad(date.getMonth() + 1);
  const yyyy = date.getFullYear();
  const HH = pad(date.getHours());
  const MM = pad(date.getMinutes());
  const SS = pad(date.getSeconds());
  return `${dd}/${mm}/${yyyy}, ${HH}.${MM}.${SS}`;
}

// Nama hari dalam bahasa Indonesia untuk zona waktu Asia/Jakarta (WIB)
function weekdayName(date = new Date()) {
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    timeZone: "Asia/Jakarta",
  }).format(date);
}

// Timestamp lokal WIB + nama hari, gaya seragam dengan timestamp():
// contoh output -> "Jumat, 21/08/2026, 16.43.59"
// Dipakai untuk kolom Timestamp di Google Sheets.
function formatTimestamp(date = new Date()) {
  // Geser komponen tanggal/jam ke dinding waktu Jakarta, lalu format ulang
  // dengan timestamp() supaya DD/MM/YYYY, HH.mm.ss konsisten di seluruh app.
  const jakarta = new Date(
    date.toLocaleString("en-US", { timeZone: "Asia/Jakarta" })
  );
  return `${weekdayName(date)}, ${timestamp(jakarta)}`;
}

// Nama file log harian: YYYY-MM-DD.log
function dailyFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`;
}

// Tulis satu baris ke file harian (fire-and-forget, tidak memblokir event loop)
function appendToFile(line) {
  if (!config.logToFile) return;
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFile(path.join(LOGS_DIR, dailyFileName()), line + "\n", () => {});
  } catch {
    /* gagal menulis file -> abaikan agar aplikasi tetap jalan */
  }
}

// Log utama: console + file harian sekaligus
function log(message) {
  const line = `[${timestamp()}] ${message}`;
  console.log(line);
  appendToFile(line);
}

module.exports = { log, timestamp, formatTimestamp };
