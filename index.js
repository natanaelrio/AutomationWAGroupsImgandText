/**
 * index.js
 * Bot WhatsApp Realtime Logger + OCR Nomor Telepon
 *
 * Alur:
 *  1. Koneksi ke WhatsApp via Baileys (WebSocket, tanpa browser).
 *  2. Session disimpan di auth_info_baileys/ -> QR cukup discan sekali.
 *  3. Pesan masuk difilter: hanya dari grup TARGET_GROUP_ID di .env.
 *  4. Setiap pesan dicetak realtime ke console + file log harian.
 *  5. Jika pesan berisi gambar -> download -> simpan ke media/ -> OCR
 *     -> ekstrak nomor HP Indonesia dari hasil OCR -> masuk antrian klaim.
 *  6. Balasan "ok" dari anggota grup -> deteksi klaim (reply-quote atau FIFO)
 *     -> tentukan PIC dari config/picMap.js -> append ke Google Sheets.
 */
const fs = require("fs");
const path = require("path");

// ---- Baileys ----
const makeWASocket = require("baileys").default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
} = require("baileys");

const qrcode = require("qrcode-terminal");
const pino = require("pino");

const config = require("./config/env");
const { log } = require("./utils/logger");
const { runOcr } = require("./utils/ocr");
const { extractPhone } = require("./utils/extractPhone");
const { normalizeSenderId, resolvePicName } = require("./config/picMap");
const pendingPhones = require("./utils/pendingPhones");
const { appendToSheet, appendLeadToSheet, VALID_SALES_NAMES } = require("./utils/sheets");
const { isLeadNotification, parseLeadFields } = require("./utils/leads");

const AUTH_DIR = path.join(__dirname, "auth_info_baileys");
const MEDIA_DIR = path.join(__dirname, "media");

