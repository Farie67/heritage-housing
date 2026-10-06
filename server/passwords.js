'use strict';

/* ==========================================================================
   Password generation, shared by the create-admin script and the admin
   password-reset action so both produce the same shape of password.

   These are meant to be read aloud or typed once by hand, so the alphabet
   omits 0/O and 1/l/I, which are the characters people mis-transcribe.
   ========================================================================== */

const crypto = require('node:crypto');

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Returns a cryptographically random password of the requested length. */
function generatePassword(length = 20) {
  let out = '';
  // randomInt is unbiased, unlike modulo-reducing random bytes.
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

module.exports = { generatePassword };
