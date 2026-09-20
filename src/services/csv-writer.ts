/**
 * Minimal, dependency-free CSV writer for "download in Excel" exports.
 *
 * A real .xlsx library (SheetJS's `xlsx` package) was tried first and
 * rejected: at install time it carried two unpatched high-severity
 * advisories with no fix available — prototype pollution
 * (GHSA-4r6h-8v6p-xvw6) and a ReDoS (GHSA-5pgg-2g8v-p4x9). Both are
 * triggered by PARSING an untrusted file, which this codebase would never
 * do here (only writing), but a permanently-vulnerable dependency isn't
 * worth taking on for a format Excel already opens natively without it —
 * CSV with a UTF-8 BOM (so Excel renders Uzbek/Cyrillic text correctly
 * instead of mojibake) covers the same "download and open in Excel" need
 * with zero new dependencies.
 */

const BOM = "﻿";

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = Array.isArray(value) ? value.join("; ") : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Converts an array of flat objects into a CSV string (comma-separated,
 * double-quote escaping, CRLF line endings, UTF-8 BOM prefix), using the
 * column order given in `columns` — [key, header] pairs, so callers control
 * both column order and human-readable headers explicitly rather than
 * relying on object key insertion order. An array-valued cell is joined
 * with "; " rather than exploded into extra columns, since this is meant
 * to render as one readable row per record, the way a person skimming a
 * spreadsheet would want it. Pure and exported for offline testing.
 */
export function toCsv<T extends object>(rows: T[], columns: [keyof T, string][]): string {
  const headerLine = columns.map(([, header]) => escapeCsvCell(header)).join(",");
  const lines = rows.map((row) => columns.map(([key]) => escapeCsvCell(row[key])).join(","));
  return BOM + [headerLine, ...lines].join("\r\n") + "\r\n";
}
