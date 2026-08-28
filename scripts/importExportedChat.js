"use strict";

/**
 * scripts/importExportedChat.js
 * Backfill histori grup via EXPORT CHAT MANUAL WhatsApp — jalur 3B.
 * Mulai dari 11 Agustus 2026.
 *
 * Latar belakang:
 *  Jalur on-demand `fetchMessageHistory()` (scripts/backfillHistory.js)
 *  terbukti TIDAK reliable untuk grup (request terkirim tapi balasan selalu
 *  0 pesan relevan) — keterbatasan dukungan Baileys untuk histori grup, bukan
 *  salah konfigurasi. Jalur yang DIPAKAI sekarang: export chat manual dari HP
 *  (grup -> titik tiga -> Lainnya -> Ekspor Chat -> SERTAKAN MEDIA), hasil
 *  .zip di-extract ke folder project (mis. import/), lalu diparse di sini.
 *
 * Pemakaian:
 *    npm run import-chat -- <path-ke-folder-export> [--dry-run]
 *
 *  - <path-ke-folder-export> : folder hasil extract .zip (harus berisi
 *    _chat.txt, langsung atau di subfolder). Boleh juga path langsung ke
 *    file .txt-nya. Kalau argumen dikosongkan, dipakai folder import/ .
 *  - --dry-run : parse + proses penuh TANPA menulis ke Google Sheets dan
 *    TANPA menyimpan state processed — aman untuk sekadar preview.
 *
 * Format baris yang didukung (regex disesuaikan format export Indonesia):
 *    [DD/MM/YY, HH.mm.ss] Nama Pengirim: isi pesan          (iOS)
 *    DD/MM/YY, HH.mm - Nama Pengirim: isi pesan             (Android)
 *  Baris yang tidak cocok format dianggap lanjutan pesan sebelumnya
 *  (multiline). Karakter penanda arah (U+200E/U+200F) dibuang dulu.
 *
 * Perbedaan penting vs jalur backfill on-demand:
 *  1. TIDAK ADA reply-quote: export teks tidak menyimpan referensi reply
 *     secara terstruktur, jadi SEMUA klaim "ok"/"oke"/"siap"/"ready" pakai
 *     FIFO fallback saja — "ok" pertama mengklaim gambar paling lama, dst.
 *     (pengambilan entri dari antrian dilakukan SINKRON, bebas race condition).
 *  2. Sender berupa nama kontak/nomor (bukan @lid): nama PIC diresolve via
 *     config/picMapExport.js lalu fallback by-name ke config/picMap.js,
 *     terakhir fallback "-". Kolom Nomor Sales diisi nomor pengirim (kalau
 *     pengirim tampil sebagai nomor) atau nama tampilannya apa adanya.
 *  3. Media TIDAK kadaluarsa (file ikut ter-export lokal), tapi tetap bisa
 *     gagal OCR / file hilang — hanya dilog & dilewati, non-blocking.
 *
 * Anti-duplikasi (idempoten lintas run & lintas jalur):
 *  - Message id sintetis (hash konten+timestamp) dicatat FLAT di
 *    data/backfillProcessed.json — format sama dengan scripts/backfillHistory.js
 *    sehingga saling kompatibel.
 *  - Hasil klaim dicatat (phone + timestamp) di data/importProcessedClaims.json;
 *    klaim dengan nomor sama dalam toleransi +-15 menit dilewati, begitu juga
 *    nomor yang sudah pernah diklaim bot realtime (riwayat claimed di
 *    data/pendingPhones.json).
 *
 * Output sheet: struktur 4 kolom baru via utils/sheets.js
 *    Tanggal | Nomor Customer | Nama Sales | Metode Klaim
 *  ditulis batch per values.append (rate-limit friendly).
 *  Nama Sales harus salah satu dari 6 nama dropdown (Alma/Azzah/Dhita/Erik/Ina/Sifa),
 *  atau baris dilewati. Metode Klaim selalu "FIFO" (export tidak punya reply-quote).
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const config = require("../config/env");
const { log, formatTimestamp } = require("../utils/logger");
const { runOcr } = require("../utils/ocr");
const { extractPhone } = require("../utils/extractPhone");
const { appendSheetRows, appendLeadSheetRows, VALID_SALES_NAMES } = require("../utils/sheets");
const { resolvePicNameFromExport } = require("../config/picMapExport");
const { isLeadNotification, parseLeadFields } = require("../utils/leads");

// ---------- konstanta ----------
const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PROCESSED_IDS_FILE = path.join(DATA_DIR, "backfillProcessed.json"); // flat map, kompatibel backfillHistory.js
const CLAIMS_FILE = path.join(DATA_DIR, "importProcessedClaims.json");    // riwayat klaim jalur import (konten)
const PENDING_FILE = path.join(DATA_DIR, "pendingPhones.json");           // riwayat klaim bot realtime (baca saja)
const DEFAULT_IMPORT_DIR = path.join(ROOT_DIR, "import");

// Batas awal backfill: 11 Agustus 2026 00.00 WIB (UTC+7)
const BACKFILL_SINCE = new Date("2026-08-11T00:00:00+07:00");

const CHAT_FILENAME = "_chat.txt";

// Ekstensi gambar yang diproses OCR; selain itu = lampiran non-gambar (skip)
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)$/i;
// Baris isi pesan HANYA nama file gambar + "(file attached)" (format export WhatsApp)
// Capture group 1 = nama file, dipakai utk cari di folder export
const IMAGE_LINE_RE = /^(.+\.(?:jpg|jpeg|png|webp))\s*\(file attached\)$/i;
// Lampiran non-gambar umum di export (video/audio/dokumen) -> skip
const NON_IMAGE_HINT_RE =
  /\.(mp4|mov|avi|mkv|webm|mp3|opus|ogg|m4a|aac|wav|pdf|docx?|xlsx?|pptx?|vcf|txt)$/i;
// Placeholder media tidak ikut ter-export: "<Media tidak disertakan>" dsb
const OMITTED_MEDIA_RE = /^<[^>]+>$/;

// Baris header pesan export chat — format tervalidasi dari file asli:
//   M/D/YY, H:MM AM/PM - Nama Pengirim: isi pesan
//   Contoh: 8/6/26, 1:58 PM - Pak Tomi Atmadiredja (Owner): ...
// Catatan: ada karakter narrow no-break space (U+202F) antara jam & AM/PM;
// regex pakai \s supaya tetap match. Detik TIDAK ada di format ini.
// Capture groups: [1]=date, [2]=time AM/PM, [3]=sender, [4]=text
const CHAT_LINE_RE =
  /^(\d{1,2}\/\d{1,2}\/\d{2}),\s*(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*([^:]+?):\s?(.*)$/;

// Tuning proses
const SHEET_FLUSH_SIZE = 25;         // maks baris per pemanggilan values.append
const SHEET_FLUSH_DELAY_MS = 500;    // jeda antar pemanggilan Sheets API
const SAVE_PROCESSED_EVERY = 25;     // simpan state tiap N pesan ditangani
const CLAIM_DUP_TOLERANCE_MS = 15 * 60_000; // toleransi "timestamp berdekatan"

// ---------- helper umum ----------
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* file corrupt / tak terbaca -> pakai fallback */
  }
  return fallback;
}

