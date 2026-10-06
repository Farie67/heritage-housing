'use strict';

/* ==========================================================================
   Sales analytics views.

   Server-rendered like the rest of the admin, so every figure works with
   JavaScript disabled and no number is fetched separately from the page it
   appears on.

   Charts are CSS bars rather than a charting library: there is no dependency
   available, and bars built from divs are responsive and printable by default.
   ========================================================================== */

const { esc, safeLink } = require('./views');
const { money, plainMoney, formatDate } = require('./format');
const { PAYMENT_METHODS } = require('./db');
/* One-directional: analytics does not require the view layer. */
const { shiftMonth } = require('./analytics');
/* One-directional: views-admin does not require this module, so there is no
   require cycle. */
const { adminLayout: layout } = require('./views-admin');

const TYPE_LABEL = {
  DEPOSIT: 'Deposit',
  INSTALLMENT: 'Instalment',
  FINAL_PAYMENT: 'Final payment',
  REFUND: 'Refund'
};

const n = (v) => Number(v) || 0;

/* ── Small building blocks ──────────────────────────────────────────────── */

/** A KPI tile. `tone` colours the value only where it carries meaning. */
function kpi(label, value, { hint = '', tone = '' } = {}) {
  return `      <div class="kpi">
        <span class="kpi-label">${esc(label)}</span>
        <strong class="kpi-value${tone ? ` ${tone}` : ''}">${esc(value)}</strong>
        ${hint ? `<span class="kpi-hint">${esc(hint)}</span>` : ''}
      </div>`;
}

/** One horizontal bar, sized against the largest value in its group. */
function bar(label, value, max, formatted, tone = '') {
  const pct = max > 0 ? (n(value) / max) * 100 : 0;
  const width = value > 0 ? Math.max(pct, 1.5) : 0;
  return `      <div class="bar-row">
        <span class="bar-label">${esc(label)}</span>
        <span class="bar-track"><span class="bar-fill ${tone}" style="width:${width.toFixed(1)}%"></span></span>
        <span class="bar-value">${esc(formatted)}</span>
      </div>`;
}

/** A bar row that shows a count as well, for the sales-vs-collections view. */
function dualBar(label, salesCents, collectedCents, max) {
  const w = (v) => (max > 0 && v > 0 ? Math.max((v / max) * 100, 1.5) : 0);
  return `      <div class="bar-row bar-row-dual">
        <span class="bar-label">${esc(label)}</span>
        <span class="bar-track">
          <span class="bar-fill" style="width:${w(salesCents).toFixed(1)}%"></span>
          <span class="bar-fill secondary" style="width:${w(collectedCents).toFixed(1)}%"></span>
        </span>
        <span class="bar-value">${esc(money(salesCents))} <small>/ ${esc(money(collectedCents))}</small></span>
      </div>`;
}

/* ── Filters ────────────────────────────────────────────────────────────── */

