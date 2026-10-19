'use strict';

/* ==========================================================================
   Staff (sales agent) portal — views.

   Phase 1 is the login shell only: a sign-in page and a dashboard that greets
   the agent. There is no lead list yet; "My Leads" is a placeholder until the
   lead screens are built.

   Rendered inside the public chrome via views-public's layout(), so these
   pages need no CSS of their own and pick up the site header and footer.
   ========================================================================== */

const { esc, formatDate } = require('./views');
const { LEAD_STATUSES } = require('./lead-input');
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

/** The dashboard: the agent's leads and their own daily activity log. */
function staffDashboard(settings, {
  agent, csrf = '', leads = [], logs = [], followUps = [], notice = '', error = ''
} = {}) {
  /* One inline form per lead, opened by its Manage summary. <details> keeps this
     working with no JavaScript, the same way the admin folders do. */
  const manageForm = (l) => `            <details>
              <summary class="text-btn">Manage</summary>
              <form method="post" action="/staff/lead/${esc(l.id)}/update" class="stack"
                    style="margin-top:10px;min-width:230px">
                <input type="hidden" name="csrf" value="${esc(csrf)}">

                <label for="st-${esc(l.id)}">Status</label>
                <select id="st-${esc(l.id)}" name="status">
${LEAD_STATUSES.map((s) => `                  <option${s === l.status ? ' selected' : ''}>${esc(s)}</option>`).join('\n')}
                </select>

                <label for="fu-${esc(l.id)}">Follow-up date</label>
                <input id="fu-${esc(l.id)}" name="followUpDate" type="date" value="${esc(l.follow_up_date || '')}">

                <label for="nt-${esc(l.id)}">Notes</label>
                <textarea id="nt-${esc(l.id)}" name="notes" rows="3" maxlength="2000">${esc(l.notes || '')}</textarea>

                <button class="btn primary" type="submit">Save changes</button>
              </form>
            </details>`;

  const leadRows = leads.length ? leads.map((l) => `          <tr>
            <td><strong>${esc(l.full_name)}</strong></td>
            <td>${l.phone ? esc(l.phone) : '<span class="muted">&mdash;</span>'}</td>
            <td>${l.email ? esc(l.email) : '<span class="muted">&mdash;</span>'}</td>
            <td>${l.source ? esc(l.source) : '<span class="muted">&mdash;</span>'}</td>
            <td>${esc(l.status)}</td>
            <td>${l.budget ? esc(l.budget) : '<span class="muted">&mdash;</span>'}</td>
            <td>${l.follow_up_date ? esc(l.follow_up_date) : '<span class="muted">&mdash;</span>'}</td>
            <td class="actions">${manageForm(l)}</td>
          </tr>`).join('\n')
    : '          <tr><td colspan="8">No leads assigned to you yet.</td></tr>';

  /* Any lead whose follow-up date has arrived or passed and which is still open.
     A closed lead is never chased again. */
  const followUpItems = followUps.length
    ? `      <ul style="margin:8px 0 0;padding-left:18px">
${followUps.map((f) => `        <li><strong>${esc(f.full_name)}</strong> &mdash; due ${esc(f.follow_up_date)}${f.phone ? ` &middot; ${esc(f.phone)}` : ''} <span class="muted">(${esc(f.status)})</span></li>`).join('\n')}
      </ul>`
    : '      <p style="margin:6px 0 0">Nothing due today. You are up to date.</p>';

  const logRows = logs.length ? logs.map((g) => `          <tr>
            <td>${esc(formatDate(g.created_at))}</td>
            <td>${esc(g.log_text)}</td>
          </tr>`).join('\n')
    : '          <tr><td colspan="2">You have not posted an update yet.</td></tr>';

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

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="notice ${followUps.length ? 'error' : ''}">
      <strong>My Follow-ups</strong>
${followUpItems}
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>My Leads</h2>
      <p class="field-hint" style="margin-bottom:14px">Leads the office has assigned to you. Use
        Manage to move one along the pipeline.</p>
      <table class="portal-table">
        <caption>Your leads</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Phone</th>
            <th scope="col">Email</th>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
            <th scope="col">Budget</th>
            <th scope="col">Follow-up</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
${leadRows}
        </tbody>
      </table>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Add a Lead</h2>
      <p class="field-hint" style="margin-bottom:14px">Someone you have spoken to who has not
        become a client yet. The lead is filed against you automatically.</p>

      <form method="post" action="/staff/lead">
        <input type="hidden" name="csrf" value="${esc(csrf)}">

        <label for="leadName">Name</label>
        <input id="leadName" name="fullName" type="text" required maxlength="120">

        <label for="leadPhone">Phone</label>
        <input id="leadPhone" name="phone" type="tel" maxlength="40">

        <label for="leadEmail">Email</label>
        <input id="leadEmail" name="email" type="email" maxlength="160">

        <label for="leadBudget">Budget</label>
        <input id="leadBudget" name="budget" type="text" maxlength="60" placeholder="US$5,000">

        <label for="leadSource">Source</label>
        <select id="leadSource" name="source">
          <option>Walk-in</option>
          <option>WhatsApp</option>
          <option>Referral</option>
          <option>Phone call</option>
          <option>Website</option>
          <option>Other</option>
        </select>

        <button class="btn primary" type="submit">Save Lead</button>
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Daily Activity Log</h2>
      <p class="field-hint" style="margin-bottom:14px">A short note about what you did today.
        The office sees these too.</p>

      <form method="post" action="/staff/log">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label for="logText">Today's update</label>
        <textarea id="logText" name="logText" rows="3" maxlength="2000" required
                  placeholder="Who did you visit? What moved forward?"></textarea>
        <button class="btn primary" type="submit">Post Update</button>
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Your last 5 updates</h2>
      <table class="portal-table">
        <caption>Your recent activity</caption>
        <thead>
          <tr><th scope="col">Date</th><th scope="col">Update</th></tr>
        </thead>
        <tbody>
${logRows}
        </tbody>
      </table>
    </div>
  </section>`
  });
}

module.exports = { staffLogin, staffDashboard };
