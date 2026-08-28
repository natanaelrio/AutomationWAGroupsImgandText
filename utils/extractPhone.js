/**
 * utils/extractPhone.js
 * Ekstraksi nomor HP Indonesia dari teks hasil OCR.
 *
 * Konteks: gambar yang diproses adalah screenshot chat WhatsApp.
 * Nomor customer muncul di header dengan format seperti "+62 8xx-xxxx-xxxx"
 * (pakai spasi & strip). Isi chat di bawahnya (jam "11.47", harga, dsb)
 * TIDAK akan cocok dengan pola ini, jadi cukup aman tanpa crop gambar.
 */

// Regex nomor HP Indonesia.
// Toleran terhadap spasi ( ) dan strip (-) di antara digit:
//   cocok : "+62 812-3456-7890", "0812 3456 7890", "6281234567890", "0812-3456-7890"
//   gagal : "11.47" (jam), "Rp150.000" (harga) -> tidak match pola
const PHONE_REGEX = /(?:\+62|62|0)[\s-]?8[0-9]{2}[\s-]?[0-9]{3,4}[\s-]?[0-9]{3,4}/g;

/**
 * Normalisasi nomor ke format 62xxxxxxxxxx.
 * Buang semua karakter selain digit (spasi, strip, tanda +),
 * lalu samakan prefix: 0xx -> 62xx, 8xx -> 628xx.
 */
function normalizePhone(raw) {
  let digits = raw.replace(/\D/g, ""); // hapus spasi, strip, tanda +
  if (digits.startsWith("0")) {
    digits = "62" + digits.slice(1); // 0812... -> 62812...
  } else if (!digits.startsWith("62")) {
    digits = "62" + digits; // 812... -> 62812...
  }
  return digits;
}

/**
 * Cari nomor HP Indonesia dari teks hasil OCR.
 * @param {string} text - teks hasil OCR
 * @returns {{ phone: string|null, allMatches: string[] }}
 *   phone      = match PERTAMA yang sudah dinormalisasi (hasil utama),
 *                null kalau tidak ada nomor ditemukan
 *   allMatches = semua match unik hasil normalisasi (array cadangan,
 *                tidak ditampilkan sebagai hasil utama)
 */
function extractPhone(text) {
  if (!text) return { phone: null, allMatches: [] };

  const matches = text.match(PHONE_REGEX) || [];
  // Dedupe sambil menjaga urutan kemunculan
  const unique = [...new Set(matches.map(normalizePhone))];

  return { phone: unique[0] || null, allMatches: unique };
}

module.exports = { extractPhone, normalizePhone };
