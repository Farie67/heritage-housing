'use strict';

/* ==========================================================================
   Heritage Housing Projects — application server.

   Built entirely on Node's standard library: node:http, node:sqlite,
   node:crypto, node:fs. There are no npm dependencies, so there is no install
   step, no lockfile to audit, and nothing to break offline.

   Run:  node server/index.js
   ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./config');
const { audit, users, sessions, portal, enquiries, admin, content, db } = require('./db');
const {
  parseCookies, sessionCookie, clearSessionCookie, csrfCookie, newCsrfToken,
  securityHeaders, csrfOk, RateLimiter, STATE_CHANGING
} = require('./security');
const auth = require('./auth');
const views = require('./views');
const adminRoutes = require('./admin');
const publicSite = require('./public-site');
const invoice = require('./invoice');
const { slugify } = require('./format');
const { isMultipart, boundaryFrom, parseMultipart } = require('./multipart');

/* ── MIME types ─────────────────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf'
};

/* ── Small helpers ──────────────────────────────────────────────────────── */

function clientIp(req) {
  if (config.TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body)
    ? body
    : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
}

function sendHtml(res, status, html, headers = {}) {
  send(res, status, html, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

/** Reads a request body into a Buffer, refusing anything oversized. */
function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        // Stop reading, but drain so the socket can still be closed cleanly.
        fail(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  if (contentType && contentType.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

/* ── Rate limiters ──────────────────────────────────────────────────────── */

const loginLimiter = new RateLimiter(config.LOGIN_MAX_ATTEMPTS, config.LOGIN_WINDOW_MS);
const enquiryLimiter = new RateLimiter(config.ENQUIRY_MAX_PER_HOUR, 60 * 60 * 1000);

// Keep the limiters' maps from growing without bound.
setInterval(() => {
  loginLimiter.sweep();
  enquiryLimiter.sweep();
  adminRoutes.sweep();
  sessions.purgeExpired();
}, 10 * 60 * 1000).unref();

/* ── Static files ───────────────────────────────────────────────────────── */

/**
 * Resolves a URL path to a file inside PUBLIC_DIR, or null.
 *
 * The check is against the *resolved* path, so encoded traversal such as
 * %2e%2e%2f is caught after decoding rather than before.
 */
function resolvePublic(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;

  const candidate = path.resolve(config.PUBLIC_DIR, '.' + path.posix.normalize(decoded));
  const root = path.resolve(config.PUBLIC_DIR);

  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  return candidate;
}

async function serveStatic(req, res, urlPath, cookies) {
  let target = resolvePublic(urlPath);
  if (!target) return send(res, 403, 'Forbidden');

  let stat;
  try { stat = await fsp.stat(target); } catch { stat = null; }

  if (stat && stat.isDirectory()) {
    target = path.join(target, 'index.html');
    try { stat = await fsp.stat(target); } catch { stat = null; }
  }

  if (!stat || !stat.isFile()) return false; // not found here — caller decides

  // Never serve dotfiles (.git, .env, editor backups).
  if (path.basename(target).startsWith('.')) return send(res, 403, 'Forbidden');

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
    return res.end();
  }

  const headers = {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'Last-Modified': stat.mtime.toUTCString()
  };

  // Give any HTML page a CSRF cookie so its scripts can echo it back.
  if (ext === '.html' && !cookies[config.CSRF_COOKIE]) {
    headers['Set-Cookie'] = csrfCookie(newCsrfToken());
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();

  await new Promise((resolve) => {
    const stream = fs.createReadStream(target);
    stream.on('error', () => { res.destroy(); resolve(); });
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

/* ── API: authentication ────────────────────────────────────────────────── */

async function handleLogin(req, res, body, ip) {
  const clientNumber = String(body.clientNumber || '').trim().toUpperCase();
  const password = String(body.password || '');

  if (!clientNumber || !password) {
    return sendJson(res, 400, { error: 'Client number and password are required.' });
  }

  const limit = loginLimiter.check(ip);
  if (!limit.allowed) {
    const mins = Math.ceil(limit.retryAfterMs / 60000);
    audit('login', 'rate_limited', { clientNumber, detail: 'per-IP limit', ip });
    return sendJson(res, 429, {
      error: `Too many sign-in attempts. Please try again in ${mins} minute${mins === 1 ? '' : 's'}.`
    }, { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) });
  }

  const result = await auth.signIn(clientNumber, password, {
    ip,
    userAgent: req.headers['user-agent']
  });

  if (!result.ok) {
    // One generic message for every failure mode: the response must not reveal
    // whether the client number exists, is locked, or simply had a bad password.
    const mins = result.retryAfterMs ? Math.ceil(result.retryAfterMs / 60000) : 0;
    const message = result.reason === 'locked'
      ? `This account is temporarily locked after repeated failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
      : 'Invalid client number or password.';

    return sendJson(res, 401, { error: message });
  }

  loginLimiter.reset(ip);
  const token = result.token;

  return sendJson(res, 200, {
    ok: true,
    user: { clientNumber: result.user.clientNumber, fullName: result.user.fullName }
  }, {
    'Set-Cookie': [
      sessionCookie(token, config.SESSION_TTL_MS),
      csrfCookie(newCsrfToken())
    ]
  });
}

async function handleLogout(req, res, user) {
  const cookies = parseCookies(req);
  const token = cookies[config.SESSION_COOKIE];
  auth.destroySession(token);
  audit('logout', 'success', { userId: user ? user.id : null, ip: clientIp(req) });
  return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
}

/* ── API: enquiries ─────────────────────────────────────────────────────── */

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function handleEnquiry(req, res, body, ip, isFormPost) {
  const limit = enquiryLimiter.check(ip);
  if (!limit.allowed) {
    if (isFormPost) return redirect(res, '/contact.html?sent=0');
    return sendJson(res, 429, { error: 'Too many enquiries from this address. Please call the office instead.' });
  }

  const name = cleanText(body.name, 120);
  const phone = cleanText(body.phone, 40);
  const interest = cleanText(body.interest, 60) || 'General enquiry';
  const message = cleanText(body.message, 4000);

  const errors = [];
  if (name.length < 2) errors.push('name');
  if (phone.length < 6) errors.push('phone');
  if (message.length < 10) errors.push('message');

  if (errors.length) {
    if (isFormPost) return redirect(res, '/contact.html?sent=0');
    return sendJson(res, 400, { error: 'Please complete all required fields.', fields: errors });
  }

  enquiries.insert({ name, phone, interest, message, ip });
  audit('enquiry', 'success', { detail: `${interest} from ${name}`, ip });

  if (isFormPost) return redirect(res, '/contact.html?sent=1');
  return sendJson(res, 201, { ok: true });
}

/* ── API: client data ───────────────────────────────────────────────────── */

function buildDashboard(user, csrf) {
  const ownership = portal.ownershipFor(user.id);
  const payments = portal.paymentsFor(user.id);
  const paidTotal = portal.paidTotalFor(user.id);
  const documents = portal.documentsFor(user.id);
  const progress = ownership ? portal.progressFor(ownership.project_id) : [];

  return { ownership, payments, paidTotal, documents, progress, user, csrf };
}

async function handleDocumentDownload(req, res, user, docId) {
  const id = Number.parseInt(docId, 10);
  if (!Number.isInteger(id) || id <= 0) return send(res, 400, 'Bad request');

  // Ownership is part of the query, so one client can never read another's
  // document by guessing an id. A miss is indistinguishable from "not found".
  const doc = portal.documentForUser(id, user.id);
  if (!doc) {
    audit('document_download', 'denied', {
      userId: user.id, detail: `document ${id}`, ip: clientIp(req)
    });
    return send(res, 404, 'Not found');
  }

  const root = path.resolve(config.PRIVATE_DOCS_DIR);
  const filePath = path.resolve(root, doc.stored_name);

  // Belt and braces: stored_name is server-generated, but re-check anyway so a
  // future bad write cannot turn this route into arbitrary file disclosure.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    audit('document_download', 'denied', { userId: user.id, detail: 'path escape', ip: clientIp(req) });
    return send(res, 403, 'Forbidden');
  }

  let stat;
  try { stat = await fsp.stat(filePath); } catch { stat = null; }
  if (!stat || !stat.isFile()) return send(res, 404, 'Not found');

  audit('document_download', 'success', {
    userId: user.id, detail: `${doc.title} (${doc.id})`, ip: clientIp(req)
  });

  const safeName = doc.title.replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 80) || 'document';

  res.writeHead(200, {
    'Content-Type': doc.mime || 'application/octet-stream',
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
}

/* ── Router ─────────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const cookies = parseCookies(req);

    securityHeaders(res, { html: pathname.endsWith('.html') || pathname === '/' });

    const token = cookies[config.SESSION_COOKIE];
    const user = auth.sessionUser(token);

    /* Issue the CSRF cookie once, here, and reuse the same value for the whole
       request. Minting a second token further down would hand the page a token
       that does not match the cookie it was just sent. */
    let csrf = cookies[config.CSRF_COOKIE];
    if (req.method === 'GET' && !csrf && !pathname.startsWith('/api/')) {
      csrf = newCsrfToken();
      res.setHeader('Set-Cookie', csrfCookie(csrf));
    }

    /* Read the body once, before the CSRF check, so that a plain HTML form POST
       with no JavaScript can prove itself with its hidden token field as well
       as with Origin/Referer.

       A multipart upload is kept as a Buffer and never decoded to a string —
       that would corrupt the bytes — and gets a larger ceiling than an
       ordinary form post. */
    let body = {};
    let files = [];
    if (STATE_CHANGING.has(req.method)) {
      const contentType = req.headers['content-type'] || '';
      const upload = isMultipart(contentType);

      const raw = await readBodyBuffer(
        req, upload ? config.MAX_UPLOAD_BYTES : config.MAX_BODY_BYTES);

      if (upload) {
        const parsed = parseMultipart(raw, boundaryFrom(contentType));
        if (parsed.truncated) {
          return sendJson(res, 400, { error: 'That form had too many fields.' });
        }
        body = parsed.fields;
        files = parsed.files;
      } else {
        const parsed = parseBody(raw.toString('utf8'), contentType);
        if (parsed === null) return sendJson(res, 400, { error: 'Malformed request body.' });
        body = parsed;
      }
    }

    /* CSRF — applies to every state-changing request, API or form. */
    if (!csrfOk(req, cookies, req.headers.host, body)) {
      audit('csrf', 'denied', { userId: user ? user.id : null, detail: `${req.method} ${pathname}`, ip });
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 403, { error: 'Request blocked: origin check failed.' });
      }
      return sendHtml(res, 403, views.renderError({
        status: 403, title: 'Request blocked',
        message: 'This request did not come from a trusted origin.'
      }));
    }

    /* ── Health ── */
    if (req.method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }

    /* ── Staff admin area ── */
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      /* `await` matters: without it a rejection inside the admin router escapes
         this try/catch as an unhandled rejection and takes the process down. */
      return await adminRoutes.handleAdmin(req, res, {
        pathname,
        method: req.method,
        cookies,
        user,
        csrf: csrf || cookies[config.CSRF_COOKIE] || '',
        ip,
        body,
        files,
        h: { send, sendHtml, sendJson, redirect }
      });
    }

    /* ── Client portal ── */
    if (pathname === '/dashboard') {
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      if (!user) return redirect(res, '/portal.html');

      const data = buildDashboard(user, csrf || '');
      audit('dashboard_view', 'success', { userId: user.id, ip });

      return sendHtml(res, 200, views.layout({
        title: 'My Heritage — Client Dashboard',
        description: 'Your stand, payment history and project progress.',
        body: views.renderDashboard(data)
      }));
    }

    /* Already signed in? Skip the login form. */
    if (pathname === '/portal.html' && req.method === 'GET' && user) {
      return redirect(res, '/dashboard');
    }

    /* ── Auth API ── */
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      return await handleLogin(req, res, body, ip);
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      return handleLogout(req, res, user);
    }

    /* ── Public enquiry form ── */
    if (pathname === '/api/enquiries' && req.method === 'POST') {
      const isFormPost = !(req.headers['x-csrf-token'] ||
        (req.headers.accept || '').includes('application/json'));
      return await handleEnquiry(req, res, body, ip, isFormPost);
    }

    /* ── Authenticated client API ── */
    if (pathname.startsWith('/api/')) {
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });

      const docMatch = pathname.match(/^\/api\/documents\/(\d+)\/download$/);
      if (docMatch && req.method === 'GET') {
        return await handleDocumentDownload(req, res, user, docMatch[1]);
      }

      const data = buildDashboard(user, csrf || '');

      if (pathname === '/api/me' && req.method === 'GET') {
        return sendJson(res, 200, {
          user: { clientNumber: user.clientNumber, fullName: user.fullName },
          ownership: data.ownership || null
        });
      }
      if (pathname === '/api/payments' && req.method === 'GET') {
        return sendJson(res, 200, {
          payments: data.payments,
          paidTotalCents: data.paidTotal,
          balanceCents: data.ownership
            ? Math.max(data.ownership.purchase_price_cents - data.paidTotal, 0)
            : 0
        });
      }
      if (pathname === '/api/documents' && req.method === 'GET') {
        return sendJson(res, 200, { documents: data.documents });
      }

      /* A client may fetch their own statement, and only their own: the id
         comes from the session, never from the URL. */
      if (pathname === '/api/statement.pdf' && req.method === 'GET') {
        const client = admin.clientById(user.id);
        if (!client) return sendJson(res, 404, { error: 'No account record found.' });

        const pdf = invoice.buildStatementPdf({
          settings: content.settings(),
          client,
          ownership: invoice.ownershipFromClientRow(client),
          payments: admin.paymentsFor(user.id),
          generatedAt: new Date()
        });

        audit('statement_download', 'success', {
          userId: user.id, clientNumber: user.clientNumber, detail: 'by client', ip
        });

        invoice.writePdfResponse(res, pdf, invoice.filenameFor(client));
        return undefined;
      }

      return sendJson(res, 404, { error: 'Unknown endpoint.' });
    }

    /* ── Editable marketing pages, rendered from the database ──
       These take precedence over the exported copies in public/, which exist
       so the site can also be hosted without Node. */
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');

      if (publicSite.isContentPage(file)) {
        const html = publicSite.renderFile(file);
        if (html !== null) {
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end();
          }
          return sendHtml(res, 200, html);
        }
      }

      if (file === 'portal.html') return sendHtml(res, 200, publicSite.renderPortalPage());
    }

    /* ── One individual property, and one development ──
       Both rendered live so an admin edit shows immediately. Addressed by
       stand number and by name-slug rather than by internal id, so the URL
       says what it is and survives a database rebuild. */
    if (req.method === 'GET' || req.method === 'HEAD') {
      const propertyMatch = pathname.match(/^\/property\/([^/]+)\/?$/);
      if (propertyMatch) {
        const stand = admin.standByNumber(decodeURIComponent(propertyMatch[1]));
        if (!stand) return sendHtml(res, 404, publicSite.renderNotFound());

        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end();
        }
        return sendHtml(res, 200, publicSite.renderProperty(stand));
      }

      const developmentMatch = pathname.match(/^\/development\/([^/]+)\/?$/);
      if (developmentMatch) {
        const wanted = decodeURIComponent(developmentMatch[1]).toLowerCase();
        const project = portal.projects().find((p) => slugify(p.name) === wanted);
        if (!project) return sendHtml(res, 404, publicSite.renderNotFound());

        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end();
        }
        return sendHtml(res, 200, publicSite.renderDevelopment(project));
      }
    }

    /* ── Static ── */
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/') {
        const ok = await serveStatic(req, res, '/index.html', cookies);
        if (ok !== false) return;
      }
      const ok = await serveStatic(req, res, pathname, cookies);
      if (ok !== false) return;

      return sendHtml(res, 404, views.renderError({
        status: 404, title: 'Page not found',
        message: 'The page you asked for does not exist. It may have been moved or renamed.'
      }));
    }

    return send(res, 405, 'Method not allowed');
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      console.error('[error]', err);
      audit('server_error', 'failure', { detail: String(err.message || err), ip });
    }
    if (res.headersSent) return res.destroy();
    return sendJson(res, status, { error: status === 413 ? 'Request too large.' : 'Something went wrong.' });
  }
});

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

/* A rejected promise anywhere in a request handler must not take the whole
   site down. Node's default is to terminate the process; for a web server that
   turns one bad request into a total outage, so log it, record it, keep
   serving.

   `uncaughtException` is deliberately NOT handled here: that can leave the
   process in an unknown state, and continuing to serve from it is worse than
   restarting. Only the promise case is safe to absorb. */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  try {
    audit('server_error', 'failure', {
      detail: `unhandled rejection: ${(reason && reason.message) || String(reason)}`
    });
  } catch { /* an audit failure must not cascade */ }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

if (require.main === module) {
  server.listen(config.PORT, config.HOST, () => {
    const count = users.byClientNumber('HP-10245');
    console.log(`\n  Heritage Housing Projects`);
    console.log(`  Server listening on http://${config.HOST}:${config.PORT}`);
    console.log(`  Database: ${config.DB_PATH}`);
    console.log(`  Behind HTTPS: ${config.BEHIND_HTTPS ? 'yes' : 'no'}`);
    if (!count) {
      console.log(`\n  ! No client accounts yet. Run:  node scripts/seed.js\n`);
    }
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received — shutting down.`);
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { server };
