'use strict';

/* ==========================================================================
   Staff (sales agent) portal — views.

   Phase 1 is the login shell only: a sign-in page and a dashboard that greets
   the agent. There is no lead list yet; "My Leads" is a placeholder until the
   lead screens are built.

   Rendered inside the public chrome via views-public's layout(), so these
   pages need no CSS of their own and pick up the site header and footer.
   ========================================================================== */

const { esc } = require('./views');
const publicViews = require('./views-public');

/** Wraps a staff page in the public shell. */
function shell(settings, { title, canonicalPath, body }) {
  return publicViews.layout({
    settings,
    title,
    description: 'Staff sign-in for the Heritage Housing Projects sales team.',
    active: '',
    canonicalPath,
    body
  });
}

/**
 * The sign-in page.
 *
 * The form posts back to /staff/login and carries the same CSRF token as every
 * other form on the site — the check in index.js is global and applies here
 * too, so it cannot be omitted.
 */
function staffLogin(settings, { csrf = '', error = '' } = {}) {
  return shell(settings, {
    title: 'Staff Login | Heritage Housing Projects',
    canonicalPath: 'staff/login',
    body: `  <section class="container inner-page">
    <span class="eyebrow dark">STAFF</span>
    <h1>Staff sign-in</h1>
    <p class="muted">For the Heritage Housing Projects sales team.</p>

    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="client-card" style="max-width:460px">
      <form method="post" action="/staff/login" class="stack">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label for="identifier">Email or name</label>
        <input id="identifier" name="identifier" type="text" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </div>

    <p class="muted" style="margin-top:18px"><a class="text-btn" href="/">Back to the website</a></p>
  </section>`
  });
}

/** The dashboard. Phase 1: a greeting, a way out, and the leads placeholder. */
function staffDashboard(settings, { agent, csrf = '' } = {}) {
  return shell(settings, {
    title: 'My Leads | Heritage Housing Projects',
    canonicalPath: 'staff',
    body: `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">STAFF</span>
        <h1>Welcome, ${esc(agent.name)}</h1>
        <p class="muted">Signed in as ${esc(agent.email || agent.name)}.</p>
      </div>
      <form method="post" action="/staff/logout" class="inline-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <button class="btn outline" type="submit">Sign out</button>
      </form>
    </div>

    <div class="client-card">
      <h2>My Leads</h2>
      <p class="muted">Lead management is not switched on yet. Leads assigned to
        you will appear here once it is.</p>
    </div>
  </section>`
  });
}

module.exports = { staffLogin, staffDashboard };
