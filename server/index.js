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
const { audit, users, sessions, portal, enquiries, admin, content, db,
  leads, staffLogs } = require('./db');
const {
  parseCookies, sessionCookie, clearSessionCookie, csrfCookie, newCsrfToken,
  securityHeaders, csrfOk, RateLimiter, STATE_CHANGING,
  staffSessionCookie, clearStaffSessionCookie
} = require('./security');
const auth = require('./auth');
const { logSecurityEvent } = require('./security-log');
const views = require('./views');
const viewsStaff = require('./views-staff');
const adminRoutes = require('./admin');
const publicSite = require('./public-site');
const invoice = require('./invoice');
const { slugify } = require('./format');
const { isMultipart, boundaryFrom, parseMultipart } = require('./multipart');
const { validateNewPassword } = require('./passwords');

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
/* One address may make at most this many requests in the window, whatever the
   route. Set well above a normal browsing session so it only catches a client
   working systematically through the site. */
const generalLimiter = new RateLimiter(config.GENERAL_MAX_PER_WINDOW, config.GENERAL_WINDOW_MS);
/* Staff sign-in gets its own bucket for the same reason the admin one does:
   hammering one portal must not lock out the other. */
const staffLoginLimiter = new RateLimiter(config.LOGIN_MAX_ATTEMPTS, config.LOGIN_WINDOW_MS);

