'use strict';

/* ==========================================================================
   Three-step password reset — the behaviour behind the markup in the card.

   The form itself lives in the login template (#reset-view), not here. This
   file only:
     - reads the portal type from [data-portal] or the "Forgot password?" link
     - posts each step to /api/auth/*
     - moves between step 1, 2 and 3

   Show/hide of the whole reset card is handled by site.js, so there is no
   overlay, no close button and nothing appended to <body>.
   ========================================================================== */

(function () {
  var resetView = document.getElementById('reset-view');
  if (!resetView) return;

  var loginView = document.getElementById('login-view');

  /* Which portal this card belongs to: the hidden span inside the reset view,
     else the link that opens it, else the path. */
  function portalType() {
    var marker = resetView.querySelector('[data-portal]');
    if (marker && marker.getAttribute('data-portal')) return marker.getAttribute('data-portal');

    var link = document.querySelector('[data-password-reset]');
    if (link) return link.getAttribute('data-password-reset');

    if (location.pathname.indexOf('/admin') === 0) return 'admin';
    if (location.pathname.indexOf('/staff') === 0) return 'staff';
    return 'client';
  }

  var portal = portalType();

  var identifierEl = resetView.querySelector('#pr-identifier');
  var otpEl = resetView.querySelector('#pr-otp');
  var passwordEl = resetView.querySelector('#pr-password');
  var password2El = resetView.querySelector('#pr-password2');
  var statusEl = resetView.querySelector('.pr-status');

  var step = 1;
  var identifier = '';
  var otp = '';

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

  function show(next) {
    step = next;
    resetView.querySelectorAll('.pr-step').forEach(function (el) {
      el.hidden = Number(el.getAttribute('data-step')) !== next;
    });
    var focus = next === 1 ? identifierEl : next === 2 ? otpEl : passwordEl;
    if (focus) focus.focus();
  }

  function say(message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.className = 'pr-status' + (kind ? ' pr-' + kind : '');
  }

  function busy(button, on) {
    if (!button) return;
    button.disabled = on;
    button.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  /* Step 1 */
  resetView.querySelector('[data-action="send"]').addEventListener('click', function () {
    var button = this;
    var value = identifierEl.value.trim();
    if (!value) { say('Enter your email or client number.', 'error'); return; }

    busy(button, true);
    say('Sending\u2026');

    post('/api/auth/forgot-password', { identifier: value, portalType: portal })
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

  /* Step 2 */
  resetView.querySelector('[data-action="verify"]').addEventListener('click', function () {
    var button = this;
    var value = otpEl.value.trim();
    if (!/^\d{6}$/.test(value)) { say('Enter the 6-digit code from the email.', 'error'); return; }

    busy(button, true);
    say('Checking\u2026');

    post('/api/auth/verify-otp', { identifier: identifier, otp: value, portalType: portal })
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

  /* Step 3 */
  resetView.querySelector('[data-action="reset"]').addEventListener('click', function () {
    var button = this;
    var p1 = passwordEl.value;
    var p2 = password2El.value;

    if (p1.length < 8) { say('Choose a password of at least 8 characters.', 'error'); return; }
    if (p1 !== p2) { say('The two passwords do not match.', 'error'); return; }

    busy(button, true);
    say('Saving\u2026');

    post('/api/auth/reset-password-otp', {
      identifier: identifier, otp: otp, newPassword: p1, portalType: portal
    })
      .then(function (data) {
        if (data && data.ok) {
          say(data.message || 'Your password has been changed. You can sign in now.', 'ok');

          /* Put them back on the sign-in view with the identifier filled in, so
             signing in is one click rather than a retype. */
          var userField = loginView
            ? loginView.querySelector('[name="identifier"], [name="email"], [name="clientNumber"]')
            : null;
          if (userField && !userField.value) userField.value = identifier;

          passwordEl.value = '';
          password2El.value = '';
          otpEl.value = '';

          var back = resetView.querySelector('[data-action="back"]');
          if (back) back.click();
          var passField = loginView ? loginView.querySelector('[name="password"]') : null;
          if (passField) passField.focus();
        } else {
          say((data && data.error) || 'The password could not be changed.', 'error');
        }
      })
      .catch(function () { say('Could not reach the server. Check your connection.', 'error'); })
      .then(function () { busy(button, false); });
  });

  /* Enter submits the visible step rather than reloading the page. */
  resetView.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    var target = event.target;
    if (!target || target.tagName !== 'INPUT') return;
    event.preventDefault();
    var action = step === 1 ? 'send' : step === 2 ? 'verify' : 'reset';
    var button = resetView.querySelector('[data-action="' + action + '"]');
    if (button) button.click();
  });

  show(1);
})();
