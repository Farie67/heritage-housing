'use strict';

/* ==========================================================================
   Sales analytics.

   Every figure here is computed from the transaction records. Nothing is
   stored as a dashboard total, so no number can drift away from the ledger.

   Two date bases, and the difference matters:

     a SALE is dated by  sale_date   — when the stand was sold
     a TRANSACTION is dated by paid_on — when the money moved

   A sale agreed in September and paid in October counts as a new sale in
   September and as cash collected in October. Moving the payment back to the
   sale date would make both months wrong, so the two are queried separately.

   Money is integer cents throughout, and only CONFIRMED, NON-VOIDED
   transactions count. A pending payment is money the office has been told
   about but has not verified; a voided one should not exist at all.
   ========================================================================== */

const { db, PAYMENT_STATUSES, PAYMENT_METHODS } = require('./db');
const { money, percent } = require('./format');

const COLLECTION_SQL = "('DEPOSIT','INSTALLMENT','FINAL_PAYMENT')";

/* ── Filters ────────────────────────────────────────────────────────────── */

const asInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const asDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

/**
 * Normalises a request's query string into a filter object.
 * Unknown values are dropped rather than passed to SQL.
 */
function filtersFrom(params = {}) {
  return {
    from: asDate(params.from),
    to: asDate(params.to),
    year: /^\d{4}$/.test(String(params.year || '')) ? String(params.year) : null,
    month: /^\d{4}-\d{2}$/.test(String(params.month || '')) ? String(params.month) : null,
    projectId: asInt(params.project),
    agentId: asInt(params.agent),
    type: ['DEPOSIT', 'INSTALLMENT', 'FINAL_PAYMENT', 'REFUND'].includes(params.type) ? params.type : null,
    method: params.method ? String(params.method).slice(0, 40) : null,
    saleStatus: ['Active', 'Completed', 'Cancelled'].includes(params.saleStatus) ? params.saleStatus : null,
    clientId: asInt(params.client),
    standId: asInt(params.stand),
    search: params.q ? String(params.q).trim().slice(0, 80) : null
  };
}

/** True when any filter is active, so the UI can offer "Clear filters". */
function hasFilters(f) {
  return Boolean(f.from || f.to || f.year || f.month || f.projectId || f.agentId
    || f.type || f.method || f.saleStatus || f.clientId || f.standId || f.search);
}

/* ── SQL fragments ──────────────────────────────────────────────────────── */

/**
 * WHERE clause for the transaction side.
 * `standAlias` lets the caller decide how a stand is reached: directly from
 * the payment, or through the sale it belongs to.
 */
function transactionWhere(f, opts = {}) {
  const p = opts.paymentAlias || 'p';
  const o = opts.ownershipAlias || 'o';
  const st = opts.standAlias || 'st';

  /* Voided transactions never count. That is rule 7: a voided payment must
     not remain in any total. */
  const w = [`${p}.voided_at IS NULL`];
  const args = [];

  const from = f.from || (f.month ? `${f.month}-01` : (f.year ? `${f.year}-01-01` : null));
  const to = f.to || (f.month ? `${f.month}-31` : (f.year ? `${f.year}-12-31` : null));

  if (from) { w.push(`${p}.paid_on >= ?`); args.push(from); }
  if (to) { w.push(`${p}.paid_on <= ?`); args.push(to); }
  if (f.type) { w.push(`${p}.type = ?`); args.push(f.type); }
  if (f.method) { w.push(`${p}.method = ?`); args.push(f.method); }
  if (f.projectId) { w.push(`${st}.project_id = ?`); args.push(f.projectId); }
  if (f.agentId) { w.push(`${o}.agent_id = ?`); args.push(f.agentId); }
  if (f.clientId) { w.push(`${p}.user_id = ?`); args.push(f.clientId); }
  if (f.standId) { w.push(`COALESCE(${p}.stand_id, ${o}.stand_id) = ?`); args.push(f.standId); }
  if (f.saleStatus) { w.push(`${o}.sale_status = ?`); args.push(f.saleStatus); }
  if (f.search) {
    w.push(`(${p}.reference LIKE ? OR ${p}.notes LIKE ?)`);
    args.push(`%${f.search}%`, `%${f.search}%`);
  }

  return { sql: w.join(' AND '), args };
}

