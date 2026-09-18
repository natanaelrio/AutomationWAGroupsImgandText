/**
 * apps-script/Code.gs
 * Google Apps Script — Web App penerima POST dari bot Node.
 *
 * DEPLOY:
 *  1. Buka spreadsheet target -> Extensions > Apps Script
 *  2. Hapus kode default, tempel seluruh file ini, simpan.
 *  3. Deploy > New deployment > jenis: Web app
 *     - Execute as: Me
 *     - Who has access: Anyone
 *  4. Salin Web app URL -> isi GOOGLE_SHEETS_WEBAPP_URL di .env
 *  5. Ganti WEBAPP_TOKEN di bawah dengan token rahasia Anda
 *     -> isi GOOGLE_SHEETS_WEBAPP_TOKEN di .env dengan nilai yang SAMA.
 *
 * Payload yang diterima (dari utils/sheets.js):
 *   { tab: "Custumer Leads", token: "rahasia", values: [[...], ...] }
 *
 * Semua data (klaim & lead) ditulis ke SATU tab "Custumer Leads"
 * dengan 4 kolom: Tanggal | Nomor Customer | Nama Sales | Sumber Lead
 * (Sumber Lead diisi otomatis oleh bot: GRUP SALES PT / WEB PELANGI).
 */

// GANTI dengan token rahasia Anda. Harus SAMA dengan GOOGLE_SHEETS_WEBAPP_TOKEN di .env
var WEBAPP_TOKEN = "wa-sheet-11ef5f1b3e075ccaae124095c97550bc29c4067183f10100";

// Nama sheet (tab) -> key string nama tab
var SPREADSHEET_ID = undefined; // kosongkan = pakai spreadsheet tempat script ini di-bind

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    if (payload.token !== WEBAPP_TOKEN) {
      return respond_(401, { ok: false, error: "Token salah" });
    }

    var tab = String(payload.tab || "Sheet1");
    var values = payload.values || [];

    var ss = SPREADSHEET_ID
      ? SpreadsheetApp.openById(SPREADSHEET_ID)
      : SpreadsheetApp.getActiveSpreadsheet();

    var sheet = ss.getSheetByName(tab);
    if (!sheet) {
      return respond_(400, { ok: false, error: "Tab tidak ditemukan: " + tab });
    }

    var appended = 0;
    values.forEach(function (row) {
      if (Array.isArray(row) && row.length > 0) {
        // formatTimestamp WIB-ish: "YYYY-MM-DD HH:mm:ss" — biarkan apa adanya
        sheet.appendRow(row);
        appended++;
      }
    });

    return respond_(200, { ok: true, appended: appended });
  } catch (err) {
    return respond_(500, { ok: false, error: String(err) });
  }
}

function respond_(status, obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Optional: test manual dari editor Apps Script (jalankan testPost_ lalu lihat Log)
function testPost_() {
  var fakeEvent = {
    postData: {
      contents: JSON.stringify({
        token: WEBAPP_TOKEN,
        tab: "Custumer Leads",
        values: [["Test", "6281234567890", "Alma", "GRUP SALES PT"]],
      }),
    },
  };
  Logger.log(doPost(fakeEvent).getContent());
}
