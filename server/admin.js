'use strict';

/* ==========================================================================
   Admin area.

   Mounted from index.js as a single entry point: handleAdmin() returns true
   when it dealt with the request, false to let the normal router continue.

   Authorisation is role-based and enforced here, server-side, on every
   request — never in the browser. A signed-in *client* is redirected to the
   ordinary portal, not shown an admin page.
   ========================================================================== */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./config');
const { audit, admin, enquiries, users, content, db, PAYMENT_STATUSES, PAYMENT_METHODS,
  PROPERTY_TYPES, STAND_STATUSES, PROJECT_STATUSES } = require('./db');
const contentSchema = require('./content');
const auth = require('./auth');
const views = require('./views-admin');
const viewsAnalytics = require('./views-analytics');
const analytics = require('./analytics');
const reportExports = require('./exports');
const { RateLimiter } = require('./security');
const { generatePassword } = require('./passwords');
const { validateUpload, validateLogoUpload } = require('./multipart');
const { logoPath, logoAbsolute, FALLBACK } = require('./branding');
const invoice = require('./invoice');
const { buildReference } = require('./references');

/* A separate limiter from the client login, so hammering one cannot lock out
   the other. Admin accounts are far fewer, so the budget is tighter. */
const adminLoginLimiter = new RateLimiter(
  Math.max(3, Math.floor(config.LOGIN_MAX_ATTEMPTS / 2)),
  config.LOGIN_WINDOW_MS
);

const HANDLE_RE = /^\/admin\/enquiries\/(\d+)\/(handle|reopen)$/;

/** Paths an unauthenticated visitor may reach. */
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login']);

function isAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

/* Flash messages keyed by the ?ok= flag a redirect carries back. */
const CLIENT_FLASH = {
  saved: 'Client details saved.',
  linked: 'Stand linked to this client.',
  unlinked: 'Stand unlinked and marked available again.',
  payment: 'Payment recorded.',
  paymentSaved: 'Payment updated.',
  paymentStatus: 'Payment status changed.',
  deleted: 'Payment deleted.',
  disabled: 'Account disabled and signed out.',
  enabled: 'Account re-enabled.',
  unlocked: 'Account unlocked.',
  document: 'Document uploaded.',
  documentDeleted: 'Document deleted.'
};

const SETTINGS_FLASH = {
  saved: 'Settings saved.',
  logo: 'Logo updated.',
  logoRemoved: 'Reverted to the default logo.'
};

/** Removes any previously uploaded logo so only one is ever present. */
async function removeCustomLogos(dir) {
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return; }
  for (const name of entries) {
    if (/^logo-custom\./.test(name)) {
      try { await fsp.unlink(path.join(dir, name)); } catch { /* already gone */ }
    }
  }
}

/** Renders the edit page for one payment, or a 404 when it is not this client's. */
function sendPaymentEdit(res, h, clientId, paymentId, opts) {
  const client = admin.clientById(clientId);
  const payment = admin.paymentById(paymentId);

  if (!client || !payment || payment.user_id !== clientId) {
    h.sendHtml(res, 404, views.adminLayout({
      title: 'Not found', active: '/admin/clients', user: opts.user, csrf: opts.csrf,
      body: '<section class="container inner-page"><h1>Payment not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
    }));
    return;
  }

  h.sendHtml(res, 200, views.adminLayout({
    title: `Edit payment — ${client.full_name}`,
    active: '/admin/clients',
    user: opts.user,
    csrf: opts.csrf,
    body: views.renderPaymentEdit({
      client,
      payment,
      basePath: `/admin/clients/${clientId}`,
      user: opts.user,
      csrf: opts.csrf,
      error: opts.error || ''
    })
  }));
}

/** The view model for one page's editable content. */
function contentSections(pageKey) {
  const schema = contentSchema.page(pageKey);
  const resolved = content.resolve(pageKey);

  return schema.sections.map((section) => {
    if (section.repeat) {
      return {
        key: section.key,
        label: section.label,
        repeat: true,
        fields: section.fields,
        items: resolved.items(section.key).map((item) => ({
          item,
          values: Object.fromEntries(
            section.fields.map((f) => [f.key, resolved.get(section.key, f.key, item)]))
        }))
      };
    }
    return {
      key: section.key,
      label: section.label,
      repeat: false,
      fields: section.fields,
      values: Object.fromEntries(
        section.fields.map((f) => [f.key, resolved.get(section.key, f.key, 0)]))
    };
  });
}

function contentPageList() {
  return contentSchema.PAGES.map((p) => ({
    key: p.key, label: p.label, file: p.file, sections: p.sections.length
  }));
}

function sendContentPage(res, h, pageKey, opts) {
  const schema = contentSchema.page(pageKey);

  if (!schema) {
    h.sendHtml(res, 404, views.adminLayout({
      title: 'Not found', active: '/admin/content', user: opts.user, csrf: opts.csrf,
      body: '<section class="container inner-page"><h1>Page not found</h1><p><a class="btn primary" href="/admin/content">Back to content</a></p></section>'
    }));
    return;
  }

  h.sendHtml(res, 200, views.adminLayout({
    title: `Content — ${schema.label}`,
    active: '/admin/content',
    user: opts.user,
    csrf: opts.csrf,
    body: views.renderContentPage({
      page: { key: schema.key, label: schema.label },
      sections: contentSections(pageKey),
      pages: contentPageList(),
      user: opts.user,
      csrf: opts.csrf,
      notice: opts.notice || '',
      error: opts.error || ''
    })
  }));
}

function sendSettingsPage(res, h, opts) {
  h.sendHtml(res, 200, views.adminLayout({
    title: 'Site settings',
    active: '/admin/settings',
    user: opts.user,
    csrf: opts.csrf,
    body: views.renderSettings({
      schema: contentSchema.SETTINGS,
      values: content.settings(),
      logo: { absolute: logoAbsolute(), custom: /logo-custom\./.test(logoPath()) },
      user: opts.user,
      csrf: opts.csrf,
      notice: opts.notice || '',
      error: opts.error || ''
    })
  }));
}

/**
 * Parses a typed amount into whole cents without ever going through floating
 * point, so a rounding artefact can never reach a client's statement.
 * Returns null when the input is not a positive amount.
 */
