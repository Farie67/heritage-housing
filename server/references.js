'use strict';

/* ==========================================================================
   Payment references.

   A reference is generated from the project's initials plus the date and time
   the payment was keyed in, for example:

       HP-20261002-143052      Heritage Park, 2 Oct 2026 at 14:30:52

   The office never types one, which removes the two ways a hand-typed
   reference goes wrong: a duplicate (the column is unique, so the second entry
   is refused and the payment is not recorded) and an inconsistent format that
   cannot be searched.

   The time is local, not UTC: a receipt number is read by the office and
   quoted by clients, so it must match the clock on the wall.
   ========================================================================== */

/* Words that are not really words in a project name — "Mkoba 21" should give
   MK, not "M2". */
const HAS_LETTER = /[A-Za-z]/;

/**
 * Initials of a project name.
 *
 *   Heritage Park     -> HP
 *   Raylands Estate   -> RE
 *   Goshen Park       -> GP
 *   Gorge of Toronto  -> GOT
 *   Mkoba 21          -> MK     (one word, so the first two letters)
 *   Emganini          -> EM
 *
 * Capped at three letters so references stay short enough to read aloud.
 */
function projectCode(name) {
  const words = String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const withLetters = words.filter((w) => HAS_LETTER.test(w));

  const initials = withLetters.map((w) => w[0].toUpperCase()).join('');
  if (initials.length >= 2) return initials.slice(0, 3);

  // A single-word project gives one initial, which is too weak to search on.
  const only = withLetters[0] || words[0] || '';
  const two = only.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  return two || 'GEN';
}

const pad = (n) => String(n).padStart(2, '0');

/** Local YYYYMMDD-HHMMSS, the part of the reference that makes it unique. */
function timestamp(when) {
  return `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`
    + `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
}

/**
 * Builds a reference that is not already in use.
 *
 * `isTaken` is called with each candidate; two payments entered in the same
 * second for the same project are the only realistic collision, and the
 * second one gets a numeric suffix.
 */
function buildReference({ projectName, when = new Date(), isTaken, fallbackCode = 'HHP' }) {
  const code = projectName ? projectCode(projectName) : fallbackCode;
  const base = `${code}-${timestamp(when)}`;

  if (!isTaken(base)) return base;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!isTaken(candidate)) return candidate;
  }

  // Vanishingly unlikely; still better than handing back a duplicate.
  return `${base}-${when.getMilliseconds()}`;
}

module.exports = { projectCode, timestamp, buildReference };
