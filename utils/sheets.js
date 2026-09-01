/**
 * utils/sheets.js
 * Integrasi Google Sheets untuk menyimpan hasil klaim lead.
 *
 * ### Cara menulis (v2 — Apps Script Web App)
 * Alih-alih auth service account (yang rawan `invalid_grant`), penulisan
 * dilakukan lewat Web App Google Apps Script yang di-deploy dari spreadsheet.
 * Node cukup melakukan `fetch(POST)` ke GOOGLE_SHEETS_WEBAPP_URL dengan payload:
 *
 *   { tab: namaTab, token: GOOGLE_SHEETS_WEBAPP_TOKEN, values: [[...], ...] }
 *
 * Web app-nya yang meng-append langsung ke tab default spreadsheet tsb.
 * Token harus sama dengan filter `doPost` di Apps Script.
 *
 * Struktur kolom yang ditulis (Sheet1 / klaim, 4 kolom, urutan tetap):
 *   Tanggal | Nomor Customer | Nama Sales | Metode Klaim
 *
 * Struktur kolom Sheet5 / leads (5 kolom, urutan tetap):
 *   Tanggal | Nomor Customer | Email | Product | Nama Sales
 *
 *  - Nomor Customer ditulis sebagai TEKS (bukan notasi ilmiah).
 *  - Nama Sales: HARUS salah satu dari VALID_SALES_NAMES (atau kosong).
 *  - Metode Klaim: "Reply" atau "FIFO".
 *
 * Ketahanan:
 *  - Semua error (webapp mati, HTTP error, token salah) ditangani di sini:
 *    fungsi mengembalikan { ok:false } dan TIDAK melempar exception,
 *    supaya bot/backfill tetap jalan.
 */
const config = require("../config/env");
const { log, formatTimestamp } = require("./logger");

// Nama sales yang valid untuk kolom dropdown di spreadsheet.
// Kalau resolved name tidak ada di list ini, baris TIDAK ditulis.
const VALID_SALES_NAMES = ["Alma", "Azzah", "Dhita", "Erik", "Ina", "Sifa"];

/**
 * Kirim satu payload append ke Apps Script Web App.
 * Melempar `Error` saat web app tidak konek / menolak — dipanggil dalam try/catch.
 * @param {{ tab: string, token: string, values: Array<Array<string|number>> }} payload
 */
async function postToWebApp(payload) {
  const res = await fetch(config.googleSheetsWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Web app HTTP ${res.status} ${res.statusText}`);
  }

  // Apps Script ContentService mengembalikan JSON { ok, appended?, error? }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.error || "Web app menolak payload");
  }
}

/**
 * Susun satu baris 4 kolom klaim dari payload klaim (Sheet1).
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
 * Append satu ATAU beberapa baris klaim (tab Sheet1) lewat web app.
 * Dipakai alur realtime (1 baris) dan backfill (batch baris histori).
 * @param {Array<{ timestamp?, phone, salesName, claimMethod }>} rows
 * @returns {Promise<{ok: boolean, appended?: number, error?: string}>}
 */
async function appendSheetRows(rows) {
  try {
    if (!config.googleSheetsWebAppUrl || !config.googleSheetsWebAppToken) {
      throw new Error("GOOGLE_SHEETS_WEBAPP_URL / GOOGLE_SHEETS_WEBAPP_TOKEN belum diisi di .env");
    }
    if (!rows || rows.length === 0) {
      return { ok: true, appended: 0 };
    }

    // Filter baris yang Nama Sales-nya kosong (sales tidak dikenali)
    const validRows = rows.filter((r) => r.salesName && VALID_SALES_NAMES.includes(r.salesName));
    if (validRows.length === 0) {
      return { ok: true, appended: 0 };
    }

    await postToWebApp({
      tab: config.googleSheetTab,
      token: config.googleSheetsWebAppToken,
      values: validRows.map((r) => buildRow(r)),
    });

    return { ok: true, appended: validRows.length };
  } catch (err) {
    // Error TIDAK boleh membuat bot crash -> cukup log & laporkan gagal
    log(`SHEET_ERROR : ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Append satu baris klaim ke spreadsheet target (Sheet1).
 * @param {{ timestamp?: Date|string|number, phone: string, salesName: string, claimMethod?: string }} params
 * @returns {Promise<{ok: boolean, appended?: number, error?: string}>}
 */
async function appendToSheet(params) {
  return appendSheetRows([params]);
}

// ========== LEADS TAB (Sheet5) ==========

/**
 * Susun satu baris 5 kolom untuk tab leads (Sheet5).
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
 * Append satu ATAU beberapa baris lead ke tab terpisah (Sheet5) lewat web app.
 * @param {Array<{ timestamp?, phone, email, product, salesName }>} rows
 * @returns {Promise<{ok: boolean, appended?: number, error?: string}>}
 */
async function appendLeadSheetRows(rows) {
  try {
    if (!config.googleSheetsWebAppUrl || !config.googleSheetsWebAppToken) {
      throw new Error("GOOGLE_SHEETS_WEBAPP_URL / GOOGLE_SHEETS_WEBAPP_TOKEN belum diisi di .env");
    }
    if (!rows || rows.length === 0) {
      return { ok: true, appended: 0 };
    }

    const validRows = rows.filter((r) => r.salesName && VALID_SALES_NAMES.includes(r.salesName));
    if (validRows.length === 0) {
      return { ok: true, appended: 0 };
    }

    await postToWebApp({
      tab: config.googleSheetTabLeads,
      token: config.googleSheetsWebAppToken,
      values: validRows.map((r) => buildLeadRow(r)),
    });

    return { ok: true, appended: validRows.length };
  } catch (err) {
    log(`LEAD_SHEET_ERROR : ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Append satu baris lead ke spreadsheet target (tab leads / Sheet5).
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