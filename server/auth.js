'use strict';

/* ==========================================================================
   Authentication: password hashing and session lifecycle.
   ========================================================================== */

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const config = require('./config');
const { users, sessions, agents, staffSessions, audit } = require('./db');
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
    /* Trimmed before parsing. A hash pasted in by hand — through a Turso
       console, a .sql file or a spreadsheet — often arrives with a trailing
       newline or stray spaces, and the only symptom is that the correct
       password silently never works. A valid hash never carries surrounding
       whitespace, so trimming cannot break a good one. */
    const parts = String(stored).trim().split('$');
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
async function createSession(userId, { ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_MS).toISOString();

  await sessions.create({
    tokenHash: hashToken(token),
    userId,
    expiresAt,
    ip: ip || null,
    userAgent: (userAgent || '').slice(0, 255)
  });

  return { token, expiresAt };
}

/** Returns the session's user, or null. Expired rows are refused and purged. */
async function sessionUser(token) {
  if (!token) return null;
  const row = await sessions.find(hashToken(token));
  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await sessions.destroy(row.token_hash);
    return null;
  }
  if (row.disabled) {
    await sessions.destroy(row.token_hash);
    return null;
  }
  /* Archiving already destroys every session for the account, so this is the
     second line of defence: a session that somehow survived is refused on its
     next request rather than lasting until it expires. */
  if (row.archived) {
    await sessions.destroy(row.token_hash);
    return null;
  }
  return {
    id: row.user_id,
    clientNumber: row.client_number,
    fullName: row.full_name,
    role: row.role
  };
}

async function destroySession(token) {
  if (token) await sessions.destroy(hashToken(token));
}

/* ── Staff (agents) ─────────────────────────────────────────────────────── */

/**
 * Issues a staff session.
 *
 * Deliberately a separate table from client sessions: sessions.user_id is a
 * foreign key to users(id) and an agent is an agents row, so an agent id could
 * never be stored there with foreign keys enforced.
 */
async function createStaffSession(agentId, { ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_MS).toISOString();

  await staffSessions.create({
    tokenHash: hashToken(token),
    agentId,
    expiresAt,
    ip: ip || null,
    userAgent: (userAgent || '').slice(0, 255)
  });

  return { token, expiresAt };
}

/** Returns the agent behind a staff session token, or null. */
async function staffSession(token) {
  if (!token) return null;
  const row = await staffSessions.find(hashToken(token));
  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await staffSessions.destroy(row.token_hash);
    return null;
  }
  /* A deactivated agent loses their session immediately, without waiting for
     it to expire. */
  if (!row.active) {
    await staffSessions.destroy(row.token_hash);
    return null;
  }

  return { id: row.agent_id, name: row.name, email: row.email };
}

async function destroyStaffSession(token) {
  if (token) await staffSessions.destroy(hashToken(token));
}

/**
 * The staff guard.
 *
 * There is no middleware stack to hang this off, so it is a plain check that
 * every /staff route calls first. Returns the agent, or null when the request
 * carries no valid staff session — the caller turns that into a redirect to
 * /staff/login.
 */
async function requireStaff(token) {
  return await staffSession(token);
}

/**
 * Attempts a staff sign-in against the agents table.
 *
 * Returns { ok: true, token, expiresAt, agent } or
 *         { ok: false, reason: 'invalid' }.
 *
 * Every failure returns the same reason, and an unknown identifier still pays
 * for a scrypt verification, so neither the response nor the timing says
 * whether an agent exists.
 */
