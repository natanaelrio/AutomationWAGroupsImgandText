/**
 * utils/ocr.js
 * OCR gambar dengan tesseract.js (bahasa dari .env, default: ind+eng).
 * Catatan: saat pertama kali dijalankan, Tesseract akan mengunduh
 * file bahasa (traineddata) dari CDN-nya — butuh koneksi internet.
 */
const Tesseract = require("tesseract.js");
const config = require("../config/env");

// Worker dibuat SEKALI lalu dipakai ulang untuk semua gambar berikutnya
// (membuat worker baru tiap gambar sangat lambat).
let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker(config.ocrLanguage);
  }
  return workerPromise;
}

/**
 * Jalankan OCR terhadap buffer gambar.
 * @param {Buffer} imageBuffer - buffer gambar hasil downloadMediaMessage
 * @returns {Promise<string>} teks lengkap hasil OCR
 * @throws Error kalau gambar corrupt / OCR gagal (ditangani caller)
 */
async function runOcr(imageBuffer) {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(imageBuffer);
    return data.text || "";
  } catch (err) {
    // Reset cache worker supaya pemanggilan berikutnya membuat worker baru,
    // bukan memakai worker yang sudah rusak.
    workerPromise = null;
    throw err;
  }
}

module.exports = { runOcr };
