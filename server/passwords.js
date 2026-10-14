'use strict';

/* ==========================================================================
   Password generation, shared by the create-admin script and the admin
   password-reset action so both produce the same shape of password.

   These are meant to be read aloud or typed once by hand, so the alphabet
   omits 0/O and 1/l/I, which are the characters people mis-transcribe.
   ========================================================================== */

const crypto = require('node:crypto');

/* Split so the generator can guarantee one of each class. 0/O and 1/l/I are
   absent from both, which is the point of the alphabet above. */
const LETTERS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const ALPHABET = LETTERS + DIGITS;

/* Symbols used when a password must contain one. Kept to characters that are
   safe to read aloud and to type on a phone keyboard. */
const SYMBOLS = '@#$!%&*';

/** Shortest password the portal will accept. */
const MIN_PASSWORD_LENGTH = 5;

/** Returns a cryptographically random password of the requested length. */
function generatePassword(length = 20) {
  let out = '';
  // randomInt is unbiased, unlike modulo-reducing random bytes.
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/**
 * A password of the requested length that is guaranteed to contain at least one
 * symbol, one letter and one digit.
 *
 * One character of each required class is placed first, the remainder is filled
 * at random, and the whole string is then shuffled — so no required character
 * sits in a fixed position, which would be predictable to anyone who has seen
 * one of these before.
 *
 * The order matters. The earlier version filled every position at random and
 * then overwrote one with a symbol, which left the letter and the digit to
 * chance: measured over 1000 runs, 57% came out with no digit at all and 0.2%
 * with no letter. Placing the required characters first is what makes the
 * guarantee real rather than likely.
 *
 * Lengths below 3 cannot hold all three classes. They take as many as fit, in
 * the order symbol, letter, digit, rather than throwing.
 */
function generatePasswordWithSymbol(length = MIN_PASSWORD_LENGTH) {
  if (!Number.isInteger(length) || length < 1) return '';

  const all = ALPHABET + SYMBOLS;
  const required = [SYMBOLS, LETTERS, DIGITS];
  const chars = [];

  const take = Math.min(length, required.length);
  for (let i = 0; i < take; i++) {
    const set = required[i];
    chars.push(set[crypto.randomInt(set.length)]);
  }

  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);

  // Fisher-Yates, so a required character ends up somewhere random.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Checks a password a client has chosen for themselves.
 *
 * Returns an error message, or an empty string when the password is acceptable.
 */
function validateNewPassword(password) {
  const value = String(password || '');

  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (!/[^A-Za-z0-9\s]/.test(value)) {
    return 'Your new password must include at least one symbol, such as @ # $ ! % & or *.';
  }
  return '';
}

module.exports = {
  generatePassword,
  generatePasswordWithSymbol,
  validateNewPassword,
  MIN_PASSWORD_LENGTH,
  SYMBOLS
};
