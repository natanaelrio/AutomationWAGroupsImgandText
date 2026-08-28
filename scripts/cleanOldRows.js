"use strict";

/**
 * scripts/cleanOldRows.js
 * Hapus baris Google Sheets yang memiliki tanggal sebelum 11 Agustus 2026.
 *
 * Pemakaian:
 *   node scripts/cleanOldRows.js [--dry-run]
 *
 * Format tanggal di kolom A:
 *   "Senin, 03/08/2026, 09.34.00" (DD/MM/YYYY)
 *   Baris yang tanggalnya 1-10 Agustus 2026 (atau format tidak dikenali)
 *   akan dihapus.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const config = require("../config/env");

const DRY_RUN = process.argv.includes("--dry-run");

// Tanggal cutoff: 11 Agustus 2026 00:00 WIB
const CUTOFF_DAY = 11;
const CUTOFF_MONTH = 8; // Agustus
const CUTOFF_YEAR = 2026;

// Regex untuk parse DD/MM/YYYY dari format "Senin, 03/08/2026, 09.34.00"
const DATE_RE = /(\d{2})\/(\d{2})\/(\d{4})/;

async function main() {
  console.log("==========================================================");
  console.log(` CLEAN OLD ROWS - hapus baris sebelum 11 Agustus 2026`);
  console.log(` Mode: ${DRY_RUN ? "DRY-RUN (preview saja)" : "HAPUS BARIS"}`);
  console.log("==========================================================");

  if (!config.googleSheetId) {
    console.error("GAGAL: GOOGLE_SHEET_ID belum diisi di .env");
    process.exit(1);
  }

  // Auth
  const credPath = path.resolve(config.googleServiceAccountPath);
  const credentials = JSON.parse(fs.readFileSync(credPath, "utf8"));
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Resolve sheetId dari NAMA tab (jangan hardcode 0 — sheetId 0 bisa jadi
  // tab lain, mis. "Custumer Leads", dan penghapusan bisa salah sasaran).
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.googleSheetId,
  });
  const targetSheet = (meta.data.sheets || []).find(
    (s) => s.properties.title === config.googleSheetTab
  );
  if (!targetSheet) {
    console.error(
      `GAGAL: tab "${config.googleSheetTab}" tidak ditemukan di spreadsheet.`
    );
    process.exit(1);
  }
  const TARGET_SHEET_ID = targetSheet.properties.sheetId;
  console.log(
    `Target tab: "${config.googleSheetTab}" (sheetId=${TARGET_SHEET_ID})`
  );

  // Baca semua data dari tab target
  console.log("\nMembaca data dari Google Sheets...");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range: `${config.googleSheetTab}!A:D`,
  });

  const rows = res.data.values || [];
  console.log(`Total baris di sheet: ${rows.length}`);

  if (rows.length === 0) {
    console.log("Sheet kosong, tidak ada yang perlu dihapus.");
    return;
  }

  // Filter baris yang perlu dihapus (tanggal 1-10 Agustus 2026)
  const rowsToDelete = []; // index 0-based

  for (let i = 0; i < rows.length; i++) {
    const cellA = String(rows[i][0] || "");
    const match = DATE_RE.exec(cellA);

    if (!match) {
      // Format tidak dikenali — skip header atau baris kosong
      // Cek apakah ini header (baris pertama)
      if (i === 0 && (cellA.includes("Tanggal") || cellA.includes("Date"))) {
        continue; // skip header
      }
      // Baris tanpa format tanggal yang dikenali — skip
      continue;
    }

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);

    // Hapus jika: tahun < 2026, atau tahun 2026 tapi bulan < 8, atau bulan 8 tapi hari < 11
    const shouldDelete =
      year < CUTOFF_YEAR ||
      (year === CUTOFF_YEAR && month < CUTOFF_MONTH) ||
      (year === CUTOFF_YEAR && month === CUTOFF_MONTH && day < CUTOFF_DAY);

    if (shouldDelete) {
      rowsToDelete.push({
        index: i,
        date: cellA,
        row: rows[i],
      });
    }
  }

  console.log(`\nBaris yang akan dihapus: ${rowsToDelete.length}`);

  if (rowsToDelete.length === 0) {
    console.log("Tidak ada baris yang perlu dihapus.");
    return;
  }

  // Tampilkan preview
  console.log("\n--- PREVIEW (10 baris pertama) ---");
  for (const r of rowsToDelete.slice(0, 10)) {
    console.log(`  Baris ${r.index + 1}: ${r.date} | ${r.row[1] || ""} | ${r.row[2] || ""}`);
  }
  if (rowsToDelete.length > 10) {
    console.log(`  ... dan ${rowsToDelete.length - 10} baris lainnya`);
  }

  if (DRY_RUN) {
    console.log("\nDRY-RUN: tidak ada baris yang dihapus.");
    return;
  }

  // Hapus baris dari bawah ke atas (agar index tidak bergeser)
  console.log("\nMenghapus baris...");

  // Sort descending by index
  const sorted = rowsToDelete.sort((a, b) => b.index - a.index);

  let deleted = 0;
  let failed = 0;

  for (const r of sorted) {
    // Convert 0-based index to 1-based for Sheets API
    // Row 1 in Sheets = index 0 in array = header
    // We need to delete row (r.index + 1) in the sheet
    const sheetRowIndex = r.index + 1; // 1-based

    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.googleSheetId,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: TARGET_SHEET_ID,
                  dimension: "ROWS",
                  startIndex: r.startIndex,
                  endIndex: r.endIndex,
                },
              },
            },
          ],
        },
      });
      deleted++;
      if (deleted % 10 === 0) {
        console.log(`  ${deleted}/${rowsToDelete.length} baris dihapus...`);
      }
      // Small delay to avoid rate limit
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      failed++;
      console.error(`  GAGAL hapus baris ${sheetRowIndex}: ${err.message}`);
    }
  }

  console.log(`\nSelesai: ${deleted} baris dihapus, ${failed} gagal.`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
