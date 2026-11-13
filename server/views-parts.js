'use strict';

/* ==========================================================================
   Shared bits of markup.

   passwordField() wraps a password input so it can be revealed with the eye
   icon. The wrapper is the positioning context the CSS uses; the icon carries
   data-target so site.js can find the field even if the markup is rearranged.
   ========================================================================== */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* Two glyphs: an open eye and a struck-through one. Both are always in the DOM
   and CSS shows one or the other, so there is no innerHTML swapping in the
   handler and no way for the icon to get out of step with the field. */
const EYE_OPEN = '<svg class="eye-on" xmlns="http://www.w3.org/2000/svg" width="20" height="20" '
  + 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>'
  + '<circle cx="12" cy="12" r="3"/></svg>';

const EYE_OFF = '<svg class="eye-off" xmlns="http://www.w3.org/2000/svg" width="20" height="20" '
  + 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>'
  + '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>'
  + '<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>'
  + '<line x1="1" y1="1" x2="23" y2="23"/></svg>';

/**
 * Wraps a password input so the eye icon can reveal it.
 *
 * `inputHtml` is the already-built <input>; `inputId` must match its id, which
 * is what the handler uses to find it.
 */
function passwordField(inputHtml, inputId) {
  const id = esc(inputId);

  return `        <div class="password-wrapper">
${inputHtml}
          <span class="toggle-password" role="button" tabindex="0" data-target="${id}"
                aria-pressed="false" aria-label="Show password" title="Show password">
            ${EYE_OPEN}
            ${EYE_OFF}
          </span>
        </div>`;
}

module.exports = { passwordField, EYE_OPEN, EYE_OFF, esc };
