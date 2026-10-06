'use strict';

/* ==========================================================================
   Admin views.

   Server-rendered for the same reasons as the client dashboard: the pages work
   with JavaScript disabled, and every value goes through esc() so no stored
   field can ever be interpreted as markup.

   Everything here reuses the esc/money/formatDate helpers from views.js so the
   admin and the client portal cannot drift apart in how they format data.
   ========================================================================== */

const { esc, money, moneyIn, formatDate, formatBytes } = require('./views');

const { logoAbsolute, faviconAbsolute, brandName } = require('./branding');
const { buildReference } = require('./references');
const { PAYMENT_METHODS, PROPERTY_TYPES, STAND_STATUSES, PROJECT_STATUSES } = require('./db');

const NAV = [
  ['/admin', 'Overview'],
  ['/admin/analytics', 'Sales'],
  ['/admin/enquiries', 'Enquiries'],
  ['/admin/clients', 'Clients'],
  ['/admin/properties', 'Properties'],
  ['/admin/projects', 'Projects'],
  ['/admin/content', 'Content']
];

function adminLayout({ title, active = '', user, csrf, body }) {
  const logo = logoAbsolute();
  const favicon = faviconAbsolute();
  const brand = esc(brandName());
  const links = NAV.map(([href, label]) =>
    `      <a href="${href}"${href === active ? ' aria-current="page"' : ''}>${esc(label)}</a>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Heritage Admin</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="${favicon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/styles.css">
</head>
<body>

<a class="skip-link" href="#main">Skip to content</a>

<header class="site-header admin-header">
  <a href="/admin" class="brand">
    <img class="brand-logo" src="${logo}" alt="${brand}">
    <span class="brand-tag">ADMIN</span>
  </a>
  <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="adminNav" aria-label="Toggle navigation">&#9776;</button>
  <nav id="adminNav" aria-label="Admin">
${links}
    <form method="post" action="/admin/logout" class="inline-form">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button class="portal-btn" type="submit">Sign out</button>
    </form>
  </nav>
</header>

<main id="main">
${body}
</main>

<footer>
  <div class="container copyright">
    Signed in as ${esc(user ? user.fullName : '')} (${esc(user ? user.clientNumber : '')}) &middot;
    Heritage Housing Projects admin &middot;
    <a href="/index.html">View public site</a>
  </div>
</footer>

<script src="/assets/js/site.js" defer></script>
</body>
</html>
`;
}

/* ── Sign in ────────────────────────────────────────────────────────────── */

function renderLogin({ error = '', csrf = '', notice = '' }) {
  const logo = logoAbsolute();
  const favicon = faviconAbsolute();
  const brand = esc(brandName());
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin sign in — Heritage Housing Projects</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="${favicon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/styles.css">
</head>
<body>

<a class="skip-link" href="#main">Skip to content</a>

<main id="main">
  <section class="portal-shell">
    <div class="portal-panel narrow">
      <div class="portal-brand">
        <img class="brand-logo" src="${logo}" alt="${brand}">
      </div>
      <p class="brand-tag">STAFF ADMINISTRATION</p>

      <h1 style="font-size:30px">Admin sign in</h1>
      <p class="muted">For Heritage staff. Client accounts sign in at the <a href="/portal.html">client portal</a>.</p>

      ${notice ? `<p class="notice info">${esc(notice)}</p>` : ''}
      ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

      <form method="post" action="/admin/login" class="login-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label for="clientNumber">Staff ID</label>
        <input id="clientNumber" name="clientNumber" type="text" autocomplete="username" required autofocus>

        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>

        <button class="btn primary full" type="submit">Sign in</button>
      </form>
    </div>
  </section>
</main>
</body>
</html>
`;
}

/* ── Overview ───────────────────────────────────────────────────────────── */

function renderDashboard({ counts, recent, clientsByDevelopment = [], user, csrf }) {
  const rows = recent.length
    ? recent.map((e) => `        <tr>
          <td>${esc(formatDate(e.created_at))}</td>
          <td>${esc(e.name)}</td>
          <td>${esc(e.interest)}</td>
          <td>${e.handled_at ? '<span class="status">Handled</span>' : '<span class="status open">Open</span>'}</td>
        </tr>`).join('\n')
    : '        <tr><td colspan="4">No enquiries yet.</td></tr>';

  /* Clients grouped by the development their stand belongs to. A client with
     no sale is listed last, under "Unassigned". */
  const clientGroups = clientsByDevelopment.length
    ? clientsByDevelopment.map((g) => `      <div class="dev-group">
        <h3>${esc(g.development)} <span class="dev-count">${esc(g.clients.length)}</span></h3>
        <ul class="dev-clients">
${g.clients.map((c) => `          <li><a href="/admin/clients/${esc(c.id)}">${esc(c.full_name)}</a> <span class="muted">${esc(c.client_number)}</span></li>`).join('\n')}
        </ul>
      </div>`).join('\n')
    : '      <p class="muted">No clients yet.</p>';

  return `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">OVERVIEW</span>
        <h1>Admin</h1>
        <p class="muted">Everything the office needs, in one place.</p>
      </div>
      <a class="btn primary" href="/admin/enquiries">Open enquiries${counts.open_enquiries ? ` (${counts.open_enquiries})` : ''}</a>
    </div>

    <div class="portal-stat-grid">
      <div class="portal-stat"><small>Clients</small><strong>${esc(counts.clients)}</strong></div>
      <div class="portal-stat"><small>Open enquiries</small><strong>${esc(counts.open_enquiries)}</strong></div>
      <div class="portal-stat"><small>Stands listed</small><strong>${esc(counts.stands)}</strong></div>
    </div>

    <div class="portal-stat-grid">
      <div class="portal-stat"><small>Documents</small><strong>${esc(counts.documents)}</strong></div>
      <div class="portal-stat"><small>Payments recorded</small><strong>${esc(counts.payments)}</strong></div>
      <div class="portal-stat"><small>Total received</small><strong>${esc(money(counts.paid_cents))}</strong></div>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Latest enquiries</h2>
      <table class="portal-table">
        <caption>Most recent contact-form submissions</caption>
        <thead>
          <tr><th scope="col">Received</th><th scope="col">Name</th><th scope="col">Interest</th><th scope="col">Status</th></tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
      <p style="margin-top:16px"><a class="text-btn" href="/admin/enquiries">View all enquiries &rarr;</a></p>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Clients by development</h2>
      <p class="field-hint" style="margin-bottom:14px">Grouped by the development whose stand the
        client bought. A client with no stand yet is listed under Unassigned.</p>
${clientGroups}
    </div>
  </section>`;
}

/* ── Enquiries ──────────────────────────────────────────────────────────── */

function renderEnquiries({ list, counts, user, csrf, flash }) {
  const cards = list.length ? list.map((e) => `      <article class="client-card enquiry${e.handled_at ? ' handled' : ''}">
        <div class="enquiry-head">
          <div>
            <span class="status${e.handled_at ? '' : ' open'}">&#9679; ${e.handled_at ? 'HANDLED' : 'OPEN'}</span>
            <h3>${esc(e.name)}</h3>
          </div>
          <span class="muted">${esc(formatDate(e.created_at))}</span>
        </div>
        <div class="mini-grid">
          <div><small>Phone / WhatsApp</small><strong><a href="tel:${esc(e.phone)}">${esc(e.phone)}</a></strong></div>
          <div><small>Interested in</small><strong>${esc(e.interest)}</strong></div>
        </div>
        <p class="enquiry-message">${esc(e.message)}</p>
        <form method="post" action="/admin/enquiries/${esc(e.id)}/${e.handled_at ? 'reopen' : 'handle'}" class="inline-form">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="btn ${e.handled_at ? 'outline' : 'primary'}" type="submit">
            ${e.handled_at ? 'Reopen' : 'Mark as handled'}
          </button>
        </form>
      </article>`).join('\n') : '      <p class="muted">No enquiries have been submitted yet.</p>';

  return `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">ENQUIRIES</span>
        <h1>Enquiries</h1>
        <p class="muted">${esc(counts.open)} open of ${esc(counts.total)} total.</p>
      </div>
    </div>

    ${flash ? `<p class="notice success">${esc(flash)}</p>` : ''}

${cards}
  </section>`;
}

/* ── Clients ────────────────────────────────────────────────────────────── */

function renderClients({ clients, user, csrf, query = '' }) {
  const rows = clients.length ? clients.map((c) => {
    const purchase = c.purchase_price_cents || 0;
    const balance = Math.max(purchase - c.paid_cents, 0);
    return `        <tr>
          <td><a href="/admin/clients/${esc(c.id)}"><strong>${esc(c.client_number)}</strong></a></td>
          <td>${esc(c.full_name)}${c.disabled ? ' <span class="status open">DISABLED</span>' : ''}</td>
          <td>${c.stand_number ? esc(c.stand_number) + '<br><small class="muted">' + esc(c.project_name) + '</small>' : '<span class="muted">none</span>'}</td>
          <td>${purchase ? esc(money(purchase)) : '<span class="muted">&mdash;</span>'}</td>
          <td>${esc(money(c.paid_cents))}</td>
          <td>${purchase ? esc(money(balance)) : '<span class="muted">&mdash;</span>'}</td>
          <td>${esc(c.email || '')}</td>
        </tr>`;
  }).join('\n') : '        <tr><td colspan="7">No client accounts yet.</td></tr>';

  return `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">CLIENTS</span>
        <h1>Client accounts</h1>
        <p class="muted">${esc(clients.length)} client${clients.length === 1 ? '' : 's'}${query ? ` matching “${esc(query)}”` : ''}.</p>
      </div>
      <a class="btn primary" href="/admin/clients/new">Add a client</a>
    </div>

    <form method="get" action="/admin/clients" class="filters" role="search">
      <div class="field">
        <label for="q">Search</label>
        <input id="q" name="q" type="search" value="${esc(query)}" placeholder="Client number, name or email">
      </div>
      <button class="btn primary" type="submit">Search</button>
      ${query ? '<a class="btn outline" href="/admin/clients">Clear</a>' : ''}
    </form>

    <div class="client-card">
      <table class="portal-table">
        <caption>Every client account, its stand, and its payment position</caption>
        <thead>
          <tr>
            <th scope="col">Client no.</th>
            <th scope="col">Name</th>
            <th scope="col">Stand</th>
            <th scope="col">Purchase</th>
            <th scope="col">Paid</th>
            <th scope="col">Balance</th>
            <th scope="col">Email</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>

    <div class="notice info" style="margin-top:20px">
      Editing clients, recording payments and uploading documents are the next
      phase of this build. This view is read-only for now.
    </div>
  </section>`;
}

/* ── One client ─────────────────────────────────────────────────────────── */

function renderClientDetail({
  client, payments, stands, documents = [], basePath, user, csrf,
  notice = '', error = '', generatedPassword = ''
}) {
  const purchase = client.purchase_price_cents || 0;
  /* Only confirmed money reduces the balance; anything else is money the
     office has been told about but has not verified yet. */
  const paid = payments
    .filter((p) => p.status === 'Confirmed')
    .reduce((sum, p) => sum + p.amount_cents, 0);
  const pending = payments
    .filter((p) => p.status !== 'Confirmed')
    .reduce((sum, p) => sum + p.amount_cents, 0);
  const balance = Math.max(purchase - paid, 0);

  const badges = [
    client.disabled ? '<span class="status open">DISABLED</span>' : '',
    client.locked_until ? '<span class="status open">LOCKED</span>' : ''
  ].filter(Boolean).join(' ');

  /* A preview of the reference the next payment will get, so the shape is
     visible before saving. The real one is generated on submit. */
  const referenceSample = buildReference({
    projectName: client.project_name,
    isTaken: () => false
  });

  /* Stands that are free, plus whichever one this client already holds. */
  const available = stands.filter((s) => !s.held_by || s.held_by === client.client_number);
  const standOptions = available.length
    ? available.map((s) => `          <option value="${esc(s.id)}"${s.id === client.stand_id ? ' selected' : ''}>${esc(s.stand_number)} — ${esc(s.project_name)} (${esc(s.size_sqm)}m&sup2;)${s.held_by ? ' — currently held' : ''}</option>`).join('\n')
    : '          <option value="">No stands available</option>';

  const paymentRows = payments.length ? payments.map((p) => {
    const confirmed = p.status === 'Confirmed';
    return `          <tr>
            <td>${esc(formatDate(p.paid_on))}</td>
            <td>${esc(p.reference)}</td>
            <td>${esc(money(p.amount_cents))}</td>
            <td><span class="status${confirmed ? '' : ' open'}">&#9679; ${esc(String(p.status).toUpperCase())}</span></td>
            <td class="row-actions">
              <form method="post" action="${esc(basePath)}/payments/${esc(p.id)}/status" class="inline-form">
                <input type="hidden" name="csrf" value="${esc(csrf)}">
                <input type="hidden" name="status" value="${confirmed ? 'Pending' : 'Confirmed'}">
                <button class="link-action" type="submit">${confirmed ? 'Mark pending' : 'Confirm'}</button>
              </form>
              <a class="link-action" href="${esc(basePath)}/payments/${esc(p.id)}">Edit</a>
              <form method="post" action="${esc(basePath)}/payments/${esc(p.id)}/delete" class="inline-form"
                    data-confirm="Delete payment ${esc(p.reference)}? This cannot be undone.">
                <input type="hidden" name="csrf" value="${esc(csrf)}">
                <button class="link-danger" type="submit">Delete</button>
              </form>
            </td>
          </tr>`;
  }).join('\n')
    : '          <tr><td colspan="5">No payments recorded.</td></tr>';

  const documentRows = documents.length ? documents.map((d) => `        <div class="document">
          <span>${esc(d.title)}<br><small class="muted">${esc(formatBytes(d.size_bytes))} &middot; ${esc(formatDate(d.uploaded_at))}</small></span>
          <span class="document-actions">
            <a href="/admin/clients/${esc(client.id)}/documents/${esc(d.id)}/download">Download</a>
            <form method="post" action="${esc(basePath)}/documents/${esc(d.id)}/delete" class="inline-form"
                  data-confirm="Delete this document? The file is removed permanently.">
              <input type="hidden" name="csrf" value="${esc(csrf)}">
              <button class="link-danger" type="submit">Delete</button>
            </form>
          </span>
        </div>`).join('\n')
    : '        <p class="muted">No documents shared with this client yet.</p>';

  return `  <section class="container inner-page">
    <p><a class="text-btn" href="/admin/clients">&larr; All clients</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">CLIENT</span>
        <h1>${esc(client.full_name)}</h1>
        <p class="muted">${esc(client.client_number)} &middot; joined ${esc(formatDate(client.created_at))} ${badges}</p>
      </div>
      <a class="btn primary" href="${esc(basePath)}/statement.pdf">Statement (PDF)</a>
    </div>

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    ${generatedPassword ? `<div class="notice info">
      <strong>New password for ${esc(client.client_number)}</strong><br>
      <code class="pw">${esc(generatedPassword)}</code><br>
      Copy it now and give it to the client — it is shown once and only its hash is stored.
      Their existing sessions have been signed out.
    </div>` : ''}

    <div class="client-grid">
      <div class="client-card">
        <h2>Account details</h2>
        <form method="post" action="${esc(basePath)}/update">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <label for="fullName">Full name</label>
          <input id="fullName" name="fullName" type="text" value="${esc(client.full_name)}" required>

          <label for="email">Email</label>
          <input id="email" name="email" type="email" value="${esc(client.email || '')}">

          <button class="btn primary" type="submit">Save details</button>
        </form>
      </div>

      <div class="client-card">
        <h2>Account actions</h2>
        <p class="field-hint">Client number <strong>${esc(client.client_number)}</strong> cannot be changed — it is printed on statements.</p>

        <form method="post" action="${esc(basePath)}/reset-password" class="stack">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="btn outline" type="submit">Reset password</button>
        </form>

        ${client.locked_until ? `<form method="post" action="${esc(basePath)}/unlock" class="stack">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="btn outline" type="submit">Unlock account</button>
        </form>` : ''}

        <form method="post" action="${esc(basePath)}/disable" class="stack"
              ${client.disabled ? '' : 'data-confirm="Disable this account? They will be signed out immediately."'}>
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <input type="hidden" name="disabled" value="${client.disabled ? '0' : '1'}">
          <button class="btn ${client.disabled ? 'primary' : 'outline'}" type="submit">
            ${client.disabled ? 'Re-enable account' : 'Disable account'}
          </button>
        </form>
      </div>
    </div>

    <div class="client-grid" style="margin-top:20px">
      <div class="client-card">
        <h2>Stand</h2>
        ${client.stand_number ? `
        <div class="mini-grid">
          <div><small>Stand</small><strong>${esc(client.stand_number)}</strong></div>
          <div><small>Project</small><strong>${esc(client.project_name)}</strong></div>
          <div><small>Size</small><strong>${esc(client.size_sqm)}m&sup2;</strong></div>
          <div><small>Status</small><strong>${esc(client.ownership_status)}</strong></div>
          <div><small>Purchase price</small><strong>${esc(money(purchase))}</strong></div>
          <div><small>Purchased</small><strong>${esc(formatDate(client.purchase_date))}</strong></div>
        </div>
        <form method="post" action="${esc(basePath)}/unlink" class="stack"
              data-confirm="Unlink this stand? The stand becomes available again.">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="btn outline" type="submit">Unlink stand</button>
        </form>` : `
        <p class="muted">No stand linked to this client yet.</p>
        <form method="post" action="${esc(basePath)}/stand">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <label for="standId">Stand</label>
          <select id="standId" name="standId" required>
${standOptions}
          </select>

          <label for="price">Purchase price (US$)</label>
          <input id="price" name="price" type="text" inputmode="decimal" placeholder="5500.00" required>

          <label for="purchaseDate">Purchase date</label>
          <input id="purchaseDate" name="purchaseDate" type="date" value="${esc(new Date().toISOString().slice(0, 10))}" required>

          <label for="ownershipStatus">Status</label>
          <select id="ownershipStatus" name="ownershipStatus">
            <option>Servicing in progress</option>
            <option>Awaiting transfer</option>
            <option>Transferred</option>
            <option>Paid up</option>
          </select>

          <button class="btn primary" type="submit">Link stand</button>
        </form>`}
      </div>

      <div class="client-card dark">
        <span class="eyebrow">ACCOUNT BALANCE</span>
        <div class="balance">${esc(money(balance))}</div>
        <p>Outstanding balance on this property account.</p>
        <div class="progress" role="img" aria-label="${purchase ? Math.min(Math.round((paid / purchase) * 100), 100) : 0}% of the purchase price has been paid">
          <span style="width:${purchase ? Math.min(Math.round((paid / purchase) * 100), 100) : 0}%"></span>
        </div>
        <p style="margin-top:10px">${esc(money(paid))} paid of ${esc(money(purchase))}</p>
        ${pending ? `<p class="field-hint">${esc(money(pending))} recorded but not yet confirmed, so it is not counted above.</p>` : ''}
      </div>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Payments</h2>
      <table class="portal-table">
        <caption>Payments recorded against this account</caption>
        <thead>
          <tr>
            <th scope="col">Date</th><th scope="col">Reference</th><th scope="col">Amount</th>
            <th scope="col">Status</th><th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
${paymentRows}
        </tbody>
      </table>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Record a payment</h2>
      <form method="post" action="${esc(basePath)}/payments" class="payment-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <div class="field">
          <label for="paidOn">Date received</label>
          <input id="paidOn" name="paidOn" type="date" value="${esc(new Date().toISOString().slice(0, 10))}" required>
        </div>
        <div class="field">
          <label for="referencePreview">Reference</label>
          <input id="referencePreview" type="text" value="${esc(referenceSample)}" readonly>
          <p class="field-hint">Generated on save from the project initials and the time of entry — no need to type one.</p>
        </div>
        <div class="field">
          <label for="amount">Amount (US$)</label>
          <input id="amount" name="amount" type="text" inputmode="decimal" placeholder="1500.00" required>
        </div>
        <div class="field">
          <label for="paymentStatus">Status</label>
          <select id="paymentStatus" name="status">
            <option>Confirmed</option>
            <option>Pending</option>
          </select>
        </div>
        <div class="field">
          <label for="paymentMethod">Payment method</label>
          <select id="paymentMethod" name="method">
            <option value="">Not recorded</option>
${PAYMENT_METHODS.map((mth) => `            <option>${esc(mth)}</option>`).join('\n')}
          </select>
        </div>
        <div class="field">
          <label for="paymentNotes">Notes</label>
          <input id="paymentNotes" name="notes" type="text" maxlength="300" placeholder="optional">
        </div>
        <div class="field field-submit">
          <button class="btn primary" type="submit">Add payment</button>
        </div>
      </form>
      <p class="field-hint">Amounts are stored as whole cents, so the arithmetic on the client's statement is always exact.</p>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Documents</h2>
      <p class="field-hint">PDF files only, up to 8 MB. They are stored outside the web root and streamed
        only to the client they belong to — an admin download is authorised separately.</p>
      <div class="document-list">
${documentRows}
      </div>

      <form method="post" action="${esc(basePath)}/documents" enctype="multipart/form-data" class="upload-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <div class="field">
          <label for="docTitle">Document title</label>
          <input id="docTitle" name="title" type="text" required maxlength="120" placeholder="e.g. Agreement of Sale">
        </div>
        <div class="field">
          <label for="docFile">PDF file</label>
          <input id="docFile" name="file" type="file" accept="application/pdf,.pdf" required>
        </div>
        <div class="field field-submit">
          <button class="btn primary" type="submit">Upload document</button>
        </div>
      </form>
    </div>
  </section>`;
}

/* ── New client ─────────────────────────────────────────────────────────── */

function renderNewClient({ suggestedNumber, user, csrf, error = '', created = null }) {
  return `  <section class="container inner-page">
    <p><a class="text-btn" href="/admin/clients">&larr; All clients</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">NEW CLIENT</span>
        <h1>Add a client</h1>
        <p class="muted">A password is generated for you and shown once.</p>
      </div>
    </div>

    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    ${created ? `<div class="notice info">
      <strong>Client ${esc(created.clientNumber)} created</strong><br>
      Password: <code class="pw">${esc(created.password)}</code><br>
      Give these to the client now — the password is shown once and only its hash is stored.
      They can sign in at <a href="/portal.html">/portal.html</a>.
    </div>` : ''}

    <div class="client-card">
      <form method="post" action="/admin/clients">
        <input type="hidden" name="csrf" value="${esc(csrf)}">

        <label for="clientNumber">Client number</label>
        <input id="clientNumber" name="clientNumber" type="text" value="${esc(suggestedNumber)}" required maxlength="32">
        <p class="field-hint">Printed on statements, so it cannot be changed later.</p>

        <label for="fullName">Full name</label>
        <input id="fullName" name="fullName" type="text" required maxlength="120">

        <label for="email">Email <span class="optional">(optional)</span></label>
        <input id="email" name="email" type="email" maxlength="160">

        <button class="btn primary" type="submit">Create client</button>
      </form>
    </div>
  </section>`;
}

/* ── Project progress ───────────────────────────────────────────────────── */

const STATE_LABEL = { done: 'Completed', current: 'In progress', pending: 'Pending' };

function stateOptions(selected) {
  return ['done', 'current', 'pending']
    .map((s) => `            <option value="${s}"${s === selected ? ' selected' : ''}>${STATE_LABEL[s]}</option>`)
    .join('\n');
}

/** A <select> from a plain list of strings. */
function optionsFrom(list, selected) {
  return list.map((v) => `            <option${String(selected) === String(v) ? ' selected' : ''}>${esc(v)}</option>`).join('\n');
}

/** A <select> of projects, by id. */
function projectOptions(projects, selected) {
  return projects.map((p) => `            <option value="${esc(p.id)}"${String(selected) === String(p.id) ? ' selected' : ''}>${esc(p.name)}</option>`).join('\n');
}

/* The tag colour is purely to make a long table scannable. */
function statusTag(status) {
  const tone = status === 'Available' ? 'tag-deposit'
    : status === 'Sold' ? 'tag-refund'
      : 'tag-installment';
  return `<span class="tag ${tone}">${esc(status)}</span>`;
}

/* ── Properties (stands) ────────────────────────────────────────────────── */

function propertyFields({ stand = {}, projects, csrf }) {
  const price = stand.price_cents ? (stand.price_cents / 100).toFixed(2) : '';
  return `        <div class="field">
          <label for="p-project">Development</label>
          <select id="p-project" name="project" required>
${projectOptions(projects, stand.project_id)}
          </select>
        </div>
        <div class="field">
          <label for="p-number">Stand / property number</label>
          <input id="p-number" name="standNumber" type="text" value="${esc(stand.stand_number || '')}" required maxlength="40">
          <p class="field-hint">This is what clients see, for example HP-0245.</p>
        </div>
        <div class="field">
          <label for="p-size">Size (m&sup2;)</label>
          <input id="p-size" name="sizeSqm" type="number" min="1" step="1" value="${esc(stand.size_sqm || '')}" required>
        </div>
        <div class="field">
          <label for="p-type">Type</label>
          <select id="p-type" name="type" required>
${optionsFrom(PROPERTY_TYPES, stand.type)}
          </select>
        </div>
        <div class="field">
          <label for="p-price">Price</label>
          <input id="p-price" name="price" type="text" inputmode="decimal" value="${esc(price)}" placeholder="leave blank for on request">
        </div>
        <div class="field">
          <label for="p-currency">Currency</label>
          <input id="p-currency" name="currency" type="text" value="${esc(stand.currency || 'US$')}" maxlength="8">
        </div>
        <div class="field">
          <label for="p-status">Status</label>
          <select id="p-status" name="status" required>
${optionsFrom(STAND_STATUSES, stand.status)}
          </select>
          <p class="field-hint">Status belongs to this property alone. Only <strong>Available</strong>
            ones are offered on the website.</p>
        </div>
        <div class="field">
          <label for="p-location">Location / details</label>
          <input id="p-location" name="location" type="text" value="${esc(stand.location || '')}" maxlength="200" placeholder="inherits the development location if blank">
        </div>
        <div class="field">
          <label for="p-image">Photograph URL</label>
          <input id="p-image" name="imageUrl" type="text" value="${esc(stand.image_url || '')}" maxlength="400" placeholder="https://...">
        </div>
        <div class="field field-wide">
          <label for="p-description">Description</label>
          <textarea id="p-description" name="description" rows="3" maxlength="2000" placeholder="anything specific to this property">${esc(stand.description || '')}</textarea>
        </div>
        <div class="field field-submit">
          <button class="btn primary" type="submit">Save property</button>
        </div>`;
}

function renderProperties({ stands, projects, user, csrf, notice = '', error = '' }) {
  const available = stands.filter((s) => s.status === 'Available').length;
  const sold = stands.filter((s) => s.status === 'Sold').length;

  const rows = stands.length ? stands.map((s) => `        <tr>
          <td><a href="/admin/properties/${esc(s.id)}"><strong>${esc(s.stand_number)}</strong></a></td>
          <td>${esc(s.project_name)}</td>
          <td>${esc(s.size_sqm)}m&sup2;</td>
          <td>${esc(s.type)}</td>
          <td>${s.price_cents == null
    ? '<span class="muted">on request</span>'
    : esc(moneyIn(s.price_cents, s.currency))}</td>
          <td>${statusTag(s.status)}</td>
          <td class="actions">
            <a class="text-btn" href="/admin/properties/${esc(s.id)}">Edit</a>
            ${s.sale_count
    ? `<span class="muted"> &middot; ${esc(s.sale_count)} sale, locked</span>`
    : ` &middot; <form method="post" action="/admin/properties/${esc(s.id)}/delete" class="inline-form"
                    data-confirm="Delete ${esc(s.stand_number)}? This cannot be undone.">
                <input type="hidden" name="csrf" value="${esc(csrf)}">
                <button class="link-danger" type="submit">Delete</button>
              </form>`}
          </td>
        </tr>`).join('\n')
    : '        <tr><td colspan="7">No properties yet. Add the first one below.</td></tr>';

  return `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">PROPERTIES</span>
        <h1>Available properties</h1>
        <p class="muted">These are the stands shown on the website. Editing one here changes what
          clients see on the properties page immediately.</p>
      </div>
    </div>

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="kpi-grid">
      <div class="kpi"><span class="kpi-label">Properties</span><strong class="kpi-value">${esc(stands.length)}</strong></div>
      <div class="kpi"><span class="kpi-label">Available</span><strong class="kpi-value good">${esc(available)}</strong></div>
      <div class="kpi"><span class="kpi-label">Sold</span><strong class="kpi-value">${esc(sold)}</strong></div>
    </div>

    <div class="client-card">
      <table class="portal-table">
        <caption>Every property, by development</caption>
        <thead>
          <tr>
            <th scope="col">Stand No.</th><th scope="col">Development</th><th scope="col">Size</th>
            <th scope="col">Type</th><th scope="col">Price</th><th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
      <p class="field-hint" style="margin-top:12px">Open a property to edit or delete it.</p>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Add a property</h2>
      <form method="post" action="/admin/properties" class="payment-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
${propertyFields({ stand: { status: 'Available', type: 'Residential' }, projects, csrf })}
      </form>
    </div>
  </section>`;
}

function renderPropertyEdit({ stand, projects, user, csrf, notice = '', error = '' }) {
  const canDelete = stand.sale_count === 0;

  return `  <section class="container inner-page">
    <p><a class="text-btn" href="/admin/properties">&larr; All properties</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">PROPERTY</span>
        <h1>${esc(stand.stand_number)}</h1>
        <p class="muted">${esc(stand.project_name)} &middot; ${esc(stand.size_sqm)}m&sup2; &middot; ${statusTag(stand.status)}</p>
      </div>
    </div>

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="client-card">
      <h2>Property details</h2>
      <form method="post" action="/admin/properties/${esc(stand.id)}" class="payment-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
${propertyFields({ stand, projects, csrf })}
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Remove this property</h2>
      ${canDelete
    ? `<p class="muted">This property has no sales against it, so it can be removed safely.</p>
      <form method="post" action="/admin/properties/${esc(stand.id)}/delete" class="inline-form"
            data-confirm="Delete ${esc(stand.stand_number)}? This cannot be undone.">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <button class="link-danger" type="submit">Delete property</button>
      </form>`
    : `<p class="notice info">This property has ${esc(stand.sale_count)} sale recorded against it, so it
        cannot be deleted — removing it would orphan a client's purchase, their payments and the
        sales analytics. Mark it <strong>Sold</strong> instead, or cancel the sale first.</p>`}
    </div>
  </section>`;
}

/**
 * "25 Properties | 18 Available | 5 Sold | 2 Reserved"
 *
 * Counted from the properties themselves on every render, so it can never
 * disagree with the list underneath it.
 */
function propertyBreakdown(p) {
  const n = (v) => Number(v) || 0;
  const parts = [
    `${n(p.property_count)} ${n(p.property_count) === 1 ? 'Property' : 'Properties'}`,
    `${n(p.available_count)} Available`,
    `${n(p.sold_count)} Sold`,
    `${n(p.reserved_count)} Reserved`
  ];
  if (n(p.on_hold_count)) parts.push(`${n(p.on_hold_count)} On hold`);
  return parts.join(' | ');
}

/* ── Developments (projects) ────────────────────────────────────────────── */

function projectFields({ project = {}, csrf }) {
  return `        <div class="field">
          <label for="pr-name">Name</label>
          <input id="pr-name" name="name" type="text" value="${esc(project.name || '')}" required maxlength="80">
          <p class="field-hint">Shown on the website, in the client portal and throughout the sales analytics.</p>
        </div>
        <div class="field">
          <label for="pr-location">Location</label>
          <input id="pr-location" name="location" type="text" value="${esc(project.location || '')}" required maxlength="120">
        </div>
        <div class="field">
          <label for="pr-type">Type</label>
          <select id="pr-type" name="type" required>
${optionsFrom(PROPERTY_TYPES, project.type)}
          </select>
        </div>
        <div class="field">
          <label for="pr-status">Status</label>
          <select id="pr-status" name="status" required>
${optionsFrom(PROJECT_STATUSES, project.status)}
          </select>
        </div>
        <div class="field">
          <label for="pr-image">Photograph URL</label>
          <input id="pr-image" name="imageUrl" type="text" value="${esc(project.image_url || '')}" maxlength="400" placeholder="https://...">
        </div>
        <div class="field">
          <label for="pr-soldout">Availability</label>
          <label class="check-inline"><input id="pr-soldout" name="soldOut" type="checkbox"${project.sold_out ? ' checked' : ''}>
            <span>Sold out &mdash; no stands remaining</span></label>
          <p class="field-hint">Stamps the development as sold out on the website and removes its
            stands from the available properties list.</p>
        </div>
        <div class="field field-wide">
          <label for="pr-description">Short description</label>
          <textarea id="pr-description" name="description" rows="4" maxlength="2000">${esc(project.description || '')}</textarea>
          <p class="field-hint">One or two sentences. Used on the card in the developments list.</p>
        </div>
        <div class="field field-wide">
          <label for="pr-long">Full overview</label>
          <textarea id="pr-long" name="longDescription" rows="6" maxlength="8000" placeholder="The longer write-up shown on this development's own page.">${esc(project.long_description || '')}</textarea>
          <p class="field-hint">Shown under "About" on the development's page. Leave a blank line
            between paragraphs.</p>
        </div>
        <div class="field field-wide">
          <label for="pr-features">Main features (one per line)</label>
          <textarea id="pr-features" name="features" rows="4" maxlength="4000" placeholder="Location: positioned next to ...">${esc(project.features || '')}</textarea>
          <p class="field-hint">Each line becomes a bullet. Start a line with a word and a colon
            &mdash; "Location: &hellip;" &mdash; to show it as a heading.</p>
        </div>
        <div class="field field-submit">
          <button class="btn primary" type="submit">Save development</button>
        </div>`;
}

function renderProjects({ projects, user, csrf, notice = '', error = '' }) {
  const rows = projects.length ? projects.map((p) => `        <tr>
          <td><a href="/admin/projects/${esc(p.id)}"><strong>${esc(p.name)}</strong></a></td>
          <td>${esc(p.location)}</td>
          <td>${esc(p.status)}</td>
          <td>${p.sold_out
    ? '<span class="tag tag-refund">Sold out</span>'
    : '<span class="tag tag-deposit">Selling</span>'}</td>
          <td class="breakdown">${esc(propertyBreakdown(p))}</td>
          <td>
            <a class="text-btn" href="/admin/projects/${esc(p.id)}">Open</a>
            &middot;
            <form method="post" action="/admin/projects/${esc(p.id)}/sold-out" class="inline-form">
              <input type="hidden" name="csrf" value="${esc(csrf)}">
              <input type="hidden" name="soldOut" value="${p.sold_out ? '0' : '1'}">
              <button class="text-btn" type="submit">${p.sold_out ? 'Mark selling again' : 'Mark sold out'}</button>
            </form>
            &middot;
            <form method="post" action="/admin/projects/${esc(p.id)}/delete" class="inline-form"
                  data-confirm="Are you sure? This will delete all associated properties.">
              <input type="hidden" name="csrf" value="${esc(csrf)}">
              <button class="link-danger" type="submit">Delete</button>
            </form>
          </td>
        </tr>`).join('\n')
    : '        <tr><td colspan="6">No developments yet.</td></tr>';

  return `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">DEVELOPMENTS</span>
        <h1>Projects</h1>
        <p class="muted">Edit a development's name and details, and the progress timeline clients
          see in their portal.</p>
      </div>
    </div>

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="client-card">
      <table class="portal-table">
        <caption>Every development and its progress steps</caption>
        <thead>
          <tr>
            <th scope="col">Development</th><th scope="col">Location</th>
            <th scope="col">Build status</th><th scope="col">Availability</th>
            <th scope="col">Properties</th><th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
      <p class="field-hint" style="margin-top:12px">Open a development to rename it or edit its details.</p>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Add a development</h2>
      <form method="post" action="/admin/projects" class="payment-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
${projectFields({ project: { type: 'Residential', status: 'Development' }, csrf })}
      </form>
    </div>
  </section>`;
}

function renderProjectDetail({ project, stands = [], pricing = [], steps, user, csrf,
  notice = '', error = '' }) {
  /* The published price list. Amounts stay as typed text because the list
     legitimately contains ranges. */
  const priceRows = pricing.length ? pricing.map((r) => `      <div class="progress-edit">
        <form method="post" action="/admin/projects/${esc(project.id)}/pricing/${esc(r.id)}" class="progress-row">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <label class="sr-only" for="ps-${esc(r.id)}">Stand size</label>
          <input id="ps-${esc(r.id)}" name="sizeLabel" type="text" value="${esc(r.size_label)}" required maxlength="60">
          <label class="sr-only" for="pc-${esc(r.id)}">Cash price</label>
          <input id="pc-${esc(r.id)}" name="cash" type="text" value="${esc(r.cash || '')}" placeholder="cash" maxlength="40">
          <label class="sr-only" for="pk-${esc(r.id)}">Credit price</label>
          <input id="pk-${esc(r.id)}" name="credit" type="text" value="${esc(r.credit || '')}" placeholder="credit" maxlength="40">
          <label class="sr-only" for="pd-${esc(r.id)}">Minimum deposit</label>
          <input id="pd-${esc(r.id)}" name="deposit" type="text" value="${esc(r.deposit || '')}" placeholder="deposit" maxlength="40">
          <button class="btn outline" type="submit">Save</button>
        </form>
        <form method="post" action="/admin/projects/${esc(project.id)}/pricing/${esc(r.id)}/delete"
              class="inline-form" data-confirm="Delete this price row?">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="link-danger" type="submit">Delete</button>
        </form>
      </div>`).join('\n')
    : '      <p class="muted">No price list yet.</p>';

  /* Every property belonging to this development. One development, many
     properties — this list is the whole point of the parent record. */
  const propertyRows = stands.length ? stands.map((s) => `          <tr>
            <td><a href="/admin/properties/${esc(s.id)}"><strong>${esc(s.stand_number)}</strong></a></td>
            <td>${esc(s.size_sqm)}m&sup2;</td>
            <td>${esc(s.type)}</td>
            <td>${s.price_cents == null
    ? '<span class="muted">on request</span>'
    : esc(moneyIn(s.price_cents, s.currency))}</td>
            <td>${statusTag(s.status)}</td>
            <td>${s.sale_count ? `${esc(s.sale_count)} sale` : '&mdash;'}</td>
            <td><a class="text-btn" href="/admin/properties/${esc(s.id)}">Edit</a></td>
          </tr>`).join('\n')
    : '          <tr><td colspan="7">No properties in this development yet. Add the first one below.</td></tr>';

  const stepRows = steps.length ? steps.map((s) => `      <div class="progress-edit">
        <form method="post" action="/admin/projects/${esc(project.id)}/progress/${esc(s.id)}" class="progress-row">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <label class="sr-only" for="label-${esc(s.id)}">Label for step ${esc(s.position)}</label>
          <input id="label-${esc(s.id)}" name="label" type="text" value="${esc(s.label)}" required maxlength="120">
          <label class="sr-only" for="state-${esc(s.id)}">State for ${esc(s.label)}</label>
          <select id="state-${esc(s.id)}" name="state">
${stateOptions(s.state)}
          </select>
          <button class="btn outline" type="submit">Save</button>
        </form>
        <form method="post" action="/admin/projects/${esc(project.id)}/progress/${esc(s.id)}/delete"
              class="inline-form" data-confirm="Delete this step?">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="link-danger" type="submit">Delete</button>
        </form>
      </div>`).join('\n')
    : '      <p class="muted">No progress steps yet.</p>';

  return `  <section class="container inner-page">
    <p><a class="text-btn" href="/admin/projects">&larr; All projects</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">DEVELOPMENT</span>
        <h1>${esc(project.name)}</h1>
        <p class="muted">${esc(project.location)} &middot; ${esc(project.status)}</p>
      </div>
    </div>

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="client-card">
      <h2>Development details</h2>
      <p class="field-hint">Renaming a development updates the website, the client portal and every
        sales report at once — the analytics read the name, not a copy of it.</p>
      <form method="post" action="/admin/projects/${esc(project.id)}" class="payment-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
${projectFields({ project, csrf })}
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Stand sizes and pricing</h2>
      <p class="field-hint">The published price list shown on this development's own page. Amounts
        are free text, so a range such as &ldquo;&dollar;2,000 &ndash; &dollar;4,000&rdquo; is fine.</p>
${priceRows}

      <h3 style="margin-top:24px">Add a price row</h3>
      <form method="post" action="/admin/projects/${esc(project.id)}/pricing" class="payment-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <div class="field">
          <label for="new-size">Stand size</label>
          <input id="new-size" name="sizeLabel" type="text" placeholder="200 sqm" required maxlength="60">
        </div>
        <div class="field">
          <label for="new-cash">Cash price</label>
          <input id="new-cash" name="cash" type="text" placeholder="$5,500" maxlength="40">
        </div>
        <div class="field">
          <label for="new-credit">Credit price</label>
          <input id="new-credit" name="credit" type="text" placeholder="$6,500" maxlength="40">
        </div>
        <div class="field">
          <label for="new-deposit">Minimum deposit</label>
          <input id="new-deposit" name="deposit" type="text" placeholder="$3,000" maxlength="40">
        </div>
        <div class="field field-submit">
          <button class="btn primary" type="submit">Add price row</button>
        </div>
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Properties in this development</h2>
      <p class="field-hint">${esc(propertyBreakdown(project))}</p>
      <table class="portal-table">
        <caption>Every individual property belonging to ${esc(project.name)}</caption>
        <thead>
          <tr>
            <th scope="col">Stand No.</th><th scope="col">Size</th><th scope="col">Type</th>
            <th scope="col">Price</th><th scope="col">Status</th><th scope="col">Sales</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
${propertyRows}
        </tbody>
      </table>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Add a property to ${esc(project.name)}</h2>
      <p class="field-hint">This adds one more individual property. The development already exists,
        so it is not created again.</p>
      <form method="post" action="/admin/properties" class="payment-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <input type="hidden" name="returnTo" value="development">
${propertyFields({
    stand: { project_id: project.id, status: 'Available', type: 'Residential', currency: 'US$' },
    projects: [project],
    csrf
  })}
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Timeline</h2>
      <p class="field-hint">Steps appear in this order in the client's portal.</p>
${stepRows}
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Add a step</h2>
      <form method="post" action="/admin/projects/${esc(project.id)}/progress" class="progress-row">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label class="sr-only" for="newLabel">New step label</label>
        <input id="newLabel" name="label" type="text" required maxlength="120" placeholder="e.g. Roads and drainage">
        <label class="sr-only" for="newState">New step state</label>
        <select id="newState" name="state">
${stateOptions('pending')}
        </select>
        <button class="btn primary" type="submit">Add step</button>
      </form>
    </div>
  </section>`;
}

/* ── Site content ───────────────────────────────────────────────────────── */

function renderContentIndex({ pages, user, csrf }) {
  const cards = pages.map((p) => `      <article class="client-card">
        <h2><a href="/admin/content/${esc(p.key)}">${esc(p.label)}</a></h2>
        <p class="muted">${esc(p.file)} &middot; ${esc(p.sections)} section${p.sections === 1 ? '' : 's'}</p>
        <a class="btn outline" href="/admin/content/${esc(p.key)}">Edit ${esc(p.label.toLowerCase())}</a>
      </article>`).join('\n');

  return `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">CONTENT</span>
        <h1>Site content</h1>
        <p class="muted">Everything on the public pages, edited here. Changes appear immediately.</p>
      </div>
      <a class="btn primary" href="/admin/settings">Site settings &amp; logo</a>
    </div>

    <div class="content-grid">
${cards}
    </div>
  </section>`;
}

/** One input, bound to a form declared elsewhere on the page. */
function fieldInput(sectionKey, item, field, value, formId) {
  const name = `f:${sectionKey}:${item}:${field.key}`;
  const id = `${formId}-${field.key}-${item}`;
  const label = `        <label for="${id}">${esc(field.label)}</label>`;
  const multiline = field.type === 'textarea' || field.type === 'lines';

  if (multiline) {
    const rows = field.type === 'lines' ? 5 : 3;
    return `${label}
        <textarea id="${id}" name="${esc(name)}" form="${esc(formId)}" rows="${rows}">${esc(value)}</textarea>`;
  }
  return `${label}
        <input id="${id}" name="${esc(name)}" form="${esc(formId)}" type="text" value="${esc(value)}">`;
}

function renderContentPage({ page, sections, pages, user, csrf, notice = '', error = '' }) {
  const tabs = pages.map((p) =>
    `      <a href="/admin/content/${esc(p.key)}"${p.key === page.key ? ' aria-current="page"' : ''}>${esc(p.label)}</a>`
  ).join('\n');

  /* Forms are declared empty and referenced by id from the inputs and buttons
     they belong to. That avoids nesting one form inside another, which the
     add/delete controls would otherwise require. */
  const forms = [];
  const body = sections.map((s) => {
    const saveId = `save-${s.key}`;
    forms.push(`    <form id="${esc(saveId)}" method="post" action="/admin/content/${esc(page.key)}/save"></form>`);
    forms.push(`    <input type="hidden" name="csrf" value="${esc(csrf)}" form="${esc(saveId)}">`);

    let items = '';

    if (s.repeat) {
      items = s.items.map((it) => {
        const delId = `del-${s.key}-${it.item}`;
        forms.push(`    <form id="${esc(delId)}" method="post" action="/admin/content/${esc(page.key)}/${esc(s.key)}/${esc(it.item)}/delete"></form>`);
        forms.push(`    <input type="hidden" name="csrf" value="${esc(csrf)}" form="${esc(delId)}">`);

        const fields = s.fields.map((f) => fieldInput(s.key, it.item, f, it.values[f.key], saveId)).join('\n');
        return `      <fieldset class="content-item">
        <legend>Item ${esc(it.item)}</legend>
${fields}
        <button class="link-danger" type="submit" form="${esc(delId)}"
                onclick="return confirm('Delete item ${esc(it.item)} from ${esc(s.label)}?');">Delete this item</button>
      </fieldset>`;
      }).join('\n');

      const addId = `add-${s.key}`;
      forms.push(`    <form id="${esc(addId)}" method="post" action="/admin/content/${esc(page.key)}/${esc(s.key)}/add"></form>`);
      forms.push(`    <input type="hidden" name="csrf" value="${esc(csrf)}" form="${esc(addId)}">`);

      if (!s.items.length) items = '      <p class="muted">No items yet. Add one below.</p>';

      items += `
      <button class="btn outline" type="submit" form="${esc(addId)}">Add another item</button>`;
    } else {
      items = s.fields.map((f) => fieldInput(s.key, 0, f, s.values[f.key], saveId)).join('\n');
    }

    return `    <div class="client-card" style="margin-top:20px">
      <h2>${esc(s.label)}</h2>
${items}
      <p style="margin-top:16px"><button class="btn primary" type="submit" form="${esc(saveId)}">Save ${esc(s.label)}</button></p>
    </div>`;
  }).join('\n');

  return `  <section class="container inner-page">
${forms.join('\n')}

    <p><a class="text-btn" href="/admin/content">&larr; All content</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">CONTENT</span>
        <h1>${esc(page.label)}</h1>
        <p class="muted">Saved section by section. Changes show on the site immediately.</p>
      </div>
    </div>

    <div class="tabs">
${tabs}
    </div>

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

${body}
  </section>`;
}

/* ── Site settings and logo ─────────────────────────────────────────────── */

function renderSettings({ schema, values, logo, user, csrf, notice = '', error = '' }) {
  const fields = schema.map((s) => `        <label for="s-${esc(s.key)}">${esc(s.label)}</label>
        <input id="s-${esc(s.key)}" name="s:${esc(s.key)}" type="text" value="${esc(values[s.key] ?? '')}">`).join('\n');

  return `  <section class="container inner-page">
    <p><a class="text-btn" href="/admin/content">&larr; All content</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">SETTINGS</span>
        <h1>Site settings &amp; logo</h1>
        <p class="muted">Used across every page: header, footer and contact details.</p>
      </div>
    </div>

    ${notice ? `<p class="notice success">${esc(notice)}</p>` : ''}
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="client-grid">
      <div class="client-card">
        <h2>Site settings</h2>
        <form method="post" action="/admin/settings">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
${fields}
          <button class="btn primary" type="submit">Save settings</button>
        </form>
      </div>

      <div class="client-card">
        <h2>Logo</h2>
        <p class="field-hint">Shown in the header and footer of every page, and as the browser tab icon.</p>
        <img class="logo-preview" src="${esc(logo.absolute)}" alt="Current logo">

        <form method="post" action="/admin/logo" enctype="multipart/form-data" class="upload-form">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <div class="field">
            <label for="logoFile">Replace logo</label>
            <input id="logoFile" name="logo" type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp,.svg,.png,.jpg,.jpeg,.webp" required>
          </div>
          <div class="field field-submit">
            <button class="btn primary" type="submit">Upload logo</button>
          </div>
        </form>

        ${logo.custom ? `<form method="post" action="/admin/logo/remove" style="margin-top:14px">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="btn outline" type="submit">Revert to the default logo</button>
        </form>` : '<p class="field-hint">Currently using the bundled default.</p>'}
      </div>
    </div>
  </section>`;
}

/* ── Edit one payment ───────────────────────────────────────────────────── */

function renderPaymentEdit({ client, payment, basePath, user, csrf, error = '' }) {
  const confirmed = payment.status === 'Confirmed';
  const amount = (payment.amount_cents / 100).toFixed(2);

  return `  <section class="container inner-page">
    <p><a class="text-btn" href="${esc(basePath)}">&larr; ${esc(client.full_name)}</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">PAYMENT</span>
        <h1>Edit payment</h1>
        <p class="muted">${esc(client.client_number)} &middot; ${esc(client.full_name)}</p>
      </div>
    </div>

    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}

    <div class="client-card">
      <form method="post" action="${esc(basePath)}/payments/${esc(payment.id)}">
        <input type="hidden" name="csrf" value="${esc(csrf)}">

        <label for="paidOn">Date received</label>
        <input id="paidOn" name="paidOn" type="date" value="${esc(String(payment.paid_on).slice(0, 10))}" required>

        <label for="reference">Reference</label>
        <input id="reference" type="text" value="${esc(payment.reference)}" readonly>
        <p class="field-hint">Generated when the payment was recorded, so it cannot be changed.</p>

        <label for="amount">Amount (US$)</label>
        <input id="amount" name="amount" type="text" inputmode="decimal" value="${esc(amount)}" required>

        <label for="status">Status</label>
        <select id="status" name="status">
          <option${confirmed ? ' selected' : ''}>Confirmed</option>
          <option${confirmed ? '' : ' selected'}>Pending</option>
        </select>
        <p class="field-hint">Only <strong>Confirmed</strong> payments reduce the client's balance.</p>

        <button class="btn primary" type="submit">Save payment</button>
      </form>
    </div>

    <div class="client-card" style="margin-top:20px">
      <h2>Delete this payment</h2>
      <p class="muted">Removing it changes the client's balance. This cannot be undone.</p>
      <form method="post" action="${esc(basePath)}/payments/${esc(payment.id)}/delete"
            data-confirm="Delete payment ${esc(payment.reference)}? This cannot be undone.">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <button class="link-danger" type="submit">Delete payment</button>
      </form>
    </div>
  </section>`;
}

module.exports = {
  adminLayout, renderLogin, renderDashboard, renderEnquiries, renderClients,
  renderClientDetail, renderNewClient, renderProjects, renderProjectDetail,
  renderContentIndex, renderContentPage, renderSettings, renderPaymentEdit,
  renderProperties, renderPropertyEdit
};
