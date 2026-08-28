/**
 * config/picMap.js
 * Mapping id pengirim (participant di dalam grup) -> nama sales/PIC.
 *
 * Format id (PENTING):
 *  - SEMUA key WAJIB polos tanpa suffix domain: "272468849725591",
 *    BUKAN "272468849725591@lid" atau "...@s.whatsapp.net".
 *  - Normalisasi dilakukan di KEDUA sisi sebelum dicocokkan:
 *    id pengirim ("participant") di-strip suffixnya lewat normalizeSenderId()
 *    sebelum lookup, dan map ini disimpan dalam format polos yang konsisten.
 *
 * Catatan:
 *  - Kalau id TIDAK ada di map ini, pemanggil memakai fallback sendiri
 *    (mis. "-") — lihat resolvePicName().
 */
module.exports = {
  // ---- mapping lama (key lama "@lid" sudah dinormalisasi jadi polos) ----
  "272468849725591": "Ridwan",

  // ---- mapping baru (id polos tanpa suffix @lid) ----
  "70884224147606": "Alma",
  "84581344608298": "Azzah",
  "45552674852937": "Dhita",
  "138260047257624": "Erik",
  "61091681939696": "Ina",
  "177708701057272": "Sifa",
};

// ---------- helper normalisasi & resolve (non-enumerable agar map tetap bersih) ----------

/**
 * Strip suffix domain dari sebuah JID/id pengirim.
 * Contoh:
 *   "272468849725591@lid"            -> "272468849725591"
 *   "6281234567890@s.whatsapp.net"   -> "6281234567890"
 *   "70884224147606"                 -> "70884224147606"
 */
function normalizeSenderId(jid) {
  return String(jid || "").trim().split("@")[0];
}

/**
 * Resolve nama sales/PIC dari id pengirim.
 * @returns {string|null} nama sales kalau terdaftar, null kalau tidak ditemukan
 */
function resolvePicName(senderId) {
  const key = normalizeSenderId(senderId);
  return Object.prototype.hasOwnProperty.call(module.exports, key)
    ? module.exports[key]
    : null;
}

Object.defineProperty(module.exports, "normalizeSenderId", {
  value: normalizeSenderId,
  enumerable: false,
});
Object.defineProperty(module.exports, "resolvePicName", {
  value: resolvePicName,
  enumerable: false,
});