function parseMoneyToCents(input) {
  const cleaned = String(input ?? '')
    .trim()
    .replace(/[,\s]/g, '')
    .replace(/^(us\$|usd|\$)/i, '');

  if (!/^\d{1,12}(\.\d{1,2})?$/.test(cleaned)) return null;

  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** True only for a real calendar date — rejects things like 2025-02-31. */
function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function loadClient(id) {
  const client = admin.clientById(id);
  if (!client) return null;
  return {
    client,
    payments: admin.paymentsFor(id),
    stands: admin.stands(),
    documents: admin.documentsFor(id)
  };
}

/** Renders one client's page, or a 404 when the id does not exist. */
function sendClientPage(res, h, id, opts) {
  const data = loadClient(id);

  if (!data) {
    h.sendHtml(res, 404, views.adminLayout({
      title: 'Not found', active: '/admin/clients', user: opts.user, csrf: opts.csrf,
      body: '<section class="container inner-page"><h1>Client not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
    }));
    return;
  }

  h.sendHtml(res, 200, views.adminLayout({
    title: data.client.full_name,
    active: '/admin/clients',
    user: opts.user,
    csrf: opts.csrf,
    body: views.renderClientDetail({
      ...data,
      basePath: `/admin/clients/${id}`,
      user: opts.user,
      csrf: opts.csrf,
      notice: opts.notice || '',
      error: opts.error || '',
      generatedPassword: opts.generatedPassword || ''
    })
  }));
}

/**
 * Reads and validates the property (stand) form.
 *
 * Returns { errors, value }. Nothing is written unless errors is empty, so a
 * half-valid property can never reach the website.
 */
function readPropertyForm(body, projects) {
  const errors = [];

  const projectId = Number(body.project) || 0;
  const standNumber = String(body.standNumber || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const sizeSqm = Number.parseInt(body.sizeSqm, 10);
  const type = String(body.type || '').trim();
  const status = String(body.status || '').trim();
  const imageUrl = String(body.imageUrl || '').trim().slice(0, 400) || null;
  const rawPrice = String(body.price || '').trim();
  const currency = String(body.currency || 'US$').trim().slice(0, 8) || 'US$';
  const description = String(body.description || '').trim().slice(0, 2000) || null;
  const location = String(body.location || '').trim().slice(0, 200) || null;

  if (!projects.some((p) => p.id === projectId)) errors.push('Choose a development.');
  if (!standNumber) errors.push('A property needs a stand number.');
  if (!Number.isInteger(sizeSqm) || sizeSqm <= 0) {
    errors.push('Size must be a whole number of square metres.');
  }
  if (!PROPERTY_TYPES.includes(type)) errors.push('Choose a property type.');
  if (!STAND_STATUSES.includes(status)) errors.push('Choose a status.');

  /* Blank means "price on request", which the website already renders. */
  let priceCents = null;
  if (rawPrice) {
    priceCents = parseMoneyToCents(rawPrice);
    if (priceCents === null) {
      errors.push('Price must be a positive number, or blank to show "on request".');
    }
  }

  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    errors.push('The photograph URL must start with http:// or https://.');
  }

  return {
    errors,
    value: {
      projectId, standNumber, sizeSqm, type, status, priceCents, imageUrl,
      currency, description, location
    }
  };
}

/** Reads and validates the development (project) form. */
function readProjectForm(body) {
  const errors = [];

  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const location = String(body.location || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const type = String(body.type || '').trim();
  const status = String(body.status || '').trim();
  const description = String(body.description || '').trim().slice(0, 2000);
  const imageUrl = String(body.imageUrl || '').trim().slice(0, 400) || null;
  const soldOut = String(body.soldOut || '') === 'on';
  /* The overview runs to several paragraphs, so it keeps its line breaks. */
  const longDescription = String(body.longDescription || '').trim().slice(0, 8000) || null;
  const features = String(body.features || '').trim().slice(0, 4000) || null;

  if (name.length < 2) errors.push('A development needs a name.');
  if (location.length < 2) errors.push('A development needs a location.');
  if (!PROPERTY_TYPES.includes(type)) errors.push('Choose a development type.');
  if (!PROJECT_STATUSES.includes(status)) errors.push('Choose a status.');
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    errors.push('The photograph URL must start with http:// or https://.');
  }

  return {
    errors,
    value: { name, location, type, status, description, imageUrl, soldOut, longDescription, features }
  };
}

/**
 * Reads one row of the published price list.
 *
 * The amounts stay as typed text: the list legitimately contains ranges such as
 * "$2,000 – $4,000", which a number cannot hold.
 */
function readPricingForm(body) {
  const errors = [];
  const sizeLabel = String(body.sizeLabel || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const cash = String(body.cash || '').trim().slice(0, 40) || null;
  const credit = String(body.credit || '').trim().slice(0, 40) || null;
  const deposit = String(body.deposit || '').trim().slice(0, 40) || null;

  if (!sizeLabel) errors.push('Each price row needs a stand size.');

  return { errors, value: { sizeLabel, cash, credit, deposit } };
}

async function handleAdmin(req, res, ctx) {
  const { pathname, method, csrf, ip, body = {}, files = [], h } = ctx;
  let { user } = ctx;

  if (!pathname.startsWith('/admin')) return false;

  /* ── Sign in ── */
  if (pathname === '/admin/login') {
    if (method === 'GET') {
      if (isAdmin(user)) return h.redirect(res, '/admin'), true;
      h.sendHtml(res, 200, views.renderLogin({ csrf }));
      return true;
    }

    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const limit = adminLoginLimiter.check(ip);
    if (!limit.allowed) {
      const mins = Math.ceil(limit.retryAfterMs / 60000);
      audit('admin_login', 'rate_limited', { detail: 'per-IP limit', ip });
      h.sendHtml(res, 429, views.renderLogin({
        csrf,
        error: `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
      }));
      return true;
    }

    const clientNumber = String(body.clientNumber || '').trim().toUpperCase();
    const password = String(body.password || '');

    if (!clientNumber || !password) {
      h.sendHtml(res, 400, views.renderLogin({ csrf, error: 'Staff ID and password are required.' }));
      return true;
    }

    const result = await auth.signIn(clientNumber, password, {
      ip,
      userAgent: req.headers['user-agent']
    });

    if (!result.ok) {
      const mins = result.retryAfterMs ? Math.ceil(result.retryAfterMs / 60000) : 0;
      const message = result.reason === 'locked'
        ? `This account is temporarily locked. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
        : 'Invalid staff ID or password.';
      h.sendHtml(res, 401, views.renderLogin({ csrf, error: message }));
      return true;
    }

    /* Credentials were valid, but this may be an ordinary client. Tear the
       session down before the cookie is ever issued, so a client can never
       hold an admin-capable session token. */
    if (result.user.role !== 'admin') {
      auth.destroySession(result.token);
      audit('admin_login', 'denied', {
        userId: result.user.id, clientNumber, detail: 'not an admin account', ip
      });
      h.sendHtml(res, 403, views.renderLogin({
        csrf, error: 'That account does not have staff access.'
      }));
      return true;
    }

    adminLoginLimiter.reset(ip);
    audit('admin_login', 'success', { userId: result.user.id, clientNumber, ip });

    h.sendHtml(res, 302, '', {
      Location: '/admin',
      'Set-Cookie': auth.sessionCookie(result.token, config.SESSION_TTL_MS)
    });
    return true;
  }

  /* ── Everything below requires an admin session ── */
  if (!isAdmin(user)) {
    if (!PUBLIC_ADMIN_PATHS.has(pathname)) {
      audit('admin_access', 'denied', {
        userId: user ? user.id : null,
        detail: `${method} ${pathname}${user ? ' (client role)' : ' (no session)'}`,
        ip
      });
    }
    // A signed-in client gets pointed at their own portal, not the admin login.
    return h.redirect(res, user ? '/dashboard' : '/admin/login'), true;
  }

  if (pathname === '/admin/logout') {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;
    auth.destroySession(ctx.cookies[config.SESSION_COOKIE]);
    audit('admin_logout', 'success', { userId: user.id, ip });
    h.sendHtml(res, 302, '', {
      Location: '/admin/login',
      'Set-Cookie': auth.clearSessionCookie()
    });
    return true;
  }

  /* ══ Sales analytics ═══════════════════════════════════════════════════
     Every figure is computed from the transaction records on each request,
     so no dashboard total can drift away from the ledger. */

  if (pathname === '/admin/analytics' || pathname === '/admin/analytics/ledger') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const filters = analytics.filtersFrom(Object.fromEntries(url.searchParams));
    const options = analytics.filterOptions();
    const isLedger = pathname.endsWith('/ledger');

    audit('analytics_view', 'success', { userId: user.id, detail: isLedger ? 'ledger' : 'overview', ip });

    const ledger = analytics.ledger(filters, {
      page: Number(url.searchParams.get('page')) || 1,
      perPage: isLedger ? 50 : 8,
      sort: url.searchParams.get('sort') || 'date',
      dir: url.searchParams.get('dir') || 'desc'
    });

    const html = isLedger
      ? viewsAnalytics.renderLedger({
        ledger, totals: analytics.sumTransactions(filters), options, filters, user, csrf
      })
      : viewsAnalytics.renderAnalytics({
        kpis: analytics.kpis(filters),
        collection: analytics.collectionAnalysis(filters),
        projects: analytics.byProject(filters),
        agents: analytics.byAgent(filters),
        types: analytics.byType(filters),
        ledger, options, filters, user, csrf, active: pathname
      });

    h.sendHtml(res, 200, html);
    return true;
  }

  /* ── Weekly, monthly and annual analysis ──
     Each period is queried with its own date bounds, so a sale agreed in one
     month and paid in another is counted where each event actually happened. */
  if (pathname === '/admin/analytics/weekly'
    || pathname === '/admin/analytics/monthly'
    || pathname === '/admin/analytics/annual') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const filters = analytics.filtersFrom(Object.fromEntries(url.searchParams));
    const options = analytics.filterOptions();
    const today = new Date();

    audit('analytics_view', 'success', {
      userId: user.id, detail: pathname.split('/').pop(), ip
    });

    if (pathname.endsWith('/weekly')) {
      /* A custom range wins over the week selector if one was given. */
      const custom = Boolean(filters.from || filters.to);
      const offset = Number(url.searchParams.get('week')) || 0;

      const range = custom
        ? { from: filters.from || filters.to, to: filters.to || filters.from }
        : analytics.weekBounds(offset, today);
      const before = analytics.weekBounds(custom ? 0 : offset - 1, today);

      const label = custom ? 'Custom range'
        : offset === 0 ? 'This week'
          : offset === -1 ? 'Last week' : `${Math.abs(offset)} weeks ago`;

      h.sendHtml(res, 200, viewsAnalytics.renderWeekly({
        kpis: analytics.kpis({ ...filters, from: range.from, to: range.to }),
        previous: analytics.kpis({ ...filters, from: before.from, to: before.to }),
        series: analytics.dailySeries(range.from, range.to, filters),
        range: { ...range, label },
        weekOffset: offset,
        custom,
        options, filters, user, csrf
      }));
      return true;
    }

    if (pathname.endsWith('/monthly')) {
      const month = filters.month
        || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      const prior = analytics.shiftMonth(month, -1);
      const scope = { ...filters, month, year: null, from: null, to: null };

      const longMonth = (m) => new Date(`${m}-01T00:00:00Z`)
        .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

      h.sendHtml(res, 200, viewsAnalytics.renderMonthly({
        kpis: analytics.kpis(scope),
        previous: analytics.kpis({ ...scope, month: prior }),
        previousLabel: longMonth(prior),
        series: analytics.monthlySeries(month.slice(0, 4), filters),
        month,
        year: month.slice(0, 4),
        options, filters, user, csrf
      }));
      return true;
    }

    const year = filters.year || String(today.getFullYear());
    const years = db.prepare(`
      SELECT DISTINCT substr(COALESCE(sale_date, purchase_date), 1, 4) AS y
        FROM ownerships
       WHERE COALESCE(sale_date, purchase_date) GLOB '[0-9][0-9][0-9][0-9]-*'
       ORDER BY y DESC`).all().map((r) => r.y);
    if (!years.includes(year)) years.unshift(year);

    h.sendHtml(res, 200, viewsAnalytics.renderAnnual({
      kpis: analytics.kpis({ ...filters, year, month: null, from: null, to: null }),
      series: analytics.monthlySeries(year, filters),
      year, years, options, filters, user, csrf
    }));
    return true;
  }

  /* ── Exports ──
     Built from the same filter object the page used, so an export always
     matches what the administrator was looking at when they pressed it. */
  const exportMatch = pathname.match(/^\/admin\/analytics\/export\/([a-z]+)\.([a-z]+)$/);
  if (exportMatch) {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const [, type, format] = exportMatch;
    if (!reportExports.REPORT_TYPES.includes(type) || !reportExports.FORMATS.includes(format)) {
      return h.send(res, 404, 'Not found'), true;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const filters = analytics.filtersFrom(Object.fromEntries(url.searchParams));
    const today = new Date();
    const context = {};

    /* The period reports need telling which period, and the period bounds must
       not also sit in the filters or the comparison counts the same money
       twice. */
    if (type === 'weekly') {
      const custom = Boolean(filters.from || filters.to);
      const offset = Number(url.searchParams.get('week')) || 0;
      const range = custom
        ? { from: filters.from || filters.to, to: filters.to || filters.from }
        : analytics.weekBounds(offset, today);

      context.from = range.from;
      context.to = range.to;
      context.label = custom ? 'Custom range'
        : offset === 0 ? 'This week'
          : offset === -1 ? 'Last week' : `${Math.abs(offset)} weeks ago`;
    } else if (type === 'monthly') {
      context.month = filters.month
        || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      filters.month = context.month;
      filters.from = null;
      filters.to = null;
      filters.year = null;
    } else if (type === 'annual') {
      context.year = filters.year || String(today.getFullYear());
      filters.year = context.year;
      filters.month = null;
      filters.from = null;
      filters.to = null;
    }

    const report = reportExports.build(type, filters, context);
    if (!report) return h.send(res, 404, 'Not found'), true;

    const buffer = reportExports.render(report, format, { settings: content.settings() });
    const filename = reportExports.filenameFor(report, format, context);

    audit('analytics_export', 'success', {
      userId: user.id, detail: `${type}.${format} — ${report.filterSummary}`, ip
    });

    res.writeHead(200, {
      'Content-Type': reportExports.MIME[format],
      'Content-Length': buffer.length,
      // An attachment: the office wants the file, not a browser preview.
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buffer);
    return true;
  }

  /* ── One sale, in full ── */
  const saleMatch = pathname.match(/^\/admin\/sales\/(\d+)$/);
  if (saleMatch) {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const saleId = Number(saleMatch[1]);
    const sale = analytics.saleById(saleId);
    if (!sale) return h.send(res, 404, 'Not found'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    audit('sale_view', 'success', { userId: user.id, detail: `sale ${saleId}`, ip });

    const audits = db.prepare(`
      SELECT f.*, u.client_number AS actor_number FROM finance_audit f
        LEFT JOIN users u ON u.id = f.actor_user_id
       WHERE (f.entity = 'sale' AND f.entity_id = ?)
          OR (f.entity = 'payment' AND f.entity_id IN
                (SELECT id FROM payments WHERE ownership_id = ?))
       ORDER BY f.id DESC`).all(saleId, saleId);

    h.sendHtml(res, 200, viewsAnalytics.renderSaleDetail({
      sale,
      transactions: analytics.saleTransactions(saleId),
      audit: audits,
      user, csrf,
      flash: url.searchParams.get('ok') || '',
      error: url.searchParams.get('error') || ''
    }));
    return true;
  }

  /* ── Record a deposit, instalment, final payment or refund on a sale ──
     Recorded from the sale page rather than the client page because the
     outstanding balance has to be known to check the overpayment rules. */
  const saleTxnMatch = pathname.match(/^\/admin\/sales\/(\d+)\/transactions$/);
  if (saleTxnMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const saleId = Number(saleTxnMatch[1]);
    const sale = analytics.saleById(saleId);
    if (!sale) return h.send(res, 404, 'Not found'), true;

    const fail = (message) => {
      h.redirect(res, `/admin/sales/${saleId}?error=${encodeURIComponent(message)}`);
      return true;
    };

    const type = String(body.type || '').trim();
    const cents = parseMoneyToCents(body.amount);
    const paidOn = String(body.paidOn || '').trim();
    const allowOverpayment = String(body.allowOverpayment || '') === 'on';

    if (!analytics.VALID_TYPES.includes(type)) return fail('Choose a transaction type.');
    if (cents === null) return fail('Amount must be a positive number, for example 1500 or 1500.00.');
    if (!isIsoDate(paidOn)) return fail('Please give a valid date.');

    const reference = buildReference({
      projectName: sale.project_name,
      when: new Date(),
      isTaken: (ref) => admin.referenceTaken(ref),
      fallbackCode: content.settings().payment_ref_prefix || 'HHP'
    });

    const result = analytics.recordTransaction({
      ownershipId: saleId,
      type,
      amountCents: cents,
      paidOn,
      method: PAYMENT_METHODS.includes(String(body.method || '')) ? body.method : null,
      reference,
      notes: String(body.notes || '').trim().slice(0, 300) || null,
      recordedBy: user.id,
      allowOverpayment
    });

    if (!result.ok) return fail(result.error);

    audit(`txn_${type.toLowerCase()}`, 'success', {
      userId: user.id, clientNumber: sale.client_number,
      detail: `${reference} ${cents} cents on sale ${saleId}`, ip
    });

    h.redirect(res, `/admin/sales/${saleId}?ok=${encodeURIComponent(`${type.replace('_', ' ').toLowerCase()} recorded — balance now ${result.sale.outstandingCents} cents outstanding`)}`);
    return true;
  }

  /* ── Void and restore a transaction ──
     Never a hard delete: rule 7 wants a voided transaction out of the
     analytics, and rule 8 wants the change to remain auditable. */
  const voidMatch = pathname.match(/^\/admin\/payments\/(\d+)\/(void|restore)$/);
  if (voidMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const paymentId = Number(voidMatch[1]);
    const action = voidMatch[2];
    const reason = String(body.reason || '').trim().slice(0, 300) || null;

    const payment = db.prepare('SELECT ownership_id FROM payments WHERE id = ?').get(paymentId);
    if (!payment) return h.send(res, 404, 'Not found'), true;

    const result = action === 'void'
      ? analytics.voidTransaction(paymentId, { actorId: user.id, reason })
      : analytics.unvoidTransaction(paymentId, { actorId: user.id, reason });

    const back = payment.ownership_id ? `/admin/sales/${payment.ownership_id}` : '/admin/analytics/ledger';
    if (!result.ok) {
      h.redirect(res, `${back}?error=${encodeURIComponent(result.error)}`);
      return true;
    }

    audit(`payment_${action}`, 'success', { userId: user.id, detail: `payment ${paymentId}`, ip });
    h.redirect(res, `${back}?ok=${action === 'void' ? 'Transaction voided.' : 'Transaction restored.'}`);
    return true;
  }

  /* ── Overview ── */
  if (pathname === '/admin') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;
    const counts = admin.counts();
    const recent = enquiries.all().slice(0, 5);
    audit('admin_view', 'success', { userId: user.id, detail: 'overview', ip });

    h.sendHtml(res, 200, views.adminLayout({
      title: 'Overview', active: '/admin', user, csrf,
      body: views.renderDashboard({ counts, recent, clientsByDevelopment: admin.clientsByDevelopment(), user, csrf })
    }));
    return true;
  }

  /* ── Enquiries ── */
  if (pathname === '/admin/enquiries') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const flash = url.searchParams.get('handled') === '1'
      ? 'Enquiry marked as handled.'
      : url.searchParams.get('reopened') === '1' ? 'Enquiry reopened.' : '';

    audit('admin_view', 'success', { userId: user.id, detail: 'enquiries', ip });

    h.sendHtml(res, 200, views.adminLayout({
      title: 'Enquiries', active: '/admin/enquiries', user, csrf,
      body: views.renderEnquiries({ list: enquiries.all(), counts: enquiries.counts(), user, csrf, flash })
    }));
    return true;
  }

  const m = pathname.match(HANDLE_RE);
  if (m) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const id = Number.parseInt(m[1], 10);
    const action = m[2];
    const record = enquiries.byId(id);

    if (!record) {
      h.sendHtml(res, 404, views.adminLayout({
        title: 'Not found', active: '/admin/enquiries', user, csrf,
        body: '<section class="container inner-page"><h1>Enquiry not found</h1><p><a class="btn primary" href="/admin/enquiries">Back to enquiries</a></p></section>'
      }));
      return true;
    }

    if (action === 'handle') enquiries.markHandled(id, user.id);
    else enquiries.reopen(id);

    audit(`enquiry_${action}`, 'success', {
      userId: user.id, detail: `enquiry ${id} (${record.name})`, ip
    });

    h.sendHtml(res, 302, '', {
      Location: action === 'handle' ? '/admin/enquiries?handled=1' : '/admin/enquiries?reopened=1'
    });
    return true;
  }

  /* ── Clients ── */
  if (pathname === '/admin/clients') {
    /* Create a client. The password is generated and shown exactly once. */
    if (method === 'POST') {
      const clientNumber = String(body.clientNumber || '').trim().toUpperCase();
      const fullName = String(body.fullName || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const email = String(body.email || '').trim().slice(0, 160);

      const refuse = (message) => {
        h.sendHtml(res, 200, views.adminLayout({
          title: 'Add a client', active: '/admin/clients', user, csrf,
          body: views.renderNewClient({
            suggestedNumber: clientNumber || admin.suggestClientNumber(),
            user, csrf, error: message
          })
        }));
      };

      if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(clientNumber)) {
        refuse('Client number must be 3 to 32 characters, using letters, digits and hyphens.');
        return true;
      }
      if (fullName.length < 2) { refuse('Please enter the client\'s full name.'); return true; }
      if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
        refuse('That does not look like a valid email address.');
        return true;
      }
      if (users.byClientNumber(clientNumber)) {
        refuse(`Client number ${clientNumber} is already in use.`);
        return true;
      }

      const password = generatePassword(20);
      admin.createClient({
        clientNumber, fullName, email,
        passwordHash: await auth.hashPassword(password)
      });
      audit('client_create', 'success', {
        userId: user.id, clientNumber, detail: `created ${fullName}`, ip
      });

      h.sendHtml(res, 200, views.adminLayout({
        title: 'Client created', active: '/admin/clients', user, csrf,
        body: views.renderNewClient({
          suggestedNumber: admin.suggestClientNumber(),
          user, csrf,
          created: { clientNumber, password }
        })
      }));
      return true;
    }

    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const q = (url.searchParams.get('q') || '').trim();
    const clients = admin.searchClients(q);

    audit('admin_view', 'success', {
      userId: user.id, detail: q ? `clients search "${q}"` : 'clients', ip
    });

    h.sendHtml(res, 200, views.adminLayout({
      title: 'Clients', active: '/admin/clients', user, csrf,
      body: views.renderClients({ clients, user, csrf, query: q })
    }));
    return true;
  }

  /* ── New client form ── */
  if (pathname === '/admin/clients/new') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    audit('admin_view', 'success', { userId: user.id, detail: 'new client form', ip });
    h.sendHtml(res, 200, views.adminLayout({
      title: 'Add a client', active: '/admin/clients', user, csrf,
      body: views.renderNewClient({ suggestedNumber: admin.suggestClientNumber(), user, csrf })
    }));
    return true;
  }

  /* ── One client ── */
  const detailMatch = pathname.match(/^\/admin\/clients\/(\d+)$/);
  if (detailMatch) {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const id = Number(detailMatch[1]);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const flag = (url.searchParams.get('ok') || '').trim();

    audit('admin_view', 'success', { userId: user.id, detail: `client ${id}`, ip });
    sendClientPage(res, h, id, {
      user, csrf,
      notice: CLIENT_FLASH[flag] || '',
      error: url.searchParams.get('error') || ''
    });
    return true;
  }

  /* ── Client actions ── */
  /* ── Statement of account, as a real PDF ──
     Served inline so the browser opens it ready to print; the same file can
     be saved or emailed from there. */
  const statementMatch = pathname.match(/^\/admin\/clients\/(\d+)\/statement\.pdf$/);
  if (statementMatch) {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const clientId = Number(statementMatch[1]);
    const client = admin.clientById(clientId);
    if (!client) return h.send(res, 404, 'Not found'), true;

    const pdf = invoice.buildStatementPdf({
      settings: content.settings(),
      client,
      ownership: invoice.ownershipFromClientRow(client),
      payments: admin.paymentsFor(clientId),
      generatedAt: new Date()
    });

    audit('statement_download', 'success', {
      userId: user.id, clientNumber: client.client_number, detail: 'by admin', ip
    });

    invoice.writePdfResponse(res, pdf, invoice.filenameFor(client));
    return true;
  }

  /* ── One payment: edit it, or change its status ──
     Placed before the delete/action block below; both patterns need a numeric
     payment id, and an empty id is what made the delete button 404. */
  const payEditMatch = pathname.match(/^\/admin\/clients\/(\d+)\/payments\/(\d+)$/);
  const payStatusMatch = pathname.match(/^\/admin\/clients\/(\d+)\/payments\/(\d+)\/status$/);

  if (payEditMatch) {
    const clientId = Number(payEditMatch[1]);
    const paymentId = Number(payEditMatch[2]);
    const client = admin.clientById(clientId);
    const payment = admin.paymentById(paymentId);

    if (!client || !payment || payment.user_id !== clientId) {
      h.sendHtml(res, 404, views.adminLayout({
        title: 'Not found', active: '/admin/clients', user, csrf,
        body: '<section class="container inner-page"><h1>Payment not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
      }));
      return true;
    }

    if (method === 'GET') {
      audit('admin_view', 'success', { userId: user.id, detail: `payment ${paymentId}`, ip });
      sendPaymentEdit(res, h, clientId, paymentId, { user, csrf });
      return true;
    }

    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const cents = parseMoneyToCents(body.amount);
    const paidOn = String(body.paidOn || '').trim();
    const status = String(body.status || '').trim();

    const refuse = (message) =>
      sendPaymentEdit(res, h, clientId, paymentId, { user, csrf, error: message });

    if (cents === null) {
      refuse('Amount must be a positive number, for example 1500 or 1500.00.');
      return true;
    }
    if (!isIsoDate(paidOn)) { refuse('Please give a valid date received.'); return true; }
    if (!PAYMENT_STATUSES.includes(status)) { refuse('Unknown payment status.'); return true; }

    /* Through the analytics layer, not straight to the table: an edit to a
       financial record must be audited and must recompute the sale. */
    const result = analytics.updateTransaction(paymentId, {
      paidOn,
      amountCents: cents,
      method: payment.method,
      notes: payment.notes,
      status,
      actorId: user.id,
      reason: 'Edited from the client page'
    });

    if (!result.ok) { refuse(result.error); return true; }

    audit('payment_update', 'success', {
      userId: user.id, clientNumber: client.client_number,
      detail: `${payment.reference} ${cents} cents (${status})`, ip
    });
    return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=paymentSaved` }), true;
  }

  if (payStatusMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const clientId = Number(payStatusMatch[1]);
    const paymentId = Number(payStatusMatch[2]);
    const client = admin.clientById(clientId);
    const payment = admin.paymentById(paymentId);

    if (!client || !payment || payment.user_id !== clientId) {
      h.send(res, 404, 'Not found');
      return true;
    }

    const status = String(body.status || '').trim();
    const changed = analytics.setTransactionStatus(paymentId, status, {
      actorId: user.id,
      reason: 'Changed from the client page'
    });

    if (!changed.ok) {
      sendClientPage(res, h, clientId, { user, csrf, error: changed.error });
      return true;
    }

    audit('payment_status', 'success', {
      userId: user.id, clientNumber: client.client_number,
      detail: `${payment.reference}: ${payment.status} -> ${status}`, ip
    });
    return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=paymentStatus` }), true;
  }

  const payDeleteMatch = pathname.match(/^\/admin\/clients\/(\d+)\/payments\/(\d+)\/delete$/);
  const actionMatch = pathname.match(
    /^\/admin\/clients\/(\d+)\/(update|reset-password|disable|unlock|stand|unlink|payments)$/);

  if (payDeleteMatch || actionMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    /* Deleting a payment. */
    if (payDeleteMatch) {
      const clientId = Number(payDeleteMatch[1]);
      const paymentId = Number(payDeleteMatch[2]);
      const payment = admin.paymentById(paymentId);

      // The payment must belong to the client in the URL — never trust the path alone.
      if (!payment || payment.user_id !== clientId) {
        h.sendHtml(res, 404, views.adminLayout({
          title: 'Not found', active: '/admin/clients', user, csrf,
          body: '<section class="container inner-page"><h1>Payment not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
        }));
        return true;
      }

      /* The row goes, so the money stops counting — but a deletion is still a
         change to a financial record, so the figures are written to the
         finance audit trail first. Voiding is the reversible alternative and
         is offered on the sale page. */
      analytics.financeAudit({
        actorUserId: user.id,
        action: 'payment_deleted',
        entity: 'payment',
        entityId: paymentId,
        reference: payment.reference,
        oldValue: `${payment.amount_cents} cents on ${payment.paid_on} (${payment.status})`,
        newValue: 'deleted',
        reason: 'Deleted from the client page'
      });

      admin.deletePayment(paymentId);
      if (payment.ownership_id) analytics.recomputeSale(payment.ownership_id, user.id);

      audit('payment_delete', 'success', {
        userId: user.id, detail: `payment ${payment.reference} (${paymentId}) from client ${clientId}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=deleted` }), true;
    }

    const clientId = Number(actionMatch[1]);
    const action = actionMatch[2];
    const client = admin.clientById(clientId);

    if (!client) {
      h.sendHtml(res, 404, views.adminLayout({
        title: 'Not found', active: '/admin/clients', user, csrf,
        body: '<section class="container inner-page"><h1>Client not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
      }));
      return true;
    }

    /* ── Edit name / email ── */
    if (action === 'update') {
      const fullName = String(body.fullName || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const email = String(body.email || '').trim().slice(0, 160);

      if (fullName.length < 2) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'Please enter the client\'s full name.' });
        return true;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'That does not look like a valid email address.' });
        return true;
      }

      admin.updateClient(clientId, { fullName, email });
      audit('client_update', 'success', { userId: user.id, detail: `client ${clientId} (${client.client_number})`, ip });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=saved` }), true;
    }

    /* ── Reset password — the new password is rendered once, never in a URL ── */
    if (action === 'reset-password') {
      const password = generatePassword(20);
      admin.setPassword(clientId, await auth.hashPassword(password));
      audit('client_password_reset', 'success', {
        userId: user.id, clientNumber: client.client_number, detail: `client ${clientId}`, ip
      });
      sendClientPage(res, h, clientId, {
        user, csrf,
        notice: 'Password reset. Existing sessions have been signed out.',
        generatedPassword: password
      });
      return true;
    }

    /* ── Disable / re-enable ── */
    if (action === 'disable') {
      const disabled = String(body.disabled) === '1';
      admin.setDisabled(clientId, disabled);
      audit(disabled ? 'client_disable' : 'client_enable', 'success', {
        userId: user.id, clientNumber: client.client_number, detail: `client ${clientId}`, ip
      });
      return h.sendHtml(res, 302, '', {
        Location: `/admin/clients/${clientId}?ok=${disabled ? 'disabled' : 'enabled'}`
      }), true;
    }

    if (action === 'unlock') {
      admin.unlock(clientId);
      audit('client_unlock', 'success', {
        userId: user.id, clientNumber: client.client_number, detail: `client ${clientId}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=unlocked` }), true;
    }

    /* ── Link a stand ── */
    if (action === 'stand') {
      const standId = Number.parseInt(body.standId, 10);
      const cents = parseMoneyToCents(body.price);
      const purchaseDate = String(body.purchaseDate || '').trim();
      const status = String(body.ownershipStatus || 'Servicing in progress').slice(0, 60);

      if (admin.ownershipCountFor(clientId) > 0) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'This client already has a stand linked.' });
        return true;
      }
      if (!Number.isInteger(standId) || standId <= 0) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'Please choose a stand.' });
        return true;
      }
      if (cents === null) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'Purchase price must be a positive amount, for example 5500 or 5500.00.' });
        return true;
      }
      if (!isIsoDate(purchaseDate)) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'Please give a valid purchase date.' });
        return true;
      }

      const stand = admin.stands().find((s) => s.id === standId);
      if (!stand) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'That stand does not exist.' });
        return true;
      }
      if (stand.held_by && stand.held_by !== client.client_number) {
        sendClientPage(res, h, clientId, {
          user, csrf, error: `Stand ${stand.stand_number} is already held by ${stand.held_by}.`
        });
        return true;
      }

      admin.linkStand({ userId: clientId, standId, priceCents: cents, purchaseDate, status });
      audit('stand_link', 'success', {
        userId: user.id, clientNumber: client.client_number,
        detail: `stand ${stand.stand_number} to client ${clientId} at ${cents} cents`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=linked` }), true;
    }

    /* ── Unlink a stand ── */
    if (action === 'unlink') {
      if (!client.ownership_id) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'This client has no stand to unlink.' });
        return true;
      }
      admin.unlinkOwnership(client.ownership_id);
      audit('stand_unlink', 'success', {
        userId: user.id, clientNumber: client.client_number,
        detail: `stand ${client.stand_number} from client ${clientId}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=unlinked` }), true;
    }

    /* ── Record a payment ── */
    if (action === 'payments') {
      const cents = parseMoneyToCents(body.amount);
      const paidOn = String(body.paidOn || '').trim();
      const status = String(body.status || 'Confirmed').slice(0, 30);

      if (cents === null) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'Amount must be a positive number, for example 1500 or 1500.00.' });
        return true;
      }
      if (!isIsoDate(paidOn)) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'Please give a valid date received.' });
        return true;
      }

      /* The reference is generated, never typed: project initials plus the
         moment of entry. That removes the duplicate-reference failure, which
         was the one way recording a payment could silently go wrong. */
      const reference = buildReference({
        projectName: client.project_name,
        when: new Date(),
        isTaken: (ref) => admin.referenceTaken(ref),
        fallbackCode: content.settings().payment_ref_prefix || 'HHP'
      });

      /* Type is derived rather than asked for: the first money in on a sale is
         its deposit and everything after that is an instalment. Final payments
         and refunds are recorded from the sale page, where the outstanding
         balance is known and the overpayment rules can be checked. */
      const ownership = client.stand_id
        ? db.prepare('SELECT id FROM ownerships WHERE user_id = ? AND stand_id = ? LIMIT 1')
          .get(clientId, client.stand_id)
        : null;

      const priorConfirmed = ownership
        ? db.prepare(`SELECT COUNT(*) AS c FROM payments
                       WHERE ownership_id = ? AND voided_at IS NULL AND status = 'Confirmed'`)
          .get(ownership.id).c
        : 0;

      const type = priorConfirmed > 0 ? 'INSTALLMENT' : 'DEPOSIT';
      const method = PAYMENT_METHODS.includes(String(body.method || '')) ? body.method : null;

      const paymentId = admin.addPayment({
        userId: clientId,
        standId: client.stand_id || null,
        ownershipId: ownership ? ownership.id : null,
        type,
        paidOn,
        reference,
        amountCents: cents,
        status,
        method,
        recordedBy: user.id,
        notes: String(body.notes || '').trim().slice(0, 300) || null
      });

      /* Rule 8: an edit to a financial record must leave an audit trail. */
      analytics.financeAudit({
        actorUserId: user.id,
        action: `${type.toLowerCase()}_created`,
        entity: 'payment',
        entityId: paymentId,
        reference,
        newValue: `${cents} cents on ${paidOn} (${status})`,
        reason: 'Recorded from the client page'
      });

      if (ownership) analytics.recomputeSale(ownership.id, user.id);

      audit('payment_add', 'success', {
        userId: user.id, clientNumber: client.client_number,
        detail: `${reference} ${cents} cents for client ${clientId}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=payment` }), true;
    }

    return h.send(res, 404, 'Not found'), true;
  }

  /* ── Documents ── */
  const docUploadMatch = pathname.match(/^\/admin\/clients\/(\d+)\/documents$/);
  const docDownloadMatch = pathname.match(/^\/admin\/clients\/(\d+)\/documents\/(\d+)\/download$/);
  const docDeleteMatch = pathname.match(/^\/admin\/clients\/(\d+)\/documents\/(\d+)\/delete$/);

  if (docUploadMatch || docDownloadMatch || docDeleteMatch) {
    const match = docUploadMatch || docDownloadMatch || docDeleteMatch;
    const clientId = Number(match[1]);
    const client = admin.clientById(clientId);

    if (!client) {
      h.sendHtml(res, 404, views.adminLayout({
        title: 'Not found', active: '/admin/clients', user, csrf,
        body: '<section class="container inner-page"><h1>Client not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
      }));
      return true;
    }

    /* ── Upload ── */
    if (docUploadMatch) {
      if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

      const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const file = files.find((f) => f.name === 'file');

      if (title.length < 2) {
        sendClientPage(res, h, clientId, { user, csrf, error: 'Please give the document a title.' });
        return true;
      }

      const check = validateUpload(file, config.MAX_UPLOAD_BYTES);
      if (!check.ok) {
        sendClientPage(res, h, clientId, { user, csrf, error: check.error });
        return true;
      }

      /* The file is stored under a random name. The client's own filename never
         reaches the disk, so a crafted one cannot escape the directory, collide
         with another document, or be used to guess a URL. */
      const storedName = crypto.randomBytes(16).toString('hex') + check.extension;

      try {
        await fsp.writeFile(path.join(config.PRIVATE_DOCS_DIR, storedName), file.data);
      } catch (err) {
        audit('document_upload', 'failure', { userId: user.id, detail: String(err.message), ip });
        sendClientPage(res, h, clientId, {
          user, csrf, error: 'The file could not be saved. Please try again.'
        });
        return true;
      }

      admin.addDocument({
        userId: clientId, title, storedName,
        mime: 'application/pdf', sizeBytes: file.data.length
      });

      audit('document_upload', 'success', {
        userId: user.id, clientNumber: client.client_number,
        detail: `${title} (${file.data.length} bytes)`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=document` }), true;
    }

    /* Both remaining actions name a document, which must belong to this client. */
    const docId = Number(match[2]);
    const doc = admin.documentById(docId);

    if (!doc || doc.user_id !== clientId) {
      h.send(res, 404, 'Not found');
      return true;
    }

    const root = path.resolve(config.PRIVATE_DOCS_DIR);
    const filePath = path.resolve(root, doc.stored_name);

    /* Belt and braces: stored_name is server-generated, but re-check so a future
       bad write cannot turn this route into arbitrary file disclosure. */
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      audit('document_download', 'denied', { userId: user.id, detail: 'path escape', ip });
      h.send(res, 403, 'Forbidden');
      return true;
    }

    /* ── Delete ── */
    if (docDeleteMatch) {
      if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

      admin.deleteDocument(docId);
      try { await fsp.unlink(filePath); } catch { /* already gone */ }

      audit('document_delete', 'success', {
        userId: user.id, clientNumber: client.client_number, detail: `${doc.title} (${docId})`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=documentDeleted` }), true;
    }

    /* ── Download ── */
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    let stat;
    try { stat = await fsp.stat(filePath); } catch { stat = null; }
    if (!stat || !stat.isFile()) return h.send(res, 404, 'The stored file is missing.'), true;

    /* Logged distinctly from a client fetching their own document. */
    audit('document_download', 'success', {
      userId: user.id, clientNumber: client.client_number,
      detail: `admin: ${doc.title} (${doc.id})`, ip
    });

    const safeName = doc.title.replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 80) || 'document';
    res.writeHead(200, {
      'Content-Type': doc.mime || 'application/pdf',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${safeName}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });

    await new Promise((resolve) => {
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => { res.destroy(); resolve(); });
      stream.on('end', resolve);
      stream.pipe(res);
    });
    return true;
  }

  /* ── Properties: the stands the website offers ──────────────────────────
     Editing these is what changes the public properties page. */

  const standEditMatch = pathname.match(/^\/admin\/properties\/(\d+)$/);
  const standDeleteMatch = pathname.match(/^\/admin\/properties\/(\d+)\/delete$/);

  if (pathname === '/admin/properties' || standEditMatch || standDeleteMatch) {
    const projects = admin.projectsWithCounts();

    /* ── Delete ── */
    if (standDeleteMatch) {
      if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

      const standId = Number(standDeleteMatch[1]);
      const stand = admin.standById(standId);
      if (!stand) return h.send(res, 404, 'Not found'), true;

      /* A stand with a sale must not vanish. The ownership, the client's
         payments and every analytics figure point at this row. */
      if (stand.sale_count > 0) {
        h.redirect(res, `/admin/properties/${standId}?error=${encodeURIComponent(
          'That property has a sale recorded against it, so it cannot be deleted. '
          + 'Mark it Sold instead, or cancel the sale first.')}`);
        return true;
      }

      admin.deleteStand(standId);
      audit('stand_delete', 'success', {
        userId: user.id, detail: `${stand.stand_number} (${standId})`, ip
      });
      h.redirect(res, '/admin/properties?ok=deleted');
      return true;
    }

    /* ── Save an existing property ── */
    if (standEditMatch && method === 'POST') {
      const standId = Number(standEditMatch[1]);
      const stand = admin.standById(standId);
      if (!stand) return h.send(res, 404, 'Not found'), true;

      const form = readPropertyForm(body, projects);
      const clash = admin.standNumberTaken(form.value.standNumber, standId);
      if (clash) {
        form.errors.push(`Stand number ${form.value.standNumber} is already used by a property in `
          + `${clash.project_name}. Every property needs its own stand number.`);
      }

      if (form.errors.length) {
        h.sendHtml(res, 200, views.adminLayout({
          title: `${stand.stand_number} — property`, active: '/admin/properties', user, csrf,
          body: views.renderPropertyEdit({
            stand, projects, user, csrf, error: form.errors.join(' ')
          })
        }));
        return true;
      }

      admin.updateStand(standId, form.value);
      audit('stand_update', 'success', {
        userId: user.id, detail: `${form.value.standNumber} (${standId})`, ip
      });
      h.redirect(res, `/admin/properties/${standId}?ok=saved`);
      return true;
    }

    /* ── Add ──
       Deliberately before the GET guard: this is a POST to the list URL. */
    if (pathname === '/admin/properties' && method === 'POST') {
      const form = readPropertyForm(body, projects);
      const clash = admin.standNumberTaken(form.value.standNumber, 0);
      if (clash) {
        form.errors.push(`Stand number ${form.value.standNumber} is already used by a property in `
          + `${clash.project_name}. Every property needs its own stand number.`);
      }

      if (form.errors.length) {
        h.sendHtml(res, 200, views.adminLayout({
          title: 'Properties', active: '/admin/properties', user, csrf,
          body: views.renderProperties({
            stands: admin.standsForAdmin(), projects, user, csrf, error: form.errors.join(' ')
          })
        }));
        return true;
      }

      const id = admin.createStand(form.value);
      audit('stand_add', 'success', {
        userId: user.id, detail: `${form.value.standNumber} (${id})`, ip
      });

      /* Adding from inside a development returns there, so the office can add
         the next stand without navigating back. */
      h.redirect(res, String(body.returnTo || '') === 'development'
        ? `/admin/projects/${form.value.projectId}?ok=propertyAdded`
        : `/admin/properties/${id}?ok=saved`);
      return true;
    }

    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    /* ── The edit form ── */
    if (standEditMatch) {
      const standId = Number(standEditMatch[1]);
      const stand = admin.standById(standId);
      if (!stand) return h.send(res, 404, 'Not found'), true;

      audit('admin_view', 'success', { userId: user.id, detail: `stand ${standId}`, ip });
      h.sendHtml(res, 200, views.adminLayout({
        title: `${stand.stand_number} — property`, active: '/admin/properties', user, csrf,
        body: views.renderPropertyEdit({
          stand, projects, user, csrf,
          notice: url.searchParams.get('ok') === 'saved'
            ? 'Property saved. The website now shows this.' : '',
          error: url.searchParams.get('error') || ''
        })
      }));
      return true;
    }

    /* ── The list ── */
    audit('admin_view', 'success', { userId: user.id, detail: 'properties', ip });
    h.sendHtml(res, 200, views.adminLayout({
      title: 'Properties', active: '/admin/properties', user, csrf,
      body: views.renderProperties({
        stands: admin.standsForAdmin(), projects, user, csrf,
        notice: url.searchParams.get('ok') === 'deleted' ? 'Property deleted.' : '',
        error: url.searchParams.get('error') || ''
      })
    }));
    return true;
  }

  /* ── Projects ── */
  if (pathname === '/admin/projects') {
    const projects = admin.projectsWithCounts();

    if (method === 'POST') {
      const form = readProjectForm(body);
      if (admin.projectNameTaken(form.value.name, 0)) {
        form.errors.push(`A development called "${form.value.name}" already exists.`);
      }

      if (form.errors.length) {
        h.sendHtml(res, 200, views.adminLayout({
          title: 'Projects', active: '/admin/projects', user, csrf,
          body: views.renderProjects({ projects, user, csrf, error: form.errors.join(' ') })
        }));
        return true;
      }

      const id = admin.createProject(form.value);
      audit('project_add', 'success', { userId: user.id, detail: `${form.value.name} (${id})`, ip });
      h.redirect(res, `/admin/projects/${id}?ok=created`);
      return true;
    }

    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    audit('admin_view', 'success', { userId: user.id, detail: 'projects', ip });

    /* Messages are composed from validated codes rather than echoed back from
       the query string, so a crafted link cannot print its own wording here. */
    const okCode = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      .searchParams.get('ok') || '';
    const removed = Number(new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      .searchParams.get('n') || 0);

    const notice = okCode === 'soldout'
      ? 'Availability updated. The website now reflects this.'
      : okCode === 'deleted'
        ? (removed > 0
          ? `Development deleted, along with ${removed} propert${removed === 1 ? 'y' : 'ies'}.`
          : 'Development deleted.')
        : '';

    /* The stand numbers are read back out of the database, never invented. */
    const blocked = (new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      .searchParams.get('stands') || '').split(',').filter(Boolean);
    const errorCode = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      .searchParams.get('error') || '';

    const error = errorCode === 'hasRecords'
      ? `That development was not deleted. ${blocked.join(', ')} `
        + `${blocked.length === 1 ? 'has' : 'have'} a sale or payment recorded, and removing `
        + `${blocked.length === 1 ? 'it' : 'them'} would erase payment history. Remove `
        + `${blocked.length === 1 ? 'that property' : 'those properties'} from the property `
        + 'list first.'
      : errorCode ? 'That development could not be deleted.' : '';

    h.sendHtml(res, 200, views.adminLayout({
      title: 'Projects', active: '/admin/projects', user, csrf,
      body: views.renderProjects({ projects, user, csrf, notice, error })
    }));
    return true;
  }

  /* ── Delete a development ──
     Matched before the general project route, and anchored, so the trailing
     /delete can never be read as part of a project id. */
  const projectDeleteMatch = pathname.match(/^\/admin\/projects\/(\d+)\/delete$/);
  if (projectDeleteMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const projectId = Number(projectDeleteMatch[1]);
    const project = admin.projectById(projectId);
    if (!project) return h.send(res, 404, 'Project not found'), true;

    const result = admin.deleteProject(projectId);

    if (!result.ok) {
      audit('project_delete', 'denied', {
        userId: user.id, detail: `${project.name}: ${result.reason}`, ip
      });
      h.redirect(res, `/admin/projects?error=${result.reason}`
        + `&stands=${encodeURIComponent(result.stands.join(','))}`);
      return true;
    }

    audit('project_delete', 'success', {
      userId: user.id,
      detail: `${project.name} deleted with ${result.stands.length} propert`
        + `${result.stands.length === 1 ? 'y' : 'ies'}`,
      ip
    });
    h.redirect(res, `/admin/projects?ok=deleted&n=${result.stands.length}`);
    return true;
  }

  /* ── Sold-out toggle, straight from the projects list ──
     Separate from the full edit form because it is the one thing the office
     needs to change the moment the last stand goes. */
  const soldOutMatch = pathname.match(/^\/admin\/projects\/(\d+)\/sold-out$/);
  if (soldOutMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const projectId = Number(soldOutMatch[1]);
    const project = admin.projectById(projectId);
    if (!project) return h.send(res, 404, 'Not found'), true;

    const soldOut = String(body.soldOut || '') === '1';
    admin.setProjectSoldOut(projectId, soldOut);

    audit('project_sold_out', 'success', {
      userId: user.id, detail: `${project.name} -> ${soldOut ? 'sold out' : 'selling'}`, ip
    });
    h.redirect(res, '/admin/projects?ok=soldout');
    return true;
  }

  const projectMatch = pathname.match(/^\/admin\/projects\/(\d+)$/);
  if (projectMatch) {
    const projectId = Number(projectMatch[1]);
    const base = admin.projectById(projectId);

    if (!base) {
      h.sendHtml(res, 404, views.adminLayout({
        title: 'Not found', active: '/admin/projects', user, csrf,
        body: '<section class="container inner-page"><h1>Project not found</h1><p><a class="btn primary" href="/admin/projects">Back to projects</a></p></section>'
      }));
      return true;
    }

    /* The counts-bearing row, so the page can show the property breakdown
       without a second query. */
    const project = admin.projectsWithCounts().find((p) => p.id === projectId) || base;

    /* ── Save the development itself: its name and details ── */
    if (method === 'POST') {
      const form = readProjectForm(body);
      if (admin.projectNameTaken(form.value.name, projectId)) {
        form.errors.push(`Another development is already called "${form.value.name}".`);
      }

      if (form.errors.length) {
        h.sendHtml(res, 200, views.adminLayout({
          title: project.name, active: '/admin/projects', user, csrf,
          body: views.renderProjectDetail({
            project, stands: admin.standsForProject(projectId),
            pricing: admin.pricingFor(projectId),
            steps: admin.progressSteps(projectId), user, csrf,
            error: form.errors.join(' ')
          })
        }));
        return true;
      }

      admin.updateProject(projectId, form.value);
      audit('project_update', 'success', {
        userId: user.id, detail: `${project.name} -> ${form.value.name}`, ip
      });
      h.redirect(res, `/admin/projects/${projectId}?ok=details`);
      return true;
    }

    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const flag = url.searchParams.get('ok') || '';
    const notice = flag === 'added' ? 'Step added.'
      : flag === 'saved' ? 'Step updated.'
        : flag === 'deleted' ? 'Step deleted.'
          : flag === 'details' ? 'Development saved. The website and the analytics now use the new details.'
            : flag === 'created' ? 'Development created. Add its properties next.'
              : flag === 'propertyAdded' ? 'Property added to this development.'
                : flag === 'priceAdded' ? 'Price row added.'
                  : flag === 'priceSaved' ? 'Price row saved.'
                    : flag === 'priceDeleted' ? 'Price row deleted.' : '';

    audit('admin_view', 'success', { userId: user.id, detail: `project ${projectId}`, ip });
    h.sendHtml(res, 200, views.adminLayout({
      title: project.name, active: '/admin/projects', user, csrf,
      body: views.renderProjectDetail({
        project,
        stands: admin.standsForProject(projectId),
        pricing: admin.pricingFor(projectId),
        steps: admin.progressSteps(projectId),
        user, csrf,
        notice,
        error: url.searchParams.get('error') || ''
      })
    }));
    return true;
  }

  const stepDeleteMatch = pathname.match(/^\/admin\/projects\/(\d+)\/progress\/(\d+)\/delete$/);
  const stepMatch = pathname.match(/^\/admin\/projects\/(\d+)\/progress\/(\d+)$/);
  const addStepMatch = pathname.match(/^\/admin\/projects\/(\d+)\/progress$/);

  if (stepDeleteMatch || stepMatch || addStepMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const match = addStepMatch || stepMatch || stepDeleteMatch;
    const projectId = Number(match[1]);
    const project = admin.projectById(projectId);

    if (!project) return h.send(res, 404, 'Project not found'), true;

    /* ── Add ── */
    if (addStepMatch) {
      const label = String(body.label || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (label.length < 2) {
        h.sendHtml(res, 200, views.adminLayout({
          title: project.name, active: '/admin/projects', user, csrf,
          body: views.renderProjectDetail({
            project, stands: admin.standsForProject(projectId),
            pricing: admin.pricingFor(projectId),
            steps: admin.progressSteps(projectId), user, csrf,
            error: 'Please give the step a label.'
          })
        }));
        return true;
      }

      admin.addProgressStep(projectId, label, String(body.state || 'pending'));
      audit('progress_add', 'success', {
        userId: user.id, detail: `${project.name}: ${label}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/projects/${projectId}?ok=added` }), true;
    }

    const stepId = Number(match[2]);
    const exists = admin.progressSteps(projectId).some((s) => s.id === stepId);
    if (!exists) return h.send(res, 404, 'Step not found'), true;

    /* ── Delete ── */
    if (stepDeleteMatch) {
      admin.deleteProgressStep(stepId);
      audit('progress_delete', 'success', {
        userId: user.id, detail: `${project.name}: step ${stepId}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/projects/${projectId}?ok=deleted` }), true;
    }

    /* ── Update ── */
    const label = String(body.label || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const state = String(body.state || 'pending');

    if (label.length < 2 || !admin.setProgressStep(stepId, label, state)) {
      h.sendHtml(res, 200, views.adminLayout({
        title: project.name, active: '/admin/projects', user, csrf,
        body: views.renderProjectDetail({
          project, stands: admin.standsForProject(projectId),
          pricing: admin.pricingFor(projectId),
          steps: admin.progressSteps(projectId), user, csrf,
          error: 'A step needs a label and a valid state.'
        })
      }));
      return true;
    }

    audit('progress_update', 'success', {
      userId: user.id, detail: `${project.name}: ${label} -> ${state}`, ip
    });
    return h.sendHtml(res, 302, '', { Location: `/admin/projects/${projectId}?ok=saved` }), true;
  }

  /* ── The published price list, mirroring the progress-step routes ── */
  const priceDeleteMatch = pathname.match(/^\/admin\/projects\/(\d+)\/pricing\/(\d+)\/delete$/);
  const priceMatch = pathname.match(/^\/admin\/projects\/(\d+)\/pricing\/(\d+)$/);
  const addPriceMatch = pathname.match(/^\/admin\/projects\/(\d+)\/pricing$/);

  if (priceDeleteMatch || priceMatch || addPriceMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const match = addPriceMatch || priceMatch || priceDeleteMatch;
    const projectId = Number(match[1]);
    const project = admin.projectById(projectId);
    if (!project) return h.send(res, 404, 'Project not found'), true;

    const back = (flag) => h.redirect(res, `/admin/projects/${projectId}?ok=${flag}`);

    if (addPriceMatch) {
      const form = readPricingForm(body);
      if (form.errors.length) {
        h.redirect(res, `/admin/projects/${projectId}?error=${encodeURIComponent(form.errors.join(' '))}`);
        return true;
      }
      admin.addPricing(projectId, form.value);
      audit('pricing_add', 'success', {
        userId: user.id, detail: `${project.name}: ${form.value.sizeLabel}`, ip
      });
      return back('priceAdded');
    }

    const priceId = Number(match[2]);
    const row = admin.pricingById(priceId);
    if (!row || row.project_id !== projectId) return h.send(res, 404, 'Price row not found'), true;

    if (priceDeleteMatch) {
      admin.deletePricing(priceId);
      audit('pricing_delete', 'success', {
        userId: user.id, detail: `${project.name}: ${row.size_label}`, ip
      });
      return back('priceDeleted');
    }

    const form = readPricingForm(body);
    if (form.errors.length) {
      h.redirect(res, `/admin/projects/${projectId}?error=${encodeURIComponent(form.errors.join(' '))}`);
      return true;
    }
    admin.updatePricing(priceId, form.value);
    audit('pricing_update', 'success', {
      userId: user.id, detail: `${project.name}: ${form.value.sizeLabel}`, ip
    });
    return back('priceSaved');
  }

  /* ── Site content ── */
  if (pathname === '/admin/content') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    audit('admin_view', 'success', { userId: user.id, detail: 'content', ip });
    h.sendHtml(res, 200, views.adminLayout({
      title: 'Site content', active: '/admin/content', user, csrf,
      body: views.renderContentIndex({ pages: contentPageList(), user, csrf })
    }));
    return true;
  }

  /* ── Site settings and logo ── */
  if (pathname === '/admin/settings') {
    if (method === 'GET') {
      const flag = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        .searchParams.get('ok') || '';
      audit('admin_view', 'success', { userId: user.id, detail: 'settings', ip });
      sendSettingsPage(res, h, { user, csrf, notice: SETTINGS_FLASH[flag] || '' });
      return true;
    }

    if (method === 'POST') {
      let saved = 0;
      for (const s of contentSchema.SETTINGS) {
        const key = `s:${s.key}`;
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          content.setSetting(s.key, String(body[key] ?? '').trim().slice(0, 400));
          saved++;
        }
      }
      audit('settings_update', 'success', { userId: user.id, detail: `${saved} settings`, ip });
      return h.sendHtml(res, 302, '', { Location: '/admin/settings?ok=saved' }), true;
    }

    return h.send(res, 405, 'Method not allowed'), true;
  }

  if (pathname === '/admin/logo' || pathname === '/admin/logo/remove') {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const logoDir = path.join(config.PUBLIC_DIR, 'assets', 'img');

    if (pathname === '/admin/logo/remove') {
      await removeCustomLogos(logoDir);
      // Back to the bundled wordmark, read from branding so there is one source.
      content.setSetting('logo_url', FALLBACK.logo);
      audit('logo_remove', 'success', { userId: user.id, ip });
      return h.sendHtml(res, 302, '', { Location: '/admin/settings?ok=logoRemoved' }), true;
    }

    const file = files.find((f) => f.name === 'logo');
    const check = validateLogoUpload(file, config.MAX_UPLOAD_BYTES);

    if (!check.ok) {
      sendSettingsPage(res, h, { user, csrf, error: check.error });
      return true;
    }

    try {
      await fsp.mkdir(logoDir, { recursive: true });
      // Only one custom logo may exist, so replace rather than accumulate.
      await removeCustomLogos(logoDir);
      const filename = 'logo-custom' + check.extension;
      await fsp.writeFile(path.join(logoDir, filename), file.data);
      content.setSetting('logo_url', 'assets/img/' + filename);
    } catch (err) {
      audit('logo_update', 'failure', { userId: user.id, detail: String(err.message), ip });
      sendSettingsPage(res, h, { user, csrf, error: 'The logo could not be saved. Please try again.' });
      return true;
    }

    audit('logo_update', 'success', {
      userId: user.id, detail: `${file.data.length} bytes`, ip
    });
    return h.sendHtml(res, 302, '', { Location: '/admin/settings?ok=logo' }), true;
  }

  /* ── One content page, and its edits ── */
  const contentPageMatch = pathname.match(/^\/admin\/content\/([a-z0-9_-]+)$/i);
  const contentSaveMatch = pathname.match(/^\/admin\/content\/([a-z0-9_-]+)\/save$/i);
  const contentAddMatch = pathname.match(/^\/admin\/content\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/add$/i);
  const contentDelMatch = pathname.match(
    /^\/admin\/content\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/(\d+)\/delete$/i);

  if (contentPageMatch) {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const pageKey = contentPageMatch[1].toLowerCase();
    const flag = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      .searchParams.get('ok') || '';
    const notice = flag === 'saved' ? 'Saved.'
      : flag === 'added' ? 'Item added.'
        : flag === 'deleted' ? 'Item deleted.' : '';

    audit('admin_view', 'success', { userId: user.id, detail: `content ${pageKey}`, ip });
    sendContentPage(res, h, pageKey, { user, csrf, notice });
    return true;
  }

  if (contentSaveMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const pageKey = contentSaveMatch[1].toLowerCase();
    const schema = contentSchema.page(pageKey);
    if (!schema) return h.send(res, 404, 'Page not found'), true;

    let saved = 0;
    for (const [name, value] of Object.entries(body)) {
      const m = /^f:([a-z0-9_-]+):(\d+):([a-z0-9_-]+)$/i.exec(name);
      if (!m) continue;

      const [, sectionKey, itemRaw, fieldKey] = m;

      /* Only fields the schema actually declares are written, so a crafted
         form cannot invent sections or fields. */
      const section = contentSchema.sectionSchema(pageKey, sectionKey);
      if (!section) continue;
      if (!section.fields.some((f) => f.key === fieldKey)) continue;

      const item = Number(itemRaw);
      if (section.repeat ? item < 1 : item !== 0) continue;

      content.setBlock(pageKey, sectionKey, item, fieldKey, String(value ?? '').slice(0, 4000));
      saved++;
    }

    audit('content_update', 'success', {
      userId: user.id, detail: `${pageKey}: ${saved} field${saved === 1 ? '' : 's'}`, ip
    });
    return h.sendHtml(res, 302, '', { Location: `/admin/content/${pageKey}?ok=saved` }), true;
  }

  if (contentAddMatch || contentDelMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const match = contentAddMatch || contentDelMatch;
    const pageKey = match[1].toLowerCase();
    const sectionKey = match[2].toLowerCase();
    const section = contentSchema.sectionSchema(pageKey, sectionKey);

    if (!section || !section.repeat) return h.send(res, 404, 'No such repeating section'), true;

    if (contentAddMatch) {
      const item = content.addItem(pageKey, sectionKey);
      audit('content_add_item', 'success', {
        userId: user.id, detail: `${pageKey}/${sectionKey} item ${item}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/content/${pageKey}?ok=added` }), true;
    }

    const item = Number(match[3]);
    content.deleteItem(pageKey, sectionKey, item);
    audit('content_delete_item', 'success', {
      userId: user.id, detail: `${pageKey}/${sectionKey} item ${item}`, ip
    });
    return h.sendHtml(res, 302, '', { Location: `/admin/content/${pageKey}?ok=deleted` }), true;
  }

  /* Unknown /admin path */
  h.sendHtml(res, 404, views.adminLayout({
    title: 'Not found', user, csrf,
    body: '<section class="container inner-page"><h1>Page not found</h1><p><a class="btn primary" href="/admin">Back to overview</a></p></section>'
  }));
  return true;
}

/* Housekeeping for the limiter map; called from index.js on the same timer. */
function sweep() { adminLoginLimiter.sweep(); }

module.exports = { handleAdmin, sweep, isAdmin };