/** WHERE clause for the sale side. */
function saleWhere(f) {
  const w = [];
  const args = [];

  if (f.from) { w.push('o.sale_date >= ?'); args.push(f.from); }
  if (f.to) { w.push('o.sale_date <= ?'); args.push(f.to); }
  if (f.year) { w.push('o.sale_date >= ? AND o.sale_date <= ?'); args.push(`${f.year}-01-01`, `${f.year}-12-31`); }
  if (f.month) { w.push('o.sale_date >= ? AND o.sale_date <= ?'); args.push(`${f.month}-01`, `${f.month}-31`); }
  if (f.projectId) { w.push('st.project_id = ?'); args.push(f.projectId); }
  if (f.agentId) { w.push('o.agent_id = ?'); args.push(f.agentId); }
  if (f.clientId) { w.push('o.user_id = ?'); args.push(f.clientId); }
  if (f.standId) { w.push('o.stand_id = ?'); args.push(f.standId); }
  /* A cancelled sale is not revenue and not a receivable. It is excluded
     unless the filter asks for cancelled sales specifically. */
  if (f.saleStatus) { w.push('o.sale_status = ?'); args.push(f.saleStatus); }
  else { w.push("o.sale_status <> 'Cancelled'"); }

  return { sql: w.length ? w.join(' AND ') : '1=1', args };
}

/* The per-sale totals. Always over ALL confirmed, non-voided transactions —
   a sale's balance is a property of the sale, not of the reporting period. */
const SALE_TOTALS = `
  LEFT JOIN (
    SELECT ownership_id,
           SUM(CASE WHEN type = 'DEPOSIT'       THEN amount_cents ELSE 0 END) AS deposits,
           SUM(CASE WHEN type = 'INSTALLMENT'   THEN amount_cents ELSE 0 END) AS installments,
           SUM(CASE WHEN type = 'FINAL_PAYMENT' THEN amount_cents ELSE 0 END) AS finals,
           SUM(CASE WHEN type = 'REFUND'        THEN amount_cents ELSE 0 END) AS refunds,
           SUM(CASE WHEN type IN ${COLLECTION_SQL} THEN amount_cents ELSE 0 END) AS collected,
           COUNT(*) AS txn_count
      FROM payments
     WHERE voided_at IS NULL AND status = 'Confirmed' AND ownership_id IS NOT NULL
     GROUP BY ownership_id
  ) t ON t.ownership_id = o.id`;

const SALE_SELECT = `
  SELECT o.id AS sale_id, o.sale_price_cents, o.deposit_required_cents, o.payment_plan,
         o.sale_status, o.sale_date, o.closed_at, o.sale_notes,
         u.id AS client_id, u.client_number, u.full_name, u.email,
         st.id AS stand_id, st.stand_number, st.size_sqm, st.type AS stand_type,
         pr.id AS project_id, pr.name AS project_name,
         ag.id AS agent_id, ag.name AS agent_name,
         COALESCE(t.deposits, 0)     AS deposits_cents,
         COALESCE(t.installments, 0) AS installments_cents,
         COALESCE(t.finals, 0)       AS finals_cents,
         COALESCE(t.refunds, 0)      AS refunds_cents,
         COALESCE(t.collected, 0)    AS collected_cents,
         COALESCE(t.txn_count, 0)    AS txn_count
    FROM ownerships o
    JOIN users u    ON u.id  = o.user_id
    JOIN stands st  ON st.id = o.stand_id
    JOIN projects pr ON pr.id = st.project_id
    LEFT JOIN agents ag ON ag.id = o.agent_id
    ${SALE_TOTALS}`;

/** Derives the money figures that are pure arithmetic on a sale row. */
function decorateSale(row) {
  const price = row.sale_price_cents || 0;
  const net = row.collected_cents - row.refunds_cents;
  const outstanding = Math.max(price - net, 0);
  const overpaid = Math.max(net - price, 0);

  return {
    ...row,
    net_cents: net,
    outstanding_cents: outstanding,
    overpaid_cents: overpaid,
    /* A sale is complete exactly when nothing remains outstanding and there
       was a sale to begin with. */
    isCompleted: price > 0 && outstanding === 0,
    paidPercent: price > 0 ? Math.min(Math.round((net / price) * 100), 100) : 0
  };
}

/** Every sale matching the filters, each with its balances worked out. */
function sales(f = {}) {
  const w = saleWhere(f);
  return db.prepare(`${SALE_SELECT} WHERE ${w.sql} ORDER BY o.sale_date DESC, o.id DESC`)
    .all(...w.args)
    .map(decorateSale);
}

function saleById(id) {
  const row = db.prepare(`${SALE_SELECT} WHERE o.id = ?`).get(id);
  return row ? decorateSale(row) : null;
}