function writeJson(file, data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    /* gagal tulis -> proses tetap lanjut */
  }
}

/**
 * Bangun Date dari string tanggal & jam format export WhatsApp.
 * Waktu export adalah wall-time HP (diasumsikan WIB, UTC+7) tanpa info zona —
 * jadi dikonversi manual: anggap komponen sebagai UTC lalu kurangi offset 7 jam.
 * @param {string} dateStr - "M/D/YY" (contoh: "8/6/26")
 * @param {string} timeStr - "H:MM AM/PM" (contoh: "1:58 PM")
 */
function buildMessageTimestamp(dateStr, timeStr) {
  // Parse tanggal: "M/D/YY"
  const dateParts = dateStr.split("/");
  const month = parseInt(dateParts[0], 10) - 1;
  const day = parseInt(dateParts[1], 10);
  let year = parseInt(dateParts[2], 10);
  if (year < 100) year += 2000;

  // Parse jam: "H:MM AM/PM" — konversi ke 24-jam
  const timeMatch = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(timeStr);
  let hours = timeMatch ? parseInt(timeMatch[1], 10) : 0;
  const minutes = timeMatch ? parseInt(timeMatch[2], 10) : 0;
  const ampm = timeMatch ? timeMatch[3].toUpperCase() : "";
  if (ampm === "PM" && hours < 12) hours += 12;
  if (ampm === "AM" && hours === 12) hours = 0;

  const epochMs = Date.UTC(year, month, day, hours, minutes, 0) - 7 * 60 * 60 * 1000;
  return new Date(epochMs);
}

