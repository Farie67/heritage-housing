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

module.exports = { money, moneyIn, plainMoney, formatDate, formatBytes, percent, slugify };
