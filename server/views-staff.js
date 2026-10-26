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
const { sanitizeRichText } = require('./sanitize');
const { staffLogOpen, STAFF_LOG_WINDOW } = require('./format');

/**
 * An activity entry, rendered as markup.
 *
 * Entries are stored as sanitised HTML now that the log has an editor — showing
 * them through esc() would print the tags. They are sanitised AGAIN here rather
 * than trusted: rows written before the editor existed were stored as raw text
 * with no escaping at all, and one of those could contain anything. Cleaning on
 * the way out makes both generations safe to render.
 */
function logBody(text) {
  return sanitizeRichText(text);
}

/**
 * The agent's most recent lead notes, shown under the activity log.
 *
 * Rendered as escaped text inside <p> tags, never as markup. These notes come
 * from a plain textarea — they were never rich text and nothing sanitises them
 * on the way in, so the only safe thing is to show them as text.
 */
function recentNotesBlock(notes) {
  if (!notes.length) {
    return '      <p class="muted" style="margin:0">No lead notes added recently.</p>';
  }

  return notes.map((n) => `      <div style="background:#f4f6fb;padding:10px;border-radius:8px;margin-bottom:10px">
        <p class="muted" style="margin:0 0 4px;font-size:12px">${esc(formatDate(n.created_at))}</p>
        <p style="margin:0 0 4px"><strong>${esc(n.lead_name)}</strong></p>
        <p style="margin:0">${esc(n.note_text)}</p>
      </div>`).join('\n');
}

/** The editor, or the locked notice.
 *
 * The same window the POST route enforces, so the page and the server agree.
 * Hiding the form is a courtesy — the route is what actually refuses.
 */
function activityLogForm(csrf) {
  if (!staffLogOpen()) {
    return `      <p class="notice error">The Daily Activity Log is locked. You can edit this
        between ${esc(STAFF_LOG_WINDOW)}.</p>`;
  }

  const button = (cmd, arg, label, style) =>
    `          <button type="button" class="btn outline" data-cmd="${cmd}"${arg ? ` data-arg="${arg}"` : ''}
                  style="${style || ''}" title="${label}">${label}</button>`;

  return `      <form method="post" action="/staff/log">
        <input type="hidden" name="csrf" value="${esc(csrf)}">

        <label for="richEditor">Today's update</label>

        <div class="rt-toolbar" role="toolbar" aria-label="Formatting"
             style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">
${button('formatBlock', 'H2', 'H2', 'padding:6px 10px')}
${button('formatBlock', 'H3', 'H3', 'padding:6px 10px')}
${button('bold', null, 'B', 'font-weight:700;padding:6px 12px')}
${button('italic', null, 'I', 'font-style:italic;padding:6px 12px')}
${button('underline', null, 'U', 'text-decoration:underline;padding:6px 12px')}
${button('insertOrderedList', null, '1.', 'padding:6px 12px')}
${button('insertUnorderedList', null, '&bull;', 'padding:6px 12px')}
        </div>

        <div id="richEditor" contenteditable="true" role="textbox" aria-multiline="true"
             aria-label="Today's update"
             data-placeholder="Who did you visit? What moved forward?"
             style="min-height:140px;padding:14px;border:1px solid var(--line);border-radius:12px;background:#fff"></div>

        <!-- The form posts this; the script copies the editor's HTML into it. -->
        <input type="hidden" name="logText" id="logText" value="">

        <button class="btn primary" type="submit" style="margin-top:12px">Post Update</button>
      </form>

      <script src="/assets/js/log-editor.js" defer></script>`;
}
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
 * Laid out like the Client Portal login: a centred .portal-shell holding a
 * .portal-panel.narrow. The shell is what puts the panel in the middle of the
 * viewport (display:grid; place-items:center) rather than letting it hug the
 * left edge inside a .container.
 *
 * The form itself is left-aligned on purpose: labels above inputs read badly
 * when centred, and the client page does the same. Only the heading and the
 * intro line are centred.
 *
 * The form posts back to /staff/login and carries the same CSRF token as every
 * other form on the site — the check in index.js is global and applies here
 * too, so it cannot be omitted.
 */
function staffLogin(settings, { csrf = '', error = '' } = {}) {
  return shell(settings, {
    title: 'Staff Login | Heritage Housing Projects',
    canonicalPath: 'staff/login',
    body: `  <section class="staff-login-bg">
    <div class="portal-panel narrow" style="text-align:center">
      <h1 style="font-size:30px">Staff sign-in</h1>
      <p class="muted">For the Heritage Housing Projects sales team.</p>

      ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

      <form method="post" action="/staff/login" class="login-form" style="text-align:left">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label for="identifier">Email or name</label>
        <input id="identifier" name="identifier" type="text" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="btn primary full" type="submit">Sign in</button>
      </form>

      <p class="muted" style="margin-top:18px"><a class="text-btn" href="/">Back to the website</a></p>
    </div>
  </section>`
  });
}

