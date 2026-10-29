'use strict';

/* ==========================================================================
   Admin area.

   Mounted from index.js as a single entry point: await handleAdmin() returns true
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
const { audit, admin, enquiries, users, agents, sessions, staffSessions, leads, staffLogs,
  leadNotes, content, db, PAYMENT_STATUSES, PAYMENT_METHODS, PROPERTY_TYPES,
  STAND_STATUSES, PROJECT_STATUSES, findLeadByPhone } = require('./db');
const contentSchema = require('./content');
const auth = require('./auth');
const views = require('./views-admin');
const viewsAnalytics = require('./views-analytics');
const analytics = require('./analytics');
const reportExports = require('./exports');
const { RateLimiter } = require('./security');
const { todayIso, utcRangeForLocalDate } = require('./format');
const { generatePassword, generatePasswordWithSymbol } = require('./passwords');
const { validateUpload, validateLogoUpload } = require('./multipart');
const { logoPath, logoAbsolute, FALLBACK } = require('./branding');
const { logSecurityEvent } = require('./security-log');
const { readLeadUpdate } = require('./lead-input');
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

/* The roles that may hold an admin session at all, and what each may do. The
   table itself lives in permissions.js so the router and the navigation read the
   same facts. 'client' is not a staff role: a client reaching /admin is sent to
   their own portal. */
const { isStaffRole, getEffectiveRole, mayReach, mayPerform } = require('./permissions');

function isAdmin(user) {
  /* getEffectiveRole may only narrow a role, never widen it, so a client whose
     email somehow matched the CEO address still fails here. */
  return Boolean(user && isStaffRole(getEffectiveRole(user)));
}

/* ── Adding a team member ───────────────────────────────────────────────────
   A Sales Agent is a row in `agents`; the panel roles are rows in `users`. The
   two tables are separate by design — staff_signin reads agents, signIn reads
   users — so the role picked on the form decides which one is written. */

/** The client_number prefix each panel role's accounts carry. */
const PANEL_ROLE_PREFIX = { admin: 'ADMIN', ceo: 'CEO', finance: 'FIN', hr: 'HR' };

/** How each role is described back to whoever added them. */
const ROLE_LABEL = {
  agent: 'Sales Agent', admin: 'Administrator', manager: 'Manager',
  ceo: 'Managing Director', md: 'Managing Director', finance: 'Finance', hr: 'HR'
};

/**
 * The next free client_number for a prefix, e.g. CEO-004.
 *
 * Derived from the highest existing number rather than a counter, so deleting a
 * row by hand cannot make the next insert collide with a surviving one.
 */