/** The transactions on one sale, oldest first. */
function saleTransactions(saleId) {
  return db.prepare(`
    SELECT p.*, u.client_number, u.full_name, r.client_number AS recorded_by_number
      FROM payments p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN users r ON r.id = p.recorded_by
     WHERE p.ownership_id = ? AND p.voided_at IS NULL
     ORDER BY p.paid_on, p.id`).all(saleId);
}

/* ── Aggregates ─────────────────────────────────────────────────────────── */

function sumTransactions(f) {
  const w = transactionWhere(f);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN p.type = 'DEPOSIT'       THEN p.amount_cents ELSE 0 END), 0) AS deposits,
      COALESCE(SUM(CASE WHEN p.type = 'INSTALLMENT'   THEN p.amount_cents ELSE 0 END), 0) AS installments,
      COALESCE(SUM(CASE WHEN p.type = 'FINAL_PAYMENT' THEN p.amount_cents ELSE 0 END), 0) AS finals,
      COALESCE(SUM(CASE WHEN p.type = 'REFUND'        THEN p.amount_cents ELSE 0 END), 0) AS refunds,
      COUNT(*) AS txn_count,
      COALESCE(SUM(p.amount_cents), 0) AS all_amounts
    FROM payments p
    LEFT JOIN ownerships o ON o.id = p.ownership_id
    LEFT JOIN stands st    ON st.id = COALESCE(p.stand_id, o.stand_id)
    WHERE ${w.sql} AND p.status = 'Confirmed'`).get(...w.args);

  /* Only collection types are cash. A REFUND row is money going the other way
     and must never be added to gross collections. */
  const gross = row.deposits + row.installments + row.finals;

  return {
    ...row,
    grossCents: gross,
    netCents: gross - row.refunds
  };
}

function sumSales(f) {
  const w = saleWhere(f);
  const rows = db.prepare(`${SALE_SELECT} WHERE ${w.sql}`).all(...w.args).map(decorateSale);

  return {
    count: rows.length,
    contractCents: rows.reduce((s, r) => s + (r.sale_price_cents || 0), 0),
    /* The accounting figure: what is actually still owed, sale by sale. */
    ledgerOutstandingCents: rows.reduce((s, r) => s + r.outstanding_cents, 0),
    overpaidCents: rows.reduce((s, r) => s + r.overpaid_cents, 0),
    completedCount: rows.filter((r) => r.isCompleted).length,
    activeCount: rows.filter((r) => !r.isCompleted).length,
    rows
  };
}

/**
 * The headline figures.
 *
 * `outstandingCents` follows the brief's formula (contract value less net
 * collections). `ledgerOutstandingCents` is the sale-by-sale total. They agree
 * whenever every collection belongs to a sale in scope — which is the case for
 * the unfiltered dashboard — and diverge only when a date filter splits a sale
 * from its payments. Both are returned rather than one being hidden.
 */
function kpis(f = {}) {
  const t = sumTransactions(f);
  const s = sumSales(f);

  return {
    totalNewSales: s.count,
    contractCents: s.contractCents,
    depositsCents: t.deposits,
    installmentsCents: t.installments,
    finalsCents: t.finals,
    grossCents: t.grossCents,
    refundsCents: t.refunds,
    netCents: t.netCents,
    outstandingCents: s.contractCents - t.netCents,
    ledgerOutstandingCents: s.ledgerOutstandingCents,
    overpaidCents: s.overpaidCents,
    completedSales: s.completedCount,
    activePlans: s.activeCount,
    transactionCount: t.txn_count
  };
}

/** Collection rate and averages. */
function collectionAnalysis(f = {}) {
  const t = sumTransactions(f);
  const s = sumSales(f);

  const rate = s.contractCents > 0 ? (t.netCents / s.contractCents) * 100 : 0;
  const refundRate = t.grossCents > 0 ? (t.refunds / t.grossCents) * 100 : 0;

  const countOf = (type) => {
    const w = transactionWhere(f);
    return db.prepare(`
      SELECT COUNT(*) AS c FROM payments p
      LEFT JOIN ownerships o ON o.id = p.ownership_id
      LEFT JOIN stands st    ON st.id = COALESCE(p.stand_id, o.stand_id)
      WHERE ${w.sql} AND p.status = 'Confirmed' AND p.type = ?`).get(...w.args, type).c;
  };

  const avg = (total, n) => (n > 0 ? Math.round(total / n) : 0);

  const depositCount = countOf('DEPOSIT');
  const installmentCount = countOf('INSTALLMENT');
  const finalCount = countOf('FINAL_PAYMENT');

  return {
    dueCents: s.contractCents,
    collectedCents: t.netCents,
    grossCents: t.grossCents,
    outstandingCents: s.ledgerOutstandingCents,
    rate,
    refundCents: t.refunds,
    refundRate,
    totalTransactions: t.txn_count,
    averageTransactionCents: avg(t.grossCents, t.txn_count),
    averageDepositCents: avg(t.deposits, depositCount),
    averageInstallmentCents: avg(t.installments, installmentCount),
    averageFinalCents: avg(t.finals, finalCount),
    depositCount, installmentCount, finalCount
  };
}

/** Sales grouped by project. */
function byProject(f = {}) {
  const rows = sales(f);
  const map = new Map();

  for (const r of rows) {
    const key = r.project_id;
    if (!map.has(key)) {
      map.set(key, {
        projectId: key, projectName: r.project_name,
        standsSold: 0, contractCents: 0, depositsCents: 0, installmentsCents: 0,
        finalsCents: 0, refundsCents: 0, netCents: 0, outstandingCents: 0,
        completed: 0, active: 0
      });
    }
    const g = map.get(key);
    g.standsSold += 1;
    g.contractCents += r.sale_price_cents || 0;
    g.depositsCents += r.deposits_cents;
    g.installmentsCents += r.installments_cents;
    g.finalsCents += r.finals_cents;
    g.refundsCents += r.refunds_cents;
    g.netCents += r.net_cents;
    g.outstandingCents += r.outstanding_cents;
    if (r.isCompleted) g.completed += 1; else g.active += 1;
  }

  return [...map.values()].sort((a, b) => b.contractCents - a.contractCents);
}

/** Sales grouped by agent. Sales with no agent are grouped as "Unassigned". */
function byAgent(f = {}) {
  const rows = sales(f);
  const map = new Map();

  for (const r of rows) {
    const key = r.agent_id || 0;
    if (!map.has(key)) {
      map.set(key, {
        agentId: r.agent_id, agentName: r.agent_name || 'Unassigned',
        salesCount: 0, contractCents: 0, depositsCents: 0, installmentsCents: 0,
        finalsCents: 0, refundsCents: 0, netCents: 0, outstandingCents: 0
      });
    }
    const g = map.get(key);
    g.salesCount += 1;
    g.contractCents += r.sale_price_cents || 0;
    g.depositsCents += r.deposits_cents;
    g.installmentsCents += r.installments_cents;
    g.finalsCents += r.finals_cents;
    g.refundsCents += r.refunds_cents;
    g.netCents += r.net_cents;
    g.outstandingCents += r.outstanding_cents;
  }

  return [...map.values()].sort((a, b) => b.contractCents - a.contractCents);
}

/** Totals per transaction type, for the breakdown chart. */
function byType(f = {}) {
  const w = transactionWhere(f);
  const rows = db.prepare(`
    SELECT p.type, COUNT(*) AS count, COALESCE(SUM(p.amount_cents), 0) AS cents
      FROM payments p
      LEFT JOIN ownerships o ON o.id = p.ownership_id
      LEFT JOIN stands st    ON st.id = COALESCE(p.stand_id, o.stand_id)
     WHERE ${w.sql} AND p.status = 'Confirmed' AND p.type IS NOT NULL
     GROUP BY p.type`).all(...w.args);

  const byName = Object.fromEntries(rows.map((r) => [r.type, r]));
  return ['DEPOSIT', 'INSTALLMENT', 'FINAL_PAYMENT', 'REFUND'].map((type) => ({
    type,
    count: byName[type] ? byName[type].count : 0,
    cents: byName[type] ? byName[type].cents : 0
  }));
}

/* ── Period series (for the charts) ─────────────────────────────────────── */

/**
 * Daily figures between two dates, inclusive, with every day present even
 * when nothing happened — a chart with gaps misleads.
 */
function dailySeries(from, to, f = {}) {
  const scoped = { ...f, from, to };

  const txns = db.prepare(`
    SELECT p.paid_on AS day,
           COALESCE(SUM(CASE WHEN p.type = 'DEPOSIT'       THEN p.amount_cents ELSE 0 END), 0) AS deposits,
           COALESCE(SUM(CASE WHEN p.type = 'INSTALLMENT'   THEN p.amount_cents ELSE 0 END), 0) AS installments,
           COALESCE(SUM(CASE WHEN p.type = 'FINAL_PAYMENT' THEN p.amount_cents ELSE 0 END), 0) AS finals,
           COALESCE(SUM(CASE WHEN p.type = 'REFUND'        THEN p.amount_cents ELSE 0 END), 0) AS refunds
      FROM payments p
      LEFT JOIN ownerships o ON o.id = p.ownership_id
      LEFT JOIN stands st    ON st.id = COALESCE(p.stand_id, o.stand_id)
     WHERE ${transactionWhere(scoped).sql} AND p.status = 'Confirmed'
     GROUP BY p.paid_on`).all(...transactionWhere(scoped).args);

  const sold = db.prepare(`
    SELECT o.sale_date AS day, COUNT(*) AS count, COALESCE(SUM(o.sale_price_cents), 0) AS cents
      FROM ownerships o
      JOIN stands st ON st.id = o.stand_id
     WHERE ${saleWhere(scoped).sql}
     GROUP BY o.sale_date`).all(...saleWhere(scoped).args);

  const txnBy = Object.fromEntries(txns.map((r) => [r.day, r]));
  const soldBy = Object.fromEntries(sold.map((r) => [r.day, r]));

  const out = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);

  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    const t = txnBy[day] || { deposits: 0, installments: 0, finals: 0, refunds: 0 };
    const s = soldBy[day] || { count: 0, cents: 0 };
    const gross = t.deposits + t.installments + t.finals;

    out.push({
      day,
      salesCount: s.count,
      salesCents: s.cents,
      depositsCents: t.deposits,
      installmentsCents: t.installments,
      finalsCents: t.finals,
      grossCents: gross,
      refundsCents: t.refunds,
      netCents: gross - t.refunds
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return out;
}

/** Twelve months of a year, with empty months present. */
function monthlySeries(year, f = {}) {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, '0')}`;
    const scoped = { ...f, year: null, month, from: null, to: null };
    const t = sumTransactions(scoped);
    const s = sumSales(scoped);

    out.push({
      month,
      label: new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
      salesCount: s.count,
      salesCents: s.contractCents,
      depositsCents: t.deposits,
      installmentsCents: t.installments,
      finalsCents: t.finals,
      grossCents: t.grossCents,
      refundsCents: t.refunds,
      netCents: t.netCents,
      outstandingCents: s.ledgerOutstandingCents
    });
  }
  return out;
}

