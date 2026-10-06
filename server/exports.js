'use strict';

/* ==========================================================================
   Exports.

   One definition per report, rendered three ways: CSV for a quick look in a
   spreadsheet, XLSX for the office to work with, and PDF for something to
   print or attach.

   The columns are declared once. That matters more than it sounds: three
   separate renderers would otherwise drift, and a report where the PDF says
   one thing and the spreadsheet another is worse than having no export.

   Every report is built from the same analytics functions the on-screen pages
   use, with the same filter object, so an export always matches the page the
   administrator was looking at when they pressed the button.
   ========================================================================== */

const analytics = require('./analytics');
const { money, formatDate } = require('./format');
const { buildXlsx } = require('./xlsx');
const { PdfDoc } = require('./pdf');

/* ── Reports ────────────────────────────────────────────────────────────── */

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const dayName = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : DAY_NAMES[(d.getUTCDay() + 6) % 7];
};

const monthLabel = (month) => new Date(`${month}-01T00:00:00Z`)
  .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const shortMonth = (month) => new Date(`${month}-01T00:00:00Z`)
  .toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });

const cent = (n) => Number(n) || 0;

/** The period summary used by the weekly, monthly and annual reports. */
const PERIOD_TOTALS = (k) => [
  ['New sales', k.totalNewSales],
  ['Value of new sales', k.contractCents],
  ['Deposits', k.depositsCents],
  ['Instalments', k.installmentsCents],
  ['Final payments', k.finalsCents],
  ['Gross collections', k.grossCents],
  ['Refunds', k.refundsCents],
  ['Net collections', k.netCents],
  ['Outstanding', k.ledgerOutstandingCents],
  ['Completed sales', k.completedSales],
  ['Active payment plans', k.activePlans]
];

const SUMMARY_COLUMNS = [
  { header: 'Metric', width: 190, type: 'text' },
  { header: 'Value', width: 110, type: 'money' },
  { header: 'Count', width: 60, type: 'number' }
];

function summaryRows(totals) {
  return totals.map(([label, value]) => {
    const numeric = typeof value === 'number';
    const isCount = /^(New sales|Completed sales|Active payment plans)$/.test(label);
    return isCount ? [label, null, value] : [label, numeric ? value : null, null];
  });
}

