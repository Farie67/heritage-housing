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
  const leadRows = leads.length ? leads.map((l) => `          <tr>
            <td><strong>${esc(l.full_name)}</strong></td>
            <td>${l.phone ? esc(l.phone) : '<span class="muted">&mdash;</span>'}</td>
            <td>${l.email ? esc(l.email) : '<span class="muted">&mdash;</span>'}</td>
            <td>${l.source ? esc(l.source) : '<span class="muted">&mdash;</span>'}</td>
            <td>${esc(l.status)}</td>
            <td>${l.budget ? esc(l.budget) : '<span class="muted">&mdash;</span>'}</td>
            <td>${l.follow_up_date ? esc(l.follow_up_date) : '<span class="muted">&mdash;</span>'}</td>
            <td class="actions"><a class="text-btn" href="/staff/lead/${esc(l.id)}">Manage</a></td>
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

    <div class="notice ${followUps.length ? 'error alert-critical' : ''}">
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

    <div class="client-card" style="margin-top:20px">
      <h2>Change Password</h2>
      <p class="field-hint" style="margin-bottom:14px">Changing this signs you out on every
        other device.</p>

      <form method="post" action="/staff/password">
        <input type="hidden" name="csrf" value="${esc(csrf)}">

        <label for="currentPassword">Current password</label>
        <input id="currentPassword" name="currentPassword" type="password"
               autocomplete="current-password" required>

        <label for="newPassword">New password</label>
        <input id="newPassword" name="newPassword" type="password"
               autocomplete="new-password" minlength="8" required>

        <label for="confirmPassword">Confirm new password</label>
        <input id="confirmPassword" name="confirmPassword" type="password"
               autocomplete="new-password" minlength="8" required>

        <button class="btn primary" type="submit">Update Password</button>
      </form>
    </div>
  </section>`
  });
}

/**
 * One lead, in full.
 *
 * Opened from the dashboard's Manage link. The route has already confirmed the
 * lead belongs to this agent, so nothing here needs to guard against that — but
 * nothing here takes an id from the visitor either.
 */
function renderStaffLeadDetail(settings, {
  agent, lead, notes = [], csrf = '', notice = '', error = ''
} = {}) {
  const logItems = notes.length ? notes.map((n) => `        <li>
          <span class="muted">${esc(formatDate(n.created_at))} &middot; ${esc(n.agent_name)}</span><br>
          ${esc(n.note_text)}
        </li>`).join('\n')
    : '        <li class="muted">No notes yet.</li>';

  const field = (label, value) => `          <div><small>${esc(label)}</small><strong>${value
    ? esc(value) : '&mdash;'}</strong></div>`;

  return shell(settings, {
    title: `${lead.full_name} | Heritage Housing Projects`,
    canonicalPath: `staff/lead/${lead.id}`,
    body: `  <section class="container inner-page">
    <p><a class="text-btn" href="/staff">&larr; Back to my leads</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">LEAD</span>
        <h1>${esc(lead.full_name)}</h1>
        <p class="muted">${esc(lead.status)}${lead.follow_up_date
      ? ` &middot; follow-up ${esc(lead.follow_up_date)}` : ''}</p>
      </div>
    </div>

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="client-card">
      <h2>Details</h2>
      <div class="mini-grid">
${field('Phone', lead.phone)}
${field('Email', lead.email)}
${field('Source', lead.source)}
${field('Status', lead.status)}
${field('Budget', lead.budget)}
${field('Follow-up date', lead.follow_up_date)}
      </div>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Update this lead</h2>
      <form method="post" action="/staff/lead/${esc(lead.id)}/update">
        <input type="hidden" name="csrf" value="${esc(csrf)}">

        <label for="status">Status</label>
        <select id="status" name="status">
${LEAD_STATUSES.map((s) => `          <option${s === lead.status ? ' selected' : ''}>${esc(s)}</option>`).join('\n')}
        </select>

        <label for="followUpDate">Follow-up date</label>
        <input id="followUpDate" name="followUpDate" type="date" value="${esc(lead.follow_up_date || '')}">

        <label for="notes">Notes</label>
        <textarea id="notes" name="notes" rows="3" maxlength="2000">${esc(lead.notes || '')}</textarea>

        <button class="btn primary" type="submit">Save changes</button>
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Add a note</h2>
      <p class="field-hint" style="margin-bottom:14px">Every conversation goes on the record,
        so the office can see what was said.</p>

      <form method="post" action="/staff/lead/${esc(lead.id)}/note">
        <input type="hidden" name="csrf" value="${esc(csrf)}">

        <label for="noteText">Note</label>
        <textarea id="noteText" name="noteText" rows="3" maxlength="2000" required
                  placeholder="What was said?"></textarea>

        <button class="btn outline" type="submit">Add note</button>
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Timeline (${notes.length})</h2>
      <ul style="margin:10px 0 0;padding-left:18px">
${logItems}
      </ul>
    </div>
  </section>`
  });
}

module.exports = { staffLogin, staffDashboard, renderStaffLeadDetail };