/* ── Ledger ─────────────────────────────────────────────────────────────── */

const LEDGER_SORTS = {
  date: 'p.paid_on',
  amount: 'p.amount_cents',
  type: 'p.type',
  client: 'u.full_name',
  stand: 'st.stand_number',
  project: 'pr.name'
};

/**
 * The transaction ledger, filtered, sorted and paged.
 * `total` is returned so the caller can paginate without a second query.
 */
function ledger(f = {}, { page = 1, perPage = 25, sort = 'date', dir = 'desc' } = {}) {
  const w = transactionWhere(f);
  const order = LEDGER_SORTS[sort] || LEDGER_SORTS.date;
  const direction = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const from = `
    FROM payments p
    LEFT JOIN ownerships o ON o.id = p.ownership_id
    LEFT JOIN stands st    ON st.id = COALESCE(p.stand_id, o.stand_id)
    LEFT JOIN projects pr  ON pr.id = st.project_id
    LEFT JOIN users u      ON u.id = p.user_id
    LEFT JOIN agents ag    ON ag.id = o.agent_id
    LEFT JOIN users rb     ON rb.id = p.recorded_by
    WHERE ${w.sql}`;

  const total = db.prepare(`SELECT COUNT(*) AS c ${from}`).get(...w.args).c;

  const limit = Math.min(Math.max(Number(perPage) || 25, 5), 200);
  const pages = Math.max(Math.ceil(total / limit), 1);
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  const offset = (current - 1) * limit;

  const rows = db.prepare(`
    SELECT p.id, p.paid_on, p.type, p.amount_cents, p.status, p.method, p.reference,
           p.notes, p.voided_at, p.ownership_id,
           u.client_number, u.full_name AS client_name,
           st.stand_number, pr.name AS project_name,
           ag.name AS agent_name, rb.client_number AS recorded_by_number,
           rb.full_name AS recorded_by_name
    ${from}
    ORDER BY ${order} ${direction}, p.id DESC
    LIMIT ? OFFSET ?`).all(...w.args, limit, offset);

  return { rows, total, page: current, pages, perPage: limit };
}