const REPORTS = {
  /* ── Weekly: one row per day, so the shape of the week is visible ── */
  weekly: {
    label: 'Weekly report',
    build(f, ctx) {
      const series = analytics.dailySeries(ctx.from, ctx.to, f);
      const k = analytics.kpis({ ...f, from: ctx.from, to: ctx.to });

      return {
        slug: 'weekly',
        title: 'Weekly sales report',
        subtitle: `${ctx.label}: ${ctx.from} to ${ctx.to}`,
        sheets: [
          {
            title: 'Daily',
            columns: [
              { header: 'Date', width: 80, type: 'text' },
              { header: 'Day', width: 72, type: 'text' },
              { header: 'New sales', width: 62, type: 'number' },
              { header: 'Sales value', width: 88, type: 'money' },
              { header: 'Deposits', width: 82, type: 'money' },
              { header: 'Instalments', width: 88, type: 'money' },
              { header: 'Final payments', width: 92, type: 'money' },
              { header: 'Gross', width: 82, type: 'money' },
              { header: 'Refunds', width: 78, type: 'money' },
              { header: 'Net collected', width: 88, type: 'money' }
            ],
            rows: series.map((d) => [
              d.day, dayName(d.day), d.salesCount, d.salesCents,
              d.depositsCents, d.installmentsCents, d.finalsCents,
              d.grossCents, d.refundsCents, d.netCents
            ])
          },
          { title: 'Totals', columns: SUMMARY_COLUMNS, rows: summaryRows(PERIOD_TOTALS(k)) }
        ]
      };
    }
  },

  /* ── Monthly: every day of the month, plus the previous-month comparison ── */
  monthly: {
    label: 'Monthly report',
    build(f, ctx) {
      const month = ctx.month;
      const prior = analytics.shiftMonth(month, -1);
      const scope = { ...f, month, year: null, from: null, to: null };

      const k = analytics.kpis(scope);
      const p = analytics.kpis({ ...scope, month: prior });
      const series = analytics.dailySeries(`${month}-01`, `${month}-31`, scope);

      const change = (a, b) => (b ? (((a - b) / Math.abs(b)) * 100).toFixed(1) + '%' : 'n/a');

      return {
        slug: 'monthly',
        title: 'Monthly sales report',
        subtitle: `${monthLabel(month)}, compared with ${monthLabel(prior)}`,
        sheets: [
          {
            title: 'Comparison',
            columns: [
              { header: 'Metric', width: 150, type: 'text' },
              { header: monthLabel(month), width: 110, type: 'money' },
              { header: monthLabel(prior), width: 110, type: 'money' },
              { header: 'Change', width: 70, type: 'text' }
            ],
            rows: [
              ['Number of sales', k.totalNewSales, p.totalNewSales, change(k.totalNewSales, p.totalNewSales)],
              ['Sales value', k.contractCents, p.contractCents, change(k.contractCents, p.contractCents)],
              ['Deposits', k.depositsCents, p.depositsCents, change(k.depositsCents, p.depositsCents)],
              ['Instalments', k.installmentsCents, p.installmentsCents, change(k.installmentsCents, p.installmentsCents)],
              ['Final payments', k.finalsCents, p.finalsCents, change(k.finalsCents, p.finalsCents)],
              ['Gross collections', k.grossCents, p.grossCents, change(k.grossCents, p.grossCents)],
              ['Refunds', k.refundsCents, p.refundsCents, change(k.refundsCents, p.refundsCents)],
              ['Net collections', k.netCents, p.netCents, change(k.netCents, p.netCents)],
              ['Outstanding', k.ledgerOutstandingCents, p.ledgerOutstandingCents, change(k.ledgerOutstandingCents, p.ledgerOutstandingCents)],
              ['Completed sales', k.completedSales, p.completedSales, change(k.completedSales, p.completedSales)],
              ['Active payment plans', k.activePlans, p.activePlans, change(k.activePlans, p.activePlans)]
            ]
          },
          {
            title: 'Daily',
            columns: [
              { header: 'Date', width: 80, type: 'text' },
              { header: 'New sales', width: 62, type: 'number' },
              { header: 'Sales value', width: 88, type: 'money' },
              { header: 'Collected', width: 88, type: 'money' },
              { header: 'Refunds', width: 78, type: 'money' },
              { header: 'Net', width: 88, type: 'money' }
            ],
            rows: series
              .filter((d) => d.salesCents || d.netCents || d.refundsCents)
              .map((d) => [d.day, d.salesCount, d.salesCents, d.grossCents, d.refundsCents, d.netCents])
          }
        ]
      };
    }
  },

  /* ── Annual: twelve months, plus the year's totals ── */
  annual: {
    label: 'Annual report',
    build(f, ctx) {
      const year = ctx.year;
      const series = analytics.monthlySeries(year, f);
      const k = analytics.kpis({ ...f, year, month: null, from: null, to: null });

      return {
        slug: 'annual',
        title: 'Annual sales report',
        subtitle: `January to December ${year}`,
        sheets: [
          {
            title: `${year} by month`,
            columns: [
              { header: 'Month', width: 62, type: 'text' },
              { header: 'New sales', width: 62, type: 'number' },
              { header: 'Sales value', width: 88, type: 'money' },
              { header: 'Deposits', width: 82, type: 'money' },
              { header: 'Instalments', width: 88, type: 'money' },
              { header: 'Final payments', width: 92, type: 'money' },
              { header: 'Gross collected', width: 92, type: 'money' },
              { header: 'Refunds', width: 78, type: 'money' },
              { header: 'Net collected', width: 88, type: 'money' },
              { header: 'Outstanding', width: 88, type: 'money' }
            ],
            rows: series.map((m) => [
              m.label, m.salesCount, m.salesCents, m.depositsCents, m.installmentsCents,
              m.finalsCents, m.grossCents, m.refundsCents, m.netCents, m.outstandingCents
            ])
          },
          { title: 'Totals', columns: SUMMARY_COLUMNS, rows: summaryRows(PERIOD_TOTALS(k)) }
        ]
      };
    }
  },

  /* ── Ledger: every transaction, honouring the filters ── */
  ledger: {
    label: 'Transaction ledger',
    build(f) {
      const rows = analytics.ledger(f, { page: 1, perPage: 200, sort: 'date', dir: 'asc' });
      const totals = analytics.sumTransactions(f);

      return {
        slug: 'ledger',
        title: 'Transaction ledger',
        subtitle: `${rows.total} transaction(s)`,
        sheets: [{
          title: 'Ledger',
          columns: [
            { header: 'ID', width: 40, type: 'number' },
            { header: 'Date', width: 68, type: 'text' },
            { header: 'Type', width: 78, type: 'text' },
            { header: 'Client', width: 110, type: 'text' },
            { header: 'Client no.', width: 72, type: 'text' },
            { header: 'Stand', width: 66, type: 'text' },
            { header: 'Project', width: 96, type: 'text' },
            { header: 'Sale', width: 42, type: 'number' },
            { header: 'Amount', width: 78, type: 'money' },
            { header: 'Method', width: 74, type: 'text' },
            { header: 'Reference', width: 118, type: 'text' },
            { header: 'Agent', width: 92, type: 'text' },
            { header: 'Recorded by', width: 76, type: 'text' },
            { header: 'Status', width: 66, type: 'text' },
            { header: 'Notes', width: 120, type: 'text' }
          ],
          rows: rows.rows.map((r) => [
            r.id, r.paid_on, r.type, r.client_name, r.client_number, r.stand_number,
            r.project_name, r.ownership_id, r.amount_cents, r.method, r.reference,
            r.agent_name, r.recorded_by_number || r.recorded_by_name, r.status, r.notes
          ]),
          /* A totals line, so the sum of the visible rows is never in doubt. */
          totals: ['Totals', '', '', '', '', '', '', '', totals.netCents, '', '', '', '', '', '']
        }]
      };
    }
  },

  /* ── Project performance ── */
  project: {
    label: 'Project sales report',
    build(f) {
      const rows = analytics.byProject(f);
      return {
        slug: 'project',
        title: 'Sales performance by project',
        subtitle: `${rows.length} project(s)`,
        sheets: [{
          title: 'By project',
          columns: [
            { header: 'Project', width: 120, type: 'text' },
            { header: 'Stands sold', width: 66, type: 'number' },
            { header: 'Contract value', width: 92, type: 'money' },
            { header: 'Deposits', width: 82, type: 'money' },
            { header: 'Instalments', width: 88, type: 'money' },
            { header: 'Final payments', width: 92, type: 'money' },
            { header: 'Refunds', width: 78, type: 'money' },
            { header: 'Net collected', width: 88, type: 'money' },
            { header: 'Outstanding', width: 88, type: 'money' },
            { header: 'Completed', width: 64, type: 'number' },
            { header: 'Active', width: 54, type: 'number' }
          ],
          rows: rows.map((p) => [
            p.projectName, p.standsSold, p.contractCents, p.depositsCents, p.installmentsCents,
            p.finalsCents, p.refundsCents, p.netCents, p.outstandingCents, p.completed, p.active
          ])
        }]
      };
    }
  },

  /* ── Agent performance ── */
  agent: {
    label: 'Sales agent report',
    build(f) {
      const rows = analytics.byAgent(f);
      return {
        slug: 'agent',
        title: 'Sales performance by agent',
        subtitle: `${rows.length} agent(s)`,
        sheets: [{
          title: 'By agent',
          columns: [
            { header: 'Agent', width: 120, type: 'text' },
            { header: 'Sales', width: 54, type: 'number' },
            { header: 'Contract value', width: 92, type: 'money' },
            { header: 'Deposits', width: 82, type: 'money' },
            { header: 'Instalments', width: 88, type: 'money' },
            { header: 'Final payments', width: 92, type: 'money' },
            { header: 'Refunds', width: 78, type: 'money' },
            { header: 'Net collected', width: 88, type: 'money' },
            { header: 'Outstanding', width: 88, type: 'money' }
          ],
          rows: rows.map((a) => [
            a.agentName, a.salesCount, a.contractCents, a.depositsCents,
            a.installmentsCents, a.finalsCents, a.refundsCents, a.netCents, a.outstandingCents
          ])
        }]
      };
    }
  },

  /* ── Outstanding balances: the list the office chases ── */
  outstanding: {
    label: 'Outstanding balances',
    build(f) {
      const rows = analytics.sales(f).filter((s) => s.outstanding_cents > 0 || s.overpaid_cents > 0);

      return {
        slug: 'outstanding',
        title: 'Outstanding balances',
        subtitle: `${rows.length} sale(s) with a balance`,
        sheets: [{
          title: 'Outstanding',
          columns: [
            { header: 'Sale', width: 42, type: 'number' },
            { header: 'Client', width: 120, type: 'text' },
            { header: 'Client no.', width: 76, type: 'text' },
            { header: 'Stand', width: 70, type: 'text' },
            { header: 'Project', width: 100, type: 'text' },
            { header: 'Sale date', width: 74, type: 'text' },
            { header: 'Sale price', width: 88, type: 'money' },
            { header: 'Net paid', width: 84, type: 'money' },
            { header: 'Outstanding', width: 92, type: 'money' },
            { header: 'Paid %', width: 54, type: 'number' },
            { header: 'Status', width: 70, type: 'text' },
            { header: 'Agent', width: 96, type: 'text' }
          ],
          rows: rows.map((s) => [
            s.sale_id, s.full_name, s.client_number, s.stand_number, s.project_name,
            s.sale_date, s.sale_price_cents, s.net_cents, s.outstanding_cents,
            s.paidPercent, s.sale_status, s.agent_name || 'Unassigned'
          ]),
          totals: ['Totals', '', '', '', '', '',
            rows.reduce((n, s) => n + s.sale_price_cents, 0),
            rows.reduce((n, s) => n + s.net_cents, 0),
            rows.reduce((n, s) => n + s.outstanding_cents, 0),
            '', '', '']
        }]
      };
    }
  },

  /* ── Payment history: transactions grouped by sale ── */
  payments: {
    label: 'Payment history',
    build(f) {
      const sales = analytics.sales(f);
      const out = [];

      for (const s of sales) {
        const txns = analytics.saleTransactions(s.sale_id);
        for (const t of txns) {
          out.push([
            s.sale_id, s.client_number, s.full_name, s.stand_number, s.project_name,
            t.paid_on, t.type, t.amount_cents, t.method, t.reference, t.status, t.notes
          ]);
        }
      }

      return {
        slug: 'payments',
        title: 'Payment history',
        subtitle: `${out.length} transaction(s) across ${sales.length} sale(s)`,
        sheets: [{
          title: 'Payment history',
          columns: [
            { header: 'Sale', width: 42, type: 'number' },
            { header: 'Client no.', width: 76, type: 'text' },
            { header: 'Client', width: 120, type: 'text' },
            { header: 'Stand', width: 70, type: 'text' },
            { header: 'Project', width: 100, type: 'text' },
            { header: 'Date', width: 74, type: 'text' },
            { header: 'Type', width: 84, type: 'text' },
            { header: 'Amount', width: 84, type: 'money' },
            { header: 'Method', width: 76, type: 'text' },
            { header: 'Reference', width: 120, type: 'text' },
            { header: 'Status', width: 68, type: 'text' },
            { header: 'Notes', width: 120, type: 'text' }
          ],
          rows: out
        }]
      };
    }
  }
};

