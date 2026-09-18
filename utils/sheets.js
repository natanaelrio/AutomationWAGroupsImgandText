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
*  Web app-nya yang meng-append langsung ke tab default spreadsheet tsb.
 *  Token harus sama dengan filter `doPost` di Apps Script.
 *
 *  SEMUA data (klaim & lead) ditulis ke SATU tab: config.googleSheetTab
 *  ("Custumer Leads"), dengan 4 kolom, urutan tetap:
 *   Tanggal | Nomor Customer | Nama Sales | Sumber Lead
 *
 *  Sumber Lead diisi otomatis berdasarkan alur data:
 *   - alur klaim (balasan "ok" / OCR screenshot) -> "GRUP SALES PT"
 *   - alur notifikasi lead terstruktur            -> "WEB PELANGI"
 *
 *  - Nomor Customer ditulis sebagai TEKS (bukan notasi ilmiah).
 *  - Nama Sales: HARUS salah satu dari VALID_SALES_NAMES (atau kosong).
 *  - Field lama (Metode Klaim, Email, Product) TIDAK lagi ditulis.
 *
 *  Ketahanan:
 *  - Semua error (webapp mati, HTTP error, token salah) ditangani di sini:
 *    fungsi mengembalikan { ok:false } dan TIDAK melempar exception,
 *    supaya bot/backfill tetap jalan.
 */
const config = require("../config/env");
const { log, formatTimestamp } = require("./logger");

// Nama sales yang valid untuk kolom dropdown di spreadsheet.
// Kalau resolved name tidak ada di list ini, baris TIDAK ditulis.
const VALID_SALES_NAMES = ["Alma", "Azzah", "Dhita", "Erik", "Ina", "Sifa"];

// Nilai otomatis kolom "Sumber Lead" berdasarkan alur data.
const SOURCE_GRUP = "GRUP SALES PT"; // alur klaim (dulu tab Sheet1)
const SOURCE_WEB = "WEB PELANGI";    // alur notifikasi lead terstruktur (dulu tab Sheet5)

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
 * Susun satu baris 4 kolom klaim dari payload klaim (tab Custumer Leads).
 * Kolom: Tanggal | Nomor Customer | Nama Sales | Sumber Lead ("GRUP SALES PT")
 * @param {{ timestamp?: Date|string|number, phone: string, salesName: string }} p
 * @returns {[string, string, string, string]}
 */
function buildRow({ timestamp, phone, salesName }) {
  return [
    formatTimestamp(timestamp ? new Date(timestamp) : new Date()),
    String(phone ?? ""),
    salesName || "",
    SOURCE_GRUP,
  ];
}

/**
 * Append satu ATAU beberapa baris klaim (tab Custumer Leads) lewat web app.
 * Dipakai alur realtime (1 baris) dan backfill (batch baris histori).
 * @param {Array<{ timestamp?, phone, salesName, claimMethod? }>} rows
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
 * Append satu baris klaim ke spreadsheet target (tab Custumer Leads).
 * @param {{ timestamp?: Date|string|number, phone: string, salesName: string, claimMethod?: string }} params
 * @returns {Promise<{ok: boolean, appended?: number, error?: string}>}
 */
async function appendToSheet(params) {
  return appendSheetRows([params]);
}

// ========== LEADS (tab Custumer Leads) ==========

/**
 * Susun satu baris 4 kolom untuk tab leads (Custumer Leads).
 * Kolom: Tanggal | Nomor Customer | Nama Sales | Sumber Lead ("WEB PELANGI")
 * Field email & product dari payload DIABAIKAN (tidak lagi ditulis).
 */
function buildLeadRow({ timestamp, phone, salesName }) {
  return [
    formatTimestamp(timestamp ? new Date(timestamp) : new Date()),
    String(phone ?? ""),
    salesName || "",
    SOURCE_WEB,
  ];
}

/**
 * Append satu ATAU beberapa baris lead ke tab Custumer Leads lewat web app.
 * @param {Array<{ timestamp?, phone, email?, product?, salesName }>} rows
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
      tab: config.googleSheetTab,
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
 * Append satu baris lead ke spreadsheet target (tab Custumer Leads).
 * @param {{ timestamp?: Date|string|number, phone: string, email?: string, product?: string, salesName: string }} params
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
  SOURCE_GRUP,
  SOURCE_WEB,
};