/* ── Balance engine ─────────────────────────────────────────────────────── */

/**
 * Recomputes a sale's status from its transactions and writes it back.
 *
 * This is the "automatic balance" rule: status is never set by hand, it is
 * derived every time money moves. Cancelled sales are left alone — a
 * deliberate cancellation should not be undone by a later payment.
 */
function recomputeSale(saleId, actorId = null) {
  const before = db.prepare(
    'SELECT id, sale_status, closed_at, sale_price_cents FROM ownerships WHERE id = ?').get(saleId);
  if (!before) return null;

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type IN ${COLLECTION_SQL} THEN amount_cents ELSE 0 END), 0) AS collected,
      COALESCE(SUM(CASE WHEN type = 'REFUND' THEN amount_cents ELSE 0 END), 0) AS refunds
    FROM payments
    WHERE ownership_id = ? AND voided_at IS NULL AND status = 'Confirmed'`).get(saleId);

  const price = before.sale_price_cents || 0;
  const net = totals.collected - totals.refunds;
  const outstanding = Math.max(price - net, 0);

  let status = before.sale_status;
  let closedAt = before.closed_at;

  if (before.sale_status !== 'Cancelled') {
    if (price > 0 && outstanding === 0) {
      status = 'Completed';
      closedAt = closedAt || new Date().toISOString();
    } else {
      status = 'Active';
      closedAt = null;
    }
  }

  if (status !== before.sale_status || closedAt !== before.closed_at) {
    db.prepare('UPDATE ownerships SET sale_status = ?, closed_at = ? WHERE id = ?')
      .run(status, closedAt, saleId);

    if (actorId !== null || before.sale_status !== status) {
      financeAudit({
        actorUserId: actorId,
        action: 'sale_status_changed',
        entity: 'sale',
        entityId: saleId,
        reference: `sale ${saleId}`,
        oldValue: before.sale_status,
        newValue: status,
        reason: 'Derived from the transaction ledger'
      });
    }
  }

  return { saleId, status, outstandingCents: outstanding, netCents: net, closedAt };
}

/** Recomputes every sale — used after an import or a bulk correction. */
function recomputeAllSales(actorId = null) {
  const ids = db.prepare('SELECT id FROM ownerships').all().map((r) => r.id);
  return ids.map((id) => recomputeSale(id, actorId));
}

/* ── Financial audit trail ──────────────────────────────────────────────── */

function financeAudit({ actorUserId = null, action, entity, entityId = null,
  reference = null, oldValue = null, newValue = null, reason = null }) {
  db.prepare(`
    INSERT INTO finance_audit
      (at, actor_user_id, action, entity, entity_id, reference, old_value, new_value, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    new Date().toISOString(), actorUserId, action, entity, entityId, reference,
    oldValue === null ? null : String(oldValue),
    newValue === null ? null : String(newValue),
    reason);
}

