'use strict';

/* ==========================================================================
   Authentication: password hashing and session lifecycle.
   ========================================================================== */

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const config = require('./config');
const { users, sessions, audit } = require('./db');
const { safeEqual, sessionCookie, clearSessionCookie } = require('./security');

const scrypt = promisify(crypto.scrypt);

/* ── Password hashing ───────────────────────────────────────────────────── */

/**
 * Hashes a password with scrypt and a per-password random salt.
 *
 * The parameters are stored alongside the digest, so existing hashes keep
 * verifying if the cost is ever raised. Stored form:
 *
 *     scrypt$N$r$p$<salt base64>$<derived key base64>
 */
async function hashPassword(password) {
  const { N, r, p, keylen, maxmem } = config.SCRYPT;
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, keylen, { N, r, p, maxmem });
  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/** Verifies a password against a stored hash. Never throws on bad input. */
async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');

    const derived = await scrypt(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: config.SCRYPT.maxmem
    });

    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* ── Sessions ───────────────────────────────────────────────────────────── */

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Issues a session. The raw token goes into the cookie exactly once; only its
 * SHA-256 digest is persisted, so the stored row is useless to an attacker
 * who reads the database.
 */
function createSession(userId, { ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_MS).toISOString();

  sessions.create({
    tokenHash: hashToken(token),
    userId,
    expiresAt,
    ip: ip || null,
    userAgent: (userAgent || '').slice(0, 255)
  });

  return { token, expiresAt };
}

/** Returns the session's user, or null. Expired rows are refused and purged. */
function sessionUser(token) {
  if (!token) return null;
  const row = sessions.find(hashToken(token));
  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    sessions.destroy(row.token_hash);
    return null;
  }
  if (row.disabled) {
    sessions.destroy(row.token_hash);
    return null;
  }
  return {
    id: row.user_id,
    clientNumber: row.client_number,
    fullName: row.full_name,
    role: row.role
  };
}

function destroySession(token) {
  if (token) sessions.destroy(hashToken(token));
}

/* ── Sign-in ────────────────────────────────────────────────────────────── */

/* A dummy hash, verified when the client number does not exist. Without this
   the response time would reveal whether an account exists. */
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(24).toString('hex'));
  }
  return dummyHashPromise;
}

/**
 * Attempts a sign-in.
 *
 * Returns { ok: true, token, expiresAt, user } or
 *         { ok: false, reason: 'invalid' | 'locked' | 'disabled', retryAfterMs? }
 *
 * The caller must apply its own per-IP rate limit as well; this function
 * handles the per-account lockout.
 */
async function signIn(clientNumber, password, { ip, userAgent }) {
  const user = users.byClientNumber(clientNumber);

  if (!user) {
    // Spend comparable time so a missing account is not distinguishable.
    await verifyPassword(password, await dummyHash());
    audit('login', 'failure', { clientNumber, detail: 'unknown client number', ip });
    return { ok: false, reason: 'invalid' };
  }

  if (user.disabled) {
    audit('login', 'failure', { userId: user.id, clientNumber, detail: 'account disabled', ip });
    return { ok: false, reason: 'disabled' };
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const retryAfterMs = new Date(user.locked_until).getTime() - Date.now();
    audit('login', 'failure', { userId: user.id, clientNumber, detail: 'account locked', ip });
    return { ok: false, reason: 'locked', retryAfterMs };
  }

  const valid = await verifyPassword(password, user.password_hash);

  if (!valid) {
    users.bumpFailed(user.id);
    const attempts = user.failed_attempts + 1;

    if (attempts >= config.LOGIN_MAX_ATTEMPTS) {
      const until = new Date(Date.now() + config.ACCOUNT_LOCK_MS).toISOString();
      users.lock(user.id, until);
      audit('login', 'locked', {
        userId: user.id, clientNumber,
        detail: `locked after ${attempts} failed attempts`, ip
      });
      return { ok: false, reason: 'locked', retryAfterMs: config.ACCOUNT_LOCK_MS };
    }

    audit('login', 'failure', {
      userId: user.id, clientNumber, detail: `bad password (${attempts})`, ip
    });
    return { ok: false, reason: 'invalid' };
  }

  users.resetFailed(user.id);
  const session = createSession(user.id, { ip, userAgent });

  audit('login', 'success', { userId: user.id, clientNumber, ip });

  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      clientNumber: user.client_number,
      fullName: user.full_name,
      role: user.role
    }
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  sessionUser,
  destroySession,
  signIn,
  sessionCookie,
  clearSessionCookie
};
