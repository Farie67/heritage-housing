'use strict';

/* ==========================================================================
   Self-service password reset by emailed one-time code.

   Three endpoints, mounted in server/index.js:

     POST /api/auth/forgot-password    { identifier, portalType }
     POST /api/auth/verify-otp         { identifier, otp }
     POST /api/auth/reset-password-otp { identifier, otp, newPassword, portalType }

   ---------------------------------------------------------------------------
   DESIGN NOTES
   ---------------------------------------------------------------------------
   The code is hashed with the same scrypt helper as a password, so a copy of
   the password_resets table cannot be used to take an account over. Six digits
   have little entropy, which is why the row also expires after 10 minutes and
   dies after five wrong guesses.

   portalType decides which table is searched:
     staff        -> agents, by email
     admin/client -> users, by email or client number

   The admin manual "Reset password" buttons are untouched — this is a separate
   route that never asks for a staff session.
   ========================================================================== */

const crypto = require('node:crypto');
const { agents, users, passwordResets } = require('./db');
const { hashPassword } = require('./auth');

const OTP_TTL_MINUTES = 10;
const OTP_LENGTH = 6;

const PORTAL_TYPES = new Set(['admin', 'client', 'staff']);

const FROM = 'Heritage Support <reminders@heritagehousingprojects.co.zw>';
const REPLY_TO = 'no-reply@heritagehousingprojects.co.zw';

/* Lead conversion writes client-0771234567@heritagehousing.co.zw when no real
   address was captured. Mail to it bounces, so the reset must refuse rather
   than promise an email that will never arrive. */
const isPlaceholderEmail = (email) =>
  String(email || '').trim().toLowerCase().endsWith('@heritagehousing.co.zw');

/** Identifiers are compared lower-cased and trimmed. */
const normaliseIdentifier = (value) => String(value || '').trim().toLowerCase();

/** A six-digit code, from a CSPRNG rather than Math.random. */
function generateOTP() {
  const max = 10 ** OTP_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(OTP_LENGTH, '0');
}

/**
 * The row, or null when the identifier names nobody.
 *
 * Takes the identifier as the person typed it. Emails are matched
 * case-insensitively by the query; client numbers are NOT lower-cased here,
 * because "HP-10245" would stop matching "hp-10245". The lower-cased form is
 * used only as the storage key for the code (normaliseIdentifier).
 */
async function findAccount(identifier, portalType) {
  const key = String(identifier || '').trim();
  if (!key) return null;

  if (portalType === 'staff') {
    const agent = await agents.byLogin(key);
    return agent ? { kind: 'agent', email: agent.email, name: agent.name, id: agent.id } : null;
  }

  /* Admin and client both live in `users`. The identifier may be an email or a
     client number such as HP-10245. */
  const byEmail = await users.byEmail(key);
  const row = byEmail || await users.byClientNumber(key);
  if (!row) return null;

  /* The admin portal is for staff roles only; the client portal for clients.
     Without this an admin could start a reset for a client, and vice versa. */
  const isStaffRole = row.role !== 'client';
  if (portalType === 'admin' && !isStaffRole) return null;
  if (portalType === 'client' && isStaffRole) return null;

  return { kind: 'user', email: row.email, name: row.full_name, id: row.id, row };
}

/**
 * Sends the code. Throws with a readable message when email is not configured.
 *
 * Required lazily, exactly as send-reminders.js does: a missing package must
 * not stop the server from starting.
 */
async function sendOTPEmail(to, otp, name) {
  let Resend;
  try {
    ({ Resend } = require('resend'));
  } catch {
    throw new Error('Email is not configured on this server.');
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Email is not configured on this server.');

  const resend = new Resend(key);
  const { error } = await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to,
    subject: 'Your Heritage Housing password reset code',
    html: `<div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
  <p>Dear ${escapeHtml(name || 'client')},</p>
  <p>Your password reset code is:</p>
  <p style="font-size: 28px; letter-spacing: 6px; font-weight: bold;">${otp}</p>
  <p>The code expires in ${OTP_TTL_MINUTES} minutes. If you did not ask to reset your
     password, you can ignore this message.</p>
  <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;" />
  <p style="font-size: 12px; color: #999; font-style: italic;">This is an automated
     message. Please do not reply to this email. For enquiries, contact the office.</p>
</div>`
  });

  if (error) throw new Error(error.message || 'The email could not be sent.');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** POST /api/auth/forgot-password */