function financeAuditLog({ limit = 100 } = {}) {
  return db.prepare(`
    SELECT f.*, u.client_number AS actor_number, u.full_name AS actor_name
      FROM finance_audit f
      LEFT JOIN users u ON u.id = f.actor_user_id
     ORDER BY f.id DESC LIMIT ?`).all(Math.min(Number(limit) || 100, 500));
}

/* ── Reference data for the filter controls ─────────────────────────────── */

function filterOptions() {
  return {
    projects: db.prepare('SELECT id, name FROM projects ORDER BY name').all(),
    agents: db.prepare('SELECT id, name FROM agents WHERE active = 1 ORDER BY name').all(),
    clients: db.prepare(
      "SELECT id, client_number, full_name FROM users WHERE role = 'client' ORDER BY full_name").all(),
    stands: db.prepare('SELECT id, stand_number FROM stands ORDER BY stand_number').all(),
    methods: db.prepare(
      "SELECT DISTINCT method FROM payments WHERE method IS NOT NULL AND method <> '' ORDER BY method")
      .all().map((r) => r.method)
  };
}

/* ── Recording transactions ─────────────────────────────────────────────── */

const VALID_TYPES = ['DEPOSIT', 'INSTALLMENT', 'FINAL_PAYMENT', 'REFUND'];
const VALID_METHODS = PAYMENT_METHODS;

/**
 * Validates and records one transaction, then recomputes the sale's balance.
 *
 * Returns { ok: true, id, sale } or { ok: false, error }.
 *
 * The rules enforced here are the accounting-integrity rules from the brief:
 *   1  a payment cannot be recorded against a sale that does not exist
 *   2  an instalment cannot exist without a linked sale
 *   3  a final payment cannot exceed the outstanding balance
 *   4  a refund cannot exceed what has actually been paid
 *   9  every transaction has a date and a positive amount
 *  11  no duplicate transaction id (the primary key guarantees this)
 */