function option(value, label, selected) {
  return `          <option value="${esc(value)}"${String(selected) === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
}

function filterBar({ filters: f, options, action = '/admin/analytics' }) {
  const projectOpts = options.projects.map((p) => option(p.id, p.name, f.projectId)).join('\n');
  const agentOpts = options.agents.map((a) => option(a.id, a.name, f.agentId)).join('\n');
  const clientOpts = options.clients.map((c) => option(c.id, `${c.client_number} — ${c.full_name}`, f.clientId)).join('\n');
  const standOpts = options.stands.map((s) => option(s.id, s.stand_number, f.standId)).join('\n');
  const methodOpts = options.methods.map((m) => option(m, m, f.method)).join('\n');

  return `    <form class="filters analytics-filters" method="get" action="${esc(action)}" role="search">
      <div class="field">
        <label for="f-from">From</label>
        <input id="f-from" name="from" type="date" value="${esc(f.from || '')}">
      </div>
      <div class="field">
        <label for="f-to">To</label>
        <input id="f-to" name="to" type="date" value="${esc(f.to || '')}">
      </div>
      <div class="field">
        <label for="f-project">Project</label>
        <select id="f-project" name="project"><option value="">All projects</option>
${projectOpts}
        </select>
      </div>
      <div class="field">
        <label for="f-agent">Sales agent</label>
        <select id="f-agent" name="agent"><option value="">All agents</option>
${agentOpts}
        </select>
      </div>
      <div class="field">
        <label for="f-type">Transaction type</label>
        <select id="f-type" name="type"><option value="">All types</option>
${['DEPOSIT', 'INSTALLMENT', 'FINAL_PAYMENT', 'REFUND'].map((t) => option(t, TYPE_LABEL[t], f.type)).join('\n')}
        </select>
      </div>
      <div class="field">
        <label for="f-method">Payment method</label>
        <select id="f-method" name="method"><option value="">All methods</option>
${methodOpts}
        </select>
      </div>
      <div class="field">
        <label for="f-status">Sale status</label>
        <select id="f-status" name="saleStatus"><option value="">All statuses</option>
${['Active', 'Completed', 'Cancelled'].map((s) => option(s, s, f.saleStatus)).join('\n')}
        </select>
      </div>
      <div class="field">
        <label for="f-client">Client</label>
        <select id="f-client" name="client"><option value="">All clients</option>
${clientOpts}
        </select>
      </div>
      <div class="field">
        <label for="f-stand">Stand</label>
        <select id="f-stand" name="stand"><option value="">All stands</option>
${standOpts}
        </select>
      </div>
      <div class="field">
        <label for="f-q">Search reference</label>
        <input id="f-q" name="q" type="search" value="${esc(f.search || '')}" placeholder="reference or note">
      </div>
      <button class="btn primary" type="submit">Apply</button>
      <a class="btn outline" href="/admin/analytics">Clear filters</a>
    </form>`;
}

/* ── Tables ─────────────────────────────────────────────────────────────── */

function projectTable(rows) {
  if (!rows.length) return '      <p class="muted">No sales match the current filters.</p>';

  return `      <table class="portal-table">
        <caption>Sales grouped by development</caption>
        <thead>
          <tr>
            <th scope="col">Project</th><th scope="col">Stands sold</th><th scope="col">Contract value</th>
            <th scope="col">Deposits</th><th scope="col">Instalments</th><th scope="col">Final</th>
            <th scope="col">Refunds</th><th scope="col">Net collected</th><th scope="col">Outstanding</th>
            <th scope="col">Completed</th><th scope="col">Active</th>
          </tr>
        </thead>
        <tbody>
${rows.map((r) => `          <tr>
            <td><strong>${esc(r.projectName)}</strong></td>
            <td>${esc(r.standsSold)}</td>
            <td>${esc(money(r.contractCents))}</td>
            <td>${esc(money(r.depositsCents))}</td>
            <td>${esc(money(r.installmentsCents))}</td>
            <td>${esc(money(r.finalsCents))}</td>
            <td${r.refundsCents ? ' class="neg"' : ''}>${esc(money(r.refundsCents))}</td>
            <td>${esc(money(r.netCents))}</td>
            <td>${esc(money(r.outstandingCents))}</td>
            <td>${esc(r.completed)}</td>
            <td>${esc(r.active)}</td>
          </tr>`).join('\n')}
        </tbody>
      </table>`;
}

function agentTable(rows) {
  if (!rows.length) return '      <p class="muted">No sales match the current filters.</p>';

  return `      <table class="portal-table">
        <caption>Sales grouped by the agent credited with the sale</caption>
        <thead>
          <tr>
            <th scope="col">Agent</th><th scope="col">Sales</th><th scope="col">Contract value</th>
            <th scope="col">Deposits</th><th scope="col">Instalments</th><th scope="col">Final</th>
            <th scope="col">Refunds</th><th scope="col">Net collected</th><th scope="col">Outstanding</th>
          </tr>
        </thead>
        <tbody>
${rows.map((r) => `          <tr>
            <td><strong>${esc(r.agentName)}</strong></td>
            <td>${esc(r.salesCount)}</td>
            <td>${esc(money(r.contractCents))}</td>
            <td>${esc(money(r.depositsCents))}</td>
            <td>${esc(money(r.installmentsCents))}</td>
            <td>${esc(money(r.finalsCents))}</td>
            <td${r.refundsCents ? ' class="neg"' : ''}>${esc(money(r.refundsCents))}</td>
            <td>${esc(money(r.netCents))}</td>
            <td>${esc(money(r.outstandingCents))}</td>
          </tr>`).join('\n')}
        </tbody>
      </table>`;
}

function ledgerTable(led, { baseQuery = '' } = {}) {
  if (!led.rows.length) return '      <p class="muted">No transactions match the current filters.</p>';

  const sortLink = (key, label) => {
    const q = new URLSearchParams(baseQuery);
    q.set('sort', key);
    q.set('dir', 'desc');
    return `<a href="?${esc(q.toString())}">${esc(label)}</a>`;
  };

  return `      <table class="portal-table ledger-table">
        <caption>${esc(led.total)} transaction${led.total === 1 ? '' : 's'}, newest first</caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">${sortLink('date', 'Date')}</th>
            <th scope="col">${sortLink('type', 'Type')}</th>
            <th scope="col">${sortLink('client', 'Client')}</th>
            <th scope="col">${sortLink('stand', 'Stand')}</th>
            <th scope="col">${sortLink('project', 'Project')}</th>
            <th scope="col">Sale</th>
            <th scope="col">${sortLink('amount', 'Amount')}</th>
            <th scope="col">Method</th>
            <th scope="col">Reference</th>
            <th scope="col">Status</th>
            <th scope="col">Recorded by</th>
          </tr>
        </thead>
        <tbody>
${led.rows.map((r) => `          <tr${r.voided_at ? ' class="voided"' : ''}>
            <td>${esc(r.id)}</td>
            <td>${esc(formatDate(r.paid_on))}</td>
            <td><span class="tag tag-${esc(String(r.type).toLowerCase())}">${esc(TYPE_LABEL[r.type] || r.type || '—')}</span></td>
            <td>${esc(r.client_name || '—')}<br><small class="muted">${esc(r.client_number || '')}</small></td>
            <td>${esc(r.stand_number || '—')}</td>
            <td>${esc(r.project_name || '—')}</td>
            <td>${r.ownership_id ? `<a href="/admin/sales/${esc(r.ownership_id)}">#${esc(r.ownership_id)}</a>` : '—'}</td>
            <td${r.type === 'REFUND' ? ' class="neg"' : ''}>${r.type === 'REFUND' ? '&minus;' : ''}${esc(money(r.amount_cents))}</td>
            <td>${esc(r.method || '—')}</td>
            <td>${esc(r.reference)}</td>
            <td>${esc(r.status)}${r.voided_at ? ' <span class="tag tag-refund">Void</span>' : ''}</td>
            <td>${esc(r.recorded_by_number || '—')}</td>
          </tr>`).join('\n')}
        </tbody>
      </table>

      <nav class="pager" aria-label="Ledger pages">
        <span>Page ${esc(led.page)} of ${esc(led.pages)}</span>
        ${led.page > 1 ? `<a class="btn outline" href="?${esc(new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(baseQuery)), page: String(led.page - 1) }).toString())}">Previous</a>` : ''}
        ${led.page < led.pages ? `<a class="btn outline" href="?${esc(new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(baseQuery)), page: String(led.page + 1) }).toString())}">Next</a>` : ''}
      </nav>`;
}

/* ── Pages ──────────────────────────────────────────────────────────────── */

function renderAnalytics({ kpis: k, collection: c, projects, agents, types, ledger,
  options, filters: f, user, csrf, active = '/admin/analytics', flash = '' }) {
  const maxProject = Math.max(...projects.map((p) => p.contractCents), 0);
  const maxType = Math.max(...types.map((t) => t.cents), 0);
  const salesVsCollected = Math.max(k.contractCents, k.netCents, 1);

  const query = new URLSearchParams(
    Object.entries({
      from: f.from, to: f.to, project: f.projectId, agent: f.agentId, type: f.type,
      method: f.method, saleStatus: f.saleStatus, client: f.clientId, stand: f.standId, q: f.search
    }).filter(([, v]) => v !== null && v !== undefined && v !== '')
  ).toString();

  const body = `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">SALES ANALYTICS</span>
        <h1>Revenue monitoring</h1>
        <p class="muted">Every figure below is calculated from the transaction records, not entered by hand.</p>
      </div>
      <a class="btn outline" href="/admin/analytics/ledger">Full ledger</a>
    </div>

    ${flash ? `<p class="notice success">${esc(flash)}</p>` : ''}

    <nav class="tabs" aria-label="Analytics period">
      <a href="/admin/analytics"${active === '/admin/analytics' ? ' aria-current="page"' : ''}>Overview</a>
      <a href="/admin/analytics/weekly"${active === '/admin/analytics/weekly' ? ' aria-current="page"' : ''}>Weekly</a>
      <a href="/admin/analytics/monthly"${active === '/admin/analytics/monthly' ? ' aria-current="page"' : ''}>Monthly</a>
      <a href="/admin/analytics/annual"${active === '/admin/analytics/annual' ? ' aria-current="page"' : ''}>Annual</a>
      <a href="/admin/analytics/ledger"${active === '/admin/analytics/ledger' ? ' aria-current="page"' : ''}>Ledger</a>
    </nav>

${filterBar({ filters: f, options })}

    <h2 class="section-title">Key figures</h2>    <div class="kpi-grid">
${kpi('Total new sales', String(k.totalNewSales), { hint: 'sale agreements recorded' })}
${kpi('Contract sales value', money(k.contractCents), { hint: 'agreed sale prices — not cash' })}
${kpi('Total deposits', money(k.depositsCents))}
${kpi('Total installments', money(k.installmentsCents))}
${kpi('Total final payments', money(k.finalsCents))}
${kpi('Gross collections', money(k.grossCents), { hint: 'deposits + instalments + final' })}
${kpi('Total refunds', money(k.refundsCents), { tone: k.refundsCents ? 'neg' : '' })}
${kpi('Net collections', money(k.netCents), { hint: 'gross less refunds' })}
${kpi('Outstanding receivables', money(k.outstandingCents), { tone: k.outstandingCents ? 'warn' : 'good' })}
${kpi('Completed sales', String(k.completedSales), { hint: 'balance cleared' })}
${kpi('Active payment plans', String(k.activePlans), { hint: 'balance outstanding' })}
    </div>

    ${k.overpaidCents ? `<p class="notice info">Credit balances: ${esc(money(k.overpaidCents))} has been
      paid above the agreed price across ${esc(k.totalNewSales)} sale(s). That is shown separately rather
      than netted off the receivables.</p>` : ''}

    <h2 class="section-title">Sales vs money actually collected</h2>
    <div class="client-card">
      <p class="field-hint">Contracted value is what clients have agreed to pay. Collected is what has
        actually arrived. The gap is the outstanding receivable.</p>
${bar('Contract sales value', k.contractCents, salesVsCollected, money(k.contractCents))}
${bar('Net collections', k.netCents, salesVsCollected, money(k.netCents), 'secondary')}
${bar('Outstanding receivables', Math.max(k.outstandingCents, 0), salesVsCollected, money(k.outstandingCents), 'warn')}
    </div>

    <h2 class="section-title">Collection analysis</h2>
    <div class="kpi-grid">
${kpi('Total amount due', money(c.dueCents))}
${kpi('Total collected', money(c.collectedCents))}
${kpi('Total outstanding', money(c.outstandingCents), { tone: c.outstandingCents ? 'warn' : 'good' })}
${kpi('Collection rate', c.rate.toFixed(1) + '%', { hint: 'net collections &divide; contract value' })}
${kpi('Average transaction', money(c.averageTransactionCents), { hint: `${c.totalTransactions} transaction(s)` })}
${kpi('Average deposit', money(c.averageDepositCents), { hint: `${c.depositCount} deposit(s)` })}
${kpi('Average installment', money(c.averageInstallmentCents), { hint: `${c.installmentCount} instalment(s)` })}
${kpi('Average final payment', money(c.averageFinalCents), { hint: `${c.finalCount} final payment(s)` })}
${kpi('Total refunded', money(c.refundCents), { tone: c.refundCents ? 'neg' : '' })}
${kpi('Refund percentage', c.refundRate.toFixed(1) + '%', { hint: 'of gross collections' })}
    </div>

    <h2 class="section-title">Transaction type breakdown</h2>
    <div class="client-card">
${types.map((t) => bar(TYPE_LABEL[t.type] || t.type, t.cents, maxType,
    `${money(t.cents)}  (${t.count})`,
    t.type === 'REFUND' ? 'neg' : (t.type === 'FINAL_PAYMENT' ? 'good' : ''))).join('\n')}
    </div>

    <h2 class="section-title">Sales performance by project</h2>
    <div class="client-card">
${projects.length ? projects.map((p) => dualBar(p.projectName, p.contractCents, p.netCents, maxProject)).join('\n') : '<p class="muted">No sales to show.</p>'}
    </div>

    <div class="client-card" style="margin-top:20px">
${projectTable(projects)}
    </div>

    <h2 class="section-title">Sales performance by agent</h2>
    <div class="client-card">
${agentTable(agents)}
    </div>

    <h2 class="section-title">Recent transactions</h2>
    <div class="client-card">
${ledgerTable(ledger, { baseQuery: query })}
      <p style="margin-top:14px"><a class="btn outline" href="/admin/analytics/ledger">Open the full ledger</a></p>
    </div>

    <h2 class="section-title">Exports</h2>
    <div class="client-card">
      <p class="field-hint">Each download respects the filters currently applied above.</p>
${exportPanel(query)}
    </div>
  </section>`;

  return layout({ title: 'Sales analytics', active, user, csrf, body });
}

/* ── Ledger ─────────────────────────────────────────────────────────────── */

function renderLedger({ ledger, totals, options, filters: f, user, csrf, flash = '' }) {
  const query = new URLSearchParams(
    Object.entries({
      from: f.from, to: f.to, project: f.projectId, agent: f.agentId, type: f.type,
      method: f.method, saleStatus: f.saleStatus, client: f.clientId, stand: f.standId, q: f.search
    }).filter(([, v]) => v !== null && v !== undefined && v !== '')
  ).toString();

  const body = `  <section class="container inner-page">
    <p><a class="text-btn" href="/admin/analytics">&larr; Sales analytics</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">TRANSACTION LEDGER</span>
        <h1>Every financial transaction</h1>
        <p class="muted">Search, sort and filter the complete record. Voided transactions are shown
          greyed out and excluded from every total.</p>
      </div>
    </div>

    ${flash ? `<p class="notice success">${esc(flash)}</p>` : ''}

${filterBar({ filters: f, options, action: '/admin/analytics/ledger' })}

${exportBar('ledger', query)}

    <div class="kpi-grid">
${kpi('Transactions shown', String(ledger.total))}
${kpi('Deposits', money(totals.depositsCents))}
${kpi('Instalments', money(totals.installmentsCents))}
${kpi('Final payments', money(totals.finalsCents))}
${kpi('Gross collections', money(totals.grossCents))}
${kpi('Refunds', money(totals.refundsCents), { tone: totals.refundsCents ? 'neg' : '' })}
${kpi('Net collections', money(totals.netCents))}
    </div>

    <div class="client-card">
${ledgerTable(ledger, { baseQuery: query })}
    </div>
  </section>`;

  return layout({ title: 'Transaction ledger', active: '/admin/analytics/ledger', user, csrf, body });
}

/* ── Sales detail ───────────────────────────────────────────────────────── */

function renderSaleDetail({ sale, transactions, audit, user, csrf, flash = '', error = '' }) {
  const balanceTone = sale.outstanding_cents ? 'warn' : 'good';

  const history = transactions.length ? transactions.map((t) => `          <tr${t.voided_at ? ' class="voided"' : ''}>
            <td>${esc(formatDate(t.paid_on))}</td>
            <td><span class="tag tag-${esc(String(t.type).toLowerCase())}">${esc(TYPE_LABEL[t.type] || t.type || '—')}</span></td>
            <td${t.type === 'REFUND' ? ' class="neg"' : ''}>${t.type === 'REFUND' ? '&minus;' : ''}${esc(money(t.amount_cents))}</td>
            <td>${esc(t.method || '—')}</td>
            <td>${esc(t.reference)}</td>
            <td>${esc(t.status)}</td>
            <td>${esc(t.recorded_by_number || '—')}</td>
            <td>${esc(t.notes || '')}</td>
            <td>
              <form method="post" action="/admin/payments/${esc(t.id)}/${t.voided_at ? 'restore' : 'void'}" class="inline-form">
                <input type="hidden" name="csrf" value="${esc(csrf)}">
                <input type="hidden" name="reason" value="${t.voided_at ? 'Restored from the sale page' : 'Voided from the sale page'}">
                <button class="text-btn" type="submit">${t.voided_at ? 'Restore' : 'Void'}</button>
              </form>
            </td>
          </tr>`).join('\n')
    : '          <tr><td colspan="9">No payments recorded on this sale yet.</td></tr>';

  const auditRows = audit.length ? audit.map((a) => `          <tr>
            <td>${esc(formatDate(a.at))}</td>
            <td>${esc(a.actor_number || '—')}</td>
            <td>${esc(a.action)}</td>
            <td>${esc(a.reference || '')}</td>
            <td>${esc(a.old_value || '')}</td>
            <td>${esc(a.new_value || '')}</td>
            <td>${esc(a.reason || '')}</td>
          </tr>`).join('\n')
    : '          <tr><td colspan="7">Nothing recorded against this sale yet.</td></tr>';

  const body = `  <section class="container inner-page">
    <p><a class="text-btn" href="/admin/analytics">&larr; Sales analytics</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">SALE #${esc(sale.sale_id)}</span>
        <h1>${esc(sale.client_name || sale.full_name)}</h1>
        <p class="muted">${esc(sale.stand_number)} &middot; ${esc(sale.project_name)} &middot;
          <span class="tag tag-${sale.sale_status === 'Completed' ? 'deposit' : 'installment'}">${esc(sale.sale_status)}</span></p>
      </div>
      <a class="btn outline" href="/admin/clients/${esc(sale.client_id)}">Open client record</a>
    </div>

    ${flash ? `<p class="notice success">${esc(flash)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="client-grid">
      <div class="client-card">
        <h2>Client</h2>
        <div class="mini-grid">
          <div><small>Name</small><strong>${esc(sale.full_name || '—')}</strong></div>
          <div><small>Client number</small><strong>${esc(sale.client_number || '—')}</strong></div>
          <div><small>Email</small><strong>${esc(sale.email || '—')}</strong></div>
        </div>
      </div>
      <div class="client-card">
        <h2>Property</h2>
        <div class="mini-grid">
          <div><small>Project</small><strong>${esc(sale.project_name)}</strong></div>
          <div><small>Stand</small><strong>${esc(sale.stand_number)}</strong></div>
          <div><small>Size</small><strong>${esc(sale.size_sqm)}m&sup2;</strong></div>
          <div><small>Sale date</small><strong>${esc(formatDate(sale.sale_date))}</strong></div>
          <div><small>Agent</small><strong>${esc(sale.agent_name || 'Unassigned')}</strong></div>
          <div><small>Payment plan</small><strong>${esc(sale.payment_plan || '—')}</strong></div>
        </div>
      </div>
    </div>

    <h2 class="section-title">Payment summary</h2>
    <div class="kpi-grid">
${kpi('Sale price', money(sale.sale_price_cents))}
${kpi('Deposits', money(sale.deposits_cents))}
${kpi('Instalments', money(sale.installments_cents))}
${kpi('Final payment', money(sale.finals_cents))}
${kpi('Refunds', money(sale.refunds_cents), { tone: sale.refunds_cents ? 'neg' : '' })}
${kpi('Net amount paid', money(sale.net_cents))}
${kpi('Outstanding balance', money(sale.outstanding_cents), { tone: balanceTone })}
${kpi('Payment progress', sale.paidPercent + '%', { hint: `${sale.txn_count} transaction(s)` })}
    </div>

    ${sale.overpaid_cents ? `<p class="notice info">This sale is paid ${esc(money(sale.overpaid_cents))}
      above the agreed price. That is a credit balance, not a receivable.</p>` : ''}

    <h2 class="section-title">Payment history</h2>
    <div class="client-card">
      <table class="portal-table">
        <caption>Every transaction on this sale, oldest first</caption>
        <thead>
          <tr>
            <th scope="col">Date</th><th scope="col">Type</th><th scope="col">Amount</th>
            <th scope="col">Method</th><th scope="col">Reference</th><th scope="col">Status</th>
            <th scope="col">Recorded by</th><th scope="col">Notes</th><th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
${history}
        </tbody>
      </table>
    </div>

    <h2 class="section-title">Record a transaction</h2>
    <div class="client-card">
      <p class="field-hint">The outstanding balance on this sale is
        <strong>${esc(money(sale.outstanding_cents))}</strong>. A final payment or a refund larger
        than the amounts actually owed or paid will be refused unless the override is ticked.</p>
      <form method="post" action="/admin/sales/${esc(sale.sale_id)}/transactions" class="payment-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <div class="field">
          <label for="txnType">Type</label>
          <select id="txnType" name="type">
            <option value="DEPOSIT">Deposit</option>
            <option value="INSTALLMENT" selected>Instalment</option>
            <option value="FINAL_PAYMENT">Final payment</option>
            <option value="REFUND">Refund</option>
          </select>
        </div>
        <div class="field">
          <label for="txnAmount">Amount (US$)</label>
          <input id="txnAmount" name="amount" type="text" inputmode="decimal" placeholder="1500.00" required>
        </div>
        <div class="field">
          <label for="txnDate">Date</label>
          <input id="txnDate" name="paidOn" type="date" value="${esc(new Date().toISOString().slice(0, 10))}" required>
        </div>
        <div class="field">
          <label for="txnMethod">Method</label>
          <select id="txnMethod" name="method">
            <option value="">Not recorded</option>
${PAYMENT_METHODS.map((mth) => `            <option>${esc(mth)}</option>`).join('\n')}
          </select>
        </div>
        <div class="field">
          <label for="txnNotes">Notes</label>
          <input id="txnNotes" name="notes" type="text" maxlength="300" placeholder="optional">
        </div>
        <div class="field">
          <label for="txnOverride">Override</label>
          <label class="check-inline"><input id="txnOverride" name="allowOverpayment" type="checkbox">
            <span>Allow a final payment or refund beyond the calculated limit</span></label>
        </div>
        <div class="field field-submit">
          <button class="btn primary" type="submit">Record transaction</button>
        </div>
      </form>
    </div>

    <h2 class="section-title">Financial audit trail</h2>
    <div class="client-card">
      <table class="portal-table">
        <caption>Every change to money on this sale</caption>
        <thead>
          <tr>
            <th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th>
            <th scope="col">Reference</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
${auditRows}
        </tbody>
      </table>
    </div>
  </section>`;

  return layout({ title: `Sale #${sale.sale_id}`, active: '/admin/analytics', user, csrf, body });
}

/* ── Period views ───────────────────────────────────────────────────────── */

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * The change between two periods, stated plainly.
 *
 * The arrow always follows the real direction of travel — a fall is shown as a
 * fall. `tone` is only applied where "up" genuinely means better, so a rise in
 * refunds is not painted green.
 */
function delta(current, previous, { upIsGood = true } = {}) {
  if (!previous && !current) return { text: 'No change', tone: '' };
  if (!previous) return { text: 'New this period', tone: upIsGood ? 'good' : 'warn' };

  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.round(pct) === 0) return { text: 'No change', tone: '' };

  const up = pct > 0;
  return {
    text: `${up ? '\u2191 Increased' : '\u2193 Decreased'} ${Math.abs(pct).toFixed(1)}%`,
    tone: upIsGood ? (up ? 'good' : 'warn') : (up ? 'warn' : 'good')
  };
}

function periodTabs(active) {
  const items = [
    ['/admin/analytics', 'Overview'],
    ['/admin/analytics/weekly', 'Weekly'],
    ['/admin/analytics/monthly', 'Monthly'],
    ['/admin/analytics/annual', 'Annual'],
    ['/admin/analytics/ledger', 'Ledger']
  ];
  return `    <nav class="tabs" aria-label="Analytics period">
${items.map(([href, label]) => `      <a href="${href}"${active === href ? ' aria-current="page"' : ''}>${label}</a>`).join('\n')}
    </nav>`;
}

/**
 * The three download links for one report.
 *
 * The current query string is carried across, so the exported file is the view
 * the administrator is actually looking at rather than the unfiltered default.
 */
function exportBar(type, query, context = {}) {
  const parts = [query, ...Object.entries(context)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)].filter(Boolean);
  const qs = parts.length ? `?${parts.join('&')}` : '';

  return `    <div class="export-bar">
      <span class="export-label">Export this view</span>
${['csv', 'xlsx', 'pdf'].map((f) => `      <a class="btn outline" href="/admin/analytics/export/${esc(type)}.${f}${esc(qs)}">`
    + `${f === 'xlsx' ? 'Excel' : f.toUpperCase()}</a>`).join('\n')}
    </div>`;
}

/** Every report, for the overview page's export panel. */
function exportPanel(query) {
  const reports = [
    ['project', 'Sales by project'],
    ['agent', 'Sales by agent'],
    ['outstanding', 'Outstanding balances'],
    ['payments', 'Payment history'],
    ['ledger', 'Transaction ledger']
  ];

  return `    <div class="export-panel">
${reports.map(([type, label]) => `      <div class="export-row">
        <span>${esc(label)}</span>
        <span class="export-links">
${['csv', 'xlsx', 'pdf'].map((f) => `          <a href="/admin/analytics/export/${type}.${f}${query ? `?${esc(query)}` : ''}">${f === 'xlsx' ? 'Excel' : f.toUpperCase()}</a>`).join('\n')}
        </span>
      </div>`).join('\n')}
    </div>`;
}

/** The shared KPI grid for a period, so all three views read the same. */function periodKpis(k) {
  return `    <div class="kpi-grid">
${kpi('New sales', String(k.totalNewSales), { hint: 'agreements recorded in this period' })}
${kpi('Value of new sales', money(k.contractCents), { hint: 'not cash collected' })}
${kpi('Deposits received', money(k.depositsCents))}
${kpi('Instalments received', money(k.installmentsCents))}
${kpi('Final payments', money(k.finalsCents))}
${kpi('Gross collections', money(k.grossCents))}
${kpi('Refunds', money(k.refundsCents), { tone: k.refundsCents ? 'neg' : '' })}
${kpi('Net collections', money(k.netCents))}
${kpi('Outstanding', money(k.ledgerOutstandingCents), { tone: k.ledgerOutstandingCents ? 'warn' : 'good' })}
${kpi('Completed sales', String(k.completedSales))}
${kpi('Active payment plans', String(k.activePlans))}
    </div>`;
}

/** A daily bar chart over the selected period. */
function dailyChart(series) {
  const max = Math.max(...series.map((d) => Math.max(d.salesCents, d.netCents, d.refundsCents)), 0);

  if (!max) {
    return '      <p class="muted">No sales or payments fall in this period.</p>';
  }

  return series.map((d, i) => {
    const label = DAY_NAMES[i % 7];
    const date = d.day.slice(8) + '/' + d.day.slice(5, 7);
    return `      <div class="bar-row bar-row-dual">
        <span class="bar-label">${esc(label)} <small class="muted">${esc(date)}</small></span>
        <span class="bar-track">
          <span class="bar-fill" style="width:${max ? Math.max((d.salesCents / max) * 100, d.salesCents ? 1.5 : 0).toFixed(1) : 0}%"></span>
          <span class="bar-fill secondary" style="width:${max ? Math.max((d.netCents / max) * 100, d.netCents ? 1.5 : 0).toFixed(1) : 0}%"></span>
          ${d.refundsCents ? `<span class="bar-fill neg" style="width:${(d.refundsCents / max * 100).toFixed(1)}%"></span>` : ''}
        </span>
        <span class="bar-value">${esc(money(d.salesCents))} <small>/ ${esc(money(d.netCents))}${d.refundsCents ? ` / &minus;${esc(money(d.refundsCents))}` : ''}</small></span>
      </div>`;
  }).join('\n');
}

/** A twelve-month chart with the four series the brief asks for. */
function monthChart(series) {
  const max = Math.max(...series.map((m) => Math.max(m.salesCents, m.grossCents, m.refundsCents, m.netCents)), 0);
  if (!max) return '      <p class="muted">Nothing was sold or collected in this year.</p>';

  const w = (v) => (max ? Math.max((v / max) * 100, v > 0 ? 1.5 : 0).toFixed(1) : 0);

  return series.map((m) => `      <div class="bar-row month-row">
        <span class="bar-label">${esc(m.label)}</span>
        <span class="bar-track month-track">
          <span class="bar-fill" style="width:${w(m.salesCents)}%" title="New sales value"></span>
          <span class="bar-fill secondary" style="width:${w(m.grossCents)}%" title="Cash collected"></span>
          <span class="bar-fill good" style="width:${w(m.netCents)}%" title="Net collections"></span>
          ${m.refundsCents ? `<span class="bar-fill neg" style="width:${w(m.refundsCents)}%" title="Refunds"></span>` : ''}
        </span>
        <span class="bar-value">${esc(money(m.salesCents))} / ${esc(money(m.grossCents))}${m.refundsCents ? ` / &minus;${esc(money(m.refundsCents))}` : ''}</span>
      </div>`).join('\n');
}

const CHART_KEY = `      <p class="chart-key">
        <span><i class="key key-sales"></i>New sales value</span>
        <span><i class="key key-collected"></i>Cash collected</span>
        <span><i class="key key-net"></i>Net collections</span>
        <span><i class="key key-refunds"></i>Refunds</span>
      </p>`;

/** Weekly analysis. */
function renderWeekly({ kpis: k, previous, series, range, weekOffset, custom, options,
  filters: f, user, csrf }) {
  const d = (label, cur, prev, opts) => {
    const change = delta(cur, prev, opts);
    return kpi(`${label} — change`, change.text, { tone: change.tone, hint: `previous week: ${money(prev)}` });
  };

  const body = `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">WEEKLY ANALYSIS</span>
        <h1>${esc(range.label)}</h1>
        <p class="muted">${esc(range.from)} to ${esc(range.to)} — keyed off the date each
          transaction happened, not the date of the sale.</p>
      </div>
    </div>

${periodTabs('/admin/analytics/weekly')}

    <nav class="tabs" aria-label="Week selection">
      <a href="/admin/analytics/weekly?week=0"${weekOffset === 0 && !custom ? ' aria-current="page"' : ''}>This week</a>
      <a href="/admin/analytics/weekly?week=-1"${weekOffset === -1 ? ' aria-current="page"' : ''}>Last week</a>
      <a href="/admin/analytics/weekly"${custom ? ' aria-current="page"' : ''}>Custom range</a>
    </nav>

${filterBar({ filters: f, options, action: '/admin/analytics/weekly' })}

${exportBar('weekly', '', { from: range.from, to: range.to, project: f.projectId })}

    <h2 class="section-title">This week</h2>
${periodKpis(k)}

    <h2 class="section-title">Compared with last week</h2>
    <div class="kpi-grid">
${d('Number of sales', k.totalNewSales, previous.totalNewSales)}
${d('Sales value', k.contractCents, previous.contractCents)}
${d('Collections', k.netCents, previous.netCents)}
${d('Refunds', k.refundsCents, previous.refundsCents, { upIsGood: false })}
    </div>

    <h2 class="section-title">Daily performance</h2>
    <div class="client-card">
${CHART_KEY}
${dailyChart(series)}
    </div>
  </section>`;

  return layout({ title: 'Weekly analysis', active: '/admin/analytics/weekly', user, csrf, body });
}

/** Monthly analysis, with the current-vs-previous comparison. */
function renderMonthly({ kpis: k, previous, previousLabel, series, month, year, options,
  filters: f, user, csrf }) {
  const monthName = new Date(`${month}-01T00:00:00Z`)
    .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const cmp = (label, cur, prev, opts) => {
    const change = delta(cur, prev, opts);
    return kpi(label, change.text, { tone: change.tone, hint: `${previousLabel}: ${money(prev)}` });
  };

  const monthOptions = [];
  for (let i = 0; i < 24; i++) {
    const value = shiftMonth(month, -i);
    const label = new Date(`${value}-01T00:00:00Z`)
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    monthOptions.push(option(value, label, month));
  }

  const body = `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">MONTHLY ANALYSIS</span>
        <h1>${esc(monthName)}</h1>
        <p class="muted">Compared with ${esc(previousLabel)}. The change shown is the real
          calculated change, whichever direction it went.</p>
      </div>
    </div>

${periodTabs('/admin/analytics/monthly')}

    <form class="filters" method="get" action="/admin/analytics/monthly">
      <div class="field">
        <label for="m-month">Month</label>
        <select id="m-month" name="month">
${monthOptions.join('\n')}
        </select>
      </div>
      <div class="field">
        <label for="m-project">Project</label>
        <select id="m-project" name="project"><option value="">All projects</option>
${options.projects.map((p) => option(p.id, p.name, f.projectId)).join('\n')}
        </select>
      </div>
      <button class="btn primary" type="submit">Apply</button>
      <a class="btn outline" href="/admin/analytics/monthly">Clear filters</a>
    </form>

${exportBar('monthly', '', { month, project: f.projectId })}

    <h2 class="section-title">${esc(monthName)}</h2>
${periodKpis(k)}

    <h2 class="section-title">${esc(monthName)} vs ${esc(previousLabel)}</h2>
    <div class="kpi-grid">
${cmp('Number of sales', k.totalNewSales, previous.totalNewSales)}
${cmp('Sales value', k.contractCents, previous.contractCents)}
${cmp('Collections', k.netCents, previous.netCents)}
${cmp('Refunds', k.refundsCents, previous.refundsCents, { upIsGood: false })}
${cmp('Net collections', k.netCents, previous.netCents)}
    </div>

    <h2 class="section-title">Monthly trend for ${esc(year)}</h2>
    <div class="client-card">
${CHART_KEY}
${monthChart(series)}
    </div>
  </section>`;

  return layout({ title: 'Monthly analysis', active: '/admin/analytics/monthly', user, csrf, body });
}

/** Annual analysis with the twelve-month chart. */
function renderAnnual({ kpis: k, series, year, years, options, filters: f, user, csrf }) {
  const body = `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">ANNUAL ANALYSIS</span>
        <h1>${esc(year)}</h1>
        <p class="muted">Twelve months of sales and collections, calculated from the transaction record.</p>
      </div>
    </div>

${periodTabs('/admin/analytics/annual')}

    <form class="filters" method="get" action="/admin/analytics/annual">
      <div class="field">
        <label for="a-year">Year</label>
        <select id="a-year" name="year">
${years.map((y) => option(y, y, year)).join('\n')}
        </select>
      </div>
      <div class="field">
        <label for="a-project">Project</label>
        <select id="a-project" name="project"><option value="">All projects</option>
${options.projects.map((p) => option(p.id, p.name, f.projectId)).join('\n')}
        </select>
      </div>
      <button class="btn primary" type="submit">Apply</button>
      <a class="btn outline" href="/admin/analytics/annual">Clear filters</a>
    </form>

${exportBar('annual', '', { year, project: f.projectId })}

    <h2 class="section-title">${esc(year)} in total</h2>
${periodKpis(k)}

    <h2 class="section-title">Twelve-month chart</h2>
    <div class="client-card">
${CHART_KEY}
${monthChart(series)}
    </div>

    <h2 class="section-title">Month by month</h2>
    <div class="client-card">
      <table class="portal-table">
        <caption>Every month of ${esc(year)}, including the empty ones</caption>
        <thead>
          <tr>
            <th scope="col">Month</th><th scope="col">Sales</th><th scope="col">Sales value</th>
            <th scope="col">Deposits</th><th scope="col">Instalments</th><th scope="col">Final</th>
            <th scope="col">Gross collected</th><th scope="col">Refunds</th><th scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
${series.map((m) => `          <tr>
            <td><strong>${esc(m.label)}</strong></td>
            <td>${esc(m.salesCount)}</td>
            <td>${esc(money(m.salesCents))}</td>
            <td>${esc(money(m.depositsCents))}</td>
            <td>${esc(money(m.installmentsCents))}</td>
            <td>${esc(money(m.finalsCents))}</td>
            <td>${esc(money(m.grossCents))}</td>
            <td${m.refundsCents ? ' class="neg"' : ''}>${esc(money(m.refundsCents))}</td>
            <td>${esc(money(m.netCents))}</td>
          </tr>`).join('\n')}
        </tbody>
      </table>
    </div>
  </section>`;

  return layout({ title: 'Annual analysis', active: '/admin/analytics/annual', user, csrf, body });
}

module.exports = {
  renderAnalytics, renderSaleDetail, renderLedger, renderWeekly, renderMonthly, renderAnnual,
  filterBar, ledgerTable, kpi, bar, TYPE_LABEL, delta
};