// Keep the limiters' maps from growing without bound.
setInterval(async () => {
  loginLimiter.sweep();
  enquiryLimiter.sweep();
  generalLimiter.sweep();
  staffLoginLimiter.sweep();
  adminRoutes.sweep();
  await sessions.purgeExpired();
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

  /* Format checks first. These say nothing about whether an account exists —
     they only reject input that could never be a valid credential — so they do
     not give an attacker an enumeration oracle. */
  const errors = [];
  if (clientNumber.length < 3) errors.push('clientNumber');
  if (password.length < 3) errors.push('password');
  if (errors.length) {
    return sendJson(res, 400, {
      error: 'Client number and password must each be at least 3 characters.',
      fields: errors
    });
  }

  const limit = loginLimiter.check(ip);
  if (!limit.allowed) {
    const mins = Math.ceil(limit.retryAfterMs / 60000);
    await audit('login', 'rate_limited', { clientNumber, detail: 'per-IP limit', ip });
    logSecurityEvent('login_rate_limited', req, { clientNumber, retryAfterMs: limit.retryAfterMs });
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

    logSecurityEvent('login_failed', req, { clientNumber, reason: result.reason });
    return sendJson(res, 401, { error: message });
  }

  loginLimiter.reset(ip);
  const token = result.token;

  logSecurityEvent('login_success', req, {
    clientNumber: result.user.clientNumber, role: result.user.role
  });

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
  await auth.destroySession(token);
  await audit('logout', 'success', { userId: user ? user.id : null, ip: clientIp(req) });
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

  await enquiries.insert({ name, phone, interest, message, ip });
  await audit('enquiry', 'success', { detail: `${interest} from ${name}`, ip });

  if (isFormPost) return redirect(res, '/contact.html?sent=1');
  return sendJson(res, 201, { ok: true });
}

/* ── API: client data ───────────────────────────────────────────────────── */

async function buildDashboard(user, csrf) {
  const ownership = await portal.ownershipFor(user.id);
  const payments = await portal.paymentsFor(user.id);
  const paidTotal = await portal.paidTotalFor(user.id);
  const documents = await portal.documentsFor(user.id);
  const progress = ownership ? await portal.progressFor(ownership.project_id) : [];

  return { ownership, payments, paidTotal, documents, progress, user, csrf };
}

async function handleDocumentDownload(req, res, user, docId) {
  const id = Number.parseInt(docId, 10);
  if (!Number.isInteger(id) || id <= 0) return send(res, 400, 'Bad request');

  // Ownership is part of the query, so one client can never read another's
  // document by guessing an id. A miss is indistinguishable from "not found".
  const doc = await portal.documentForUser(id, user.id);
  if (!doc) {
    await audit('document_download', 'denied', {
      userId: user.id, detail: `document ${id}`, ip: clientIp(req)
    });
    return send(res, 404, 'Not found');
  }

  const root = path.resolve(config.PRIVATE_DOCS_DIR);
  const filePath = path.resolve(root, doc.stored_name);

  // Belt and braces: stored_name is server-generated, but re-check anyway so a
  // future bad write cannot turn this route into arbitrary file disclosure.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    await audit('document_download', 'denied', { userId: user.id, detail: 'path escape', ip: clientIp(req) });
    return send(res, 403, 'Forbidden');
  }

  let stat;
  try { stat = await fsp.stat(filePath); } catch { stat = null; }
  if (!stat || !stat.isFile()) return send(res, 404, 'Not found');

  await audit('document_download', 'success', {
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

    securityHeaders(res, {
      /* The staff pages are authenticated, so they must never be cached. */
      html: pathname.endsWith('.html') || pathname === '/'
        || pathname === '/staff' || pathname.startsWith('/staff/')
    });

    /* The global ceiling, checked before any database work so that a flood
       costs as little as possible.
       /healthz is exempt: a monitor that gets rate limited looks exactly like
       an outage, and that is the one signal worth keeping clean. */
    if (pathname !== '/healthz') {
      const limit = generalLimiter.check(ip);
      if (!limit.allowed) {
        logSecurityEvent('rate_limit_exceeded', req, {
          scope: 'general', method: req.method, retryAfterMs: limit.retryAfterMs
        });
        const headers = { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) };
        if (pathname.startsWith('/api/')) {
          return sendJson(res, 429,
            { error: 'Too many requests. Please wait a few minutes.' }, headers);
        }
        return sendHtml(res, 429, await views.renderError({
          status: 429,
          title: 'Too many requests',
          message: 'Too many requests. Please wait a few minutes.'
        }), headers);
      }
    }

    const token = cookies[config.SESSION_COOKIE];
    const user = await auth.sessionUser(token);

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
      await audit('csrf', 'denied', { userId: user ? user.id : null, detail: `${req.method} ${pathname}`, ip });
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 403, { error: 'Request blocked: origin check failed.' });
      }
      return sendHtml(res, 403, await views.renderError({
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

    /* ── Staff portal (sales agents) ──
       Phase 1 is the login shell only. Agents are rows in `agents`, not in
       `users`, so they carry their own cookie and their own session table; the
       requireStaff guard below is the single gate every staff page goes
       through. The CSRF check above already covers the POSTs here. */
    if (pathname === '/staff' || pathname.startsWith('/staff/')) {
      const staffToken = cookies[config.STAFF_COOKIE];
      const agent = await auth.requireStaff(staffToken);

      /* Sign in. */
      if (pathname === '/staff/login') {
        if (req.method === 'GET') {
          if (agent) return redirect(res, '/staff');
          return sendHtml(res, 200, viewsStaff.staffLogin(await content.settings(), { csrf }));
        }
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed');

        const limit = staffLoginLimiter.check(ip);
        if (!limit.allowed) {
          const mins = Math.ceil(limit.retryAfterMs / 60000);
          logSecurityEvent('staff_login_rate_limited', req, { retryAfterMs: limit.retryAfterMs });
          return sendHtml(res, 429, viewsStaff.staffLogin(await content.settings(), {
            csrf,
            error: `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
          }), { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) });
        }

        const identifier = String(body.identifier || '').trim();
        const password = String(body.password || '');

        if (identifier.length < 2 || password.length < 3) {
          return sendHtml(res, 400, viewsStaff.staffLogin(await content.settings(), {
            csrf, error: 'Please enter your email or name and your password.'
          }));
        }

        const result = await auth.staffSignIn(identifier, password, {
          ip, userAgent: req.headers['user-agent']
        });

        if (!result.ok) {
          logSecurityEvent('staff_login_failed', req, { identifier: identifier.slice(0, 80) });
          return sendHtml(res, 401, viewsStaff.staffLogin(await content.settings(), {
            csrf, error: 'Invalid email, name or password.'
          }));
        }

        staffLoginLimiter.reset(ip);
        logSecurityEvent('staff_login_success', req, { agent: result.agent.name });
        return sendHtml(res, 302, '', {
          Location: '/staff',
          'Set-Cookie': staffSessionCookie(result.token, config.SESSION_TTL_MS)
        });
      }

      /* Sign out. */
      if (pathname === '/staff/logout') {
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
        await auth.destroyStaffSession(staffToken);
        return sendHtml(res, 302, '', {
          Location: '/staff/login',
          'Set-Cookie': clearStaffSessionCookie()
        });
      }

      /* Dashboard — the protected page. */
      if (pathname === '/staff') {
        if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
        if (!agent) return redirect(res, '/staff/login');

        /* Only this agent's own leads and own updates. Nothing here takes an
           id from the request, so there is no id to tamper with. */
        return sendHtml(res, 200, viewsStaff.staffDashboard(await content.settings(), {
          agent, csrf,
          notice: url.searchParams.get('ok') === 'logged' ? 'Update posted.'
            : url.searchParams.get('ok') === 'lead' ? 'Lead added successfully.'
              : '',
          leads: await leads.forAgent(agent.id),
          logs: await staffLogs.forAgent(agent.id, 5)
        }));
      }

      /* Add a lead.

         The owning agent comes from the session and nowhere else. There is no
         assignedAgentId field in the form and none is read from the body, so an
         agent can only ever file a lead against themselves — a hidden input
         would have been editable in devtools. */
      if (pathname === '/staff/lead') {
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
        if (!agent) return redirect(res, '/staff/login');

        const renderDashboard = async (opts = {}) => viewsStaff.staffDashboard(
          await content.settings(), {
            agent, csrf,
            leads: await leads.forAgent(agent.id),
            logs: await staffLogs.forAgent(agent.id, 5),
            ...opts
          });

        const fullName = String(body.fullName || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const phone = String(body.phone || '').trim().slice(0, 40);
        const email = String(body.email || '').trim().slice(0, 160);
        const source = String(body.source || '').trim().slice(0, 60);

        if (fullName.length < 2) {
          return sendHtml(res, 400, await renderDashboard({
            error: 'Please enter the lead\'s name.'
          }));
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
          return sendHtml(res, 400, await renderDashboard({
            error: 'That does not look like a valid email address.'
          }));
        }

        const id = await leads.create({
          fullName, phone, email, source, status: 'New', assignedAgentId: agent.id
        });
        await audit('lead_create', 'success', {
          detail: `lead ${id} (${fullName}) by agent ${agent.id} (${agent.name})`, ip
        });

        /* Redirect after post, so a refresh does not file the same lead twice. */
        return redirect(res, '/staff?ok=lead');
      }

      /* Post a daily update. */
      if (pathname === '/staff/log') {
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
        if (!agent) return redirect(res, '/staff/login');

        const text = String(body.logText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);

        if (text.length < 3) {
          return sendHtml(res, 400, viewsStaff.staffDashboard(await content.settings(), {
            agent, csrf, error: 'Please write a short update before posting.',
            leads: await leads.forAgent(agent.id),
            logs: await staffLogs.forAgent(agent.id, 5)
          }));
        }

        await staffLogs.create({ agentId: agent.id, text });
        await audit('staff_log', 'success', {
          detail: `agent ${agent.id} (${agent.name})`, ip
        });

        /* Redirect after post, so a refresh does not file the same update
           twice. */
        return redirect(res, '/staff?ok=logged');
      }

      return sendHtml(res, 404, await views.renderError({
        status: 404, title: 'Not found', message: 'That page could not be found.'
      }));
    }

    /* ── Client portal ── */
    if (pathname === '/dashboard') {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return send(res, 405, 'Method not allowed');
      }
      if (!user) return redirect(res, '/portal.html');

      /* A password change re-renders this same page carrying a message rather
         than redirecting, so the outcome appears where the form was. The CSRF
         check has already run for every state-changing request above. */
      let passwordNotice = null;

      if (req.method === 'POST') {
        const current = String(body.currentPassword || '');
        const next = String(body.newPassword || '');
        const confirm = String(body.confirmPassword || '');
        const me = await users.byId(user.id);

        if (!me || !(await auth.verifyPassword(current, me.password_hash))) {
          passwordNotice = { kind: 'error', text: 'Your current password is not correct.' };
          logSecurityEvent('password_change_failed', req, {
            clientNumber: user.clientNumber, reason: 'current password incorrect'
          });
        } else if (next !== confirm) {
          passwordNotice = { kind: 'error', text: 'The two new passwords do not match.' };
        } else {
          const problem = validateNewPassword(next);
          if (problem) {
            passwordNotice = { kind: 'error', text: problem };
          } else {
            await admin.setPassword(user.id, await auth.hashPassword(next));
            await audit('client_password_change', 'success', { userId: user.id, ip });
            logSecurityEvent('password_changed', req, {
              clientNumber: user.clientNumber, self: true
            });
            passwordNotice = { kind: 'success', text: 'Your password has been changed.' };
          }
        }

        if (passwordNotice.kind === 'error') {
          await audit('client_password_change', 'denied', {
            userId: user.id, detail: passwordNotice.text, ip
          });
        }
      } else {
        await audit('dashboard_view', 'success', { userId: user.id, ip });
      }

      const data = await buildDashboard(user, csrf || '');
      data.passwordNotice = passwordNotice;

      return sendHtml(res, 200, await views.layout({
        title: 'My Heritage — Client Dashboard',
        description: 'Your stand, payment history and project progress.',
        body: await views.renderDashboard(data)
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
      return await handleLogout(req, res, user);
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

      const data = await buildDashboard(user, csrf || '');

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
        const client = await admin.clientById(user.id);
        if (!client) return sendJson(res, 404, { error: 'No account record found.' });

        const pdf = invoice.buildStatementPdf({
          settings: await content.settings(),
          client,
          ownership: invoice.ownershipFromClientRow(client),
          payments: await admin.paymentsFor(user.id),
          generatedAt: new Date()
        });

        await audit('statement_download', 'success', {
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
        const html = await publicSite.renderFile(file);
        if (html !== null) {
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end();
          }
          return sendHtml(res, 200, html);
        }
      }

      if (file === 'portal.html') return sendHtml(res, 200, await publicSite.renderPortalPage());
    }

    /* ── One individual property, and one development ──
       Both rendered live so an admin edit shows immediately. Addressed by
       stand number and by name-slug rather than by internal id, so the URL
       says what it is and survives a database rebuild. */
    if (req.method === 'GET' || req.method === 'HEAD') {
      const propertyMatch = pathname.match(/^\/property\/([^/]+)\/?$/);
      if (propertyMatch) {
        const stand = await admin.standByNumber(decodeURIComponent(propertyMatch[1]));
        if (!stand) return sendHtml(res, 404, await publicSite.renderNotFound());

        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end();
        }
        return sendHtml(res, 200, await publicSite.renderProperty(stand));
      }

      const developmentMatch = pathname.match(/^\/development\/([^/]+)\/?$/);
      if (developmentMatch) {
        const wanted = decodeURIComponent(developmentMatch[1]).toLowerCase();
        const project = (await portal.projects()).find((p) => slugify(p.name) === wanted);
        if (!project) return sendHtml(res, 404, await publicSite.renderNotFound());

        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end();
        }
        return sendHtml(res, 200, await publicSite.renderDevelopment(project));
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

      return sendHtml(res, 404, await views.renderError({
        status: 404, title: 'Page not found',
        message: 'The page you asked for does not exist. It may have been moved or renamed.'
      }));
    }

    return send(res, 405, 'Method not allowed');
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      console.error('[error]', err);
      await audit('server_error', 'failure', { detail: String(err.message || err), ip });
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
process.on('unhandledRejection', async (reason) => {
  console.error('[unhandledRejection]', reason);
  try {
    await audit('server_error', 'failure', {
      detail: `unhandled rejection: ${(reason && reason.message) || String(reason)}`
    });
  } catch { /* an audit failure must not cascade */ }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

if (require.main === module) {
  server.listen(config.PORT, config.HOST, async () => {
    const count = await users.byClientNumber('HP-10245');
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
