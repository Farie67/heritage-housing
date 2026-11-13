'use strict';

/* ==========================================================================
   Shared bits of markup.

   passwordField() wraps a password input so it can be revealed with the eye
   icon. The wrapper is the positioning context the CSS uses; site.js finds the
   input by looking inside the nearest .password-wrapper.
   ========================================================================== */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ONE glyph, always the same shape. The earlier attempt put two SVGs in the DOM
   and swapped them with CSS; when that rule did not apply both icons showed at
   once. A single icon cannot do that, and the .active class is enough to show
   the state (site.js also flips aria-pressed). */
const EYE = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" '
  + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>'
  + '<circle cx="12" cy="12" r="3"/></svg>';

/**
 * Wraps a password input so the eye icon can reveal it.
 *
 * `inputHtml` is the already-built <input>; it must keep its own id so labels
 * and autofill still work.
 *
 * The styles are inline on purpose: the button is the one thing that must be
 * positioned correctly inside the field, and an inline rule cannot be lost to
 * a stale or partially-applied stylesheet.
 */
function passwordField(inputHtml, inputId) {
  return `        <div class="password-wrapper" style="position: relative; width: 100%;">
${inputHtml}
          <button type="button" class="toggle-password" data-target="${esc(inputId)}"
                  aria-pressed="false" aria-label="Show password" title="Show password"
                  style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); line-height: 0;">
            ${EYE}
          </button>
        </div>`;
}

/**
 * The three-step reset form, as markup that lives inside the login card.
 *
 * Hidden until site.js swaps the card's #login-view for this one. Kept in the
 * template rather than built by JavaScript so the fields sit in the same card,
 * inherit the same form styling, and are present even before a script runs.
 *
 * The default `method`/`action` are never used: password-reset.js intercepts
 * the buttons and talks to /api/auth/* instead. They are here so an
 * unscripted submit reloads the page rather than doing something surprising.
 */
function resetForm(portalType) {
  const portal = esc(portalType);

  return `      <div id="reset-view" style="display: none;">
        <h1 style="font-size:30px">Reset password</h1>
        <p class="muted">We will email you a 6-digit code.</p>

        <p class="pr-status" role="status" aria-live="polite"></p>

        <form class="login-form pr-step" data-step="1">
          <label for="pr-identifier">Email or client number</label>
          <input id="pr-identifier" type="text" autocomplete="username">
          <button type="button" class="btn primary full" data-action="send">Send OTP</button>
        </form>

        <form class="login-form pr-step" data-step="2" hidden>
          <label for="pr-otp">6-digit code</label>
          <input id="pr-otp" type="text" inputmode="numeric" maxlength="6"
                 autocomplete="one-time-code" pattern="[0-9]{6}">
          <button type="button" class="btn primary full" data-action="verify">Verify</button>
        </form>

        <form class="login-form pr-step" data-step="3" hidden>
          <label for="pr-password">New password</label>
          <input id="pr-password" type="password" autocomplete="new-password">
          <label for="pr-password2">Confirm new password</label>
          <input id="pr-password2" type="password" autocomplete="new-password">
          <button type="button" class="btn primary full" data-action="reset">Reset Password</button>
        </form>

        <p class="muted" style="margin-top:14px;text-align:center">
          <a href="#" class="text-btn" data-action="back">Back to Sign in</a>
        </p>

        <span data-portal="${portal}" hidden></span>
      </div>`;
}

module.exports = { passwordField, resetForm, EYE, esc };
