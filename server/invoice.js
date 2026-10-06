'use strict';

/* ==========================================================================
   Client statement of account, as a real PDF.

   Built here rather than handed to the browser's print dialog so the office
   gets an actual file they can email, and so the numbers are the same ones the
   portal and the admin already show — the totals come from the same rows, and
   the currency formatting is the shared `money()` helper, not a second copy of
   it that could drift.

   Only confirmed payments reduce the balance; anything pending is listed
   separately and labelled, because a statement that quietly counts unverified
   money is worse than no statement.
   ========================================================================== */

const { PdfDoc } = require('./pdf');
const { money } = require('./views');

const MARGIN = 50;
const FOOTER_SPACE = 60;
const ROW = 17;

const INK = 0.08;
const MUTED = 0.42;
const RULE = 0.75;
const BAND = 0.93;

function formatLongDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function pad(n) { return String(n).padStart(2, '0'); }

/** A statement reference the office can quote on the phone. */
function statementNumber(clientNumber, when) {
  return `STM-${clientNumber}-${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
}

function filenameFor(client) {
  return `Statement-${client.client_number}.pdf`;
}

/**
 * @param {object} input
 * @param {object} input.settings   site settings (company name, contact details)
 * @param {object} input.client     the client row
 * @param {object} input.ownership  their stand, or null
 * @param {Array}  input.payments   every payment row for the client
 * @param {Date}   input.generatedAt
 * @returns {Buffer}
 */
function buildStatementPdf({ settings, client, ownership, payments, generatedAt = new Date() }) {
  const doc = new PdfDoc();
  const LEFT = MARGIN;
  const RIGHT = doc.width - MARGIN;
  const bottomLimit = doc.height - MARGIN - FOOTER_SPACE;

  const confirmed = payments.filter((p) => p.status === 'Confirmed');
  const pending = payments.filter((p) => p.status !== 'Confirmed');
  const receivedCents = confirmed.reduce((sum, p) => sum + p.amount_cents, 0);
  const pendingCents = pending.reduce((sum, p) => sum + p.amount_cents, 0);
  const purchaseCents = ownership ? ownership.purchase_price_cents : 0;
  const balanceCents = Math.max(purchaseCents - receivedCents, 0);

  let y = MARGIN;

  /* ── Masthead ── */
  doc.text(settings.company_legal, LEFT, y + 8, { font: 'bold', size: 15, gray: INK });
  y += 28;
  doc.text(settings.office, LEFT, y, { size: 9, gray: MUTED });
  y += 13;
  doc.text(`${settings.phone}   ${settings.email}`, LEFT, y, { size: 9, gray: MUTED });
  y += 13;

  doc.textRight('STATEMENT OF ACCOUNT', RIGHT, MARGIN + 8, { font: 'bold', size: 12, gray: INK });
  doc.textRight(`Issued ${formatLongDate(generatedAt)}`, RIGHT, MARGIN + 25, { size: 9, gray: MUTED });
  doc.textRight(statementNumber(client.client_number, generatedAt), RIGHT, MARGIN + 38, { size: 9, gray: MUTED });

  y += 12;
  doc.line(LEFT, y, RIGHT, y, { width: 1, gray: INK });
  y += 26;

  /* ── Who it is for, and what it is about ── */
  doc.text('ACCOUNT', LEFT, y, { font: 'bold', size: 8, gray: MUTED });
  doc.text('PROPERTY', LEFT + 280, y, { font: 'bold', size: 8, gray: MUTED });
  y += 15;

  const account = [
    ['Client', client.full_name],
    ['Client number', client.client_number],
    ['Email', client.email || '—']
  ];
  const property = ownership
    ? [
      ['Stand', ownership.stand_number],
      ['Project', ownership.project_name],
      ['Size', `${ownership.size_sqm} m²`],
      ['Status', ownership.status],
      ['Purchased', formatLongDate(ownership.purchase_date)]
    ]
    : [['Stand', 'No stand linked to this account']];

  const rows = Math.max(account.length, property.length);
  for (let i = 0; i < rows; i++) {
    if (account[i]) {
      doc.text(`${account[i][0]}:`, LEFT, y + i * 14, { size: 9, gray: MUTED });
      doc.text(String(account[i][1]), LEFT + 78, y + i * 14, { size: 9, gray: INK });
    }
    if (property[i]) {
      doc.text(`${property[i][0]}:`, LEFT + 280, y + i * 14, { size: 9, gray: MUTED });
      doc.text(String(property[i][1]), LEFT + 358, y + i * 14, { size: 9, gray: INK });
    }
  }
  y += rows * 14 + 14;

  /* ── The money ── */
  doc.fillRect(LEFT, y, RIGHT - LEFT, 76, { gray: BAND });
  const boxY = y + 20;
  doc.text('Purchase price', LEFT + 14, boxY, { size: 10, gray: MUTED });
  doc.textRight(money(purchaseCents), RIGHT - 14, boxY, { size: 10, gray: INK });

  doc.text('Total received (confirmed)', LEFT + 14, boxY + 20, { size: 10, gray: MUTED });
  doc.textRight(money(receivedCents), RIGHT - 14, boxY + 20, { size: 10, gray: INK });

  doc.line(LEFT + 14, boxY + 32, RIGHT - 14, boxY + 32, { width: 0.5, gray: RULE });

  doc.text('BALANCE OUTSTANDING', LEFT + 14, boxY + 50, { font: 'bold', size: 11, gray: INK });
  doc.textRight(money(balanceCents), RIGHT - 14, boxY + 50, { font: 'bold', size: 13, gray: INK });

  if (pendingCents > 0) {
    doc.text(`Plus ${money(pendingCents)} recorded but not yet confirmed (listed below, not counted above).`,
      LEFT + 14, boxY + 68, { size: 8, gray: MUTED });
  }
  y += 76 + 30;

  /* ── Payment history ── */
  const drawTableHead = (top) => {
    doc.text('PAYMENTS RECEIVED', LEFT, top, { font: 'bold', size: 8, gray: MUTED });
    doc.text('Date', LEFT, top + 16, { font: 'bold', size: 8, gray: MUTED });
    doc.text('Reference', LEFT + 110, top + 16, { font: 'bold', size: 8, gray: MUTED });
    doc.textRight('Amount', LEFT + 340, top + 16, { font: 'bold', size: 8, gray: MUTED });
    doc.text('Status', LEFT + 360, top + 16, { font: 'bold', size: 8, gray: MUTED });
    doc.line(LEFT, top + 22, RIGHT, top + 22, { width: 0.5, gray: RULE });
    return top + 38;
  };

  const ensure = (needed) => {
    if (y + needed <= bottomLimit) return false;
    doc.addPage();
    y = MARGIN + 10;
    return true;
  };

  y = drawTableHead(y);

  const drawRows = (list) => {
    if (!list.length) {
      doc.text('None recorded.', LEFT, y, { size: 9, gray: MUTED });
      y += ROW;
      return;
    }
    for (const p of list) {
      if (ensure(ROW + 6)) y = drawTableHead(y);
      doc.text(formatLongDate(p.paid_on), LEFT, y, { size: 9, gray: INK });
      doc.text(p.reference, LEFT + 110, y, { size: 9, gray: INK });
      doc.textRight(money(p.amount_cents), LEFT + 340, y, { size: 9, gray: INK });
      doc.text(p.status, LEFT + 360, y, { size: 9, gray: p.status === 'Confirmed' ? INK : MUTED });
      y += ROW;
    }
  };

  drawRows(confirmed);

  y += 8;
  ensure(60);
  doc.line(LEFT, y, RIGHT, y, { width: 0.5, gray: RULE });
  y += 18;
  doc.text('Total confirmed', LEFT + 110, y, { font: 'bold', size: 9, gray: INK });
  doc.textRight(money(receivedCents), LEFT + 340, y, { font: 'bold', size: 9, gray: INK });
  y += 26;

  if (pending.length) {
    ensure(70);
    doc.text('RECORDED BUT NOT YET CONFIRMED', LEFT, y, { font: 'bold', size: 8, gray: MUTED });
    y += 8;
    doc.text('These do not reduce the balance until the office confirms them.', LEFT, y, { size: 8, gray: MUTED });
    y += 18;

    for (const p of pending) {
      if (ensure(ROW + 6)) y = drawTableHead(y);
      doc.text(formatLongDate(p.paid_on), LEFT, y, { size: 9, gray: MUTED });
      doc.text(p.reference, LEFT + 110, y, { size: 9, gray: MUTED });
      doc.textRight(money(p.amount_cents), LEFT + 340, y, { size: 9, gray: MUTED });
      doc.text(p.status, LEFT + 360, y, { size: 9, gray: MUTED });
      y += ROW;
    }
    y += 10;
  }

  /* ── Footer on every page ── */
  const total = doc.pageCount;
  for (let i = 0; i < total; i++) {
    const footY = doc.height - MARGIN + 6;
    doc.line(LEFT, footY - 16, RIGHT, footY - 16, { width: 0.5, gray: RULE });
    doc.text(
      'This statement is computer generated. Please quote the statement number with any query.',
      LEFT, footY, { size: 8, gray: MUTED, page: i });
    doc.textRight(`Page ${i + 1} of ${total}`, RIGHT, footY, { size: 8, gray: MUTED, page: i });
    if (settings.tagline) {
      doc.textRight(settings.tagline, RIGHT, footY + 12, { size: 8, gray: MUTED, page: i });
    }
  }

  return doc.build();
}

/** Pulls the property block out of an admin client row, or null if unlinked. */
function ownershipFromClientRow(client) {
  if (!client || !client.stand_id) return null;
  return {
    stand_number: client.stand_number,
    project_name: client.project_name,
    size_sqm: client.size_sqm,
    status: client.ownership_status,
    purchase_date: client.purchase_date,
    purchase_price_cents: client.purchase_price_cents
  };
}

/** Sends the PDF inline, so the browser opens it ready to print or save. */
function writePdfResponse(res, pdf, filename) {
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': pdf.length,
    'Content-Disposition': `inline; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(pdf);
}

module.exports = {
  buildStatementPdf, filenameFor, statementNumber, ownershipFromClientRow, writePdfResponse
};