/**
 * Parse seluruh isi _chat.txt menjadi daftar pesan kronologis-mentah.
 * @param {string} content - isi file _chat.txt
 * @returns {Array<{ts: Date, sender: string, text: string}>}
 */
function parseChatText(content) {
  const lines = String(content || "")
    .replace(/^\uFEFF/, "")        // buang BOM
    .replace(/\r\n?/g, "\n")       // samakan line ending
    .replace(/[\u200e\u200f]/g, "") // buang penanda arah LRM/RLM dari WA
    .split("\n");

  const messages = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = CHAT_LINE_RE.exec(line);
    if (m) {
      messages.push({
        ts: buildMessageTimestamp(m[1], m[2]),
        sender: m[3].trim(),
        text: m[4].trim(),
        idx: messages.length,
      });
    } else if (messages.length > 0) {
      // Bukan header baru -> baris lanjutan pesan sebelumnya (multiline)
      messages[messages.length - 1].text += "\n" + line;
    }
  }
  return messages;
}

/** Id sintetis stabil utk dedupe lintas run: hash(idx|timestamp|pengirim|isi). */
function syntheticMessageId(msg) {
  const hash = crypto
    .createHash("sha1")
    .update(`${msg.idx}|${msg.ts.getTime()}|${msg.sender}|${msg.text}`)
    .digest("hex");
  return `exp_${hash.slice(0, 16)}`;
}

/**
 * Identitas sales utk kolom "Nomor Sales" dari tampilan pengirim di export:
 *  - kalau tampil sebagai NOMOR telepon -> bentuk digit saja ("+62 812-..." ->
 *    "6281234567890")
 *  - kalau NAMA kontak -> nama apa adanya (export tidak membawa id @lid)
 */
function senderIdentity(displayName) {
  const name = String(displayName || "").trim();
  const digitsOnly = name.replace(/\D/g, "");
  if (digitsOnly.length >= 8 && /^[\s+()\-.0-9]+$/.test(name)) {
    return digitsOnly;
  }
  return name;
}

/** Index semua file di folder export (by basename lowercase) utk resolve media. */
function buildFileIndex(rootDir) {
  const index = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(fullPath);
      } else {
        const base = ent.name.toLowerCase();
        if (!index.has(base)) index.set(base, fullPath);
      }
    }
  };
  walk(rootDir);
  return index;
}

/** Cari _chat.txt: cek root dulu, lalu telusuri subfolder (ambil terpendek). */
function findChatFile(rootDir) {
  const direct = path.join(rootDir, CHAT_FILENAME);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const candidate = path.join(dir, ent.name, CHAT_FILENAME);
      if (fs.existsSync(candidate)) found.push(candidate);
      walk(path.join(dir, ent.name));
    }
  };
  walk(rootDir);
  if (found.length === 0) return null;
  found.sort((a, b) => a.length - b.length);
  return found[0];
}