/** The dashboard: the agent's leads and their own daily activity log. */
/**
 * The office's feedback on one update, as shown to the agent.
 *
 * Empty string when there is none, so the ordinary case adds nothing at all to
 * the page. Coloured with .notice.info, which is the same blue box the rest of
 * the site uses for a neutral message from the office.
 */
function adminFeedback(comments = []) {
  return comments.map((c) => `            <div class="notice info" style="margin:8px 0 0">
              <strong>Admin Feedback</strong>
              <span class="muted">&middot; ${esc(formatDate(c.created_at))}${c.admin_name
    ? ` &middot; ${esc(c.admin_name)}` : ''}</span><br>
              ${esc(c.comment_text)}
            </div>`).join('\n');
}

/**
 * The badge itself.
 *
 * Red, deliberately: --gold is the brand red the stylesheet already uses for
 * small coloured text on white, so it stays readable. .status.open alone would
 * have been amber, and the point of this is that it stands out.
 *
 * Counts UNREAD feedback only. The routes pass the number in, computed across
 * every log the agent owns — not just the handful a page happens to show.
 */
function commentBadge(unread) {
  const n = Number(unread) || 0;
  if (!n) return '';
  return ` <span class="status open" style="color:var(--gold);font-weight:700">${esc(n)} new comment${n === 1 ? '' : 's'}</span>`;
}