async function nextStaffNumber(prefix) {
  const rows = await db.prepare(
    'SELECT client_number FROM users WHERE client_number LIKE ?').all(`${prefix}-%`);

  let highest = 0;
  for (const r of rows) {
    const n = Number.parseInt(String(r.client_number).slice(prefix.length + 1), 10);
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`;
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
  archived: 'Client archived and signed out. Their records are untouched.',
  unarchived: 'Client restored to the active list.',
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
async function sendPaymentEdit(res, h, clientId, paymentId, opts) {
  const client = await admin.clientById(clientId);
  const payment = await admin.paymentById(paymentId);

  if (!client || !payment || payment.user_id !== clientId) {
    h.sendHtml(res, 404, await views.adminLayout({
      title: 'Not found', active: '/admin/clients', user: opts.user, csrf: opts.csrf,
      body: '<section class="container inner-page"><h1>Payment not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
    }));
    return;
  }

  h.sendHtml(res, 200, await views.adminLayout({
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
async function contentSections(pageKey) {
  const schema = contentSchema.page(pageKey);
  const resolved = await content.resolve(pageKey);

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

async function sendContentPage(res, h, pageKey, opts) {
  const schema = contentSchema.page(pageKey);

  if (!schema) {
    h.sendHtml(res, 404, await views.adminLayout({
      title: 'Not found', active: '/admin/content', user: opts.user, csrf: opts.csrf,
      body: '<section class="container inner-page"><h1>Page not found</h1><p><a class="btn primary" href="/admin/content">Back to content</a></p></section>'
    }));
    return;
  }

  h.sendHtml(res, 200, await views.adminLayout({
    title: `Content — ${schema.label}`,
    active: '/admin/content',
    user: opts.user,
    csrf: opts.csrf,
    body: views.renderContentPage({
      page: { key: schema.key, label: schema.label },
      sections: await contentSections(pageKey),
      pages: contentPageList(),
      user: opts.user,
      csrf: opts.csrf,
      notice: opts.notice || '',
      error: opts.error || ''
    })
  }));
}

async function sendSettingsPage(res, h, opts) {
  h.sendHtml(res, 200, await views.adminLayout({
    title: 'Site settings',
    active: '/admin/settings',
    user: opts.user,
    csrf: opts.csrf,
    body: views.renderSettings({
      schema: contentSchema.SETTINGS,
      values: await content.settings(),
      logo: { absolute: await logoAbsolute(), custom: /logo-custom\./.test(await logoPath()) },
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

async function loadClient(id) {
  const client = await admin.clientById(id);
  if (!client) return null;
  return {
    client,
    payments: await admin.paymentsFor(id),
    stands: await admin.stands(),
    agents: await admin.agents(),
    documents: await admin.documentsFor(id)
  };
}

/** Renders one client's page, or a 404 when the id does not exist. */
async function sendClientPage(res, h, id, opts) {
  const data = await loadClient(id);

  if (!data) {
    h.sendHtml(res, 404, await views.adminLayout({
      title: 'Not found', active: '/admin/clients', user: opts.user, csrf: opts.csrf,
      body: '<section class="container inner-page"><h1>Client not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
    }));
    return;
  }

  h.sendHtml(res, 200, await views.adminLayout({
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
      h.sendHtml(res, 200, await views.renderLogin({ csrf }));
      return true;
    }

    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const limit = adminLoginLimiter.check(ip);
    if (!limit.allowed) {
      const mins = Math.ceil(limit.retryAfterMs / 60000);
      await audit('admin_login', 'rate_limited', { detail: 'per-IP limit', ip });
      logSecurityEvent('admin_login_rate_limited', req, { retryAfterMs: limit.retryAfterMs });
      h.sendHtml(res, 429, await views.renderLogin({
        csrf,
        error: `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
      }));
      return true;
    }

    const clientNumber = String(body.clientNumber || '').trim().toUpperCase();
    const password = String(body.password || '');

    if (!clientNumber || !password) {
      h.sendHtml(res, 400, await views.renderLogin({ csrf, error: 'Staff ID and password are required.' }));
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
      logSecurityEvent('admin_login_failed', req, { clientNumber, reason: result.reason });
      h.sendHtml(res, 401, await views.renderLogin({ csrf, error: message }));
      return true;
    }

    /* Credentials were valid, but this may be an ordinary client. Tear the
       session down before the cookie is ever issued, so a client can never
       hold an admin-capable session token. */
    if (!isStaffRole(getEffectiveRole(result.user))) {
      await auth.destroySession(result.token);
      await audit('admin_login', 'denied', {
        userId: result.user.id, clientNumber, detail: 'not an admin account', ip
      });
      logSecurityEvent('admin_login_denied', req, {
        clientNumber, reason: 'not an admin account'
      });
      h.sendHtml(res, 403, await views.renderLogin({
        csrf, error: 'That account does not have staff access.'
      }));
      return true;
    }

    adminLoginLimiter.reset(ip);
    await audit('admin_login', 'success', { userId: result.user.id, clientNumber, ip });
    logSecurityEvent('admin_login_success', req, { clientNumber: result.user.clientNumber });

    h.sendHtml(res, 302, '', {
      Location: '/admin',
      'Set-Cookie': auth.sessionCookie(result.token, config.SESSION_TTL_MS)
    });
    return true;
  }

  /* ── Everything below requires an admin session ── */
  if (!isAdmin(user)) {
    if (!PUBLIC_ADMIN_PATHS.has(pathname)) {
      await audit('admin_access', 'denied', {
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
    await auth.destroySession(ctx.cookies[config.SESSION_COOKIE]);
    await audit('admin_logout', 'success', { userId: user.id, ip });
    h.sendHtml(res, 302, '', {
      Location: '/admin/login',
      'Set-Cookie': auth.clearSessionCookie()
    });
    return true;
  }

  /* A manager is a restricted admin — sales, leads and the activity log only.
     Checked here, once, before any page route below runs, so no individual route
     has to remember. */
  /* Two separate questions, asked here, once, before any page route below runs
     so no individual route has to remember:
       1. may this role open this page at all?
       2. may this role perform this method on it?
     The second only matters for a role that is read-only, or read-only on this
     part of the panel. */
  /* Resolved once and used for both the decision and the audit line, so the log
     always names the role the panel actually applied. */
  const role = getEffectiveRole(user);

  if (!mayReach(role, pathname)) {
    await audit('admin_access', 'denied', {
      userId: user.id, detail: `${method} ${pathname} (${role} role)`, ip
    });
    return h.redirect(res, '/admin?error=denied'), true;
  }

  if (!mayPerform(role, method, pathname)) {
    await audit('admin_access', 'denied', {
      userId: user.id, detail: `${method} ${pathname} (${role} is view-only here)`, ip
    });
    return h.redirect(res, '/admin?error=readonly'), true;
  }

  /* ══ Sales analytics ═══════════════════════════════════════════════════
     Every figure is computed from the transaction records on each request,
     so no dashboard total can drift away from the ledger. */

  if (pathname === '/admin/analytics' || pathname === '/admin/analytics/ledger') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const filters = await analytics.filtersFrom(Object.fromEntries(url.searchParams));
    const options = await analytics.filterOptions();
    const isLedger = pathname.endsWith('/ledger');

    await audit('analytics_view', 'success', { userId: user.id, detail: isLedger ? 'ledger' : 'overview', ip });

    const ledger = await analytics.ledger(filters, {
      page: Number(url.searchParams.get('page')) || 1,
      perPage: isLedger ? 50 : 8,
      sort: url.searchParams.get('sort') || 'date',
      dir: url.searchParams.get('dir') || 'desc'
    });

    const html = isLedger
      ? await viewsAnalytics.renderLedger({
        ledger, totals: await analytics.sumTransactions(filters), options, filters, user, csrf
      })
      : await viewsAnalytics.renderAnalytics({
        kpis: await analytics.kpis(filters),
        collection: await analytics.collectionAnalysis(filters),
        projects: await analytics.byProject(filters),
        agents: await analytics.byAgent(filters),
        types: await analytics.byType(filters),
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
    const filters = await analytics.filtersFrom(Object.fromEntries(url.searchParams));
    const options = await analytics.filterOptions();
    const today = new Date();

    await audit('analytics_view', 'success', {
      userId: user.id, detail: pathname.split('/').pop(), ip
    });

    if (pathname.endsWith('/weekly')) {
      /* A custom range wins over the week selector if one was given. */
      const custom = Boolean(filters.from || filters.to);
      const offset = Number(url.searchParams.get('week')) || 0;

      const range = custom
        ? { from: filters.from || filters.to, to: filters.to || filters.from }
        : await analytics.weekBounds(offset, today);
      const before = await analytics.weekBounds(custom ? 0 : offset - 1, today);

      const label = custom ? 'Custom range'
        : offset === 0 ? 'This week'
          : offset === -1 ? 'Last week' : `${Math.abs(offset)} weeks ago`;

      h.sendHtml(res, 200, await viewsAnalytics.renderWeekly({
        kpis: await analytics.kpis({ ...filters, from: range.from, to: range.to }),
        previous: await analytics.kpis({ ...filters, from: before.from, to: before.to }),
        series: await analytics.dailySeries(range.from, range.to, filters),
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
      const prior = await analytics.shiftMonth(month, -1);
      const scope = { ...filters, month, year: null, from: null, to: null };

      const longMonth = (m) => new Date(`${m}-01T00:00:00Z`)
        .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

      h.sendHtml(res, 200, await viewsAnalytics.renderMonthly({
        kpis: await analytics.kpis(scope),
        previous: await analytics.kpis({ ...scope, month: prior }),
        previousLabel: longMonth(prior),
        series: await analytics.monthlySeries(month.slice(0, 4), filters),
        month,
        year: month.slice(0, 4),
        options, filters, user, csrf
      }));
      return true;
    }

    const year = filters.year || String(today.getFullYear());
    const years = (await db.prepare(`
      SELECT DISTINCT substr(COALESCE(sale_date, purchase_date), 1, 4) AS y
        FROM ownerships
       WHERE COALESCE(sale_date, purchase_date) GLOB '[0-9][0-9][0-9][0-9]-*'
       ORDER BY y DESC`).all()).map((r) => r.y);
    if (!years.includes(year)) years.unshift(year);

    h.sendHtml(res, 200, await viewsAnalytics.renderAnnual({
      kpis: await analytics.kpis({ ...filters, year, month: null, from: null, to: null }),
      series: await analytics.monthlySeries(year, filters),
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
    const filters = await analytics.filtersFrom(Object.fromEntries(url.searchParams));
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
        : await analytics.weekBounds(offset, today);

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

    const report = await reportExports.build(type, filters, context);
    if (!report) return h.send(res, 404, 'Not found'), true;

    const buffer = reportExports.render(report, format, { settings: await content.settings() });
    const filename = reportExports.filenameFor(report, format, context);

    await audit('analytics_export', 'success', {
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
    const sale = await analytics.saleById(saleId);
    if (!sale) return h.send(res, 404, 'Not found'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    await audit('sale_view', 'success', { userId: user.id, detail: `sale ${saleId}`, ip });

    const audits = await db.prepare(`
      SELECT f.*, u.client_number AS actor_number FROM finance_audit f
        LEFT JOIN users u ON u.id = f.actor_user_id
       WHERE (f.entity = 'sale' AND f.entity_id = ?)
          OR (f.entity = 'payment' AND f.entity_id IN
                (SELECT id FROM payments WHERE ownership_id = ?))
       ORDER BY f.id DESC`).all(saleId, saleId);

    h.sendHtml(res, 200, await viewsAnalytics.renderSaleDetail({
      sale,
      transactions: await analytics.saleTransactions(saleId),
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
    const sale = await analytics.saleById(saleId);
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
      isTaken: async (ref) => await admin.referenceTaken(ref),
      fallbackCode: (await content.settings()).payment_ref_prefix || 'HHP'
    });

    const result = await analytics.recordTransaction({
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

    await audit(`txn_${type.toLowerCase()}`, 'success', {
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

    const payment = await db.prepare('SELECT ownership_id FROM payments WHERE id = ?').get(paymentId);
    if (!payment) return h.send(res, 404, 'Not found'), true;

    const result = action === 'void'
      ? await analytics.voidTransaction(paymentId, { actorId: user.id, reason })
      : await analytics.unvoidTransaction(paymentId, { actorId: user.id, reason });

    const back = payment.ownership_id ? `/admin/sales/${payment.ownership_id}` : '/admin/analytics/ledger';
    if (!result.ok) {
      h.redirect(res, `${back}?error=${encodeURIComponent(result.error)}`);
      return true;
    }

    await audit(`payment_${action}`, 'success', { userId: user.id, detail: `payment ${paymentId}`, ip });
    h.redirect(res, `${back}?ok=${action === 'void' ? 'Transaction voided.' : 'Transaction restored.'}`);
    return true;
  }

  /* ── Overview ── */
  if (pathname === '/admin') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;
    const counts = await admin.counts();
    const recent = (await enquiries.all()).slice(0, 5);
    await audit('admin_view', 'success', { userId: user.id, detail: 'overview', ip });

    /* A role that reached for a page outside its remit, or tried to change
       something it may only read, lands here rather than on a bare error page. */
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const flag = url.searchParams.get('error');
    const error = flag === 'denied'
      ? 'Access denied. You do not have permission to view this page.'
      : flag === 'readonly'
        ? 'Your role is view-only here. That change was not saved.'
        : '';

    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Overview', active: '/admin', user, csrf,
      body: views.renderDashboard({
        counts, recent, clientsByDevelopment: await admin.clientsByDevelopment(),
        user, csrf, error
      })
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

    await audit('admin_view', 'success', { userId: user.id, detail: 'enquiries', ip });

    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Enquiries', active: '/admin/enquiries', user, csrf,
      body: views.renderEnquiries({ list: await enquiries.all(), counts: await enquiries.counts(), user, csrf, flash })
    }));
    return true;
  }

  const m = pathname.match(HANDLE_RE);
  if (m) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const id = Number.parseInt(m[1], 10);
    const action = m[2];
    const record = await enquiries.byId(id);

    if (!record) {
      h.sendHtml(res, 404, await views.adminLayout({
        title: 'Not found', active: '/admin/enquiries', user, csrf,
        body: '<section class="container inner-page"><h1>Enquiry not found</h1><p><a class="btn primary" href="/admin/enquiries">Back to enquiries</a></p></section>'
      }));
      return true;
    }

    if (action === 'handle') await enquiries.markHandled(id, user.id);
    else await enquiries.reopen(id);

    await audit(`enquiry_${action}`, 'success', {
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

      const refuse = async (message) => {
        h.sendHtml(res, 200, await views.adminLayout({
          title: 'Add a client', active: '/admin/clients', user, csrf,
          body: views.renderNewClient({
            suggestedNumber: clientNumber || await admin.suggestClientNumber(),
            user, csrf, error: message
          })
        }));
      };

      if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(clientNumber)) {
        await refuse('Client number must be 3 to 32 characters, using letters, digits and hyphens.');
        return true;
      }
      if (fullName.length < 2) { await refuse('Please enter the client\'s full name.'); return true; }
      if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
        await refuse('That does not look like a valid email address.');
        return true;
      }
      if (await users.byClientNumber(clientNumber)) {
        await refuse(`Client number ${clientNumber} is already in use.`);
        return true;
      }

      const password = generatePassword(20);
      await admin.createClient({
        clientNumber, fullName, email,
        passwordHash: await auth.hashPassword(password)
      });
      await audit('client_create', 'success', {
        userId: user.id, clientNumber, detail: `created ${fullName}`, ip
      });

      h.sendHtml(res, 200, await views.adminLayout({
        title: 'Client created', active: '/admin/clients', user, csrf,
        body: views.renderNewClient({
          suggestedNumber: await admin.suggestClientNumber(),
          user, csrf,
          created: { clientNumber, password }
        })
      }));
      return true;
    }

    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const q = (url.searchParams.get('q') || '').trim();
    const showArchived = url.searchParams.get('show') === 'archived';

    /* The development filter the overview's folder tiles link to. A project id,
       or the literal 'unassigned' for clients with no sale. Anything else is
       treated as no filter rather than as an error, so a mangled link still
       shows the full list instead of an empty page. */
    const devParam = (url.searchParams.get('development') || '').trim();
    let developmentId = null;
    if (devParam === 'unassigned') developmentId = 'unassigned';
    else if (Number.isInteger(Number.parseInt(devParam, 10))) {
      developmentId = Number.parseInt(devParam, 10);
    }

    const clients = await admin.searchClients(q, { includeArchived: showArchived, developmentId });

    /* The name of the active filter, so the page can say what it is showing. */
    let developmentName = null;
    if (developmentId === 'unassigned') developmentName = 'Unassigned';
    else if (developmentId) developmentName = ((await admin.projectById(developmentId)) || {}).name || null;

    await audit('admin_view', 'success', {
      userId: user.id, detail: q ? `clients search "${q}"` : 'clients', ip
    });

    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Clients', active: '/admin/clients', user, csrf,
      body: views.renderClients({
        clients, user, csrf, query: q, showArchived, developmentId, developmentName
      })
    }));
    return true;
  }

  /* ── New client form ── */
  if (pathname === '/admin/clients/new') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    await audit('admin_view', 'success', { userId: user.id, detail: 'new client form', ip });
    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Add a client', active: '/admin/clients', user, csrf,
      body: views.renderNewClient({ suggestedNumber: await admin.suggestClientNumber(), user, csrf })
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

    await audit('admin_view', 'success', { userId: user.id, detail: `client ${id}`, ip });
    await sendClientPage(res, h, id, {
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
    const client = await admin.clientById(clientId);
    if (!client) return h.send(res, 404, 'Not found'), true;

    const pdf = invoice.buildStatementPdf({
      settings: await content.settings(),
      client,
      ownership: invoice.ownershipFromClientRow(client),
      payments: await admin.paymentsFor(clientId),
      generatedAt: new Date()
    });

    await audit('statement_download', 'success', {
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
    const client = await admin.clientById(clientId);
    const payment = await admin.paymentById(paymentId);

    if (!client || !payment || payment.user_id !== clientId) {
      h.sendHtml(res, 404, await views.adminLayout({
        title: 'Not found', active: '/admin/clients', user, csrf,
        body: '<section class="container inner-page"><h1>Payment not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
      }));
      return true;
    }

    if (method === 'GET') {
      await audit('admin_view', 'success', { userId: user.id, detail: `payment ${paymentId}`, ip });
      await sendPaymentEdit(res, h, clientId, paymentId, { user, csrf });
      return true;
    }

    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const cents = parseMoneyToCents(body.amount);
    const paidOn = String(body.paidOn || '').trim();
    const status = String(body.status || '').trim();

    const refuse = async (message) =>
      await sendPaymentEdit(res, h, clientId, paymentId, { user, csrf, error: message });

    if (cents === null) {
      await refuse('Amount must be a positive number, for example 1500 or 1500.00.');
      return true;
    }
    if (!isIsoDate(paidOn)) { await refuse('Please give a valid date received.'); return true; }
    if (!PAYMENT_STATUSES.includes(status)) { await refuse('Unknown payment status.'); return true; }

    /* Through the analytics layer, not straight to the table: an edit to a
       financial record must be audited and must recompute the sale. */
    const result = await analytics.updateTransaction(paymentId, {
      paidOn,
      amountCents: cents,
      method: payment.method,
      notes: payment.notes,
      status,
      actorId: user.id,
      reason: 'Edited from the client page'
    });

    if (!result.ok) { await refuse(result.error); return true; }

    await audit('payment_update', 'success', {
      userId: user.id, clientNumber: client.client_number,
      detail: `${payment.reference} ${cents} cents (${status})`, ip
    });
    return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=paymentSaved` }), true;
  }

  if (payStatusMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const clientId = Number(payStatusMatch[1]);
    const paymentId = Number(payStatusMatch[2]);
    const client = await admin.clientById(clientId);
    const payment = await admin.paymentById(paymentId);

    if (!client || !payment || payment.user_id !== clientId) {
      h.send(res, 404, 'Not found');
      return true;
    }

    const status = String(body.status || '').trim();
    const changed = await analytics.setTransactionStatus(paymentId, status, {
      actorId: user.id,
      reason: 'Changed from the client page'
    });

    if (!changed.ok) {
      await sendClientPage(res, h, clientId, { user, csrf, error: changed.error });
      return true;
    }

    await audit('payment_status', 'success', {
      userId: user.id, clientNumber: client.client_number,
      detail: `${payment.reference}: ${payment.status} -> ${status}`, ip
    });
    return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=paymentStatus` }), true;
  }

  const payDeleteMatch = pathname.match(/^\/admin\/clients\/(\d+)\/payments\/(\d+)\/delete$/);
  const actionMatch = pathname.match(
    /^\/admin\/clients\/(\d+)\/(update|reset-password|disable|archive|unlock|stand|unlink|payments)$/);

  if (payDeleteMatch || actionMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    /* Deleting a payment. */
    if (payDeleteMatch) {
      const clientId = Number(payDeleteMatch[1]);
      const paymentId = Number(payDeleteMatch[2]);
      const payment = await admin.paymentById(paymentId);

      // The payment must belong to the client in the URL — never trust the path alone.
      if (!payment || payment.user_id !== clientId) {
        h.sendHtml(res, 404, await views.adminLayout({
          title: 'Not found', active: '/admin/clients', user, csrf,
          body: '<section class="container inner-page"><h1>Payment not found</h1><p><a class="btn primary" href="/admin/clients">Back to clients</a></p></section>'
        }));
        return true;
      }

      /* The row goes, so the money stops counting — but a deletion is still a
         change to a financial record, so the figures are written to the
         finance audit trail first. Voiding is the reversible alternative and
         is offered on the sale page. */
      await analytics.financeAudit({
        actorUserId: user.id,
        action: 'payment_deleted',
        entity: 'payment',
        entityId: paymentId,
        reference: payment.reference,
        oldValue: `${payment.amount_cents} cents on ${payment.paid_on} (${payment.status})`,
        newValue: 'deleted',
        reason: 'Deleted from the client page'
      });

      await admin.deletePayment(paymentId);
      if (payment.ownership_id) await analytics.recomputeSale(payment.ownership_id, user.id);

      await audit('payment_delete', 'success', {
        userId: user.id, detail: `payment ${payment.reference} (${paymentId}) from client ${clientId}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=deleted` }), true;
    }

    const clientId = Number(actionMatch[1]);
    const action = actionMatch[2];
    const client = await admin.clientById(clientId);

    if (!client) {
      h.sendHtml(res, 404, await views.adminLayout({
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
        await sendClientPage(res, h, clientId, { user, csrf, error: 'Please enter the client\'s full name.' });
        return true;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
        await sendClientPage(res, h, clientId, { user, csrf, error: 'That does not look like a valid email address.' });
        return true;
      }

      await admin.updateClient(clientId, { fullName, email });
      await audit('client_update', 'success', { userId: user.id, detail: `client ${clientId} (${client.client_number})`, ip });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=saved` }), true;
    }

    /* ── Reset password — the new password is rendered once, never in a URL ── */
    if (action === 'reset-password') {
      const password = generatePasswordWithSymbol(5);
      await admin.setPassword(clientId, await auth.hashPassword(password));
      await audit('client_password_reset', 'success', {
        userId: user.id, clientNumber: client.client_number, detail: `client ${clientId}`, ip
      });
      /* The password itself is deliberately absent from this line — it is shown
         once in the response and must never reach a log. */
      logSecurityEvent('password_reset_by_admin', req, {
        clientNumber: client.client_number, actorClientNumber: user.clientNumber
      });
      await sendClientPage(res, h, clientId, {
        user, csrf,
        notice: 'Password reset. Existing sessions have been signed out.',
        generatedPassword: password
      });
      return true;
    }

    /* ── Disable / re-enable ── */
    if (action === 'disable') {
      const disabled = String(body.disabled) === '1';
      await admin.setDisabled(clientId, disabled);
      await audit(disabled ? 'client_disable' : 'client_enable', 'success', {
        userId: user.id, clientNumber: client.client_number, detail: `client ${clientId}`, ip
      });
      return h.sendHtml(res, 302, '', {
        Location: `/admin/clients/${clientId}?ok=${disabled ? 'disabled' : 'enabled'}`
      }), true;
    }

    /* ── Archive / restore ──
       The cleanup path. There is deliberately no delete for a client: the
       ownerships, the payments and the audit rows all point at this account, so
       removing it would break the financial trail. Archiving hides the account
       and stops it signing in, and nothing else. */
    if (action === 'archive') {
      const archived = String(body.archived) === '1';
      await admin.setClientArchived(clientId, archived);
      await audit(archived ? 'client_archive' : 'client_unarchive', 'success', {
        userId: user.id, clientNumber: client.client_number, detail: `client ${clientId}`, ip
      });
      return h.sendHtml(res, 302, '', {
        Location: `/admin/clients/${clientId}?ok=${archived ? 'archived' : 'unarchived'}`
      }), true;
    }

    if (action === 'unlock') {
      await admin.unlock(clientId);
      await audit('client_unlock', 'success', {
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

      if (await admin.ownershipCountFor(clientId) > 0) {
        await sendClientPage(res, h, clientId, { user, csrf, error: 'This client already has a stand linked.' });
        return true;
      }
      if (!Number.isInteger(standId) || standId <= 0) {
        await sendClientPage(res, h, clientId, { user, csrf, error: 'Please choose a stand.' });
        return true;
      }
      if (cents === null) {
        await sendClientPage(res, h, clientId, { user, csrf, error: 'Purchase price must be a positive amount, for example 5500 or 5500.00.' });
        return true;
      }
      if (!isIsoDate(purchaseDate)) {
        await sendClientPage(res, h, clientId, { user, csrf, error: 'Please give a valid purchase date.' });
        return true;
      }

      const stand = (await admin.stands()).find((s) => s.id === standId);
      if (!stand) {
        await sendClientPage(res, h, clientId, { user, csrf, error: 'That stand does not exist.' });
        return true;
      }
      if (stand.held_by && stand.held_by !== client.client_number) {
        await sendClientPage(res, h, clientId, {
          user, csrf, error: `Stand ${stand.stand_number} is already held by ${stand.held_by}.`
        });
        return true;
      }

      /* The sales agent is optional — an old sale being re-keyed may have no
         agent recorded — but a value that is not a live agent is a mistake, so
         it is refused rather than silently dropped. */
      let agentId = null;
      const rawAgent = String(body.agentId || '').trim();
      if (rawAgent) {
        agentId = Number.parseInt(rawAgent, 10);
        if (!(await admin.agents()).some((a) => a.id === agentId)) {
          await sendClientPage(res, h, clientId, {
            user, csrf, error: 'Please choose a sales agent from the list.'
          });
          return true;
        }
      }

      /* The guard inside linkStand() throws when the stand was taken between
         this page being rendered and the form being submitted — a double-click,
         a stale tab, or another member of staff getting there first. The page
         is re-rendered with the reason, and its error slot is the same
         <p class="notice error"> every other failure on this page uses. */
      try {
        await admin.linkStand({
          userId: clientId, standId, priceCents: cents, purchaseDate, status, agentId
        });
      } catch (err) {
        await sendClientPage(res, h, clientId, {
          user, csrf,
          error: (err && err.message) || 'That stand could not be linked. Please try again.'
        });
        return true;
      }
      await audit('stand_link', 'success', {
        userId: user.id, clientNumber: client.client_number,
        detail: `stand ${stand.stand_number} to client ${clientId} at ${cents} cents`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=linked` }), true;
    }

    /* ── Unlink a stand ── */
    if (action === 'unlink') {
      if (!client.ownership_id) {
        await sendClientPage(res, h, clientId, { user, csrf, error: 'This client has no stand to unlink.' });
        return true;
      }
      await admin.unlinkOwnership(client.ownership_id);
      await audit('stand_unlink', 'success', {
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
        await sendClientPage(res, h, clientId, { user, csrf, error: 'Amount must be a positive number, for example 1500 or 1500.00.' });
        return true;
      }
      if (!isIsoDate(paidOn)) {
        await sendClientPage(res, h, clientId, { user, csrf, error: 'Please give a valid date received.' });
        return true;
      }

      /* The reference is generated, never typed: project initials plus the
         moment of entry. That removes the duplicate-reference failure, which
         was the one way recording a payment could silently go wrong. */
      const reference = buildReference({
        projectName: client.project_name,
        when: new Date(),
        isTaken: async (ref) => await admin.referenceTaken(ref),
        fallbackCode: (await content.settings()).payment_ref_prefix || 'HHP'
      });

      /* Type is derived rather than asked for: the first money in on a sale is
         its deposit and everything after that is an instalment. Final payments
         and refunds are recorded from the sale page, where the outstanding
         balance is known and the overpayment rules can be checked. */
      const ownership = client.stand_id
        ? await db.prepare('SELECT id FROM ownerships WHERE user_id = ? AND stand_id = ? LIMIT 1')
          .get(clientId, client.stand_id)
        : null;

      const priorConfirmed = ownership
        ? (await db.prepare(`SELECT COUNT(*) AS c FROM payments
                       WHERE ownership_id = ? AND voided_at IS NULL AND status = 'Confirmed'`)
          .get(ownership.id)).c
        : 0;

      const type = priorConfirmed > 0 ? 'INSTALLMENT' : 'DEPOSIT';
      const method = PAYMENT_METHODS.includes(String(body.method || '')) ? body.method : null;

      const paymentId = await admin.addPayment({
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
      await analytics.financeAudit({
        actorUserId: user.id,
        action: `${type.toLowerCase()}_created`,
        entity: 'payment',
        entityId: paymentId,
        reference,
        newValue: `${cents} cents on ${paidOn} (${status})`,
        reason: 'Recorded from the client page'
      });

      if (ownership) await analytics.recomputeSale(ownership.id, user.id);

      await audit('payment_add', 'success', {
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
    const client = await admin.clientById(clientId);

    if (!client) {
      h.sendHtml(res, 404, await views.adminLayout({
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
        await sendClientPage(res, h, clientId, { user, csrf, error: 'Please give the document a title.' });
        return true;
      }

      const check = validateUpload(file, config.MAX_UPLOAD_BYTES);
      if (!check.ok) {
        await sendClientPage(res, h, clientId, { user, csrf, error: check.error });
        return true;
      }

      /* The file is stored under a random name. The client's own filename never
         reaches the disk, so a crafted one cannot escape the directory, collide
         with another document, or be used to guess a URL. */
      const storedName = crypto.randomBytes(16).toString('hex') + check.extension;

      try {
        await fsp.writeFile(path.join(config.PRIVATE_DOCS_DIR, storedName), file.data);
      } catch (err) {
        await audit('document_upload', 'failure', { userId: user.id, detail: String(err.message), ip });
        await sendClientPage(res, h, clientId, {
          user, csrf, error: 'The file could not be saved. Please try again.'
        });
        return true;
      }

      await admin.addDocument({
        userId: clientId, title, storedName,
        mime: 'application/pdf', sizeBytes: file.data.length
      });

      await audit('document_upload', 'success', {
        userId: user.id, clientNumber: client.client_number,
        detail: `${title} (${file.data.length} bytes)`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/clients/${clientId}?ok=document` }), true;
    }

    /* Both remaining actions name a document, which must belong to this client. */
    const docId = Number(match[2]);
    const doc = await admin.documentById(docId);

    if (!doc || doc.user_id !== clientId) {
      h.send(res, 404, 'Not found');
      return true;
    }

    const root = path.resolve(config.PRIVATE_DOCS_DIR);
    const filePath = path.resolve(root, doc.stored_name);

    /* Belt and braces: stored_name is server-generated, but re-check so a future
       bad write cannot turn this route into arbitrary file disclosure. */
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      await audit('document_download', 'denied', { userId: user.id, detail: 'path escape', ip });
      h.send(res, 403, 'Forbidden');
      return true;
    }

    /* ── Delete ── */
    if (docDeleteMatch) {
      if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

      await admin.deleteDocument(docId);
      try { await fsp.unlink(filePath); } catch { /* already gone */ }

      await audit('document_delete', 'success', {
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
    await audit('document_download', 'success', {
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
  const standComingSoonMatch = pathname.match(/^\/admin\/properties\/(\d+)\/coming-soon$/);

  if (pathname === '/admin/properties' || standEditMatch || standDeleteMatch || standComingSoonMatch) {
    const projects = await admin.projectsWithCounts();

    /* ── Delete ── */
    if (standDeleteMatch) {
      if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

      const standId = Number(standDeleteMatch[1]);
      const stand = await admin.standById(standId);
      if (!stand) return h.send(res, 404, 'Not found'), true;

      /* A stand with a sale must not vanish. The ownership, the client's
         payments and every analytics figure point at this row. */
      if (stand.sale_count > 0) {
        h.redirect(res, `/admin/properties/${standId}?error=${encodeURIComponent(
          'That property has a sale recorded against it, so it cannot be deleted. '
          + 'Mark it Sold instead, or cancel the sale first.')}`);
        return true;
      }

      await admin.deleteStand(standId);
      await audit('stand_delete', 'success', {
        userId: user.id, detail: `${stand.stand_number} (${standId})`, ip
      });
      h.redirect(res, '/admin/properties?ok=deleted');
      return true;
    }

    /* ── Coming-soon toggle, straight from the properties list ──
       The mirror of the development switch, for a single stand that has been
       announced but is not on sale yet. */
    if (standComingSoonMatch) {
      if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

      const standId = Number(standComingSoonMatch[1]);
      const stand = await admin.standById(standId);
      if (!stand) return h.send(res, 404, 'Not found'), true;

      const comingSoon = String(body.comingSoon || '') === '1';
      await admin.setPropertyComingSoon(standId, comingSoon);

      await audit('stand_coming_soon', 'success', {
        userId: user.id, detail: `${stand.stand_number} -> ${comingSoon ? 'coming soon' : 'on sale'}`, ip
      });
      h.redirect(res, '/admin/properties?ok=comingsoon');
      return true;
    }

    /* ── Save an existing property ── */
    if (standEditMatch && method === 'POST') {
      const standId = Number(standEditMatch[1]);
      const stand = await admin.standById(standId);
      if (!stand) return h.send(res, 404, 'Not found'), true;

      const form = readPropertyForm(body, projects);
      const clash = await admin.standNumberTaken(form.value.standNumber, standId);
      if (clash) {
        form.errors.push(`Stand number ${form.value.standNumber} is already used by a property in `
          + `${clash.project_name}. Every property needs its own stand number.`);
      }

      if (form.errors.length) {
        h.sendHtml(res, 200, await views.adminLayout({
          title: `${stand.stand_number} — property`, active: '/admin/properties', user, csrf,
          body: views.renderPropertyEdit({
            stand, projects, user, csrf, error: form.errors.join(' ')
          })
        }));
        return true;
      }

      await admin.updateStand(standId, form.value);
      await audit('stand_update', 'success', {
        userId: user.id, detail: `${form.value.standNumber} (${standId})`, ip
      });
      h.redirect(res, `/admin/properties/${standId}?ok=saved`);
      return true;
    }

    /* ── Add ──
       Deliberately before the GET guard: this is a POST to the list URL. */
    if (pathname === '/admin/properties' && method === 'POST') {
      const form = readPropertyForm(body, projects);
      const clash = await admin.standNumberTaken(form.value.standNumber, 0);
      if (clash) {
        form.errors.push(`Stand number ${form.value.standNumber} is already used by a property in `
          + `${clash.project_name}. Every property needs its own stand number.`);
      }

      if (form.errors.length) {
        h.sendHtml(res, 200, await views.adminLayout({
          title: 'Properties', active: '/admin/properties', user, csrf,
          body: views.renderProperties({
            stands: await admin.standsForAdmin(), projects, user, csrf, error: form.errors.join(' ')
          })
        }));
        return true;
      }

      const id = await admin.createStand(form.value);
      await audit('stand_add', 'success', {
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
      const stand = await admin.standById(standId);
      if (!stand) return h.send(res, 404, 'Not found'), true;

      await audit('admin_view', 'success', { userId: user.id, detail: `stand ${standId}`, ip });
      h.sendHtml(res, 200, await views.adminLayout({
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
    await audit('admin_view', 'success', { userId: user.id, detail: 'properties', ip });
    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Properties', active: '/admin/properties', user, csrf,
      body: views.renderProperties({
        stands: await admin.standsForAdmin(), projects, user, csrf,
        notice: url.searchParams.get('ok') === 'deleted' ? 'Property deleted.'
          : url.searchParams.get('ok') === 'comingsoon'
            ? 'Coming-soon flag updated. The website now reflects this.' : '',
        error: url.searchParams.get('error') || ''
      })
    }));
    return true;
  }

  /* ── Leads ── */
  if (pathname === '/admin/leads') {
    if (method === 'POST') {
      const fullName = String(body.fullName || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const phone = String(body.phone || '').trim().slice(0, 40);
      const email = String(body.email || '').trim().slice(0, 160);
      const source = String(body.source || '').trim().slice(0, 60);
      const budget = String(body.budget || '').trim().slice(0, 60);

      /* Empty means unassigned, which is a valid state — a lead can sit
         unowned until someone picks it up. */
      const rawAgent = String(body.assignedAgentId || '').trim();
      const assignedAgentId = rawAgent ? Number.parseInt(rawAgent, 10) : null;

      /* Optional: which development they are interested in. Empty means not
         known yet, and the conversion then offers every free stand. */
      const rawProject = String(body.projectId || '').trim();
      const projectId = rawProject ? Number.parseInt(rawProject, 10) : null;

      const refuse = async (message, typed = {}) => {
        h.sendHtml(res, 200, await views.adminLayout({
          title: 'Leads', active: '/admin/leads', user, csrf,
          body: views.renderLeads({
            leads: await leads.all(), agents: await agents.list(),
            projects: await admin.projectsWithCounts(),
            user, csrf, error: message, values: typed,
            readOnly: getEffectiveRole(user) !== 'admin'
          })
        }));
      };

      /* Everything typed so far, so a refused submission comes back filled in. */
      const typed = { fullName, phone, email, source, budget, projectId, assignedAgentId };

      if (fullName.length < 2) { await refuse('Please enter the lead\'s name.', typed); return true; }
      if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
        await refuse('That does not look like a valid email address.', typed);
        return true;
      }
      if (assignedAgentId && !(await agents.list()).some((a) => a.id === assignedAgentId)) {
        await refuse('Please choose an agent from the list.', typed);
        return true;
      }

      /* Duplicate guard. A blank phone is allowed through — two leads with no
         number cannot be told apart, and SQLite treats NULLs as distinct. */
      if (phone) {
        const existing = await findLeadByPhone(phone);
        if (existing) {
          await refuse(
            `A lead with this phone number already exists (Assigned to: ${existing.agent_name || 'Unassigned'}).`,
            typed);
          return true;
        }
      }

      const id = await leads.create({
        fullName, phone, email, source, budget, projectId, assignedAgentId,
        /* Marks the lead as office-filed. The staff dashboard shows these in
           red, so an agent can tell an approach that was handed to them from
           one they found themselves. */
        createdBy: 'admin'
      });
      await audit('lead_create', 'success', {
        userId: user.id, detail: `lead ${id} (${fullName})`, ip
      });
      return h.redirect(res, '/admin/leads?ok=added'), true;
    }

    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    await audit('admin_view', 'success', { userId: user.id, detail: 'leads', ip });
    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Leads', active: '/admin/leads', user, csrf,
      body: views.renderLeads({
        leads: await leads.all(),
        agents: await agents.list(),
        projects: await admin.projectsWithCounts(),
        user, csrf,
        /* A form the router would refuse is worse than no form, so the view is
           told whether this role may actually post it. */
        readOnly: getEffectiveRole(user) !== 'admin',
        notice: url.searchParams.get('ok') === 'added' ? 'Lead added.' : ''
      })
    }));
    return true;
  }

  /* ── Leads: one lead ──
     Read, update and reassign. Unlike the staff page this is the office view:
     the budget is editable and the lead can be handed to another agent. */
  const leadDetailMatch = pathname.match(/^\/admin\/leads\/(\d+)$/);
  if (leadDetailMatch) {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const leadId = Number(leadDetailMatch[1]);
    const lead = await leads.byId(leadId);

    if (!lead) {
      h.sendHtml(res, 404, await views.adminLayout({
        title: 'Not found', active: '/admin/leads', user, csrf,
        body: '<section class="container inner-page"><h1>Lead not found</h1><p><a class="btn primary" href="/admin/leads">Back to leads</a></p></section>'
      }));
      return true;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    /* The row's agent_name comes from the list query; a single-lead lookup does
       not join agents, so it is filled in here for the header. */
    const owner = lead.assigned_agent_id
      ? (await agents.list()).find((a) => a.id === lead.assigned_agent_id)
      : null;

    await audit('admin_view', 'success', {
      userId: user.id, detail: `lead ${leadId}`, ip
    });

    h.sendHtml(res, 200, await views.adminLayout({
      title: lead.full_name, active: '/admin/leads', user, csrf,
      body: views.renderAdminLeadDetail({
        lead: { ...lead, agent_name: owner ? owner.name : null },
        notes: await leadNotes.forLead(leadId),
        agents: await agents.list(),
        availableStands: await admin.availableStands(lead.project_id),
        user, csrf,
        readOnly: getEffectiveRole(user) !== 'admin',
        notice: url.searchParams.get('ok') === 'updated' ? 'Lead updated.' : '',
        error: url.searchParams.get('error') || ''
      })
    }));
    return true;
  }

  /* ── Leads: convert to client ──
     Creates the portal account, links the stand and closes the lead, all in one
     transaction inside admin.convertLeadToClient. */
  const leadConvertMatch = pathname.match(/^\/admin\/leads\/(\d+)\/convert$/);
  if (leadConvertMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const leadId = Number(leadConvertMatch[1]);
    const lead = await leads.byId(leadId);

    if (!lead) {
      h.sendHtml(res, 404, await views.adminLayout({
        title: 'Not found', active: '/admin/leads', user, csrf,
        body: '<section class="container inner-page"><h1>Lead not found</h1><p><a class="btn primary" href="/admin/leads">Back to leads</a></p></section>'
      }));
      return true;
    }

    /* Re-renders the lead page with the reason, so the admin stays where they
       were instead of being bounced to a list. */
    const refuse = async (message) => {
      const owner = lead.assigned_agent_id
        ? (await agents.list()).find((a) => a.id === lead.assigned_agent_id)
        : null;
      h.sendHtml(res, 400, await views.adminLayout({
        title: lead.full_name, active: '/admin/leads', user, csrf,
        body: views.renderAdminLeadDetail({
          lead: { ...lead, agent_name: owner ? owner.name : null },
          notes: await leadNotes.forLead(leadId),
          agents: await agents.list(),
          availableStands: await admin.availableStands(lead.project_id),
          user, csrf, error: message,
          readOnly: getEffectiveRole(user) !== 'admin'
        })
      }));
    };

    const standId = Number.parseInt(String(body.standId || ''), 10);
    const cents = parseMoneyToCents(body.price);

    if (!Number.isInteger(standId) || standId <= 0) {
      await refuse('Please choose a stand.'); return true;
    }
    if (cents === null) {
      await refuse('Purchase price must be a positive amount, for example 5500 or 5500.00.');
      return true;
    }

    const result = await admin.convertLeadToClient(leadId, standId, cents, lead.assigned_agent_id);

    if (!result.ok) {
      const reasons = {
        leadNotFound: 'That lead no longer exists.',
        alreadyWon: 'This lead has already been converted.',
        standNotFound: 'That stand no longer exists.',
        standTaken: 'That stand has just been taken by someone else. Choose another.'
      };
      await refuse(reasons[result.reason] || 'That conversion could not be completed.');
      return true;
    }

    await audit('lead_convert', 'success', {
      userId: user.id,
      detail: `lead ${leadId} (${lead.full_name}) -> client ${result.clientId} (${result.clientNumber})`, ip
    });

    /* Rendered, not redirected. The generated password has to be shown exactly
       once, and putting it in a redirect URL would write it into the browser
       history, the Referer header and the server access log. Same approach as
       the client password reset. */
    await sendClientPage(res, h, result.clientId, {
      user, csrf,
      notice: `Lead converted successfully. Client portal account created. Password: ${result.password}`,
      generatedPassword: result.password
    });
    return true;
  }

  /* ── Leads: update one ──
     The admin can edit any lead, whoever owns it. */
  const leadUpdateMatch = pathname.match(/^\/admin\/leads\/(\d+)\/update$/);
  if (leadUpdateMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const leadId = Number(leadUpdateMatch[1]);
    const fields = readLeadUpdate(body);

    /* Reassignment is admin-only, so it is read here rather than in
       readLeadUpdate — the staff route must never see it. An empty value means
       "unassign", which is a real state, so it maps to null rather than being
       dropped. */
    const rawAgent = String(body.assignedAgentId || '').trim();
    const assignedAgentId = rawAgent ? Number.parseInt(rawAgent, 10) : null;

    if (rawAgent && !(await agents.list()).some((a) => a.id === assignedAgentId)) {
      return h.redirect(res, `/admin/leads/${leadId}?error=${encodeURIComponent('Please choose an agent from the list.')}`), true;
    }

    const ok = await leads.update(leadId, { ...fields, assignedAgentId });

    if (!ok) {
      h.sendHtml(res, 404, await views.adminLayout({
        title: 'Not found', active: '/admin/leads', user, csrf,
        body: '<section class="container inner-page"><h1>Lead not found</h1><p><a class="btn primary" href="/admin/leads">Back to leads</a></p></section>'
      }));
      return true;
    }

    await audit('lead_update', 'success', {
      userId: user.id, detail: `lead ${leadId} (${fields.status})`, ip
    });
    return h.redirect(res, `/admin/leads/${leadId}?ok=updated`), true;
  }

  /* ── Staff (sales agents) ──
     Agents are not clients: they never appear in the clients list, and they
     sign in at /staff/login with their own cookie and session table. This page
     is the office side of that — who exists, and who can get in. */
  /* ── Staff ──
     Active staff unless “Show archived” is asked for. One helper builds the
     view so a new call site cannot forget one of the two lists, or show the
     wrong side of the archive. */
  const staffView = async ({ showArchived = false, ...rest } = {}) => views.renderStaff({
    agents: await agents.listByActive(!showArchived),
    accounts: await users.staffAccounts(showArchived),
    user, csrf, showArchived, ...rest
  });

  /**
   * Editing, archiving and password resets are the Administrator's alone.
   *
   * Called at the top of each route, before any work. Hiding the buttons is
   * convenience; this is the control — it refuses a guessed URL and a hand-made
   * POST the same way.
   *
   * Returns true when it has already answered the request.
   */
  const refusedByRole = async () => {
    const role = getEffectiveRole(user);
    if (role === 'admin') return false;

    await audit('admin_access', 'denied', {
      userId: user.id, detail: `staff management as ${role} at ${method} ${pathname}`, ip
    });

    /* The label comes from a fixed table, so nothing here needs escaping — and
       admin.js deliberately does not import esc. */
    h.sendHtml(res, 403, await views.adminLayout({
      title: 'Forbidden', active: '/admin', user, csrf,
      body: `  <section class="container inner-page">
    <span class="eyebrow dark">FORBIDDEN</span>
    <h1>Not available to your role</h1>
    <p>Managing other people's accounts is limited to an Administrator. You are
      signed in as ${ROLE_LABEL[role] || 'an unknown role'}.</p>
    <p><a class="btn primary" href="/admin/staff">Back to staff</a></p>
  </section>`
    }));
    return true;
  };

  if (pathname === '/admin/staff') {
    if (method === 'POST') {
      const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const email = String(body.email || '').trim().slice(0, 160);
      const phone = String(body.phone || '').trim().slice(0, 40);
      const role = String(body.role || 'agent').trim().toLowerCase();

      /* 'agent' lives in the agents table; everything else is a users row. The
         two are different tables on purpose — see db.js — so the choice is made
         here rather than in one shared insert. */
      const PANEL_ROLES = ['admin', 'ceo', 'md', 'finance', 'hr'];
      const isAgent = role === 'agent';

      const refuse = async (message) => {
        h.sendHtml(res, 200, await views.adminLayout({
          title: 'Staff', active: '/admin/staff', user, csrf,
          body: await staffView({
            user, csrf, error: message
          })
        }));
      };

      if (name.length < 2) { await refuse('Please enter the agent\'s name.'); return true; }
      if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
        await refuse('That does not look like a valid email address.');
        return true;
      }
      if (!isAgent && !PANEL_ROLES.includes(role)) {
        await refuse('Please choose a role from the list.');
        return true;
      }
      if (isAgent && await agents.nameTaken(name)) {
        await refuse(`An agent called "${name}" already exists.`);
        return true;
      }

      /* The same generator and the same scrypt hash as every other login in
         the system — a staff password is not a second class of credential. */
      const password = generatePassword(20);

      if (isAgent) {
        const id = await agents.create({
          name, email, phone, passwordHash: await auth.hashPassword(password)
        });
        await audit('agent_create', 'success', {
          userId: user.id, detail: `agent ${id} (${name})`, ip
        });

        /* Rendered, not redirected. The password has to be shown exactly once,
           and a redirect would put it in the browser history. */
        h.sendHtml(res, 200, await views.adminLayout({
          title: 'Staff', active: '/admin/staff', user, csrf,
          body: await staffView({
            user, csrf,
            notice: `${name} added.`,
            generatedPassword: password,
            generatedFor: name
          })
        }));
        return true;
      }

      /* A panel account. users.client_number is UNIQUE, so the next free number
         for this role's prefix is picked first. */
      const prefix = PANEL_ROLE_PREFIX[role];
      const clientNumber = await nextStaffNumber(prefix);

      /* The users table cannot hold ceo/finance/hr — its CHECK still allows only
         client, admin and manager, and the rebuild keeps failing on foreign
         keys. Those roles are saved as 'admin' and resolved back by
         getEffectiveRole, which reads the email address and the staff-ID
         prefix. Same arrangement the edit route uses. */
      /* Every role the users table cannot hold is stored as 'admin'. 'manager' is
      in the list because the live CHECK allows only client and admin — the
      manager value was rejected there too, which is the error the edit form was
      throwing. What the office picked is resolved by getEffectiveRole. */
      const STORED_ROLE = {
        ceo: 'admin', md: 'admin', manager: 'admin', finance: 'admin', hr: 'admin'
      };
      const storedRole = STORED_ROLE[role] || role;
      const substituted = storedRole !== role;

      try {
        await users.insert({
          clientNumber,
          fullName: name,
          email: email || null,
          role: storedRole,
          passwordHash: await auth.hashPassword(password)
        });
      } catch (err) {
        /* Belt and braces: if the substitution above ever misses a role the
           CHECK still rejects, say so instead of throwing a raw 500. */
        if (/CHECK constraint failed/i.test(String(err.message))) {
          await refuse(
            `The database does not accept the "${role}" role yet. Its users table still `
            + `allows only client, admin and manager — run scripts/migrate-roles.js `
            + `first, then add this person again. "${name}" was NOT created.`);
          return true;
        }
        throw err;
      }

      await audit('staff_user_create', 'success', {
        userId: user.id,
        detail: `user ${clientNumber} (${name}, ${role}${substituted ? ' stored as admin' : ''})`, ip
      });

      /* Report what actually took effect, not what was asked for: the role is
         only real if the email or the staff ID identifies it. */
      let notice = `${name} added as ${ROLE_LABEL[role]} (${clientNumber}).`;
      if (substituted) {
        const row = await users.byClientNumber(clientNumber);
        const actual = getEffectiveRole(row);
        notice = actual === role
          ? `${name} added as ${ROLE_LABEL[role]} (${clientNumber}).`
          : `${name} was added, but their access is Administrator, not ${ROLE_LABEL[role]}. `
            + `Neither their email nor their staff ID (${clientNumber}) identifies that role — `
            + `give them a ${role} address to fix it.`;
      }

      h.sendHtml(res, 200, await views.adminLayout({
        title: 'Staff', active: '/admin/staff', user, csrf,
        body: await staffView({
          user, csrf,
          notice,
          generatedPassword: password,
          generatedFor: name
        })
      }));
      return true;
    }

    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    await audit('admin_view', 'success', { userId: user.id, detail: 'staff', ip });

    const staffUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const showArchived = staffUrl.searchParams.get('show') === 'archived';

    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Staff', active: '/admin/staff', user, csrf,
      body: await staffView({ showArchived })
    }));
    return true;
  }

  /* ── Staff: reset a password ── */
  const agentResetMatch = pathname.match(/^\/admin\/staff\/(\d+)\/reset-password$/);
  if (agentResetMatch) {
    if (await refusedByRole()) return true;
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const agentId = Number(agentResetMatch[1]);
    const agent = (await agents.list()).find((a) => a.id === agentId);

    if (!agent) {
      h.sendHtml(res, 404, await views.adminLayout({
        title: 'Not found', active: '/admin/staff', user, csrf,
        body: '<section class="container inner-page"><h1>Agent not found</h1><p><a class="btn primary" href="/admin/staff">Back to staff</a></p></section>'
      }));
      return true;
    }

    const password = generatePassword(20);
    await agents.setPassword(agentId, await auth.hashPassword(password));

    /* A new password must end every session the old one had opened, exactly as
       it does for a client or an admin. */
    await staffSessions.destroyAllForAgent(agentId);

    await audit('agent_password_reset', 'success', {
      userId: user.id, detail: `agent ${agentId} (${agent.name})`, ip
    });

    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Staff', active: '/admin/staff', user, csrf,
      body: await staffView({
        user, csrf,
        notice: `Password reset for ${agent.name}.`,
        generatedPassword: password,
        generatedFor: agent.name
      })
    }));
    return true;
  }

  /* ── Staff: reset a panel account's password ──
     A separate route from the agent one because it writes to `users`, which has
     its own id sequence. Spelled out in the path rather than prefixed, so the
     two resets cannot be confused. */
  const userResetMatch = pathname.match(/^\/admin\/staff\/user\/(\d+)\/reset-password$/);

  if (userResetMatch) {
    if (await refusedByRole()) return true;
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const accountId = Number(userResetMatch[1]);
    const account = await users.byId(accountId);

    if (!account || account.role === 'client') {
      h.sendHtml(res, 404, await views.adminLayout({
        title: 'Not found', active: '/admin/staff', user, csrf,
        body: '<section class="container inner-page"><h1>Account not found</h1><p><a class="btn primary" href="/admin/staff">Back to staff</a></p></section>'
      }));
      return true;
    }

    const password = generatePassword(20);
    await users.setPassword(accountId, await auth.hashPassword(password));

    /* A new password must end every session the old one opened. */
    await sessions.destroyAllForUser(accountId);

    await audit('staff_user_password_reset', 'success', {
      userId: user.id, detail: `user ${accountId} (${account.full_name})`, ip
    });

    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Staff', active: '/admin/staff', user, csrf,
      body: await staffView({
        user, csrf,
        notice: `Password reset for ${account.full_name}.`,
        generatedPassword: password,
        generatedFor: account.full_name
      })
    }));
    return true;
  }

  /* ── Staff: edit / archive / restore ──
     The ref is "a-5" or "u-5": agents and users have independent id sequences,
     so a bare number would be ambiguous and could act on the wrong record. */
  const staffRefMatch = pathname.match(/^\/admin\/staff\/([au])-(\d+)\/(edit|archive|restore)$/);

  if (staffRefMatch) {
    if (await refusedByRole()) return true;
    const kind = staffRefMatch[1] === 'a' ? 'agent' : 'user';
    const recordId = Number(staffRefMatch[2]);
    const action = staffRefMatch[3];

    const backToStaff = async (message, isError = false) => h.sendHtml(res, 200,
      await views.adminLayout({
        title: 'Staff', active: '/admin/staff', user, csrf,
        body: await staffView(isError ? { error: message } : { notice: message })
      }));

    if (action === 'edit') {
      const record = kind === 'agent'
        ? await agents.byId(recordId)
        : await users.byId(recordId);

      if (!record) {
        h.sendHtml(res, 404, await views.adminLayout({
          title: 'Not found', active: '/admin/staff', user, csrf,
          body: '<section class="container inner-page"><h1>Staff member not found</h1><p><a class="btn primary" href="/admin/staff">Back to staff</a></p></section>'
        }));
        return true;
      }

      if (method === 'GET') {
        h.sendHtml(res, 200, await views.adminLayout({
          title: `Edit ${kind === 'agent' ? record.name : record.full_name}`,
          active: '/admin/staff', user, csrf,
          body: views.renderStaffEdit({ kind, record, user, csrf })
        }));
        return true;
      }

      if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

      const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const email = String(body.email || '').trim().slice(0, 160);

      if (name.length < 2) {
        h.sendHtml(res, 400, await views.adminLayout({
          title: 'Edit', active: '/admin/staff', user, csrf,
          body: views.renderStaffEdit({
            kind, record, user, csrf, error: 'Please enter a name.'
          })
        }));
        return true;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
        h.sendHtml(res, 400, await views.adminLayout({
          title: 'Edit', active: '/admin/staff', user, csrf,
          body: views.renderStaffEdit({
            kind, record, user, csrf, error: 'That does not look like a valid email address.'
          })
        }));
        return true;
      }

      if (kind === 'agent') {
        const phone = String(body.phone || '').trim().slice(0, 40);
        await agents.update(recordId, { name, email, phone });
        await audit('agent_update', 'success', {
          userId: user.id, detail: `agent ${recordId} (${name})`, ip
        });
        await backToStaff(`${name} updated.`);
        return true;
      }

      /* Panel accounts only. A client card must never be re-roled from here.

         'manager' is not accepted. It used to be, and because the database
         stores it as 'admin' with nothing to mark it, choosing it granted full
         administrator rights. Refusing it here closes the hole for a hand-made
         POST as well as for the form, which no longer offers it. */
      const role = String(body.role || '').trim().toLowerCase();
      const allowed = ['admin', 'ceo', 'md', 'finance', 'hr'];
      if (!allowed.includes(role)) {
        h.sendHtml(res, 400, await views.adminLayout({
          title: 'Edit', active: '/admin/staff', user, csrf,
          body: views.renderStaffEdit({
            kind, record, user, csrf, error: 'Please choose a role from the list.'
          })
        }));
        return true;
      }

      /* Never let the signed-in admin demote or re-role their own account by
         accident — that is how an office locks itself out. */
      if (recordId === user.id && role !== getEffectiveRole(user)) {
        h.sendHtml(res, 400, await views.adminLayout({
          title: 'Edit', active: '/admin/staff', user, csrf,
          body: views.renderStaffEdit({
            kind, record, user, csrf,
            error: 'You cannot change your own role. Ask another administrator to do it.'
          })
        }));
        return true;
      }

      /* The users table cannot hold ceo/finance/hr — its CHECK still allows only
         client, admin and manager, and the rebuild keeps failing on foreign
         keys. Those roles are therefore stored as 'admin' and resolved back to
         the intended role by getEffectiveRole, which reads the email address
         and the CEO-/FIN-/HR- staff-ID prefix.

         The consequence worth understanding: what the office picks is an
         *intent* recorded outside the role column. If neither the address nor
         the staff ID identifies the role, the account simply stays a full
         administrator — so the notice below says which route took effect. */
      /* Every role the users table cannot hold is stored as 'admin'. 'manager' is
      in the list because the live CHECK allows only client and admin — the
      manager value was rejected there too, which is the error the edit form was
      throwing. What the office picked is resolved by getEffectiveRole. */
      const STORED_ROLE = {
        ceo: 'admin', md: 'admin', manager: 'admin', finance: 'admin', hr: 'admin'
      };
      const storedRole = STORED_ROLE[role] || role;
      const substituted = storedRole !== role;

      try {
        await users.updateProfile(recordId, { fullName: name, email, role: storedRole });
      } catch (err) {
        if (/CHECK constraint failed/i.test(String(err.message))) {
          h.sendHtml(res, 400, await views.adminLayout({
            title: 'Edit', active: '/admin/staff', user, csrf,
            body: views.renderStaffEdit({
              kind, record, user, csrf,
              error: `The database does not accept the "${role}" role yet. `
                + 'Run scripts/migrate-roles.js first. Nothing was changed.'
            })
          }));
          return true;
        }
        throw err;
      }

      await audit('staff_user_update', 'success', {
        userId: user.id,
        detail: `user ${recordId} (${name}, ${role}${substituted ? ' stored as admin' : ''})`, ip
      });

      /* Say plainly which mechanism decided their access, because only one of
         the two actually narrows the account. */
      if (substituted) {
        const row = await users.byId(recordId);
        const actual = getEffectiveRole(row);
        if (actual === role) {
          await backToStaff(`${name} updated. ${role.toUpperCase()} access is in effect.`);
        } else {
          await backToStaff(
            `${name} saved, but their access is still Administrator. The database cannot store `
            + `"${role}", and neither their email nor their staff ID (${row.client_number}) `
            + `identifies that role. Give them a ${role} address, or a staff ID beginning `
            + `${role === 'ceo' ? 'CEO-' : role === 'finance' ? 'FIN-' : 'HR-'}, then save again.`,
            true);
        }
        return true;
      }

      await backToStaff(`${name} updated.`);
      return true;
    }

    /* archive / restore */
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const label = kind === 'agent'
      ? (await agents.byId(recordId) || {}).name
      : (await users.byId(recordId) || {}).full_name;

    if (!label) {
      h.sendHtml(res, 404, await views.adminLayout({
        title: 'Not found', active: '/admin/staff', user, csrf,
        body: '<section class="container inner-page"><h1>Staff member not found</h1><p><a class="btn primary" href="/admin/staff">Back to staff</a></p></section>'
      }));
      return true;
    }

    /* Archiving yourself would end your own access mid-session. */
    if (kind === 'user' && recordId === user.id && action === 'archive') {
      await backToStaff('You cannot archive your own account.', true);
      return true;
    }

    const done = action === 'archive'
      ? (kind === 'agent' ? await agents.archive(recordId) : await users.archiveStaff(recordId))
      : (kind === 'agent' ? await agents.restore(recordId) : await users.restoreStaff(recordId));

    if (!done) {
      await backToStaff('That change could not be made.', true);
      return true;
    }

    await audit(`staff_${action}`, 'success', {
      userId: user.id, detail: `${kind} ${recordId} (${label})`, ip
    });

    await backToStaff(action === 'archive'
      ? `${label} archived. Their records are untouched.`
      : `${label} restored.`);
    return true;
  }

  /* ── Activity logs ──
     Every agent's updates for one day, optionally narrowed to one agent and
     sortable. The sort value is read here and passed through staffLogs.recent,
     which will only ever accept 'ASC' or 'DESC' — the SQL keyword is never built
     from input. */
  if (pathname === '/admin/activity-logs') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const rawAgent = (url.searchParams.get('agent') || '').trim();
    const agentId = rawAgent ? Number.parseInt(rawAgent, 10) : null;
    const sortOrder = url.searchParams.get('sort') === 'asc' ? 'ASC' : 'DESC';

    /* Defaults to today. todayIso() rather than new Date().toISOString(): the
       latter is the UTC date, which in Harare is still yesterday until 02:00, so
       an early-morning visit would open on the wrong day and look empty.
       A date that does not parse falls back to today rather than to "everything",
       so a hand-edited query string cannot turn the page back into an endless
       list. */
    const today = todayIso();
    const requested = (url.searchParams.get('date') || '').trim();
    const date = utcRangeForLocalDate(requested) ? requested : today;

    await audit('admin_view', 'success', { userId: user.id, detail: 'activity logs', ip });

    h.sendHtml(res, 200, await views.adminLayout({
      title: 'Activity Logs', active: '/admin/activity-logs', user, csrf,
      body: views.renderActivityLogs({
        logs: await staffLogs.recent({ sortOrder, agentId, date }),
        agents: await agents.list(),
        user, csrf,
        agentId, sortOrder, date, today,
        notice: url.searchParams.get('ok') === 'commented' ? 'Comment added.' : '',
        error: url.searchParams.get('error') || ''
      })
    }));
    return true;
  }

  /* ── Activity logs: comment on one entry ──
     The office's reply to an agent's update. Managers reach this too: activity
     logs are inside their remit, and /admin/activity-logs/5/comment matches the
     prefix allowlist. */
  const logCommentMatch = pathname.match(/^\/admin\/activity-logs\/(\d+)\/comment$/);
  if (logCommentMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const logId = Number(logCommentMatch[1]);

    /* Send them back to the day, agent and order they were looking at. Each
       value is re-validated rather than trusted, because these arrive as hidden
       fields and are trivially editable. */
    const params = new URLSearchParams();
    const backDate = String(body.date || '').trim();
    if (utcRangeForLocalDate(backDate)) params.set('date', backDate);
    const backAgent = String(body.agent || '').trim();
    if (/^\d+$/.test(backAgent)) params.set('agent', backAgent);
    if (String(body.sort || '') === 'asc') params.set('sort', 'asc');

    const text = String(body.commentText || '').replace(/\s+/g, ' ').trim().slice(0, 1000);

    if (text.length < 2) {
      params.set('error', 'Please write a comment before saving.');
      return h.redirect(res, `/admin/activity-logs?${params}`), true;
    }

    await staffLogs.addLogComment(logId, user.id, text);
    await audit('log_comment', 'success', {
      userId: user.id, detail: `log ${logId}`, ip
    });

    params.set('ok', 'commented');
    return h.redirect(res, `/admin/activity-logs?${params}`), true;
  }

  /* ── Projects ── */
  if (pathname === '/admin/projects') {
    const projects = await admin.projectsWithCounts();

    if (method === 'POST') {
      const form = readProjectForm(body);
      if (await admin.projectNameTaken(form.value.name, 0)) {
        form.errors.push(`A development called "${form.value.name}" already exists.`);
      }

      if (form.errors.length) {
        h.sendHtml(res, 200, await views.adminLayout({
          title: 'Projects', active: '/admin/projects', user, csrf,
          body: views.renderProjects({ projects, user, csrf, error: form.errors.join(' ') })
        }));
        return true;
      }

      const id = await admin.createProject(form.value);
      await audit('project_add', 'success', { userId: user.id, detail: `${form.value.name} (${id})`, ip });
      h.redirect(res, `/admin/projects/${id}?ok=created`);
      return true;
    }

    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    await audit('admin_view', 'success', { userId: user.id, detail: 'projects', ip });

    /* Messages are composed from validated codes rather than echoed back from
       the query string, so a crafted link cannot print its own wording here. */
    const okCode = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      .searchParams.get('ok') || '';
    const removed = Number(new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      .searchParams.get('n') || 0);

    const notice = okCode === 'soldout'
      ? 'Availability updated. The website now reflects this.'
      : okCode === 'comingsoon'
        ? 'Coming-soon flag updated. The website now reflects this.'
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

    h.sendHtml(res, 200, await views.adminLayout({
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
    const project = await admin.projectById(projectId);
    if (!project) return h.send(res, 404, 'Project not found'), true;

    const result = await admin.deleteProject(projectId);

    if (!result.ok) {
      await audit('project_delete', 'denied', {
        userId: user.id, detail: `${project.name}: ${result.reason}`, ip
      });
      h.redirect(res, `/admin/projects?error=${result.reason}`
        + `&stands=${encodeURIComponent(result.stands.join(','))}`);
      return true;
    }

    await audit('project_delete', 'success', {
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
    const project = await admin.projectById(projectId);
    if (!project) return h.send(res, 404, 'Not found'), true;

    const soldOut = String(body.soldOut || '') === '1';
    await admin.setProjectSoldOut(projectId, soldOut);

    await audit('project_sold_out', 'success', {
      userId: user.id, detail: `${project.name} -> ${soldOut ? 'sold out' : 'selling'}`, ip
    });
    h.redirect(res, '/admin/projects?ok=soldout');
    return true;
  }

  /* ── Coming-soon toggle, from the same list ──
     The mirror of the sold-out switch: a development that has been announced
     but is not on sale yet. Where both flags end up set, coming soon wins on
     the website, so there is no need to clear the other one here. */
  const comingSoonMatch = pathname.match(/^\/admin\/projects\/(\d+)\/coming-soon$/);
  if (comingSoonMatch) {
    if (method !== 'POST') return h.send(res, 405, 'Method not allowed'), true;

    const projectId = Number(comingSoonMatch[1]);
    const project = await admin.projectById(projectId);
    if (!project) return h.send(res, 404, 'Not found'), true;

    const comingSoon = String(body.comingSoon || '') === '1';
    await admin.setProjectComingSoon(projectId, comingSoon);

    await audit('project_coming_soon', 'success', {
      userId: user.id, detail: `${project.name} -> ${comingSoon ? 'coming soon' : 'on sale'}`, ip
    });
    h.redirect(res, '/admin/projects?ok=comingsoon');
    return true;
  }

  const projectMatch = pathname.match(/^\/admin\/projects\/(\d+)$/);
  if (projectMatch) {
    const projectId = Number(projectMatch[1]);
    const base = await admin.projectById(projectId);

    if (!base) {
      h.sendHtml(res, 404, await views.adminLayout({
        title: 'Not found', active: '/admin/projects', user, csrf,
        body: '<section class="container inner-page"><h1>Project not found</h1><p><a class="btn primary" href="/admin/projects">Back to projects</a></p></section>'
      }));
      return true;
    }

    /* The counts-bearing row, so the page can show the property breakdown
       without a second query. */
    const project = (await admin.projectsWithCounts()).find((p) => p.id === projectId) || base;

    /* ── Save the development itself: its name and details ── */
    if (method === 'POST') {
      const form = readProjectForm(body);
      if (await admin.projectNameTaken(form.value.name, projectId)) {
        form.errors.push(`Another development is already called "${form.value.name}".`);
      }

      if (form.errors.length) {
        h.sendHtml(res, 200, await views.adminLayout({
          title: project.name, active: '/admin/projects', user, csrf,
          body: views.renderProjectDetail({
            project, stands: await admin.standsForProject(projectId),
            pricing: await admin.pricingFor(projectId),
            steps: await admin.progressSteps(projectId), user, csrf,
            error: form.errors.join(' ')
          })
        }));
        return true;
      }

      await admin.updateProject(projectId, form.value);
      await audit('project_update', 'success', {
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

    await audit('admin_view', 'success', { userId: user.id, detail: `project ${projectId}`, ip });
    h.sendHtml(res, 200, await views.adminLayout({
      title: project.name, active: '/admin/projects', user, csrf,
      body: views.renderProjectDetail({
        project,
        stands: await admin.standsForProject(projectId),
        pricing: await admin.pricingFor(projectId),
        steps: await admin.progressSteps(projectId),
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
    const project = await admin.projectById(projectId);

    if (!project) return h.send(res, 404, 'Project not found'), true;

    /* ── Add ── */
    if (addStepMatch) {
      const label = String(body.label || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (label.length < 2) {
        h.sendHtml(res, 200, await views.adminLayout({
          title: project.name, active: '/admin/projects', user, csrf,
          body: views.renderProjectDetail({
            project, stands: await admin.standsForProject(projectId),
            pricing: await admin.pricingFor(projectId),
            steps: await admin.progressSteps(projectId), user, csrf,
            error: 'Please give the step a label.'
          })
        }));
        return true;
      }

      await admin.addProgressStep(projectId, label, String(body.state || 'pending'));
      await audit('progress_add', 'success', {
        userId: user.id, detail: `${project.name}: ${label}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/projects/${projectId}?ok=added` }), true;
    }

    const stepId = Number(match[2]);
    const exists = (await admin.progressSteps(projectId)).some((s) => s.id === stepId);
    if (!exists) return h.send(res, 404, 'Step not found'), true;

    /* ── Delete ── */
    if (stepDeleteMatch) {
      await admin.deleteProgressStep(stepId);
      await audit('progress_delete', 'success', {
        userId: user.id, detail: `${project.name}: step ${stepId}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/projects/${projectId}?ok=deleted` }), true;
    }

    /* ── Update ── */
    const label = String(body.label || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const state = String(body.state || 'pending');

    if (label.length < 2 || !await admin.setProgressStep(stepId, label, state)) {
      h.sendHtml(res, 200, await views.adminLayout({
        title: project.name, active: '/admin/projects', user, csrf,
        body: views.renderProjectDetail({
          project, stands: await admin.standsForProject(projectId),
          pricing: await admin.pricingFor(projectId),
          steps: await admin.progressSteps(projectId), user, csrf,
          error: 'A step needs a label and a valid state.'
        })
      }));
      return true;
    }

    await audit('progress_update', 'success', {
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
    const project = await admin.projectById(projectId);
    if (!project) return h.send(res, 404, 'Project not found'), true;

    const back = (flag) => h.redirect(res, `/admin/projects/${projectId}?ok=${flag}`);

    if (addPriceMatch) {
      const form = readPricingForm(body);
      if (form.errors.length) {
        h.redirect(res, `/admin/projects/${projectId}?error=${encodeURIComponent(form.errors.join(' '))}`);
        return true;
      }
      await admin.addPricing(projectId, form.value);
      await audit('pricing_add', 'success', {
        userId: user.id, detail: `${project.name}: ${form.value.sizeLabel}`, ip
      });
      return back('priceAdded');
    }

    const priceId = Number(match[2]);
    const row = await admin.pricingById(priceId);
    if (!row || row.project_id !== projectId) return h.send(res, 404, 'Price row not found'), true;

    if (priceDeleteMatch) {
      await admin.deletePricing(priceId);
      await audit('pricing_delete', 'success', {
        userId: user.id, detail: `${project.name}: ${row.size_label}`, ip
      });
      return back('priceDeleted');
    }

    const form = readPricingForm(body);
    if (form.errors.length) {
      h.redirect(res, `/admin/projects/${projectId}?error=${encodeURIComponent(form.errors.join(' '))}`);
      return true;
    }
    await admin.updatePricing(priceId, form.value);
    await audit('pricing_update', 'success', {
      userId: user.id, detail: `${project.name}: ${form.value.sizeLabel}`, ip
    });
    return back('priceSaved');
  }

  /* ── Site content ── */
  if (pathname === '/admin/content') {
    if (method !== 'GET') return h.send(res, 405, 'Method not allowed'), true;

    await audit('admin_view', 'success', { userId: user.id, detail: 'content', ip });
    h.sendHtml(res, 200, await views.adminLayout({
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
      await audit('admin_view', 'success', { userId: user.id, detail: 'settings', ip });
      await sendSettingsPage(res, h, { user, csrf, notice: SETTINGS_FLASH[flag] || '' });
      return true;
    }

    if (method === 'POST') {
      let saved = 0;
      for (const s of contentSchema.SETTINGS) {
        const key = `s:${s.key}`;
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          await content.setSetting(s.key, String(body[key] ?? '').trim().slice(0, 400));
          saved++;
        }
      }
      await audit('settings_update', 'success', { userId: user.id, detail: `${saved} settings`, ip });
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
      await content.setSetting('logo_url', FALLBACK.logo);
      await audit('logo_remove', 'success', { userId: user.id, ip });
      return h.sendHtml(res, 302, '', { Location: '/admin/settings?ok=logoRemoved' }), true;
    }

    const file = files.find((f) => f.name === 'logo');
    const check = validateLogoUpload(file, config.MAX_UPLOAD_BYTES);

    if (!check.ok) {
      await sendSettingsPage(res, h, { user, csrf, error: check.error });
      return true;
    }

    try {
      await fsp.mkdir(logoDir, { recursive: true });
      // Only one custom logo may exist, so replace rather than accumulate.
      await removeCustomLogos(logoDir);
      const filename = 'logo-custom' + check.extension;
      await fsp.writeFile(path.join(logoDir, filename), file.data);
      await content.setSetting('logo_url', 'assets/img/' + filename);
    } catch (err) {
      await audit('logo_update', 'failure', { userId: user.id, detail: String(err.message), ip });
      await sendSettingsPage(res, h, { user, csrf, error: 'The logo could not be saved. Please try again.' });
      return true;
    }

    await audit('logo_update', 'success', {
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

    await audit('admin_view', 'success', { userId: user.id, detail: `content ${pageKey}`, ip });
    await sendContentPage(res, h, pageKey, { user, csrf, notice });
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

      await content.setBlock(pageKey, sectionKey, item, fieldKey, String(value ?? '').slice(0, 4000));
      saved++;
    }

    await audit('content_update', 'success', {
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
      const item = await content.addItem(pageKey, sectionKey);
      await audit('content_add_item', 'success', {
        userId: user.id, detail: `${pageKey}/${sectionKey} item ${item}`, ip
      });
      return h.sendHtml(res, 302, '', { Location: `/admin/content/${pageKey}?ok=added` }), true;
    }

    const item = Number(match[3]);
    await content.deleteItem(pageKey, sectionKey, item);
    await audit('content_delete_item', 'success', {
      userId: user.id, detail: `${pageKey}/${sectionKey} item ${item}`, ip
    });
    return h.sendHtml(res, 302, '', { Location: `/admin/content/${pageKey}?ok=deleted` }), true;
  }

  /* Unknown /admin path */
  h.sendHtml(res, 404, await views.adminLayout({
    title: 'Not found', user, csrf,
    body: '<section class="container inner-page"><h1>Page not found</h1><p><a class="btn primary" href="/admin">Back to overview</a></p></section>'
  }));
  return true;
}

/* Housekeeping for the limiter map; called from index.js on the same timer. */
function sweep() { adminLoginLimiter.sweep(); }

module.exports = { handleAdmin, sweep, isAdmin };
