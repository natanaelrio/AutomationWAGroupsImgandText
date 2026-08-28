"use strict";

/**
 * utils/leads.js
 * Deteksi & ekstraksi pesan notifikasi lead terstruktur dari grup.
 *
 * Pesan lead punya format multi-baris dengan label-label:
 *   Nama Customer:
 *   Nomor Telp:
 *   Email:
 *   Product:
 *   PIC Sales:
 *
 * Fungsi di sini digunakan oleh SEMUA jalur (realtime index.js,
 * backfillHistory.js, importExportedChat.js) supaya logika konsisten.
 */

const { VALID_SALES_NAMES } = require("./sheets");

const LEAD_LABELS = [
  "Nama Customer:",
  "Nomor Telp:",
  "Email:",
  "Product:",
  "PIC Sales:",
];

/**
 * Cek apakah sebuah teks (multi-baris) adalah pesan notifikasi lead.
 * Syarat: SEMUA label harus hadir (per baris, case-insensitive).
 * @param {string} text - teks pesan utuh (boleh multi-baris)
 * @returns {boolean}
 */
function isLeadNotification(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return LEAD_LABELS.every((label) => lower.includes(label.toLowerCase()));
}

/**
 * Ekstrak field-field dari pesan notifikasi lead.
 * @param {string} text - teks pesan utuh (multi-baris)
 * @returns {{ namaCustomer: string, phone: string, email: string, product: string, salesName: string } | null}
 */
function parseLeadFields(text) {
  if (!text || !isLeadNotification(text)) return null;

  const namaCustomer = (text.match(/Nama Customer:\s*(.+)/i)?.[1] || "").trim();
  const nomorTelpRaw = (text.match(/Nomor Telp:\s*(.+)/i)?.[1] || "").trim();
  const email = (text.match(/Email:\s*(.+)/i)?.[1] || "").trim();
  const product = (text.match(/Product:\s*(.+)/i)?.[1] || "").trim();
  const picSalesRaw = (text.match(/PIC Sales:\s*(.+)/i)?.[1] || "").trim();

  // Normalisasi nomor telepon: buang non-digit, tambah prefix 62
  let phone = nomorTelpRaw.replace(/\D/g, "");
  if (!phone.startsWith("62")) {
    phone = "62" + phone;
  }

  // Cocokkan nama sales ke daftar valid (case-insensitive)
  const salesName = resolveSalesName(picSalesRaw);

  return { namaCustomer, phone, email, product, salesName };
}

/**
 * Cocokkan nama PIC Sales ke salah satu dari VALID_SALES_NAMES.
 * Case-insensitive; mengembalikan nama persis (case-sensitive) atau "".
 * @param {string} raw
 * @returns {string}
 */
function resolveSalesName(raw) {
  if (!raw) return "";
  const lower = raw.trim().toLowerCase();
  for (const name of VALID_SALES_NAMES) {
    if (name.toLowerCase() === lower) return name;
  }
  return "";
}

module.exports = { isLeadNotification, parseLeadFields, resolveSalesName };
