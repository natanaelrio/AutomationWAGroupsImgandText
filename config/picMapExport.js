/**
 * config/picMapExport.js
 * Mapping tambahan KHUSUS jalur import export chat manual WhatsApp
 * (dipakai oleh scripts/importExportedChat.js).
 *
 * Latar belakang:
 *  File export chat (_chat.txt) menampilkan pengirim sebagai NAMA KONTAK
 *  yang tersimpan di HP (mis. "Alma") atau NOMOR TELEPON mentah kalau
 *  kontaknya tidak tersimpan (mis. "+62 812-3456-7890") — BUKAN id internal
 *  (@lid / @s.whatsapp.net) seperti yang dipakai config/picMap.js. Karena itu
 *  id tidak bisa dinormalisasi & dicocokkan langsung; dibutuhkan mapping
 *  berbasis nama/nomor ini sebagai jembatan.
 *
 * Format entri di map:
 *  - Key   : nama/nomor PERSIS seperti muncul di _chat.txt. Pencocokan
 *            case-insensitive, spasi di awal/akhir diabaikan. Untuk key
 *            berisi nomor, pencocokan juga dilakukan pada bentuk digit saja
 *            (jadi "+62 812-3456-7890" otomatis cocok dengan "6281234567890").
 *  - Value : nama PIC yang KONSISTEN dengan nilai-nilai di config/picMap.js
 *            (mis. "Alma", "Ridwan") — dipakai apa adanya untuk kolom
 *            "Nama Sales" di spreadsheet.
 *
 * Prioritas resolusi nama PIC di jalur import (lihat resolvePicNameFromExport):
 *  1. Key di map ini (cocok by nama ATAU by digit nomor) -> value.
 *  2. Nama pengirim MENGANDUNG salah satu nama PIC di picMap
 *     (substring match case-insensitive; mis. "Sales Alma (Pelangi Teknik)"
 *     mengandung "alma") -> pakai itu.
 *  3. Tidak ada yang cocok -> null; pemanggil memakai fallback "-" .
 *
 * Entri di bawah masih CONTOH/kosong — isi sesuai nama yang benar-benar
 * muncul di file _chat.txt hasil export, lalu sesuaikan.
 */
module.exports = {
  "Sales Belanja Mesin Bekasi": "Erik",
};

// ---------- helper resolve (non-enumerable agar map tetap bersih) ----------

/**
 * Resolve nama sales/PIC dari nama tampilan pengirim di file export chat.
 * @param {string} displayName - nama/nomor persis seperti di _chat.txt
 * @returns {string|null} nama PIC kalau ketemu, null kalau tidak ditemukan
 */
function resolvePicNameFromExport(displayName) {
  const picMap = require("./picMap");

  const name = String(displayName || "").trim();
  if (!name) return null;

  const norm = (s) => String(s).trim().toLowerCase();
  const digits = name.replace(/\D/g, ""); // bentuk digit saja utk key nomor

  // 1) Override khusus jalur import: cocokkan by nama lalu by digit nomor.
  for (const [key, value] of Object.entries(module.exports)) {
    if (norm(key) === norm(name)) return value;
    const keyDigits = String(key).replace(/\D/g, "");
    if (digits && keyDigits && keyDigits === digits) return value;
  }

  // 2) Nama pengirim MENGANDUNG salah satu nama PIC di picMap (substring match).
  //    Format export: "Sales Alma (Pelangi Teknik)" -> includes("alma") = true
  for (const value of Object.values(picMap)) {
    if (typeof value === "string" && norm(name).includes(norm(value))) return value;
  }

  return null;
}

Object.defineProperty(module.exports, "resolvePicNameFromExport", {
  value: resolvePicNameFromExport,
  enumerable: false,
});