const REPORT_TYPES = Object.keys(REPORTS);
const FORMATS = ['csv', 'xlsx', 'pdf'];

/** Builds one report, or null if the type is unknown. */
function build(type, filters, context = {}) {
  const spec = REPORTS[type];
  if (!spec) return null;

  const report = spec.build(filters, context);
  report.type = type;
  report.filterSummary = describeFilters(filters);
  return report;
}

/** A one-line description of the filters an export was run with. */
function describeFilters(f) {
  const bits = [];
  if (f.from) bits.push(`from ${f.from}`);
  if (f.to) bits.push(`to ${f.to}`);
  if (f.year) bits.push(`year ${f.year}`);
  if (f.month) bits.push(`month ${f.month}`);
  if (f.type) bits.push(`type ${f.type}`);
  if (f.method) bits.push(`method ${f.method}`);
  if (f.saleStatus) bits.push(`status ${f.saleStatus}`);
  if (f.search) bits.push(`search "${f.search}"`);

  const named = analytics.filterOptions();
  if (f.projectId) bits.push(`project ${(named.projects.find((p) => p.id === f.projectId) || {}).name || f.projectId}`);
  if (f.agentId) bits.push(`agent ${(named.agents.find((a) => a.id === f.agentId) || {}).name || f.agentId}`);

  return bits.length ? bits.join(', ') : 'no filters — all records';
}