function recordTransaction({
  ownershipId, type, amountCents, paidOn, method = null, reference,
  notes = null, recordedBy = null, approvedBy = null,
  originalTransactionId = null, allowOverpayment = false
} = {}) {
  const sale = ownershipId ? db.prepare(
    'SELECT id, sale_price_cents, sale_status FROM ownerships WHERE id = ?').get(ownershipId) : null;

  if (!sale) return { ok: false, error: 'A transaction must belong to an existing sale.' };
  if (sale.sale_status === 'Cancelled') {
    return { ok: false, error: 'That sale has been cancelled, so no money can be recorded against it.' };
  }
  if (!VALID_TYPES.includes(type)) return { ok: false, error: 'Unknown transaction type.' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'A transaction needs a positive amount.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paidOn || ''))) {
    return { ok: false, error: 'A transaction needs a valid date.' };
  }
  if (!reference) return { ok: false, error: 'A transaction needs a reference.' };
  if (method && !VALID_METHODS.includes(method)) return { ok: false, error: 'Unknown payment method.' };

  const balance = outstandingFor(ownershipId);

  /* Rule 3: you cannot take a final payment for more than is owed. */
  if (type === 'FINAL_PAYMENT' && !allowOverpayment && amountCents > balance.outstanding) {
    return {
      ok: false,
      error: `A final payment of ${money(amountCents)} is more than the ${money(balance.outstanding)} outstanding. `
        + 'Record it as an instalment, or allow the overpayment explicitly.'
    };
  }

  /* Rule 4: you cannot refund more than the client has actually paid. */
  if (type === 'REFUND' && !allowOverpayment && amountCents > balance.net) {
    return {
      ok: false,
      error: `A refund of ${money(amountCents)} is more than the ${money(balance.net)} received so far. `
        + 'Only an administrator can override this.'
    };
  }

  const info = db.prepare(`
    INSERT INTO payments
      (user_id, stand_id, ownership_id, type, paid_on, amount_cents, status, method,
       reference, notes, recorded_by, approved_by, original_transaction_id)
    VALUES (?, ?, ?, ?, ?, ?, 'Confirmed', ?, ?, ?, ?, ?, ?)`).run(
    db.prepare('SELECT user_id, stand_id FROM ownerships WHERE id = ?').get(ownershipId).user_id,
    db.prepare('SELECT stand_id FROM ownerships WHERE id = ?').get(ownershipId).stand_id,
    ownershipId, type, paidOn, amountCents, method, reference, notes,
    recordedBy, approvedBy, originalTransactionId);

  const id = Number(info.lastInsertRowid);

  financeAudit({
    actorUserId: recordedBy,
    action: `${type.toLowerCase()}_created`,
    entity: 'payment',
    entityId: id,
    reference,
    newValue: `${amountCents} cents on ${paidOn}`,
    reason: notes
  });

  const sale2 = recomputeSale(ownershipId, recordedBy);
  return { ok: true, id, sale: sale2 };
}

/** The balance figures for one sale, or null when it does not exist. */
function outstandingFor(saleId) {
  const s = saleById(saleId);
  if (!s) return null;
  return { outstanding: s.outstanding_cents, net: s.net_cents, price: s.sale_price_cents };
}

/**
 * Voids a transaction rather than deleting it.
 *
 * Rule 7 says a voided transaction must not remain in the analytics, and rule
 * 8 says edits must keep an audit trail. Deleting the row would satisfy the
 * first and destroy the second, so the row is kept and excluded.
 */
function voidTransaction(id, { actorId = null, reason = null } = {}) {
  const before = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!before) return { ok: false, error: 'Transaction not found.' };
  if (before.voided_at) return { ok: false, error: 'That transaction is already void.' };

  const voidedAt = new Date().toISOString();
  db.prepare('UPDATE payments SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?')
    .run(voidedAt, actorId, reason, id);

  financeAudit({
    actorUserId: actorId,
    action: 'payment_voided',
    entity: 'payment',
    entityId: id,
    reference: before.reference,
    oldValue: `${before.amount_cents} cents, ${before.status}`,
    newValue: 'void',
    reason
  });

  if (before.ownership_id) recomputeSale(before.ownership_id, actorId);
  return { ok: true };
}