function staffDashboard(settings, {
  agent, csrf = '', leads = [], logs = [], followUps = [], projects = [],
  topSales = [], topOverdue = [], values = {}, recentLeadNotes = [], unread = 0,
  notice = '', error = ''
} = {}) {
  /* What the agent typed, so a rejected form comes back filled in rather than
     blank. Every field falls back to empty on a first render. */
  const v = (key) => esc(values[key] == null ? '' : values[key]);
  /* Both leaderboards share one shape: a numbered list, or "No data yet."
     The first place is bolded and coloured — --gold is the darkened brand red,
     which the stylesheet already uses for exactly this reason (small coloured
     text on white). */
  /* The icon is a fixed-size decorative glyph in its own span. Left inside the
     heading it inherits the text size and grows with it; pinned at 24px it
     stays a label rather than a picture, and vertical-align keeps it sitting on
     the same line as the words. aria-hidden keeps it out of a screen reader's
     reading, since the heading already says what the card is. */
  const icon = (glyph) =>
    `<span aria-hidden="true" style="font-size:24px;margin-right:10px;vertical-align:middle">${glyph}</span>`;

  /* One renderer for both lists, so the two cards cannot drift apart.
     `label` turns a row into the count text, because the two lists do not
     pluralise the same way: "3 sales" takes an s, but "3 overdue" does not —
     overdue is an adjective, not a count noun. `empty` is the message shown
     when there is nothing to rank. */
  const leaderboard = (rows, label, empty) => (rows.length
    ? `<ol style="margin:0;padding-left:20px">
${rows.map((r, i) => `        <li${i === 0 ? ' style="font-weight:700;color:var(--gold)"' : ''}>${esc(r.name)} &mdash; ${esc(label(r))}</li>`).join('\n')}
      </ol>`
    : `<p class="muted" style="margin:0">${esc(empty)}</p>`);

  /* A lead the office filed is shown in red, so an agent can tell an approach
     that was handed to them from one they found themselves, at a glance.
     <strong> already carries the weight; only the colour is added. */
  const leadName = (l) => (l.created_by === 'admin'
    ? `<strong style="color:var(--red)">${esc(l.full_name)}</strong>`
    : `<strong>${esc(l.full_name)}</strong>`);

  const leadRows = leads.length ? leads.map((l) => `          <tr>
            <td>${leadName(l)}</td>
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
            <td>${logBody(g.log_text)}${adminFeedback(g.comments)}</td>
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

    <div class="client-grid" style="grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));margin-top:20px">
      <div class="client-card">
        <h3>${icon('&#127942;')}Top Sales Agents</h3>
        <p class="field-hint" style="margin-bottom:12px">Stands sold, all time.</p>
${leaderboard(topSales, (r) => `${r.sales} sale${r.sales === 1 ? '' : 's'}`, 'No sales recorded yet.')}
      </div>

      <div class="client-card">
        <h3>${icon('&#9888;&#65039;')}Most Overdue Follow-ups</h3>
        <p class="field-hint" style="margin-bottom:12px">Open leads past their follow-up date.</p>
${topOverdue.length
    ? leaderboard(topOverdue, (r) => `${r.overdue} overdue`, '')
    : `<p class="notice success" style="margin:0;font-size:1rem">&#127881; You have no overdue
        follow-ups. Great job!</p>`}
      </div>
    </div>

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
        <input id="leadName" name="fullName" type="text" required maxlength="120" value="${v('fullName')}">

        <label for="leadPhone">Phone</label>
        <input id="leadPhone" name="phone" type="tel" maxlength="40" value="${v('phone')}">

        <label for="leadEmail">Email</label>
        <input id="leadEmail" name="email" type="email" maxlength="160" value="${v('email')}">

        <label for="leadBudget">Budget</label>
        <input id="leadBudget" name="budget" type="text" maxlength="60" placeholder="US$5,000" value="${v('budget')}">

        <label for="leadSource">Source</label>
        <select id="leadSource" name="source">
${['Walk-in', 'WhatsApp', 'Referral', 'Phone call', 'Website', 'Other'].map((s) => `          <option${values.source === s ? ' selected' : ''}>${s}</option>`).join('\n')}
        </select>

        <label for="leadProject">Location of interest</label>
        <select id="leadProject" name="projectId">
          <option value="">Not decided yet</option>
${projects.map((p) => `          <option value="${esc(p.id)}"${String(values.projectId) === String(p.id) ? ' selected' : ''}>${esc(p.name)}</option>`).join('\n')}
        </select>

        <button class="btn primary" type="submit">Save Lead</button>
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Daily Activity Log${commentBadge(unread)}</h2>
      <p class="field-hint" style="margin-bottom:14px">What you did today, with formatting. The
        office sees these too.</p>
${activityLogForm(csrf)}

      <hr style="border:0;border-top:1px solid var(--line);margin:20px 0 16px">

      <h4>Recent Lead Notes</h4>
${recentNotesBlock(recentLeadNotes)}
    </div>

    <!-- History last: it is a record to check, not something to act on. -->
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
      <p style="margin-top:14px"><a class="text-btn" href="/staff/activity-logs">View full history &rarr;</a></p>
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
        <h1>${esc(lead.full_name)}${lead.created_by === 'admin'
      ? ' <span style="background:var(--red);color:white;padding:4px 8px;border-radius:4px;font-size:12px;margin-left:10px;vertical-align:middle">Admin Assigned</span>'
      : ''}</h1>
        <p class="muted">${esc(lead.status)}${lead.follow_up_date
      ? ` &middot; follow-up ${esc(lead.follow_up_date)}` : ''}</p>
      </div>
      <form method="post" action="/staff/lead/${esc(lead.id)}/delete" class="inline-form"
            data-confirm="Are you sure you want to delete this lead?">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <button class="btn outline" type="submit">Delete Lead</button>
      </form>
    </div>

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <!-- The reveal is a <details> rather than a script: the site sends
         script-src 'self', which drops inline handlers without any error, so an
         onclick here would simply do nothing. The summary is styled as a button
         so it still reads as one. -->
    <details style="margin-top:18px">
      <summary class="btn outline">Edit Details</summary>
      <div class="client-card" style="margin-top:14px">
        <h2>Contact details</h2>
        <p class="field-hint" style="margin-bottom:14px">Changes the name, phone, email and
          source only. Status and follow-up are on the form below.</p>

        <form method="post" action="/staff/lead/${esc(lead.id)}/edit">
          <input type="hidden" name="csrf" value="${esc(csrf)}">

          <label for="editName">Name</label>
          <input id="editName" name="fullName" type="text" required maxlength="120"
                 value="${esc(lead.full_name)}">

          <label for="editPhone">Phone</label>
          <input id="editPhone" name="phone" type="tel" maxlength="40"
                 value="${esc(lead.phone || '')}">

          <label for="editEmail">Email</label>
          <input id="editEmail" name="email" type="email" maxlength="160"
                 value="${esc(lead.email || '')}">

          <label for="editSource">Source</label>
          <!-- Free text, not the fixed list from the Add form: the office can set
               any source, and a select would silently drop a value it did not
               offer the next time this form was saved. -->
          <input id="editSource" name="source" type="text" maxlength="60"
                 placeholder="Walk-in, referral, website&hellip;"
                 value="${esc(lead.source || '')}">

          <button class="btn primary" type="submit">Save details</button>
        </form>
      </div>
    </details>

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

/**
 * The agent's own full activity history.
 *
 * The route passes only this agent's rows, so there is no filter here and no id
 * in the page — a signed-in agent simply cannot ask for anyone else's.
 */
function renderStaffActivityLogs(settings, { agent, logs = [], unread = 0 } = {}) {
  const rows = logs.length ? logs.map((g) => `          <tr>
            <td>${esc(formatDate(g.created_at))}</td>
            <td>${logBody(g.log_text)}${adminFeedback(g.comments)}</td>
          </tr>`).join('\n')
    : '          <tr><td colspan="2">You have not posted any updates yet.</td></tr>';

  return shell(settings, {
    title: 'My Activity | Heritage Housing Projects',
    canonicalPath: 'staff/activity-logs',
    body: `  <section class="container inner-page">
    <p><a class="text-btn" href="/staff">&larr; Back to my dashboard</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">ACTIVITY</span>
        <h1>My activity${commentBadge(unread)}</h1>
        <p class="muted">Every update you have posted, newest first.</p>
      </div>
    </div>

    <div class="client-card">
      <table class="portal-table">
        <caption>${esc(logs.length)} ${logs.length === 1 ? 'update' : 'updates'}</caption>
        <thead>
          <tr><th scope="col">Date</th><th scope="col">Update</th></tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
  </section>`
  });
}

module.exports = { staffLogin, staffDashboard, renderStaffLeadDetail, renderStaffActivityLogs };
