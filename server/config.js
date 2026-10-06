'use strict';

/* ==========================================================================
   Configuration
   Everything tunable lives here. Values come from the environment so that no
   secret is ever committed to the repository.
   ========================================================================== */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

function int(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

module.exports = {
  ROOT,
  /* Overridable so the verification suite can serve and upload into a
     throwaway copy rather than the real directory. */
  PUBLIC_DIR: process.env.PUBLIC_DIR || path.join(ROOT, 'public'),
  /* Overridable so the verification suite can upload into a throwaway
     directory instead of the real one. */
  PRIVATE_DOCS_DIR: process.env.PRIVATE_DOCS_DIR || path.join(ROOT, 'private-docs'),
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data', 'heritage.db'),

  PORT: int('PORT', 3000),
  HOST: process.env.HOST || '127.0.0.1',

  /* Set BEHIND_HTTPS=1 in production so cookies get the Secure flag and HSTS
     is asserted. It is off by default because the development server is
     plain HTTP, and a Secure cookie would simply never be stored. */
  BEHIND_HTTPS: bool('BEHIND_HTTPS', false),

  /* Only enable when a reverse proxy you control sets X-Forwarded-For.
     Trusting that header on a directly exposed server lets any client spoof
     its address and walk straight through the per-IP rate limiter. */
  TRUST_PROXY: bool('TRUST_PROXY', false),

  MAX_BODY_BYTES: int('MAX_BODY_BYTES', 64 * 1024),

  /* Uploads get their own, larger ceiling. Ordinary form posts stay at the
     small limit above so a JSON endpoint cannot be fed megabytes. */
  MAX_UPLOAD_BYTES: int('MAX_UPLOAD_BYTES', 8 * 1024 * 1024),

  SESSION_COOKIE: 'heritage_session',
  CSRF_COOKIE: 'csrf',
  SESSION_TTL_MS: int('SESSION_TTL_HOURS', 8) * 60 * 60 * 1000,

  /* Password hashing. scrypt with N=2^15 needs ~33 MB, which is above the
     32 MB Node default for maxmem — hence the explicit value below. */
  SCRYPT: { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 },

  /* Brute-force controls. */
  LOGIN_MAX_ATTEMPTS: int('LOGIN_MAX_ATTEMPTS', 8),
  LOGIN_WINDOW_MS: int('LOGIN_WINDOW_MINUTES', 15) * 60 * 1000,
  ACCOUNT_LOCK_MS: int('ACCOUNT_LOCK_MINUTES', 15) * 60 * 1000,
  ENQUIRY_MAX_PER_HOUR: int('ENQUIRY_MAX_PER_HOUR', 5)
};
