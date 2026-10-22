'use strict';

/* ==========================================================================
   Shared formatting.

   These lived in views.js, but the analytics engine and the PDF generator also
   need them — and a calculation module should not have to pull in the whole
   presentation layer to format an error message. One definition, used by all
   three, so a figure can never be formatted two different ways.
   ========================================================================== */

/**
 * Cents to a display string.
 *
 * Whole amounts render without decimals (US$5,500) and part-dollar amounts
 * show both places (US$250.50). Without this, 25050 cents printed as
 * "US$250.5", which on a payment statement reads like a rounding bug.
 */
function money(cents) {
  const n = Math.round(Number(cents) || 0) / 100;
  const whole = Number.isInteger(n);
  return 'US$' + n.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2
  });
}

/** Cents to a plain number string, for spreadsheets and CSV. */
function plainMoney(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

/**
 * Money in a stated currency.
 *
 * `money` stays the US$ shorthand used across the statements and analytics;
 * this is for properties, which carry their own currency because a development
 * could be priced in anything.
 */
function moneyIn(cents, currency = 'US$') {
  const n = Math.round(Number(cents) || 0) / 100;
  const whole = Number.isInteger(n);
  return String(currency || 'US$') + n.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2
  });
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Today as an ISO date, in the server's own time zone.
 *
 * Deliberately not `new Date().toISOString().slice(0, 10)`: that is the UTC
 * date, which in Harare (UTC+2) is still yesterday for the first two hours of
 * every morning — so an agent starting early would see yesterday's follow-ups
 * as "today" and today's as "not due yet".
 */
function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

/** A percentage with one decimal, and no division-by-zero surprise. */
function percent(part, whole) {
  if (!whole) return 0;
  return (part / whole) * 100;
}

/**
 * A URL-safe form of a name: "Heritage Park" -> "heritage-park".
 *
 * Used to address developments in the address bar. Derived on demand rather
 * than stored, so renaming a development cannot leave a stale slug behind.
 */
function slugify(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The UTC instants that bound one local calendar day.
 *
 * Timestamps are stored as UTC (`new Date().toISOString()`), so asking SQL for
 * `DATE(created_at) = '2026-10-22'` compares against the *UTC* day. In Harare
 * (UTC+2) that is wrong by two hours at each end: something posted at 00:30
 * local is still 22:30 UTC the previous day, so it would be filed under
 * yesterday, and a page for "today" would look empty when it is not.
 *
 * This turns a local date into the half-open UTC range [start, end) that
 * actually covers it, which works with a plain indexed comparison on the stored
 * text rather than a function wrapped around the column.
 *
 * Returns null for anything that is not a real YYYY-MM-DD date, so a hand-edited
 * query string cannot produce a nonsense range.
 */
function utcRangeForLocalDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  /* Local midnight. Constructing from the parts (rather than parsing the string
     as UTC) keeps this in the server's own zone, matching todayIso above. */
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const valid = start.getFullYear() === year
    && start.getMonth() === month - 1
    && start.getDate() === day;
  if (!valid) return null;   // e.g. 2026-02-31, which Date would roll forward

  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

module.exports = {
  money, moneyIn, plainMoney, formatDate, formatBytes, percent, slugify, todayIso,
  utcRangeForLocalDate
};
