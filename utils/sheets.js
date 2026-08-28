/**
 * utils/sheets.js
 * Integrasi Google Sheets untuk menyimpan hasil klaim lead.
 *
 * Struktur kolom yang ditulis (4 kolom, urutan tetap):
 *   Tanggal | Nomor Customer | Nama Sales | Metode Klaim
 *
 *  - Nomor Customer ditulis sebagai TEKS: valueInputOption "USER_ENTERED"
 *    supaya angka panjang tidak tampil sebagai notasi ilmiah / hilang digit.
 *  - Nama Sales: HARUS salah satu dari VALID_SALES_NAMES (atau kosong).
 *  - Metode Klaim: "Reply" atau "FIFO".
 *
 * Keamanan:
 *  - Credential service account dibaca DARI FILE (path lewat env var
 *    GOOGLE_SERVICE_ACCOUNT_PATH). Isi key TIDAK di-hardcode di source/.env.
 *  - File credential ditaruh manual di credentials/service-account.json,
 *    dan folder credentials/ wajib masuk .gitignore.
 *
 * Ketahanan:
 *  - Semua error API (auth invalid, rate limit, dsb) ditangani di sini:
 *    fungsi mengembalikan { ok:false } dan TIDAK melempar exception,
 *    supaya bot/backfill tetap jalan.
 */
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const config = require("../config/env");
const { log, formatTimestamp } = require("./logger");

// Nama sales yang valid untuk kolom dropdown di spreadsheet.
// Kalau resolved name tidak ada di list ini, baris TIDAK ditulis.
const VALID_SALES_NAMES = ["Alma", "Azzah", "Dhita", "Erik", "Ina", "Sifa"];

// Cache client Sheets agar file credential hanya dibaca sekali
let sheetsPromise = null;

async function getSheets() {
  if (!sheetsPromise) {
    sheetsPromise = (async () => {
      // Baca credential dari FILE PATH (bukan hardcode isi key)
      const credPath = path.resolve(config.googleServiceAccountPath);
      const credentials = JSON.parse(fs.readFileSync(credPath, "utf8"));

      // Auth JWT ala service account, scope cukup untuk Sheets API v4
      const auth = new google.auth.JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      return google.sheets({ version: "v4", auth });
    })().catch((err) => {
      sheetsPromise = null; // reset cache -> pemanggilan berikutnya baca ulang file
      throw err;
    });
  }
  return sheetsPromise;
}

/**
 * Susun satu baris 4 kolom dari payload klaim.
 * @param {{ timestamp?: Date|string|number, phone: string, salesName: string, claimMethod?: string }} p
 * @returns {[string, string, string, string]} [Tanggal, Nomor Customer, Nama Sales, Metode Klaim]
 */
function buildRow({ timestamp, phone, salesName, claimMethod }) {
  return [
    formatTimestamp(timestamp ? new Date(timestamp) : new Date()),
    String(phone ?? ""),
    salesName || "",
    claimMethod || "FIFO",
  ];
}

/**
 * Append satu ATAU beberapa baris klaim dalam SATU pemanggilan values.append.
 * Dipakai alur realtime (1 baris) dan backfill (batch baris histori) —
 * struktur kolomnya sama: Tanggal | Nomor Customer | Nama Sales | Metode Klaim.
 * @param {Array<{ timestamp?, phone, salesName, claimMethod }>} rows
 * @returns {Promise<{ok: boolean, appended?: number, error?: string}>}
 */
async function appendSheetRows(rows) {
  try {
    if (!config.googleSheetId) {
      throw new Error("GOOGLE_SHEET_ID belum diisi di .env");
    }
    if (!rows || rows.length === 0) {
      return { ok: true, appended: 0 };
    }

    // Filter baris yang Nama Sales-nya kosong (sales tidak dikenali)
    const validRows = rows.filter((r) => r.salesName && VALID_SALES_NAMES.includes(r.salesName));
    if (validRows.length === 0) {
      return { ok: true, appended: 0 };
    }

    const sheets = await getSheets();

    // USER_ENTERED: nilai diproses sebagai input user, nomor panjang tetap teks
    // jika diawali atau dibungkus kutip ( Sheets formula).
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.googleSheetId,
      range: `${config.googleSheetTab}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: validRows.map((r) => buildRow(r)),
      },
    });

    return { ok: true, appended: validRows.length };
  } catch (err) {
    // Error TIDAK boleh membuat bot crash -> cukup log & laporkan gagal
    log(`SHEET_ERROR : ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Append satu baris klaim ke spreadsheet target.
 * @param {{ timestamp?: Date|string|number, phone: string, salesName: string, claimMethod?: string }} params
 * @returns {Promise<{ok: boolean, appended?: number, error?: string}>}
 */
async function appendToSheet(params) {
  return appendSheetRows([params]);
}

// ========== LEADS TAB (Sheet5) ==========

/**
 * Susun satu baris 5 kolom untuk tab leads.
 * Kolom: Tanggal | Nomor Customer | Email | Product | Nama Sales
 */
function buildLeadRow({ timestamp, phone, email, product, salesName }) {
  return [
    formatTimestamp(timestamp ? new Date(timestamp) : new Date()),
    String(phone ?? ""),
    email || "",
    product || "",
    salesName || "",
  ];
}

/**
 * Append satu ATAU beberapa baris lead ke tab terpisah (Sheet5).
 * @param {Array<{ timestamp?, phone, email, product, salesName }>} rows
 * @returns {Promise<{ok: boolean, appended?: number, error?: string}>}
 */
async function appendLeadSheetRows(rows) {
  try {
    if (!config.googleSheetId) {
      throw new Error("GOOGLE_SHEET_ID belum diisi di .env");
    }
    if (!rows || rows.length === 0) {
      return { ok: true, appended: 0 };
    }

    const validRows = rows.filter((r) => r.salesName && VALID_SALES_NAMES.includes(r.salesName));
    if (validRows.length === 0) {
      return { ok: true, appended: 0 };
    }

    const sheets = await getSheets();
    const tab = config.googleSheetTabLeads || "Sheet5";

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.googleSheetId,
      range: `${tab}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: validRows.map((r) => buildLeadRow(r)),
      },
    });

    return { ok: true, appended: validRows.length };
  } catch (err) {
    log(`LEAD_SHEET_ERROR : ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Append satu baris lead ke spreadsheet target (tab leads).
 * @param {{ timestamp?: Date|string|number, phone: string, email: string, product: string, salesName: string }} params
 * @returns {Promise<{ok: boolean, appended?: number, error?: string}>}
 */
async function appendLeadToSheet(params) {
  return appendLeadSheetRows([params]);
}

module.exports = {
  appendToSheet,
  appendSheetRows,
  appendLeadToSheet,
  appendLeadSheetRows,
  VALID_SALES_NAMES,
};
