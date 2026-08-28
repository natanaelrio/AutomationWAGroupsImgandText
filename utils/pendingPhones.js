/**
 * utils/pendingPhones.js
 * Antrian FIFO nomor HP hasil OCR yang MENUNGGU DIKLAIM oleh sales
 * (sales membalas "ok" -> ambil nomor dari antrian).
 *
 * State dipersist ke data/pendingPhones.json supaya antrian & riwayat
 * klaim tidak hilang saat bot restart.
 */
const fs = require("fs");
const path = require("path");
const config = require("../config/env");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "pendingPhones.json");

// Struktur file JSON:
// {
//   pending: [ { messageId, phone, groupName, addedAt } ],   <- belum diklaim
//   claimed: [ { ..., claimedBy, claimedAt } ]               <- riwayat sudah diklaim
// }
let state = { pending: [], claimed: [] };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      state.pending = Array.isArray(raw.pending) ? raw.pending : [];
      state.claimed = Array.isArray(raw.claimed) ? raw.claimed : [];
    }
  } catch {
    /* file corrupt / tak terbaca -> mulai dengan state kosong */
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* gagal tulis file -> antrian in-memory tetap jalan */
  }
}

// Muat state lama saat modul pertama kali di-require
load();

/** Masukkan nomor HP hasil OCR ke antrian (status: belum diklaim). */
function addPending({ messageId, phone, groupName }) {
  if (!phone) return false;
  // Cegah duplikat: message id gambar yang sama tidak masuk dua kali
  if (state.pending.some((e) => e.messageId === messageId)) return false;
  state.pending.push({
    messageId: messageId || "",
    phone,
    groupName: groupName || "",
    addedAt: new Date().toISOString(),
  });
  save();
  return true;
}

/** Lihat entri paling lama TANPA mengeluarkannya dari antrian. */
function peekOldest() {
  purgeExpired();
  return state.pending[0] || null;
}

/** Cari entri berdasarkan message id gambar (untuk reply/quote detection). */
function findByMessageId(messageId) {
  purgeExpired();
  return state.pending.find((e) => e.messageId === messageId) || null;
}

/** Nomor HP ini sudah pernah diklaim orang lain? (satu nomor = satu klaim) */
function isPhoneClaimed(phone) {
  return state.claimed.some((c) => c.phone === phone);
}

// ---------- operasi klaim: keluarkan dari antrian + catat riwayat ----------

function recordClaim(entry, claimedBy) {
  state.claimed.push({
    messageId: entry.messageId,
    phone: entry.phone,
    groupName: entry.groupName,
    addedAt: entry.addedAt,
    claimedBy,
    claimedAt: new Date().toISOString(),
  });
  save();
}

/** Klaim via reply/quote: cocokkan message id pesan gambar yang dibalas. */
function claimByMessageId(messageId, claimedBy) {
  const idx = state.pending.findIndex((e) => e.messageId === messageId);
  if (idx === -1) return null;
  const [entry] = state.pending.splice(idx, 1); // keluarkan dari antrian
  recordClaim(entry, claimedBy);
  return entry;
}

/**
 * Klaim FIFO: ambil entri PALING LAMA yang masih berstatus belum diklaim.
 * Dipakai kalau user ketik "ok" tanpa reply/quote ke gambar tertentu.
 */
function claimOldest(claimedBy) {
  const entry = state.pending.shift();
  if (!entry) return null;
  recordClaim(entry, claimedBy);
  return entry;
}

/** Buang entri dari antrian tanpa mencatat klaim (mis. nomornya sudah pernah diklaim). */
function removePending(messageId) {
  const before = state.pending.length;
  state.pending = state.pending.filter((e) => e.messageId !== messageId);
  if (state.pending.length !== before) save();
}

/**
 * Kadaluarsa: nomor yang tidak diklaim dalam CLAIM_WINDOW_MINUTES dibuang
 * dari antrian TANPA dicatat ke sheet. Set 0/negatif di .env untuk mematikan.
 * Log setiap entry yang hangus supaya terlihat di console.
 */
function purgeExpired() {
  const minutes = config.claimWindowMinutes;
  if (!minutes || minutes <= 0) return;
  const cutoff = Date.now() - minutes * 60 * 1000;
  const expired = state.pending.filter((e) => new Date(e.addedAt).getTime() < cutoff);
  if (expired.length > 0) {
    const { log: logger } = require("./logger");
    for (const e of expired) {
      logger(`NOMOR_HANGUS : ${e.phone} dibuang dari antrian, tidak diklaim dalam ${minutes} menit`);
    }
    state.pending = state.pending.filter((e) => new Date(e.addedAt).getTime() >= cutoff);
    save();
  }
}

function count() {
  return state.pending.length;
}

module.exports = {
  addPending,
  peekOldest,
  findByMessageId,
  isPhoneClaimed,
  claimByMessageId,
  claimOldest,
  removePending,
  purgeExpired,
  count,
};