async function staffSignIn(identifier, password, { ip, userAgent }) {
  const agent = await agents.byLogin(identifier);

  if (!agent) {
    await verifyPassword(password, await dummyHash());
    await audit('staff_login', 'failure', { detail: 'unknown agent identifier', ip });
    return { ok: false, reason: 'invalid' };
  }

  /* An agent can exist as a sales credit without ever being given a login. */
  if (!agent.password_hash) {
    await verifyPassword(password, await dummyHash());
    await audit('staff_login', 'failure', {
      detail: `agent ${agent.id} (${agent.name}) has NO PASSWORD SET — run scripts/create-agent.js --reset`, ip
    });
    return { ok: false, reason: 'invalid' };
  }

  /* Checked after the lookup, not inside it, so a deactivated agent is audited
     as deactivated rather than as an unknown identifier. The user still sees
     one generic message, so nothing is leaked to a caller. */
  if (!agent.active) {
    await verifyPassword(password, await dummyHash());
    await audit('staff_login', 'failure', {
      detail: `agent ${agent.id} (${agent.name}) is DEACTIVATED`, ip
    });
    return { ok: false, reason: 'invalid' };
  }

  if (!(await verifyPassword(password, agent.password_hash))) {
    await audit('staff_login', 'failure', {
      detail: `agent ${agent.id} (${agent.name}) bad password`, ip
    });
    return { ok: false, reason: 'invalid' };
  }

  const session = await createStaffSession(agent.id, { ip, userAgent });
  await audit('staff_login', 'success', {
    detail: `agent ${agent.id} (${agent.name})`, ip
  });

  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    agent: { id: agent.id, name: agent.name, email: agent.email }
  };
}

/* ── Sign-in ────────────────────────────────────────────────────────────── */

/* A dummy hash, verified when the client number does not exist. Without this
   the response time would reveal whether an account exists. */
let dummyHashPromise = null;
async function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = await hashPassword(crypto.randomBytes(24).toString('hex'));
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
  const user = await users.byClientNumber(clientNumber);

  if (!user) {
    // Spend comparable time so a missing account is not distinguishable.
    await verifyPassword(password, await dummyHash());
    await audit('login', 'failure', { clientNumber, detail: 'unknown client number', ip });
    return { ok: false, reason: 'invalid' };
  }

  if (user.disabled) {
    await audit('login', 'failure', { userId: user.id, clientNumber, detail: 'account disabled', ip });
    return { ok: false, reason: 'disabled' };
  }

  /* An archived account is one the office has filed away — a test account, or a
     client who has been refunded. It is refused the same way a disabled one is,
     so the answer to a caller is identical and the archive does not become a
     way to probe which accounts exist. */
  if (user.archived) {
    await audit('login', 'failure', { userId: user.id, clientNumber, detail: 'account archived', ip });
    return { ok: false, reason: 'disabled' };
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const retryAfterMs = new Date(user.locked_until).getTime() - Date.now();
    await audit('login', 'failure', { userId: user.id, clientNumber, detail: 'account locked', ip });
    return { ok: false, reason: 'locked', retryAfterMs };
  }

  const valid = await verifyPassword(password, user.password_hash);

  if (!valid) {
    await users.bumpFailed(user.id);
    const attempts = user.failed_attempts + 1;

    if (attempts >= config.LOGIN_MAX_ATTEMPTS) {
      const until = new Date(Date.now() + config.ACCOUNT_LOCK_MS).toISOString();
      await users.lock(user.id, until);
      await audit('login', 'locked', {
        userId: user.id, clientNumber,
        detail: `locked after ${attempts} failed attempts`, ip
      });
      return { ok: false, reason: 'locked', retryAfterMs: config.ACCOUNT_LOCK_MS };
    }

    await audit('login', 'failure', {
      userId: user.id, clientNumber, detail: `bad password (${attempts})`, ip
    });
    return { ok: false, reason: 'invalid' };
  }

  await users.resetFailed(user.id);
  const session = await createSession(user.id, { ip, userAgent });

  await audit('login', 'success', { userId: user.id, clientNumber, ip });

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
  /* Staff */
  createStaffSession,
  staffSession,
  destroyStaffSession,
  requireStaff,
  staffSignIn,
  sessionCookie,
  clearSessionCookie
};
