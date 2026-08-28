"use strict";

/**
 * scripts/backfillHistory.js
 * Backfill histori pesan grup target dari 11 Agustus 2026 s.d. sekarang.
 *
 * Pendekatan: ON-DEMAND HISTORY REQUEST (BUKAN pasif).
 *  Hasil tes: syncFullHistory pasif TIDAK cukup untuk sesi lama — bulk dump
 *  histori hanya dikirim WhatsApp di sekitar SESI PERTAMA kali pairing (scan
 *  QR); reconnect biasa tidak memicu ulang dump itu. Karena itu script ini
 *  AKTIF meminta histori mundur-per-chunk lewat
 *  sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestampMs):
 *   1. Dapat 1 pesan ANCHOR di grup target yang sudah diketahui lokal —
 *      otomatis dari chunk sync awal / pesan live yang masuk selama script
 *      jalan (kalau tidak kunjung masuk: kirim 1 pesan test ke grup itu).
 *   2. Request 50 pesan SEBELUM anchor; hasil tiba via event
 *      "messaging-history.set" (syncType ON_DEMAND) dan dikumpulkan.
 *   3. Anchor baru = pesan PALING LAMA dari hasil chunk; ulangi sampai
 *      timestamp <= 11 Agustus 2026 00.00 WIB, atau sampai tidak ada pesan
 *      baru lagi (histori benar-benar habis).
 *   4. Jeda ~2.5 detik antar pemanggilan supaya tidak dianggap spam.
 *
 *  Batasan mendasar (bukan soal kode): histori hanya bisa ditarik bila nomor
 *  bot SUDAH anggota grup itu sejak sebelum tanggal cutoff (dan historinya
 *  tersimpan di HP utama sesi ini) — batasan enkripsi end-to-end WhatsApp.
 *  Kalau anchor valid tapi selalu 0 hasil: kemungkinan bug versi Baileys rc —
 *  cek `npm list baileys` dan update ke versi terbaru sebelum debug lanjut.
 *
 * Setelah terkumpul:
 *  - Pesan difilter timestamp >= cutoff lalu diurutkan PALING LAMA ->
 *    PALING BARU, supaya antrian FIFO & klaim "ok" berjalan kronologis
 *    persis seperti real-time.
 *  - Tiap gambar: download media -> OCR -> ekstrak nomor -> antrian lokal.
 *    Media kadaluarsa (gagal download) hanya dilog & dilewati (non-blocking).
 *  - Tiap teks "ok"/"oke"/"siap"/"ready": logic klaim sama dengan bot
 *    realtime (prioritas reply-quote, fallback FIFO). Pengambilan entri +
 *    pengeluaran dari antrian terjadi SINKRON sebelum operasi async apapun
 *    (bebas race condition).
 *  - Hasil klaim ditulis ke spreadsheet yang sama, struktur kolom baru:
 *    Tanggal | Nomor Customer | Nama Sales | Metode Klaim (batch per values.append,
 *    valueInputOption USER_ENTERED agar nomor panjang tetap teks).
 *  - Antrian FIFO lokal menerapkan CLAIM_WINDOW_MINUTES: entry yang tidak
 *    diklaim dalam durasi ini dianggap hangus dan dibuang (non-blocking).
 *
 * Idempoten: semua message id yang sudah ditangani dicatat di
 * data/backfillProcessed.json — jalankan ulang tidak menduplikasi baris.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const makeWASocket = require("baileys").default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
} = require("baileys");

const qrcode = require("qrcode-terminal");
const pino = require("pino");

const config = require("../config/env");
const picMap = require("../config/picMap");
const { log, formatTimestamp } = require("../utils/logger");
const { runOcr } = require("../utils/ocr");
const { extractPhone } = require("../utils/extractPhone");
const { appendSheetRows, appendLeadSheetRows, VALID_SALES_NAMES } = require("../utils/sheets");
const { isLeadNotification, parseLeadFields } = require("../utils/leads");

// ---------- konstanta ----------
const AUTH_DIR = path.join(__dirname, "..", "auth_info_baileys");
const DATA_DIR = path.join(__dirname, "..", "data");
const PROCESSED_FILE = path.join(DATA_DIR, "backfillProcessed.json");
const PENDING_FILE = path.join(DATA_DIR, "pendingPhones.json");

// Batas awal backfill: 11 Agustus 2026 00.00 WIB (UTC+7)
const BACKFILL_SINCE = new Date("2026-08-11T00:00:00+07:00");
const SINCE_EPOCH_SEC = Math.floor(BACKFILL_SINCE.getTime() / 1000);

// Tuning proses
const ON_DEMAND_MSG_COUNT = 50;          // maks pesan per fetchMessageHistory
const FETCH_INTERVAL_MS = 2_500;         // jeda antar request (anti-spam, 2-3 detik)
const ANCHOR_MAX_WAIT_MS = 5 * 60_000;   // batas tunggu anchor pertama
const ANCHOR_HINT_EVERY_MS = 20_000;     // interval pengingat "kirim pesan test"
const PAGE_RESULT_TIMEOUT_MS = 90_000;   // tunggu balasan satu request on-demand
const EMPTY_RETRIES = 1;                 // retry sekali sebelum nyatakan histori habis
const MAX_PAGES = 500;                   // pengaman jumlah request
const HARD_TIME_LIMIT_MS = 30 * 60_000;  // batas keras total runtime script
const SHEET_FLUSH_SIZE = 25;             // maks baris per pemanggilan values.append
const SHEET_FLUSH_DELAY_MS = 500;        // jeda antar pemanggilan Sheets API
const SAVE_PROCESSED_EVERY = 25;         // simpan backfillProcessed.json tiap N pesan
const MAX_RECONNECT = 5;                 // percobaan reconnect saat fase pengambilan

// Nama syncType untuk log (nilai enum proto.HistorySync.HistorySyncType)
const SYNC_TYPE_NAMES = {
  0: "INITIAL_BOOTSTRAP",
  1: "INITIAL_STATUS_V3",
  2: "FULL",
  3: "RECENT",
  4: "PUSH_NAME",
  5: "NON_BLOCKING_DATA",
  6: "ON_DEMAND",
};

// ---------- helper umum ----------
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Buka wrapper pesan (ephemeral / view-once) supaya isi pesan asli terbaca
function unwrapMessage(m) {
  return m?.ephemeralMessage?.message || m?.viewOnceMessage?.message || m;
}

// Hook pembersihan yang diisi main() agar Ctrl-C tetap menyimpan progres
let onGracefulExit = null;

// ---------- main ----------
async function main() {
  console.log("==========================================================");
  console.log(" BACKFILL HISTORI GRUP (on-demand) - mulai 11 Agustus 2026");
  console.log(" PENTING : hentikan dulu bot realtime (npm start) bila sedang");
  console.log("           jalan - script ini memakai sesi auth yang sama.");
  console.log(` Target  : ${config.targetGroupId}`);
  console.log("==========================================================");

  if (!config.googleSheetId) {
    console.error("[CONFIG] GOOGLE_SHEET_ID belum diisi di .env - backfill butuh menulis ke sheet.");
    process.exit(1);
  }

  // ===== anti-duplikasi lintas run: daftar message id yang sudah diproses =====
  const processed = readJson(PROCESSED_FILE, {}); // { [messageId]: true }
  let processedSinceSave = 0;

  function saveProcessed() {
    writeJson(PROCESSED_FILE, processed);
    processedSinceSave = 0;
  }

  function markProcessed(messageId) {
    if (!messageId || processed[messageId]) return;
    processed[messageId] = true;
    processedSinceSave++;
    if (processedSinceSave >= SAVE_PROCESSED_EVERY) saveProcessed();
  }

  onGracefulExit = saveProcessed; // Ctrl-C tetap menyimpan progres

  // Nomor HP yang sudah diklaim oleh bot realtime (riwayat persist di
  // data/pendingPhones.json) -> nomor yang sama TIDAK ditulis dua kali.
  const claimedPhones = new Set();
  const pendingState = readJson(PENDING_FILE, {});
  for (const c of pendingState.claimed || []) {
    if (c && c.phone) claimedPhones.add(c.phone);
  }

  // ===== koleksi histori =====
  const collected = [];      // pesan unik grup target dalam rentang cutoff
  const seenIds = new Set(); // dedupe message id antar chunk / live / run
  let seqCounter = 0;        // urutan kedatangan (untuk tiebreak sorting)
  let loginLoggedOut = false;
  let reconnectAttempts = 0;
  const startedAt = Date.now();

  const stats = {
    pagesFetched: 0,
    imagesTotal: 0,
    mediaFailed: 0,
    pendingAdded: 0,
    duplicateSkipped: 0,
    claimsWritten: 0,
    claimsWithoutTarget: 0,
    rowsWritten: 0,
    rowsFailed: 0,
    alreadyProcessed: 0,
    leadsDetected: 0,
    leadsWritten: 0,
    leadsFailed: 0,
  };

  // Antrian FIFO LOKAL hasil histori (tidak menyentuh state bot realtime):
  // entri: { messageId, phone, addedAt }
  const queue = [];
  let rowsBuffer = []; // baris sheet klaim tertunda sebelum di-flush batch
  let leadsRowsBuffer = []; // baris sheet leads tertunda

  // ===== expiry antrian lokal: buang entry yang sudah lebih lama dari CLAIM_WINDOW_MINUTES =====
  function purgeExpiredQueue() {
    const minutes = config.claimWindowMinutes;
    if (!minutes || minutes <= 0) return;
    const cutoff = Date.now() - minutes * 60 * 1000;
    const expired = queue.filter((e) => new Date(e.addedAt).getTime() < cutoff);
    if (expired.length > 0) {
      for (const e of expired) {
        log(`NOMOR_HANGUS : ${e.phone} dibuang dari antrian, tidak diklaim dalam ${minutes} menit`);
      }
      const kept = queue.filter((e) => new Date(e.addedAt).getTime() >= cutoff);
      queue.length = 0;
      queue.push(...kept);
    }
  }

  // ---- penerima data: dipanggil handler event saat ada pesan baru masuk ----
  let collectionWaiters = [];

  function signalCollectionChanged() {
    const waiters = collectionWaiters;
    collectionWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // Resolve begitu collected bertambah melewati prevCount, atau timeout
  function waitForCollectionGrowth(prevCount, timeoutMs) {
    if (collected.length > prevCount) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        collectionWaiters = collectionWaiters.filter((w) => w !== wrapped);
        resolve();
      };
      const wrapped = () => finish();
      const timer = setTimeout(finish, timeoutMs);
      collectionWaiters.push(wrapped);
    });
  }

  // ---- koneksi ----
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  let sock = null;

  // Coba simpan 1 pesan ke koleksi (filter grup target + cutoff + dedupe)
  function tryCollect(m, source) {
    if (!m?.message || !m.key) return false;
    if (m.key.remoteJid !== config.targetGroupId) return false;
    const ts = Number(m.messageTimestamp) || 0;
    if (!ts || ts < SINCE_EPOCH_SEC) return false;
    const id = m.key.id;
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    m.__seq = seqCounter++;
    m.__source = source;
    collected.push(m);
    return true;
  }

  function connect() {
    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      // Pasif DIMATIKAN: dump penuh cuma dikirim saat pairing pertama, jadi
      // pengambilan histori dilakukan aktif lewat fetchMessageHistory().
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // WAJIB return true untuk SEMUA syncType termasuk ON_DEMAND — kalau
      // false/tidak return true, balasan request histori ditolak diam-diam
      // oleh Baileys tanpa error yang jelas.
      shouldSyncHistoryMessage: () => true,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\nScan QR berikut dengan WhatsApp > Perangkat Tertaut:\n");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        log("Koneksi WhatsApp TERHUBUNG.");
        log(
          "ANCHOR       : menunggu minimal 1 pesan grup target dikenali lokal"
        );
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          log("Sesi logged out. Hapus folder auth_info_baileys/ lalu scan ulang QR.");
          loginLoggedOut = true;
          return;
        }
        if (reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          log(`Koneksi terputus (code ${statusCode ?? "?"}). Reconnect dalam 3 detik... (${reconnectAttempts}/${MAX_RECONNECT})`);
          setTimeout(() => {
            try {
              connect();
            } catch (err) {
              log(`RECONNECT_ERROR : ${err.message}`);
            }
          }, 3000);
        }
        // Bangunkan waiter supaya tidak menggantung sampai timeout penuh
        signalCollectionChanged();
      }
    });

    // Pesan live (notify) ikut dikumpulkan — ini juga kandidat anchor termudah
    sock.ev.on("messages.upsert", ({ type, messages = [] }) => {
      if (type !== "notify") return;
      let taken = 0;
      for (const m of messages) if (tryCollect(m, "live")) taken++;
      if (taken) {
        log(`LIVE         : +${taken} pesan grup tersimpan (total ${collected.length})`);
        signalCollectionChanged();
      }
    });

    // SEMUA chunk histori (sync awal RECENT maupun ON_DEMAND hasil request)
    // tiba lewat event ini — semuanya dipakai sebagai data + anchor.
    sock.ev.on("messaging-history.set", ({ messages = [], syncType }) => {
      const name = SYNC_TYPE_NAMES[syncType] ?? `TYPE_${syncType}`;
      let taken = 0;
      for (const m of messages) if (tryCollect(m, name)) taken++;
      if (name === "ON_DEMAND" || taken > 0) {
        log(
          `HISTORY_SET  : [${name}] +${taken} pesan grup relevan (total ${collected.length})`
        );
      }
      if (taken > 0) signalCollectionChanged();
    });
  }

  // Pesan paling lama yang sudah terkumpul dari grup target (anchor paging)
  function getOldestCollected() {
    let oldest = null;
    for (const m of collected) {
      if (
        !oldest ||
        Number(m.messageTimestamp) < Number(oldest.messageTimestamp) ||
        (Number(m.messageTimestamp) === Number(oldest.messageTimestamp) &&
          m.__seq > oldest.__seq)
      ) {
        oldest = m;
      }
    }
    return oldest;
  }

  connect();

  // ==========================================================
  // FASE 1 — dapatkan ANCHOR pertama di grup target
  // Chunk sync awal (RECENT) biasanya membawa pesan grup terkini secara
  // otomatis; kalau tidak ada juga, user tinggal kirim 1 pesan test ke grup.
  // ==========================================================
  log(`BACKFILL     : rentang mulai ${formatTimestamp(BACKFILL_SINCE)} WIB`);
  const anchorDeadline = Date.now() + ANCHOR_MAX_WAIT_MS;
  let nextHint = Date.now() + ANCHOR_HINT_EVERY_MS;
  while (
    collected.length === 0 &&
    !loginLoggedOut &&
    Date.now() < anchorDeadline &&
    Date.now() - startedAt < HARD_TIME_LIMIT_MS
  ) {
    if (Date.now() >= nextHint) {
      log(
        "ANCHOR       : belum ada pesan grup target yang dikenali — kirim 1" +
          " pesan test ke grup (atau tunggu sync awal masuk)."
      );
      nextHint = Date.now() + ANCHOR_HINT_EVERY_MS;
    }
    await delay(1000);
  }

  if (loginLoggedOut) {
    saveProcessed();
    process.exitCode = 1;
    return;
  }
  if (collected.length === 0) {
    log(
      "GAGAL        : tidak ada anchor dalam batas tunggu. Pastikan bot bisa" +
        " menerima pesan grup target (cek TARGET_GROUP_ID / keanggotaan grup)," +
        " lalu jalankan ulang."
    );
    saveProcessed();
    process.exitCode = 1;
    return;
  }

  // ==========================================================
  // FASE 2 — paging mundur on-demand sampai cutoff / histori habis
  // ==========================================================
  if (typeof sock?.fetchMessageHistory !== "function") {
    log(
      "FATAL        : sock.fetchMessageHistory tidak tersedia di baileys" +
        " terpasang — jalankan `npm list baileys` dan update ke versi terbaru."
    );
    saveProcessed();
    process.exitCode = 1;
    return;
  }

  let consecutiveEmpty = 0;
  while (
    !loginLoggedOut &&
    stats.pagesFetched < MAX_PAGES &&
    Date.now() - startedAt < HARD_TIME_LIMIT_MS
  ) {
    const oldest = getOldestCollected();
    if (!oldest) break; // tidak ada pesan grup sama sekali sebagai anchor
    if (Number(oldest.messageTimestamp) <= SINCE_EPOCH_SEC) break; // cutoff tercapai

    const before = collected.length;
    log(
      `ON_DEMAND    : req #${stats.pagesFetched + 1} — minta ${ON_DEMAND_MSG_COUNT}` +
        ` pesan sebelum ${formatTimestamp(new Date(Number(oldest.messageTimestamp) * 1000))}`
    );
    try {
      await sock.fetchMessageHistory(
        ON_DEMAND_MSG_COUNT,
        oldest.key,
        Number(oldest.messageTimestamp) * 1000 // parameter dalam MILIDETIK
      );
    } catch (err) {
      log(`ON_DEMAND    : gagal kirim request (${err.message}) — lanjut dengan yang terkumpul`);
      break;
    }
    stats.pagesFetched++;

    // Tunggu balasan tiba; quiet tanpa tambahan -> histori habis ATAU bug versi
    await waitForCollectionGrowth(before, PAGE_RESULT_TIMEOUT_MS);
    const gained = collected.length - before;
    if (gained > 0) {
      consecutiveEmpty = 0;
      log(`ON_DEMAND    : +${gained} pesan baru (total ${collected.length})`);
    } else {
      consecutiveEmpty++;
      if (consecutiveEmpty > EMPTY_RETRIES) {
        log("ON_DEMAND    : tidak ada pesan baru lagi — histori dianggap habis.");
        log(
          "               (kalau posisi ini masih jauh di atas 11 Agustus:" +
            " kemungkinan bug versi Baileys — `npm list baileys`, update dulu)"
        );
        break;
      }
      log("ON_DEMAND    : balasan kosong — coba sekali lagi dengan anchor yang sama...");
    }

    await delay(FETCH_INTERVAL_MS); // jeda anti-spam antar pemanggilan
  }

  if (loginLoggedOut) {
    saveProcessed();
    process.exitCode = 1;
    return;
  }

  // ==========================================================
  // FASE 3 — urutkan PALING LAMA -> PALING BARU (wajib, kronologis)
  // ==========================================================
  collected.sort((a, b) => {
    const d = Number(a.messageTimestamp) - Number(b.messageTimestamp);
    if (d !== 0) return d;
    // Timestamp WA presisinya detik; tie-break pakai urutan kedatangan
    // (chunk datang newest -> oldest, seq LEBIH BESAR = pesan lebih lama).
    return b.__seq - a.__seq;
  });

  // Snapshot supaya pesan live yang datang belakangan tidak menyisip di
  // tengah iterasi — sisanya ditangani bot realtime setelah script selesai.
  const ordered = collected.slice();

  log(
    `BACKFILL     : ${ordered.length} pesan grup siap diproses kronologis` +
      ` (${stats.pagesFetched}x request on-demand)`
  );

  // ===== flush batch baris ke Sheets (rate-limit friendly) =====
  async function flushRows(isFinal) {
    if (rowsBuffer.length === 0) return;
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
      log(`SHEET_APPEND : GAGAL, ${stats.rowsFailed} baris tidak tertulis (${result.error})`);
    } else {
      // biarkan di buffer untuk dicoba lagi pada flush berikutnya
      log(`SHEET_APPEND : gagal (${result.error}) - baris ditahan untuk retry`);
      await delay(SHEET_FLUSH_DELAY_MS);
    }
  }

  // ===== flush batch baris leads ke Sheets =====
  async function flushLeadsRows(isFinal) {
    if (leadsRowsBuffer.length === 0) return;
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
      log(`LEAD_SHEET   : gagal (${result.error}) - baris ditahan untuk retry`);
      await delay(SHEET_FLUSH_DELAY_MS);
    }
  }

  // ===== klaim pada konteks histori (sama seperti realtime, race-free) =====
  async function handleBackfillClaim(senderId, stanzaId, msgTime, text) {
    // SINKRON dulu: tentukan entri (reply-quote prioritas, FIFO fallback)
    // dan keluarkan dari antrian SEBELUM operasi async apapun.
    let idx = -1;
    let claimMethod = "FIFO";
    if (stanzaId) {
      idx = queue.findIndex((e) => e.messageId === stanzaId);
      if (idx !== -1) claimMethod = "Reply";
    }
    // FIFO fallback: buang entry expired dulu, baru ambil yang paling lama
    if (idx === -1) {
      purgeExpiredQueue();
      if (queue.length > 0) idx = 0;
    }
    if (idx === -1) {
      stats.claimsWithoutTarget++;
      log(`CLAIM_SKIP   : "${text}" - tidak ada nomor HP pending di histori`);
      return;
    }

    const [entry] = queue.splice(idx, 1); // ambil + keluar dari antrian secara sinkron
    claimedPhones.add(entry.phone); // cegah nomor sama diklaim dua kali di run ini

    // Resolve nama sales ke salah satu dari 6 nama dropdown yang valid.
    // Kalau tidak cocok, baris TIDAK ditulis (skip).
    const salesName = picMap.resolvePicName(senderId);
    if (!salesName || !VALID_SALES_NAMES.includes(salesName)) {
      log(`CLAIM_SKIP   : ${entry.phone} — sales "${salesName || senderId}" tidak ada di dropdown, baris dilewati`);
      return;
    }

    // Operasi async BOLEH setelah titik ini - entri sudah "terkunci".
    rowsBuffer.push({ timestamp: msgTime, phone: entry.phone, salesName, claimMethod });
    stats.claimsWritten++;
    log(`CLAIMED      : [${formatTimestamp(msgTime)}] ${entry.phone} <- ${salesName} (${claimMethod})`);

    if (rowsBuffer.length >= SHEET_FLUSH_SIZE) await flushRows(false);
  }

  // ===== proses satu pesan histori =====
  async function processOne(msg) {
    const id = msg.key.id;
    if (processed[id]) {
      stats.alreadyProcessed++;
      return;
    }

    const msgTime = new Date(Number(msg.messageTimestamp) * 1000);
    const content = unwrapMessage(msg.message);
    const senderId = msg.key.participant || msg.key.remoteJid;
    const imageMsg = content.imageMessage || null;
    // Teks mentah sebelum dirapatkan (untuk deteksi notifikasi lead multi-baris)
    const rawText = (
      content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      ""
    ).trim();
    const text = rawText.replace(/\s+/g, " ").trim();

    // --- gambar: download -> OCR -> ekstrak nomor -> antrian lokal ---
    if (imageMsg) {
      stats.imagesTotal++;
      try {
        const buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: pino({ level: "silent" }),
            reuploadRequest: sock.updateMediaMessage.bind(sock),
          }
        );
        const ocrText = await runOcr(buffer);
        const { phone } = extractPhone(ocrText);
        log(`IMAGE_OK     : [${formatTimestamp(msgTime)}] OCR="${ocrText.replace(/\s+/g, " ").slice(0, 60)}" -> ${phone || "-"}`);

        if (phone) {
          if (claimedPhones.has(phone)) {
            stats.duplicateSkipped++;
            log(`SKIP         : ${phone} sudah pernah diklaim sebelumnya`);
          } else if (queue.some((e) => e.phone === phone)) {
            stats.duplicateSkipped++;
            log(`SKIP         : ${phone} sudah ada di antrian histori`);
          } else {
            queue.push({ messageId: id, phone, addedAt: new Date(Number(msg.messageTimestamp) * 1000).toISOString() });
            stats.pendingAdded++;
            log(`PENDING      : ${phone} masuk antrian histori (depth ${queue.length})`);
          }
        }
      } catch (err) {
        // Media kadaluarsa / gagal download: log & SKIP pesan ini saja,
        // jangan hentikan keseluruhan proses backfill (non-blocking).
        stats.mediaFailed++;
        log(`MEDIA_SKIP   : [${formatTimestamp(msgTime)}] gagal ambil media (${err.message})`);
      }
      markProcessed(id); // gambar sudah ditangani (berhasil/gagal) -> tak diproses ulang
      return;
    }

    // --- teks notifikasi lead terstruktur -> tulis ke Sheet5 ---
    if (!imageMsg && rawText && isLeadNotification(rawText)) {
      const lead = parseLeadFields(rawText);
      if (lead) {
        stats.leadsDetected++;
        leadsRowsBuffer.push({
          timestamp: msgTime,
          phone: lead.phone,
          email: lead.email,
          product: lead.product,
          salesName: lead.salesName,
        });
        log(`LEAD_FOUND   : [${formatTimestamp(msgTime)}] ${lead.namaCustomer} | ${lead.phone} | ${lead.salesName || "-"}`);
        if (leadsRowsBuffer.length >= SHEET_FLUSH_SIZE) await flushLeadsRows(false);
      }
      markProcessed(id);
      return;
    }

    // --- teks klaim "ok"/"oke"/"siap"/"ready" ---
    if (text && config.okKeywords.includes(text.toLowerCase())) {
      const stanzaId = content.extendedTextMessage?.contextInfo?.stanzaId || null;
      await handleBackfillClaim(senderId, stanzaId, msgTime, text);
    }

    markProcessed(id); // pesan lain juga ditandai agar tak dipindai ulang
  }

  // ===== loop utama: proses kronologis paling lama -> paling baru =====
  for (const msg of ordered) {
    if (loginLoggedOut) break;
    if (Date.now() - startedAt > HARD_TIME_LIMIT_MS) {
      log("TIME_LIMIT   : batas waktu tercapai - hentikan proses.");
      break;
    }
    try {
      await processOne(msg);
    } catch (err) {
      log(`MSG_ERROR    : ${err.stack || err.message}`);
      markProcessed(msg.key?.id);
    }
  }

  await flushRows(true);
  await flushLeadsRows(true);
  saveProcessed();

  // ===== ringkasan =====
  log("========== RINGKASAN BACKFILL ==========");
  log(`Rentang         : ${formatTimestamp(BACKFILL_SINCE)} s.d. sekarang (WIB)`);
  log(`Pesan grup      : ${ordered.length} unik diproses`);
  log(`Request history : ${stats.pagesFetched}x on-demand (@${ON_DEMAND_MSG_COUNT}/req)`);
  log(`Sudah diproses  : ${stats.alreadyProcessed} (dari run sebelumnya, dilewati)`);
  log(`Gambar          : ${stats.imagesTotal} | media gagal/kadaluarsa: ${stats.mediaFailed}`);
  log(`Nomor pending   : +${stats.pendingAdded} | duplikat dilewati: ${stats.duplicateSkipped}`);
  log(`Klaim           : ${stats.claimsWritten} ditulis | tanpa target: ${stats.claimsWithoutTarget}`);
  log(`Leads          : ${stats.leadsDetected} terdeteksi | ${stats.leadsWritten} ditulis | gagal: ${stats.leadsFailed}`);
  log(`Baris sheet     : OK ${stats.rowsWritten} | gagal ${stats.rowsFailed}`);
  log(`Sisa antrian    : ${queue.length} nomor tak terklaim sampai akhir histori`);
  log(`Prosesed ids    : ${PROCESSED_FILE}`);
  log("========================================");

  // Tutup koneksi dengan rapi
  try {
    sock.end(undefined);
  } catch {
    /* abaikan */
  }
}

// Ctrl-C: simpan progres yang sudah ditandai agar aman dijalankan ulang
process.on("SIGINT", () => {
  log("SIGINT       : menghentikan backfill...");
  if (onGracefulExit) onGracefulExit();
  process.exit(130);
});

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  if (onGracefulExit) onGracefulExit();
  process.exit(1);
});
