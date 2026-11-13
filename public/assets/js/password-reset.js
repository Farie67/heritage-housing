'use strict';

/* ==========================================================================
   "Forgot password?" — three steps, no page reloads.

   Shared by the admin, staff and client logins. The markup is built here rather
   than repeated in three templates, so the three portals cannot drift apart: a
   page only needs

     <a href="#" data-password-reset="admin">Forgot password?</a>
     <script src="/assets/js/password-reset.js" defer></script>

   data-password-reset is the portalType the API expects: admin, staff or client.
   ========================================================================== */

(function () {
  var trigger = document.querySelector('[data-password-reset]');
  if (!trigger) return;

  var portalType = trigger.getAttribute('data-password-reset');

  /* Same double-submit token the rest of the site uses: the server sets a
     readable `csrf` cookie and this echoes it back in a header. */
  function csrfToken() {
    var match = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken(),
        Accept: 'application/json'
      },
      credentials: 'same-origin',
      body: new URLSearchParams(data).toString()
    }).then(function (res) {
      return res.json().catch(function () { return { error: 'Unexpected reply from the server.' }; });
    });
  }

  /* ── Markup ─────────────────────────────────────────────────────────────
     Built once, hidden until asked for. .portal-panel is the same card the
     login forms use, so the dialog belongs to the page visually. */
  var overlay = document.createElement('div');
  overlay.className = 'pr-overlay';
  overlay.setAttribute('hidden', '');
  overlay.innerHTML =
    '<div class="portal-panel narrow pr-panel" role="dialog" aria-modal="true" aria-labelledby="pr-title">' +
      '<button type="button" class="pr-close" aria-label="Close">&times;</button>' +
      '<h2 id="pr-title" style="margin-top:0">Reset your password</h2>' +
      '<p class="pr-status" role="status" aria-live="polite"></p>' +

      '<div class="pr-step" data-step="1">' +
        '<p class="field-hint">Enter the email or client number on your account. ' +
          'We will send a 6-digit code to the email we hold for you.</p>' +
        '<label for="pr-identifier">Email or client number</label>' +
        '<input id="pr-identifier" type="text" autocomplete="username">' +
        '<button type="button" class="btn primary full" data-action="send">Send OTP</button>' +
      '</div>' +

      '<div class="pr-step" data-step="2" hidden>' +
        '<p class="field-hint">Enter the 6-digit code from the email.</p>' +
        '<label for="pr-otp">6-digit code</label>' +
        '<input id="pr-otp" type="text" inputmode="numeric" maxlength="6" ' +
          'autocomplete="one-time-code" pattern="[0-9]{6}">' +
        '<button type="button" class="btn primary full" data-action="verify">Verify</button>' +
        '<p class="field-hint"><a href="#" class="text-btn" data-action="restart">Use a different account</a></p>' +
      '</div>' +

      '<div class="pr-step" data-step="3" hidden>' +
        '<p class="field-hint">Choose a new password of at least 8 characters.</p>' +
        '<label for="pr-password">New password</label>' +
        '<input id="pr-password" type="password" autocomplete="new-password">' +
        '<label for="pr-password2">Confirm new password</label>' +
        '<input id="pr-password2" type="password" autocomplete="new-password">' +
        '<button type="button" class="btn primary full" data-action="reset">Reset Password</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  var panel = overlay.querySelector('.pr-panel');
  var statusEl = overlay.querySelector('.pr-status');
  var identifierEl = overlay.querySelector('#pr-identifier');
  var otpEl = overlay.querySelector('#pr-otp');
  var passwordEl = overlay.querySelector('#pr-password');
  var password2El = overlay.querySelector('#pr-password2');

  var step = 1;
  var identifier = '';
  var otp = '';

  function show(next) {
    step = next;
    overlay.querySelectorAll('.pr-step').forEach(function (el) {
      el.hidden = Number(el.getAttribute('data-step')) !== next;
    });
    var focus = next === 1 ? identifierEl : next === 2 ? otpEl : passwordEl;
    if (focus) focus.focus();
  }

  function say(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = 'pr-status' + (kind ? ' pr-' + kind : '');
  }

  function open() {
    overlay.removeAttribute('hidden');
    document.body.classList.add('pr-open');
    show(1);
    say('');
    identifierEl.focus();
  }

  function close() {
    overlay.setAttribute('hidden', '');
    document.body.classList.remove('pr-open');
    say('');
    trigger.focus();
  }

  function busy(button, on) {
    if (!button) return;
    button.disabled = on;
    button.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  /* ── Step 1 ── */
  overlay.querySelector('[data-action="send"]').addEventListener('click', function () {
    var button = this;
    var value = identifierEl.value.trim();
    if (!value) { say('Enter your email or client number.', 'error'); return; }

    busy(button, true);
    say('Sending\u2026');

    post('/api/auth/forgot-password', { identifier: value, portalType: portalType })
      .then(function (data) {
        if (data && data.ok) {
          identifier = value;
          say(data.message || 'A code has been sent.', 'ok');
          show(2);
        } else {
          say((data && data.error) || 'That did not work. Please try again.', 'error');
        }
      })
      .catch(function () { say('Could not reach the server. Check your connection.', 'error'); })
      .then(function () { busy(button, false); });
  });

  /* ── Step 2 ── */
  overlay.querySelector('[data-action="verify"]').addEventListener('click', function () {
    var button = this;
    var value = otpEl.value.trim();
    if (!/^\d{6}$/.test(value)) { say('Enter the 6-digit code from the email.', 'error'); return; }

    busy(button, true);
    say('Checking\u2026');

    post('/api/auth/verify-otp', { identifier: identifier, otp: value, portalType: portalType })
      .then(function (data) {
        if (data && data.ok) {
          otp = value;
          say('Code accepted. Choose a new password.', 'ok');
          show(3);
        } else {
          say((data && data.error) || 'That code is wrong or has expired.', 'error');
        }
      })
      .catch(function () { say('Could not reach the server. Check your connection.', 'error'); })
      .then(function () { busy(button, false); });
  });

  /* ── Step 3 ── */
  overlay.querySelector('[data-action="reset"]').addEventListener('click', function () {
    var button = this;
    var p1 = passwordEl.value;
    var p2 = password2El.value;

    if (p1.length < 8) { say('Choose a password of at least 8 characters.', 'error'); return; }
    if (p1 !== p2) { say('The two passwords do not match.', 'error'); return; }

    busy(button, true);
    say('Saving\u2026');

    post('/api/auth/reset-password-otp', {
      identifier: identifier, otp: otp, newPassword: p1, portalType: portalType
    })
      .then(function (data) {
        if (data && data.ok) {
          say(data.message || 'Your password has been changed. You can sign in now.', 'ok');
          passwordEl.value = '';
          password2El.value = '';
          otpEl.value = '';
          /* Put the new password in the form they came from, so signing in is
             one click away rather than a retype. The identifier goes in too. */
          var loginForm = document.querySelector('.login-form') || document.querySelector('form');
          if (loginForm) {
            var userField = loginForm.querySelector('[name="identifier"], [name="email"], [name="clientNumber"]');
            var passField = loginForm.querySelector('[name="password"]');
            if (userField && !userField.value) userField.value = identifier;
            if (passField) passField.focus();
          }
        } else {
          say((data && data.error) || 'The password could not be changed.', 'error');
        }
      })
      .catch(function () { say('Could not reach the server. Check your connection.', 'error'); })
      .then(function () { busy(button, false); });
  });

  overlay.querySelector('[data-action="restart"]').addEventListener('click', function (event) {
    event.preventDefault();
    otpEl.value = '';
    say('');
    show(1);
  });

  overlay.querySelector('.pr-close').addEventListener('click', close);

  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) close();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !overlay.hasAttribute('hidden')) close();
  });

  trigger.addEventListener('click', function (event) {
    event.preventDefault();
    open();
  });

  /* Enter submits the visible step rather than reloading the login form. */
  overlay.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    var action = step === 1 ? 'send' : step === 2 ? 'verify' : 'reset';
    overlay.querySelector('[data-action="' + action + '"]').click();
  });
})();