// ---------- main ----------
let onGracefulExit = null; // diisi main() agar Ctrl-C tetap menyimpan state

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  let targetPath = positional[0];

  if (!targetPath && fs.existsSync(DEFAULT_IMPORT_DIR)) {
    targetPath = DEFAULT_IMPORT_DIR;
    log(`IMPORT_SRC   : argumen kosong -> pakai folder default ${DEFAULT_IMPORT_DIR}`);
  }

  if (!targetPath) {
    console.error("\nPemakaian: npm run import-chat -- <path-folder-export> [--dry-run]");
    console.error("- Folder export = hasil extract .zip WhatsApp (berisi _chat.txt + media)");
    console.error("- --dry-run: proses tanpa menulis ke Sheets/state (preview)\n");
    process.exitCode = 1;
    return;
  }

  targetPath = path.resolve(targetPath);

  if (!fs.existsSync(targetPath)) {
    console.error(`GAGAL: path tidak ditemukan: ${targetPath}`);
    process.exitCode = 1;
    return;
  }
  if (/\.zip$/i.test(targetPath)) {
    console.error("GAGAL: file masih .zip — extract dulu, lalu pass FOLDERNYA ke script ini.");
    process.exitCode = 1;
    return;
  }

  // Tentukan folder export & lokasi _chat.txt
  let exportDir;
  let chatFile;
  if (fs.statSync(targetPath).isFile()) {
    chatFile = targetPath;
    exportDir = path.dirname(targetPath);
  } else {
    exportDir = targetPath;
    chatFile = findChatFile(exportDir);
  }
  if (!chatFile) {
    console.error(
      `GAGAL: ${CHAT_FILENAME} tidak ditemukan di ${exportDir} (beserta subfoldernya).`
    );
    console.error("Pastikan export memakai opsi 'Sertakan Media' dan zip sudah di-extract.");
    process.exitCode = 1;
    return;
  }

  console.log("==========================================================");
  console.log(" IMPORT EXPORT CHAT WHATSAPP -> BACKFILL (jalur 3B)");
  console.log(` Rentang : mulai ${formatTimestamp(BACKFILL_SINCE)} WIB`);
  console.log(` Sumber  : ${chatFile}`);
  console.log(` Mode    : ${dryRun ? "DRY-RUN (tanpa tulis sheet/state)" : "NORMAL"}`);
  console.log(" Klaim   : FIFO saja (export tidak menyimpan reply-quote)");
  console.log("==========================================================");

  if (!dryRun && !config.googleSheetId) {
    console.error("[CONFIG] GOOGLE_SHEET_ID belum diisi di .env — pakai --dry-run untuk preview.");
    process.exitCode = 1;
    return;
  }

  // ===== state anti-duplikasi =====
  // ids: flat map { "<id>": true } — FORMAT SAMA dengan scripts/backfillHistory.js
  const rawIds = readJson(PROCESSED_IDS_FILE, {});
  const processedIds = {};
  for (const [k, v] of Object.entries(rawIds || {})) {
    if (v === true || v === undefined || v === null) processedIds[k] = true;
  }
  // klaim jalur import sebelumnya (konten phone+ts) utk dedupe konten
  const previousClaims = Array.isArray(readJson(CLAIMS_FILE, []))
    ? readJson(CLAIMS_FILE, [])
    : [];
  // nomor yang sudah pernah diklaim BOT REALTIME (riwayat persist) -> jangan dobel
  const realtimeClaimedPhones = new Set();
  const pendingState = readJson(PENDING_FILE, {});
  for (const c of pendingState.claimed || []) {
    if (c && c.phone) realtimeClaimedPhones.add(c.phone);
  }

  let processedSinceSave = 0;
  function persistState(force) {
    if (dryRun) return;
    if (!force && processedSinceSave < SAVE_PROCESSED_EVERY) return;
    writeJson(PROCESSED_IDS_FILE, processedIds);
    writeJson(CLAIMS_FILE, previousClaims);
    processedSinceSave = 0;
  }
  onGracefulExit = () => persistState(true);

  function markProcessed(id) {
    if (!id || processedIds[id]) return;
    processedIds[id] = true;
    processedSinceSave++;
    persistState(false); // autosave berkala
  }

  /**
   * Cek duplikasi klaim berbasis KONTEN (nomor + timestamp berdekatan).
   * @returns {string|null} alasan duplikat ("realtime"|"nearby") atau null
   */
  function duplicateClaimReason(phone, tsMs) {
    if (realtimeClaimedPhones.has(phone)) return "realtime";
    const nearby = previousClaims.some(
      (c) =>
        c &&
        c.phone === phone &&
        Math.abs(Number(c.ts) - tsMs) <= CLAIM_DUP_TOLERANCE_MS
    );
    return nearby ? "nearby" : null;
  }

  // ===== parse =====
  const chatContent = fs.readFileSync(chatFile, "utf8");
  const allMessages = parseChatText(chatContent);

  const inRange = allMessages.filter((m) => m.ts >= BACKFILL_SINCE);
  inRange.sort((a, b) => a.ts - b.ts); // kronologis: paling lama -> paling baru

  const stats = {
    parsedTotal: allMessages.length,
    beforeCutoff: allMessages.length - inRange.length,
    inRange: inRange.length,
    alreadyProcessed: 0,
    imagesFound: 0,
    mediaFileMissing: 0,
    ocrFailed: 0,
    omittedMediaSkipped: 0,
    nonMediaSkipped: 0,
    pendingAdded: 0,
    dupQueueSkipped: 0,
    claimsWritten: 0,
    claimsDuplicateSkipped: 0,
    claimsWithoutTarget: 0,
    rowsWritten: 0,
    rowsFailed: 0,
    leadsDetected: 0,
    leadsWritten: 0,
    leadsFailed: 0,
  };

  // Index file media di folder export — dibangun SEKALI sebelum loop
  const fileIndex = buildFileIndex(exportDir);
  log(`MEDIA_INDEX  : ${fileIndex.size} file ditemukan di folder export`);

  // Antrian FIFO LOKAL hasil OCR (tidak menyentuh antrian bot realtime)
  const queue = []; // entri: { messageId, phone }
  let rowsBuffer = [];
  let leadsRowsBuffer = [];

  async function flushRows(isFinal) {
    if (rowsBuffer.length === 0) return;
    if (dryRun) {
      log(`DRY_RUN     : lewati append ${rowsBuffer.length} baris ke sheet`);
      rowsBuffer = [];
      return;
    }
    const batch = rowsBuffer.slice();
    const result = await appendSheetRows(batch);
    if (result.ok) {
      rowsBuffer = rowsBuffer.slice(batch.length);
      stats.rowsWritten += batch.length;
      log(`SHEET_APPEND : ${batch.length} baris ditulis (total OK: ${stats.rowsWritten})`);
      if (!isFinal) await delay(SHEET_FLUSH_DELAY_MS);
    } else if (isFinal) {
      stats.rowsFailed += rowsBuffer.length;
      rowsBuffer = [];
      log(`SHEET_APPEND : GAGAL final, ${stats.rowsFailed} baris tidak tertulis (${result.error})`);
    } else {
      // biarkan di buffer utk dicoba lagi pada flush berikutnya
      log(`SHEET_APPEND : gagal (${result.error}) — baris ditahan untuk retry`);
      await delay(SHEET_FLUSH_DELAY_MS);
    }
  }

  async function flushLeadsRows(isFinal) {
    if (leadsRowsBuffer.length === 0) return;
    if (dryRun) {
      log(`DRY_RUN     : lewati append ${leadsRowsBuffer.length} baris lead ke sheet`);
      leadsRowsBuffer = [];
      return;
    }
    const batch = leadsRowsBuffer.slice();
    const result = await appendLeadSheetRows(batch);
    if (result.ok) {
      leadsRowsBuffer = leadsRowsBuffer.slice(batch.length);
      stats.leadsWritten += batch.length;
      log(`LEAD_SHEET   : ${batch.length} baris lead ditulis (total OK: ${stats.leadsWritten})`);
      if (!isFinal) await delay(SHEET_FLUSH_DELAY_MS);
    } else if (isFinal) {
      stats.leadsFailed += leadsRowsBuffer.length;
      leadsRowsBuffer = [];
      log(`LEAD_SHEET   : GAGAL, ${stats.leadsFailed} baris lead tidak tertulis (${result.error})`);
    } else {
      log(`LEAD_SHEET   : gagal (${result.error}) — baris ditahan untuk retry`);
      await delay(SHEET_FLUSH_DELAY_MS);
    }
  }

  // ===== gambar: cari file di folder export -> OCR -> ekstrak nomor -> antrian =====
  async function handleImage(msg, messageId, fileName) {
    stats.imagesFound++;
    const filePath = fileIndex.get(fileName.toLowerCase());

    if (!filePath) {
      stats.mediaFileMissing++;
      log(`IMG_SKIP     : [${formatTimestamp(msg.ts)}] file "${fileName}" tidak ada di folder export`);
      return;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const ocrText = await runOcr(buffer);
      const { phone } = extractPhone(ocrText);
      log(
        `IMAGE_OK     : [${formatTimestamp(msg.ts)}] OCR="${ocrText.replace(/\s+/g, " ").slice(0, 60)}" -> ${phone || "-"}`
      );

      if (!phone) return;

      if (queue.some((e) => e.phone === phone)) {
        stats.dupQueueSkipped++;
        log(`SKIP         : ${phone} sudah ada di antrian import`);
        return;
      }
      queue.push({ messageId, phone });
      stats.pendingAdded++;
      log(`PENDING      : ${phone} masuk antrian import (depth ${queue.length})`);
    } catch (err) {
      // Gagal baca/OCR SATU gambar tidak boleh menghentikan keseluruhan import
      stats.ocrFailed++;
      log(`MEDIA_SKIP   : [${formatTimestamp(msg.ts)}] gagal proses "${fileName}" (${err.message})`);
    }
  }

  // ===== klaim "ok" — NEAREST IMAGE / LIFO (ambil gambar terakhir sebelum "ok") =====
  async function handleClaim(msg) {
    const entry = queue.pop(); // LIFO: ambil gambar paling dekat di atas "ok"
    if (!entry) {
      stats.claimsWithoutTarget++;
      log(`CLAIM_SKIP   : "${msg.text.replace(/\s+/g, " ")}" — tidak ada nomor HP pending di antrian import`);
      return;
    }

    const reason = duplicateClaimReason(entry.phone, msg.ts.getTime());
    if (reason) {
      stats.claimsDuplicateSkipped++;
      log(
        `CLAIM_DUP    : [${formatTimestamp(msg.ts)}] ${entry.phone} dilewati (` +
          (reason === "realtime"
            ? "sudah diklaim bot realtime"
            : `klaim serupa tercatat +-${CLAIM_DUP_TOLERANCE_MS / 60000} menit`) +
          ")"
      );
      return;
    }

    // Resolve nama sales ke salah satu dari 6 nama dropdown yang valid.
    // Kalau tidak cocok, baris TIDAK ditulis (skip).
    const salesName = resolvePicNameFromExport(msg.sender);
    if (!salesName || !VALID_SALES_NAMES.includes(salesName)) {
      log(`CLAIM_SKIP   : ${entry.phone} — sales "${salesName || msg.sender}" tidak ada di dropdown, baris dilewati`);
      return;
    }

    // Async BOLEH setelah titik ini — entri sudah terkunci & keluar dari antrian.
    const claimMethod = "FIFO";
    previousClaims.push({ phone: entry.phone, ts: msg.ts.getTime(), salesName });
    rowsBuffer.push({ timestamp: msg.ts, phone: entry.phone, salesName, claimMethod });
    stats.claimsWritten++;
    log(`CLAIMED      : [${formatTimestamp(msg.ts)}] ${entry.phone} <- ${salesName} (${claimMethod})`);

    if (rowsBuffer.length >= SHEET_FLUSH_SIZE) await flushRows(false);
  }

  // ==========================================================
  // LOOP UTAMA — kronologis paling lama -> paling baru
  // ==========================================================
  for (const msg of inRange) {
    const messageId = syntheticMessageId(msg);
    if (processedIds[messageId]) {
      stats.alreadyProcessed++;
      continue;
    }

    const text = msg.text.replace(/\u200e\u200f/g, "").trim();

    const imgMatch = IMAGE_LINE_RE.exec(text);
    if (imgMatch) {
      await handleImage(msg, messageId, imgMatch[1]);
      markProcessed(messageId);
      continue;
    }

    if (OMITTED_MEDIA_RE.test(text)) {
      // "<Media tidak disertakan>" — coba ekstrak nomor dari teks lanjutan
      const { phone: textPhone } = extractPhone(text);
      if (textPhone) {
        if (!queue.some((e) => e.phone === textPhone)) {
          queue.push({ messageId, phone: textPhone });
          stats.pendingAdded++;
          log(`TEXT_PHONE   : [${formatTimestamp(msg.ts)}] ${textPhone} dari teks "${text.slice(0, 60).replace(/\s+/g, " ")}" masuk antrian (depth ${queue.length})`);
        }
      } else {
        stats.omittedMediaSkipped++;
      }
      markProcessed(messageId);
      continue;
    }

    if (NON_IMAGE_HINT_RE.test(text)) {
      stats.nonMediaSkipped++;
      markProcessed(messageId);
      continue;
    }

    // --- teks notifikasi lead terstruktur -> tulis ke Sheet5 ---
    if (msg.text && isLeadNotification(msg.text)) {
      const lead = parseLeadFields(msg.text);
      if (lead) {
        stats.leadsDetected++;
        leadsRowsBuffer.push({
          timestamp: msg.ts,
          phone: lead.phone,
          email: lead.email,
          product: lead.product,
          salesName: lead.salesName,
        });
        log(`LEAD_FOUND   : [${formatTimestamp(msg.ts)}] ${lead.namaCustomer} | ${lead.phone} | ${lead.salesName || "-"}`);
        if (leadsRowsBuffer.length >= SHEET_FLUSH_SIZE) await flushLeadsRows(false);
      }
      markProcessed(messageId);
      continue;
    }

    if (text && config.okKeywords.includes(text.toLowerCase())) {
      await handleClaim(msg);
      markProcessed(messageId);
      continue;
    }

    // Pesan teks biasa lainnya: coba ekstrak nomor HP (dari customer, bukan sales/bot)
    {
      const isBot = /Rio Tsuzumi/i.test(msg.sender);
      const salesName = resolvePicNameFromExport(msg.sender);
      if (!isBot && !salesName) {
        const { phone: textPhone } = extractPhone(text);
        if (textPhone) {
          if (!queue.some((e) => e.phone === textPhone)) {
            queue.push({ messageId, phone: textPhone });
            stats.pendingAdded++;
            log(`TEXT_PHONE   : [${formatTimestamp(msg.ts)}] ${textPhone} dari teks "${text.slice(0, 60).replace(/\s+/g, " ")}" masuk antrian (depth ${queue.length})`);
          }
        }
      }
    }
    markProcessed(messageId);
  }

  await flushRows(true);
  await flushLeadsRows(true);
  persistState(true);

  // ===== ringkasan =====
  log("========== RINGKASAN IMPORT CHAT ==========");
  log(`Sumber          : ${chatFile}`);
  log(`Baris pesan     : ${stats.parsedTotal} parsed | ${stats.beforeCutoff} sebelum cutoff | ${stats.inRange} diproses`);
  log(`Rentang mulai   : ${formatTimestamp(BACKFILL_SINCE)} WIB`);
  log(`Sudah diproses  : ${stats.alreadyProcessed} (dari run sebelumnya, dilewati)`);
  log(`Gambar          : ${stats.imagesFound} ditemukan | file hilang: ${stats.mediaFileMissing} | OCR gagal: ${stats.ocrFailed}`);
  log(`Media lain      : omit ${stats.omittedMediaSkipped} | non-gambar ${stats.nonMediaSkipped}`);
  log(`Nomor pending   : +${stats.pendingAdded} | duplikat di antrian: ${stats.dupQueueSkipped}`);
  log(`Klaim           : ${stats.claimsWritten} ditulis | duplikat: ${stats.claimsDuplicateSkipped} | tanpa target: ${stats.claimsWithoutTarget}`);
  log(`Leads          : ${stats.leadsDetected} terdeteksi | ${stats.leadsWritten} ditulis | gagal: ${stats.leadsFailed}`);
  log(`Baris sheet     : OK ${stats.rowsWritten} | gagal ${stats.rowsFailed}${dryRun ? " (DRY-RUN: tidak benar-benar ditulis)" : ""}`);
  log(`Sisa antrian    : ${queue.length} nomor tak terklaim sampai akhir chat`);
  log(`State ids       : ${PROCESSED_IDS_FILE}`);
  log(`State klaim     : ${CLAIMS_FILE}`);
  log("===========================================");

  if (dryRun) {
    log("DRY_RUN     : state TIDAK disimpan — jalankan tanpa --dry-run untuk eksekusi nyata.");
  }

  // Jangan langsung process.exit: beri jeda 2 detik agar write Sheets
  // terakhir benar-benar ter-commit di server sebelum proses diterminasi
  // (worker Tesseract bisa menahan event loop).
  await delay(2000);
  process.exit(stats.rowsFailed > 0 ? 1 : 0);
}

// Ctrl-C: simpan progres yang sudah ditandai agar aman dijalankan ulang
process.on("SIGINT", () => {
  log("SIGINT       : menghentikan import...");
  if (onGracefulExit) onGracefulExit();
  process.exit(130);
});

if (require.main === module) {
  main().catch((err) => {
    console.error(`FATAL: ${err.stack || err.message}`);
    if (onGracefulExit) onGracefulExit();
    process.exit(1);
  });
}

// Diekspor untuk pengujian parser tanpa menjalankan main()
module.exports = { parseChatText, CHAT_LINE_RE, buildMessageTimestamp };