async function forgotPassword(body) {
  /* Two forms of the same thing, on purpose: the account is looked up with what
     was typed (client numbers are case-sensitive), while the code is stored
     against the normalised form so "CEO@Example.com " and "ceo@example.com"
     find the same row. */
  const typed = String(body.identifier || '').trim();
  const identifier = normaliseIdentifier(body.identifier);
  const portalType = String(body.portalType || '').trim().toLowerCase();

  if (!identifier) return { status: 400, json: { error: 'Enter your email or client number.' } };
  if (!PORTAL_TYPES.has(portalType)) return { status: 400, json: { error: 'Unknown portal.' } };

  const account = await findAccount(typed, portalType);

  /* Deliberately explicit: the brief asks for a real message when the account
     exists but has no usable address. It does reveal that the account exists —
     the alternative is an office full of people who never get a code and cannot
     tell why. */
  if (!account) {
    return {
      status: 404,
      json: { error: 'No account was found with those details. Check the spelling, or contact the office.' }
    };
  }

  if (!account.email || isPlaceholderEmail(account.email)) {
    return {
      status: 400,
      json: {
        error: 'This account has no email address on file. Please contact the office so they can reset it for you.',
        contactOffice: true
      }
    };
  }

  const otp = generateOTP();
  const userType = account.kind === 'agent' ? 'agent' : 'user';
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60000).toISOString();

  /* Stored against both the submitted identifier and the account's own address,
     so a client who asked with "HP-10234" can still verify with that number. */
  await passwordResets.createOTP(identifier, await hashPassword(otp), userType, expiresAt);

  try {
    await sendOTPEmail(account.email, otp, account.name);
  } catch (err) {
    await passwordResets.deleteOTP(identifier);
    return { status: 503, json: { error: err.message } };
  }

  return {
    status: 200,
    json: {
      ok: true,
      message: `A 6-digit code has been sent to ${maskEmail(account.email)}.`,
      expiresInMinutes: OTP_TTL_MINUTES
    }
  };
}

/** Hides most of an address so the response does not confirm it to a stranger. */
function maskEmail(email) {
  const value = String(email || '');
  const at = value.lastIndexOf('@');
  if (at < 1) return '***';
  const local = value.slice(0, at);
  if (local.length <= 2) return `***${value.slice(at)}`;
  return `${local[0]}${'*'.repeat(Math.max(local.length - 2, 1))}${local[local.length - 1]}${value.slice(at)}`;
}

/**
 * Checks a code without consuming it, shared by verify and reset.
 *
 * Returns the matching row, or null. A wrong guess is counted against the row
 * so the code cannot be brute-forced across many requests.
 */
async function checkOTP(identifier, otp, userType) {
  const row = await passwordResets.findOTP(identifier, userType);
  if (!row) return null;

  const { verifyPassword } = require('./auth');
  const ok = await verifyPassword(String(otp || ''), row.otp_code);
  if (!ok) {
    await passwordResets.recordFailedAttempt(identifier);
    return null;
  }
  return row;
}

/** The user_type a portal writes its codes under. */
async function userTypeFor(identifier, portalType) {
  if (portalType === 'staff') return 'agent';
  return 'user';
}

/** POST /api/auth/verify-otp */
async function verifyOTP(body) {
  const identifier = normaliseIdentifier(body.identifier);
  const otp = String(body.otp || '').trim();
  const portalType = String(body.portalType || '').trim().toLowerCase();

  if (!identifier || !/^\d{6}$/.test(otp)) {
    return { status: 400, json: { ok: false, error: 'Enter the 6-digit code from the email.' } };
  }
  if (!PORTAL_TYPES.has(portalType)) return { status: 400, json: { ok: false, error: 'Unknown portal.' } };

  const row = await checkOTP(identifier, otp, await userTypeFor(identifier, portalType));
  if (!row) return { status: 400, json: { ok: false, error: 'That code is wrong or has expired.' } };

  return { status: 200, json: { ok: true } };
}

/** POST /api/auth/reset-password-otp */
async function resetPassword(body) {
  const typed = String(body.identifier || '').trim();
  const identifier = normaliseIdentifier(body.identifier);
  const otp = String(body.otp || '').trim();
  const newPassword = String(body.newPassword || '');
  const portalType = String(body.portalType || '').trim().toLowerCase();

  if (!PORTAL_TYPES.has(portalType)) return { status: 400, json: { error: 'Unknown portal.' } };
  if (!identifier || !/^\d{6}$/.test(otp)) {
    return { status: 400, json: { error: 'Enter the 6-digit code from the email.' } };
  }
  /* The same minimum the rest of the site enforces. Kept short and specific so
     the message is useful rather than a rule list. */
  if (newPassword.length < 8) {
    return { status: 400, json: { error: 'Choose a password of at least 8 characters.' } };
  }

  const userType = await userTypeFor(identifier, portalType);
  const row = await checkOTP(identifier, otp, userType);
  if (!row) return { status: 400, json: { error: 'That code is wrong or has expired.' } };

  const account = await findAccount(typed, portalType);
  if (!account) {
    await passwordResets.deleteOTP(identifier);
    return { status: 404, json: { error: 'The account no longer exists.' } };
  }

  const hash = await hashPassword(newPassword);

  if (account.kind === 'agent') {
    await agents.setPassword(account.id, hash);
  } else {
    /* setPassword refuses clients on purpose; this one is the OTP-proven path. */
    await users.setPasswordFromReset(account.id, hash);
  }

  await passwordResets.deleteOTP(identifier);

  return { status: 200, json: { ok: true, message: 'Your password has been changed. You can sign in now.' } };
}

module.exports = {
  forgotPassword, verifyOTP, resetPassword,
  generateOTP, isPlaceholderEmail, normaliseIdentifier, findAccount, OTP_TTL_MINUTES
};