/**
 * Confirms a pending transaction, or puts a confirmed one back to pending.
 *
 * Routed through here rather than straight to the table because two things
 * must happen with it: the change belongs in the audit trail, and the sale's
 * balance has to be recomputed — confirming the payment that clears a balance
 * is exactly the moment a sale becomes Completed.
 */
function setTransactionStatus(id, status, { actorId = null, reason = null } = {}) {
  const before = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!before) return { ok: false, error: 'Transaction not found.' };
  if (!PAYMENT_STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  if (before.voided_at) return { ok: false, error: 'That transaction is void, so its status cannot change.' };
  if (before.status === status) return { ok: true, unchanged: true };

  db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, id);

  financeAudit({
    actorUserId: actorId,
    action: 'payment_status_changed',
    entity: 'payment',
    entityId: id,
    reference: before.reference,
    oldValue: before.status,
    newValue: status,
    reason
  });

  if (before.ownership_id) recomputeSale(before.ownership_id, actorId);
  return { ok: true };
}

/** Restores a voided transaction, with the reversal recorded. */
function unvoidTransaction(id, { actorId = null, reason = null } = {}) {
  const before = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!before) return { ok: false, error: 'Transaction not found.' };
  if (!before.voided_at) return { ok: false, error: 'That transaction is not void.' };

  db.prepare('UPDATE payments SET voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE id = ?')
    .run(id);

  financeAudit({
    actorUserId: actorId,
    action: 'payment_restored',
    entity: 'payment',
    entityId: id,
    reference: before.reference,
    oldValue: 'void',
    newValue: `${before.amount_cents} cents`,
    reason
  });

  if (before.ownership_id) recomputeSale(before.ownership_id, actorId);
  return { ok: true };
}

/** Edits an existing transaction, recording both the old and new values. */
function updateTransaction(id, { paidOn, amountCents, method, status, notes, actorId, reason }) {
  const before = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!before) return { ok: false, error: 'Transaction not found.' };
  if (before.voided_at) return { ok: false, error: 'That transaction is void and cannot be edited.' };

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'A transaction needs a positive amount.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paidOn || ''))) {
    return { ok: false, error: 'A transaction needs a valid date.' };
  }
  if (!PAYMENT_STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  if (method && !VALID_METHODS.includes(method)) return { ok: false, error: 'Unknown payment method.' };

  db.prepare(`UPDATE payments SET paid_on = ?, amount_cents = ?, method = ?, status = ?, notes = ?
               WHERE id = ?`).run(paidOn, amountCents, method, status, notes, id);

  financeAudit({
    actorUserId: actorId,
    action: 'payment_edited',
    entity: 'payment',
    entityId: id,
    reference: before.reference,
    oldValue: `${before.amount_cents} cents, ${before.paid_on}, ${before.status}, ${before.method || 'no method'}`,
    newValue: `${amountCents} cents, ${paidOn}, ${status}, ${method || 'no method'}`,
    reason
  });

  if (before.ownership_id) recomputeSale(before.ownership_id, actorId);
  return { ok: true };
}

/* Uses the shared formatter so an error message and a page never disagree. */
/* ── Period helpers ─────────────────────────────────────────────────────── */

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * The Monday-to-Sunday week, `offsetWeeks` away from the anchor week.
 * Weeks run Monday-first because that is how the office reads a week.
 */
function weekBounds(offsetWeeks = 0, anchor = new Date()) {
  const d = new Date(Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate()));
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset + offsetWeeks * 7);

  const from = iso(d);
  d.setUTCDate(d.getUTCDate() + 6);
  return { from, to: iso(d) };
}

/** 'YYYY-MM' shifted by whole months, which keeps December/January correct. */
function shiftMonth(month, months) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Every day between two ISO dates, inclusive, as ISO strings. */
function daysBetween(from, to) {
  const out = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    out.push(iso(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

module.exports = {
  filtersFrom, hasFilters, kpis, collectionAnalysis, byProject, byAgent, byType,
  sales, saleById, saleTransactions, sumTransactions, sumSales,
  dailySeries, monthlySeries, ledger,
  recomputeSale, recomputeAllSales, financeAudit, financeAuditLog, filterOptions,
  decorateSale, LEDGER_SORTS,
  recordTransaction, voidTransaction, unvoidTransaction, updateTransaction, outstandingFor,
  setTransactionStatus,
  VALID_TYPES, VALID_METHODS,
  weekBounds, shiftMonth, daysBetween
};