// Pastikan folder runtime tersedia
for (const dir of [AUTH_DIR, MEDIA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Cache nama grup agar tidak query groupMetadata setiap pesan
let groupNameCache = null;

// Buka wrapper pesan (ephemeral / view-once) supaya isi pesan asli terbaca
function unwrapMessage(m) {
  return m?.ephemeralMessage?.message || m?.viewOnceMessage?.message || m;
}

/**
 * Tangani pesan klaim ("ok"/"oke"/"siap"/"ready") dari anggota grup.
 *
 * Strategi pencocokan nomor HP (berlapis, yang paling akurat didahulukan):
 *  1. Reply/quote detection — jika pesan "ok" adalah balasan ke pesan gambar,
 *     contextInfo.stanzaId berisi message id pesan yang di-reply; cocokkan
 *     dengan message id gambar yang sudah masuk antrian hasil OCR.
 *  2. FIFO queue (fallback) — kalau "ok" diketik polos tanpa reply, ambil
 *     entri PALING LAMA yang masih belum diklaim dari antrian.
 *
 * Bebas race condition: pemilihan entri + validasi + pengeluaran dari antrian
 * terjadi SINKRON (tanpa await) SEBELUM operasi async apapun. Jadi kalau dua
 * gambar dikirim beruntun lalu dua "ok" masuk hampir bersamaan (tanpa reply),
 * urutannya pasti: "ok" pertama -> gambar pertama, "ok" kedua -> gambar kedua.
 */
async function handleClaim(senderId, stanzaId) {
  // --- 1. Reply/quote detection ---
  // Cari kandidat dulu TANPA mengubah antrian, supaya validasi
  // "satu nomor hanya boleh diklaim sekali" bisa dijalankan lebih dulu.
  const quoted = stanzaId ? pendingPhones.findByMessageId(stanzaId) : null;

  // --- 2. Fallback: FIFO queue (ok tanpa reply / reply tak dikenal) ---
  const candidate = quoted || pendingPhones.peekOldest();

  if (!candidate) {
    log(`CLAIM_SKIP   : tidak ada nomor HP pending untuk diklaim`);
    return;
  }

  // Satu nomor HP hanya boleh diklaim SATU KALI (first come first served).
  if (pendingPhones.isPhoneClaimed(candidate.phone)) {
    pendingPhones.removePending(candidate.messageId);
    log(`CLAIM_SKIP   : nomor ${candidate.phone} sudah pernah diklaim sebelumnya`);
    return;
  }

  // Klaim resmi: keluarkan dari antrian + catat riwayat claimed — SEMUA
  // sinkron. Setelah titik ini entri sudah "terkunci" dan aman dari klaim ganda.
  const entry = quoted
    ? pendingPhones.claimByMessageId(stanzaId, senderId) // splice sinkron
    : pendingPhones.claimOldest(senderId); // shift sinkron

  if (!entry) return;

  // Tentukan metode klaim: Reply jika via reply-quote, FIFO jika via antrian
  const claimMethod = quoted ? "Reply" : "FIFO";

  // Resolve nama sales ke salah satu dari 6 nama dropdown yang valid.
  // Kalau tidak cocok, baris TIDAK ditulis (skip).
  const salesName = resolvePicName(senderId);
  if (!salesName || !VALID_SALES_NAMES.includes(salesName)) {
    log(`CLAIM_SKIP   : ${entry.phone} — sales "${salesName || senderId}" tidak ada di dropdown, baris dilewati`);
    return;
  }

  // Operasi async BOLEH setelah titik ini — append ke Google Sheets.
  // Error ditangani di dalam (non-blocking, tak crash).
  const result = await appendToSheet({
    phone: entry.phone,
    salesName,
    claimMethod,
  });

  // ===== LOG REALTIME KLAIM SESUAI FORMAT SPESIFIKASI =====
  log("========== KLAIM PIC ==========");
  log(`CLAIMED_BY   : ${senderId}`);
  log(`PIC_NAME     : ${salesName}`);
  log(`PHONE        : ${entry.phone}`);
  log(`METHOD       : ${claimMethod}`);
  log(`SHEET_STATUS : ${result.ok ? "success" : "failed"}`);
  log("================================");
}

async function startBot() {
  // ==========================================================
  // 1. KONEKSI & AUTENTIKASI
  // useMultiFileAuthState menyimpan session ke auth_info_baileys/
  // sehingga QR hanya perlu discan sekali (kecuali logout dari HP).
  // ==========================================================
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Ambil versi WhatsApp Web terbaru (kalau offline, pakai versi bawaan Baileys)
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    version,
    auth: state,
    // Baileys mewajibkan logger internal; level "silent" agar console bersih
    logger: pino({ level: "silent" }),
    syncFullHistory: false,
  });

  // Simpan session setiap kali kredensial diperbarui
  sock.ev.on("creds.update", saveCreds);

  // ==========================================================
  // QR LOGIN & AUTO-RECONNECT
  // ==========================================================
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR ditampilkan di terminal saat login pertama kali
    if (qr) {
      console.log("\nScan QR berikut dengan WhatsApp > Perangkat Tertaut:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      log("Koneksi WhatsApp TERHUBUNG.");
      log(`Antrian pending: ${pendingPhones.count()} nomor menunggu klaim`);
      // Opsional: ambil nama grup target agar log lebih mudah dibaca
      try {
        const meta = await sock.groupMetadata(config.targetGroupId);
        groupNameCache = meta.subject;
        log(`Grup target   : ${groupNameCache} (${config.targetGroupId})`);
      } catch (err) {
        log(`Peringatan    : gagal ambil metadata grup (${err.message}). Cek TARGET_GROUP_ID.`);
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // Reconnect untuk SEMUA alasan KECUALI logout manual dari HP
      if (statusCode !== DisconnectReason.loggedOut) {
        log(`Koneksi terputus (code ${statusCode ?? "?"}). Reconnect dalam 3 detik...`);
        setTimeout(startBot, 3000);
      } else {
        log("Sesi logged out. Hapus folder auth_info_baileys/ lalu jalankan ulang untuk scan QR baru.");
      }
    }
  });

  // ==========================================================
  // 2-5. FILTER GRUP + LOG REALTIME + OCR GAMBAR
  // ==========================================================
  sock.ev.on("messages.upsert", async (upsert) => {
    // "notify" = pesan realtime baru; "append" = histori lama hasil sync
    // (diabaikan supaya tidak spam saat pertama kali login)
    if (upsert.type !== "notify") return;

    for (const msg of upsert.messages) {
      if (!msg.message) continue; // pesan kosong / protocol message

      const chatId = msg.key.remoteJid;

      // FILTER GRUP: proses HANYA pesan dari grup target di .env.
      // Pesan dari chat pribadi / grup lain langsung dilewati.
      if (chatId !== config.targetGroupId) continue;

      const content = unwrapMessage(msg.message);
      const senderId = msg.key.participant || chatId; // di grup = nomor pengirim
      const fromMe = Boolean(msg.key.fromMe);
      const imageMsg = content.imageMessage || null;

      // Teks mentah sebelum dirapatkan (untuk deteksi notifikasi lead multi-baris)
      const rawText = (
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        ""
      ).trim();

      // Ambil teks pesan / caption gambar (rapatkan jadi satu baris)
      const text = rawText.replace(/\s+/g, " ").trim();

      // ===== LOG REALTIME SESUAI FORMAT SPESIFIKASI =====
      log("========== PESAN MASUK ==========");
      log(`TYPE       : ${upsert.type}`);
      log(`GROUP      : ${chatId}`);
      if (groupNameCache) log(`GROUP_NAME : ${groupNameCache}`);
      log(`FROM       : ${senderId}`);
      log(`FROM ME    : ${fromMe}`);
      log(`TEXT       : ${text || "-"}`);
      log(`HAS_IMAGE  : ${Boolean(imageMsg)}`);

      // ===== DETEKSI GAMBAR -> DOWNLOAD -> OCR -> EKSTRAK NOMOR =====
      if (imageMsg) {
        try {
          // Download buffer gambar. Kalau media sudah kadaluarsa di server,
          // Baileys otomatis minta re-upload via ctx.reuploadRequest.
          const buffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            {
              logger: pino({ level: "silent" }),
              reuploadRequest: sock.updateMediaMessage.bind(sock),
            }
          );

          // Simpan gambar ke media/<timestamp>_<sender>.jpg
          const safeSender = String(senderId).replace(/[^0-9A-Za-z]/g, "");
          const filePath = path.join(MEDIA_DIR, `${Date.now()}_${safeSender}.jpg`);
          fs.writeFileSync(filePath, buffer);
          log(`IMAGE_SAVED : ${filePath}`);

          // OCR seluruh gambar (versi awal, tanpa crop area tertentu)
          const ocrText = await runOcr(buffer);
          log(`OCR_TEXT     : ${ocrText.replace(/\s+/g, " ").trim()}`);

          // Ekstrak nomor HP Indonesia dari hasil OCR
          const { phone } = extractPhone(ocrText);
          log(`PHONE_FOUND  : ${phone || "-"}`);

          // Nomor hasil OCR masuk antrian "menunggu diklaim".
          // Saat nanti ada yang membalas "ok", entri inilah yang diambil.
          if (phone) {
            pendingPhones.addPending({
              messageId: msg.key.id,
              phone,
              groupName: groupNameCache || chatId,
            });
            log(`PENDING_QUEUE: ${phone} menunggu klaim (antrian: ${pendingPhones.count()})`);
          }
        } catch (err) {
          // Error download/OCR TIDAK boleh membuat aplikasi crash
          log(`OCR_ERROR    : ${err.message}`);
        }
      }

      // ===== DETEKSI NOTIFIKASI LEAD TERSTRUKTUR -> TULIS KE SHEET5 =====
      if (!imageMsg && rawText && isLeadNotification(rawText)) {
        const lead = parseLeadFields(rawText);
        if (lead) {
          const result = await appendLeadToSheet({
            phone: lead.phone,
            email: lead.email,
            product: lead.product,
            salesName: lead.salesName,
          });
          log("========== LEAD NOTIFICATION ==========");
          log(`LEAD_DETECT  : notifikasi lead terstruktur terdeteksi`);
          log(`CUSTOMER     : ${lead.namaCustomer}`);
          log(`PHONE        : ${lead.phone}`);
          log(`EMAIL        : ${lead.email}`);
          log(`PRODUCT      : ${lead.product}`);
          log(`SALES        : ${lead.salesName || "-"}`);
          log(`SHEET_STATUS : ${result.ok ? "success" : "failed"}`);
          log("=======================================");
        }
        log("==================================");
        continue;
      }

      // ===== DETEKSI BALASAN KLAIM "OK" -> TETAPKAN PIC -> APPEND SHEET =====
      // Hanya pesan TEKS polos (bukan gambar) yang dicek sebagai klaim.
      // stanzaId ada kalau "ok" dikirim sebagai reply ke pesan gambar tertentu.
      if (!imageMsg && text && config.okKeywords.includes(text.toLowerCase())) {
        const stanzaId = content.extendedTextMessage?.contextInfo?.stanzaId || null;
        await handleClaim(senderId, stanzaId);
      }

      log("==================================");
    }
  });
}

// Bersihkan antrian nomor kadaluarsa (CLAIM_WINDOW_MINUTES) tiap 1 menit
setInterval(() => pendingPhones.purgeExpired(), 60 * 1000);

startBot().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
