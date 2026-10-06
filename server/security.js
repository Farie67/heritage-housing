'use strict';

/* ==========================================================================
   Security helpers: headers, cookies, CSRF, rate limiting.
   ========================================================================== */

const crypto = require('node:crypto');
const config = require('./config');

/* ── Constant-time comparison ───────────────────────────────────────────── */

function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  // timingSafeEqual throws on length mismatch, so compare digests instead of
  // the raw values — that keeps the comparison constant-time regardless of
  // input length and avoids leaking length through an exception.
  const ah = crypto.createHash('sha256').update(ab).digest();
  const bh = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/* ── Cookies ────────────────────────────────────────────────────────────── */

function parseCookies(req) {
  const out = Object.create(null);
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.httpOnly) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  bits.push(`SameSite=${opts.sameSite || 'Strict'}`);
  return bits.join('; ');
}

/* Session cookie: HttpOnly so JavaScript cannot read it (an XSS bug then
   cannot exfiltrate the session), SameSite=Strict so it is not attached to
   cross-site requests at all. */
function sessionCookie(token, maxAgeMs) {
  return serializeCookie(config.SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.BEHIND_HTTPS,
    sameSite: 'Strict',
    maxAge: maxAgeMs
  });
}

function clearSessionCookie() {
  return serializeCookie(config.SESSION_COOKIE, '', {
    httpOnly: true,
    secure: config.BEHIND_HTTPS,
    sameSite: 'Strict',
    maxAge: 0
  });
}

/* CSRF cookie: deliberately NOT HttpOnly, because the double-submit pattern
   requires the page's own JavaScript to read it and echo it back in a header.
   It carries no authority on its own. */
function csrfCookie(token) {
  return serializeCookie(config.CSRF_COOKIE, token, {
    httpOnly: false,
    secure: config.BEHIND_HTTPS,
    sameSite: 'Strict',
    maxAge: config.SESSION_TTL_MS
  });
}

function newCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/* ── Security headers ───────────────────────────────────────────────────── */

/* The CSP keeps 'unsafe-inline' out of script-src entirely. Inline styles are
   still permitted because the property cards set a background image inline;
   that is a much smaller risk than inline script. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // Images are local files under /images/; nothing is loaded from another origin.
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ');

function securityHeaders(res, { html = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (config.BEHIND_HTTPS) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (html) res.setHeader('Cache-Control', 'no-store');
}

/* ── CSRF ───────────────────────────────────────────────────────────────── */

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A state-changing request must prove it came from our own origin.
 *
 * Two acceptable proofs, so that both the fetch() path and a plain HTML form
 * POST (JavaScript disabled) are covered:
 *
 *   1. Double-submit token — `X-CSRF-Token` header must equal the `csrf`
 *      cookie. An attacker's page can cause the cookie to be sent but cannot
 *      read it, so it cannot set a matching header.
 *   2. Origin/Referer must name this host. Browsers set these and scripts
 *      cannot forge them.
 */
function csrfOk(req, cookies, host, body) {
  if (!STATE_CHANGING.has(req.method)) return true;

  const cookie = cookies[config.CSRF_COOKIE];
  const header = req.headers['x-csrf-token'];

  /* Both double-submit forms need the cookie to compare against; if it is
     absent we fall through to the Origin check rather than refusing outright,
     so a client that never fetched a page (or whose cookie expired) can still
     be validated by its origin. */
  if (cookie) {
    if (header && safeEqual(header, cookie)) return true;

    /* A plain HTML form cannot set a header, so it carries the token in a
       hidden field instead. Same guarantee: an attacker's page can cause the
       cookie to be sent but cannot read it to fill the field. */
    if (body && body.csrf && safeEqual(body.csrf, cookie)) return true;
  }

  const source = req.headers.origin || req.headers.referer;
  if (!source) return false;
  try {
    const u = new URL(source);
    return u.host === host;
  } catch {
    return false;
  }
}

/* ── Rate limiting ──────────────────────────────────────────────────────── */

/**
 * Sliding-window limiter held in memory.
 *
 * Suitable for a single-process deployment, which this is. If the app is ever
 * scaled to multiple workers or machines, move this into SQLite or Redis —
 * in-memory counters are per-process and would multiply the effective limit.
 */
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Records a hit and returns { allowed, remaining, retryAfterMs }. */
  check(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);

    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return { allowed: false, remaining: 0, retryAfterMs: list[0] + this.windowMs - now };
    }

    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, remaining: this.limit - list.length, retryAfterMs: 0 };
  }

  /** Forgets a key — used after a successful sign-in. */
  reset(key) { this.hits.delete(key); }

  /** Drops empty/expired buckets so the map cannot grow without bound. */
  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length) this.hits.set(key, kept);
      else this.hits.delete(key);
    }
  }
}

module.exports = {
  safeEqual,
  parseCookies,
  serializeCookie,
  sessionCookie,
  clearSessionCookie,
  csrfCookie,
  newCsrfToken,
  securityHeaders,
  csrfOk,
  RateLimiter,
  STATE_CHANGING
};