/* ── CSV ────────────────────────────────────────────────────────────────── */

/** Escapes one CSV field, quoting only when it has to. */
function csvField(value, type) {
  if (value === null || value === undefined) return '';

  if (type === 'money') {
    // A bare number, so the spreadsheet treats it as numeric. The currency is
    // named in the column header instead.
    return (cent(value) / 100).toFixed(2);
  }
  if (type === 'number') return String(Number(value) || 0);

  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(report) {
  const lines = [];

  lines.push(csvField(report.title));
  if (report.subtitle) lines.push(csvField(report.subtitle));
  lines.push(`Filters: ${csvField(report.filterSummary)}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  report.sheets.forEach((sheet, index) => {
    if (index > 0) lines.push('');
    lines.push(csvField(sheet.title));

    const headers = sheet.columns.map((c) =>
      (c.type === 'money' ? `${c.header} (US$)` : c.header));
    lines.push(headers.map((h) => csvField(h)).join(','));

    for (const row of sheet.rows) {
      lines.push(row.map((v, i) => csvField(v, sheet.columns[i] ? sheet.columns[i].type : 'text')).join(','));
    }

    if (sheet.totals) {
      lines.push(sheet.totals
        .map((v, i) => csvField(v, sheet.columns[i] ? sheet.columns[i].type : 'text')).join(','));
    }
  });

  // A BOM so Excel opens UTF-8 correctly rather than mis-reading accented names.
  return Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

/* ── XLSX ───────────────────────────────────────────────────────────────── */

function toXlsx(report) {
  const sheets = report.sheets.map((sheet) => ({
    title: sheet.title,
    columns: sheet.columns,
    rows: [
      ...sheet.rows.map((row) => row.map((v, i) => {
        const type = sheet.columns[i] ? sheet.columns[i].type : 'text';
        if (type === 'money') return cent(v) / 100;
        if (type === 'number') return Number(v) || 0;
        return v === null || v === undefined ? '' : String(v);
      })),
      ...(sheet.totals
        ? [sheet.totals.map((v, i) => {
          const type = sheet.columns[i] ? sheet.columns[i].type : 'text';
          if (type === 'money') return cent(v) / 100;
          if (type === 'number') return Number(v) || 0;
          return v === null || v === undefined ? '' : String(v);
        })]
        : [])
    ]
  }));

  return buildXlsx({ sheets, creator: 'Heritage Housing Projects' });
}

/* ── PDF ────────────────────────────────────────────────────────────────── */

const MARGIN = 42;
const ROW = 15;

/**
 * A printable table.
 *
 * Columns are scaled to the page width, and the header repeats on every page —
 * a multi-page table without a repeated header is unusable when printed.
 */
function toPdf(report, { settings = {} } = {}) {
  const doc = new PdfDoc();
  const LEFT = MARGIN;
  const RIGHT = doc.width - MARGIN;
  const usable = RIGHT - LEFT;
  const bottom = doc.height - MARGIN - 34;

  const sheet = report.sheets[0];
  const columns = sheet.columns;

  const declared = columns.reduce((n, c) => n + c.width, 0);
  const scale = usable / declared;
  const widths = columns.map((c) => c.width * scale);

  const cell = (value, index, x, y, { bold = false, right = false } = {}) => {
    const column = columns[index];
    if (!column) return;

    let text;
    if (value === null || value === undefined || value === '') text = '';
    else if (column.type === 'money') text = money(cent(value));
    else text = String(value);

    // Trim to the column, so a long note cannot run over its neighbour.
    const font = bold ? 'bold' : 'regular';
    const limit = widths[index] - 6;
    let shown = text;
    while (shown.length > 1 && doc.measure(shown, { font, size: 7.5 }) > limit) {
      shown = shown.slice(0, -1);
    }

    if (right) doc.textRight(shown, x, y, { font, size: 7.5, gray: 0.1 });
    else doc.text(shown, x, y, { font, size: 7.5, gray: 0.1 });
  };

  let y = MARGIN;

  /* Masthead */
  doc.text(settings.company_legal || 'Heritage Housing Projects (Pvt) Ltd', LEFT, y, { font: 'bold', size: 13, gray: 0.08 });
  doc.textRight(report.title.toUpperCase(), RIGHT, y, { font: 'bold', size: 9, gray: 0.42 });
  y += 15;
  doc.text(report.subtitle || '', LEFT, y, { size: 8, gray: 0.42 });
  doc.textRight(`Generated ${formatDate(new Date())}`, RIGHT, y, { size: 8, gray: 0.42 });
  y += 12;
  doc.text(`Filters: ${report.filterSummary}`, LEFT, y, { size: 7.5, gray: 0.42 });
  y += 10;
  doc.line(LEFT, y, RIGHT, y, { width: 0.8, gray: 0.1 });
  y += 14;

  const drawHeader = (atY) => {
    let x = LEFT;
    columns.forEach((c, i) => {
      const right = c.type === 'money' || c.type === 'number';
      const shown = c.type === 'money' ? `${c.header} (US$)` : c.header;
      if (right) doc.textRight(shown, x + widths[i], atY, { font: 'bold', size: 7.5, gray: 0.1 });
      else doc.text(shown, x, atY, { font: 'bold', size: 7.5, gray: 0.1 });
      x += widths[i];
    });
    doc.line(LEFT, atY + 3, RIGHT, atY + 3, { width: 0.5, gray: 0.5 });
    return atY + 12;
  };

  y = drawHeader(y);

  const emit = (row, { bold = false, band = false } = {}) => {
    if (y > bottom) {
      doc.addPage();
      y = MARGIN;
      y = drawHeader(y);
    }
    if (band) doc.fillRect(LEFT - 2, y - 8, usable + 4, ROW - 1, { gray: 0.95 });

    let x = LEFT;
    row.forEach((value, i) => {
      if (!columns[i]) return;
      const right = columns[i].type === 'money' || columns[i].type === 'number';
      cell(value, i, right ? x + widths[i] : x, y, { bold, right });
      x += widths[i];
    });
    y += ROW;
  };

  sheet.rows.forEach((row, i) => emit(row, { band: i % 2 === 1 }));
  if (sheet.totals) {
    doc.line(LEFT, y - 6, RIGHT, y - 6, { width: 0.5, gray: 0.4 });
    emit(sheet.totals, { bold: true });
  }

  /* A second sheet becomes a second table on its own page. */
  report.sheets.slice(1).forEach((extra) => {
    doc.addPage();
    let ey = MARGIN;
    doc.text(extra.title, LEFT, ey, { font: 'bold', size: 10, gray: 0.1 });
    ey += 16;

    const exDeclared = extra.columns.reduce((n, c) => n + c.width, 0);
    const exScale = usable / exDeclared;
    const exWidths = extra.columns.map((c) => c.width * exScale);

    let x = LEFT;
    extra.columns.forEach((c, i) => {
      const right = c.type === 'money' || c.type === 'number';
      const shown = c.type === 'money' ? `${c.header} (US$)` : c.header;
      if (right) doc.textRight(shown, x + exWidths[i], ey, { font: 'bold', size: 7.5, gray: 0.1 });
      else doc.text(shown, x, ey, { font: 'bold', size: 7.5, gray: 0.1 });
      x += exWidths[i];
    });
    ey += 12;

    extra.rows.forEach((row) => {
      if (ey > bottom) { doc.addPage(); ey = MARGIN; }
      let cx = LEFT;
      row.forEach((value, i) => {
        if (!extra.columns[i]) return;
        const c = extra.columns[i];
        let text = value === null || value === undefined || value === ''
          ? '' : (c.type === 'money' ? money(cent(value)) : String(value));
        const right = c.type === 'money' || c.type === 'number';
        const font = 'regular';
        while (text.length > 1 && doc.measure(text, { font, size: 7.5 }) > exWidths[i] - 6) text = text.slice(0, -1);
        if (right) doc.textRight(text, cx + exWidths[i], ey, { size: 7.5, gray: 0.1 });
        else doc.text(text, cx, ey, { size: 7.5, gray: 0.1 });
        cx += exWidths[i];
      });
      ey += ROW;
    });
  });

  /* Page numbers, added last so the total is known. */
  const total = doc.pageCount;
  for (let p = 0; p < total; p++) {
    doc.textRight(`Page ${p + 1} of ${total}`, RIGHT, doc.height - MARGIN + 8,
      { size: 7.5, gray: 0.5, page: p });
    doc.text('Heritage Housing Projects — sales analytics', LEFT, doc.height - MARGIN + 8,
      { size: 7.5, gray: 0.5, page: p });
  }

  return doc.build();
}

/* ── Delivery ───────────────────────────────────────────────────────────── */

const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf'
};

function render(report, format, options = {}) {
  if (format === 'csv') return toCsv(report);
  if (format === 'xlsx') return toXlsx(report);
  if (format === 'pdf') return toPdf(report, options);
  return null;
}

/** Weekly-2026-01-05.csv, and so on. */
function filenameFor(report, format, context = {}) {
  const parts = [report.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')];
  if (context.from) parts.push(context.from);
  if (context.month) parts.push(context.month);
  if (context.year) parts.push(context.year);
  return `${parts.join('-')}.${format}`;
}

module.exports = {
  REPORTS, REPORT_TYPES, FORMATS, build, render, filenameFor, describeFilters,
  toCsv, toXlsx, toPdf, MIME
};
