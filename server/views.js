'use strict';

/* ==========================================================================
   Server-rendered views.

   The dashboard is rendered on the server and every interpolated value passes
   through esc(). This is what replaces the original prototype's client-side
   innerHTML string-building, where any future backend value would have become
   stored XSS.
   ========================================================================== */

/** Escapes text for HTML text and quoted-attribute contexts. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Allows an admin-supplied link through only if it is http or https.
 *
 * Escaping stops a value breaking out of the attribute, but it does not stop
 * `href="javascript:..."` executing when clicked. Anything that is not a real
 * web link is dropped rather than rendered.
 */
function safeLink(url) {
  const raw = String(url || '').trim();
  return /^https?:\/\//i.test(raw) ? raw : '';
}

/* ── WhatsApp ───────────────────────────────────────────────────────────── */

const WHATSAPP_ICON =
  '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.47-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.53.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.42-.07-.12-.27-.2-.57-.35M12.05 21.8a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.83 9.83 0 0 1 2.89 6.99c0 5.45-4.44 9.88-9.89 9.88m8.41-18.3A11.8 11.8 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 0 0 5.69 1.45c6.55 0 11.89-5.34 11.89-11.89 0-3.18-1.24-6.17-3.48-8.41"/></svg>';

/**
 * The WhatsApp button, or nothing at all when the setting is not a web link.
 * `wa.me` links open the app or web client in a new tab, so they carry
 * rel="noopener" — without it the opened page can reach back via window.opener.
 */
function whatsappButton(settings, className = 'btn light') {
  const url = safeLink(settings.whatsapp_url);
  if (!url) return '';
  return `<a class="${className} btn-with-icon" href="${esc(url)}" target="_blank" `
    + `rel="noopener noreferrer">${WHATSAPP_ICON}WhatsApp us</a>`;
}

/* Formatting lives in format.js so the analytics engine and the PDF generator
   can use the same definitions without importing the view layer. Re-exported
   here because every existing caller imports them from views. */
const { money, moneyIn, plainMoney, formatDate, formatBytes, percent, slugify } = require('./format');

/* The brand mark comes from server/branding.js, which resolves the three
   files the wordmark needs. */
const { logoAbsolute, logoLightAbsolute, faviconAbsolute, brandName } = require('./branding');
const { content } = require('./db');

const NAV = [
  ['/index.html', 'Home'],
  ['/about.html', 'About'],
  ['/services.html', 'Services'],
  ['/projects.html', 'Projects'],
  ['/properties.html', 'Properties'],
  ['/news.html', 'News'],
  ['/contact.html', 'Contact']
];

function layout({ title, description, body, active = '' }) {
  const logo = logoAbsolute();
  const logoLight = logoLightAbsolute();
  const favicon = faviconAbsolute();
  const brand = esc(brandName());
  const links = NAV.map(([href, label]) =>
    `    <a href="${href}"${href === active ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="${favicon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/styles.css">
</head>
<body>

<a class="skip-link" href="#main">Skip to content</a>
<div id="toast" class="toast" role="status" aria-live="polite"></div>

<header class="site-header">
  <a href="/index.html" class="brand">
    <img class="brand-logo" src="${logo}" alt="${brand}">
  </a>
  <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="mainNav" aria-label="Toggle navigation">&#9776;</button>
  <nav id="mainNav" aria-label="Primary">
${links}
    <a class="portal-btn" href="/portal.html">Client Login</a>
  </nav>
</header>

<main id="main">
${body}
</main>

<footer>
  <div class="container footer-grid">
    <div>
      <div class="brand">
        <img class="brand-logo" src="${logoLight}" alt="${brand}">
      </div>
      <p>Building communities. Creating opportunities.</p>
    </div>
    <div>
      <h4>Explore</h4>
      <a href="/projects.html">Projects</a>
      <a href="/properties.html">Properties</a>
      <a href="/services.html">Services</a>
      <a href="/news.html">News</a>
    </div>
    <div>
      <h4>Clients</h4>
      <a href="/portal.html">Client Login</a>
      <a href="/contact.html">Support</a>
    </div>
    <div>
      <h4>Contact</h4>
      <p>NetOne Building, Office PD30, Gweru, Zimbabwe</p>
      <p><a href="tel:+26354222697">+263 542 22697</a></p>
      <p><a href="mailto:heritagehousingp@gmail.com">heritagehousingp@gmail.com</a></p>
    </div>
  </div>
  <div class="container copyright">
    &copy; <span data-year>2026</span> Heritage Housing Projects (Pvt) Ltd. All rights reserved.
  </div>
</footer>

<script src="/assets/js/site.js" defer></script>
</body>
</html>
`;
}

/* ── Dashboard ──────────────────────────────────────────────────────────── */

function progressTimeline(items) {
  if (!items.length) return '<p class="muted">No progress recorded yet.</p>';
  return '<div class="timeline">' + items.map((p) => `        <div class="timeline-item">
          <span class="dot ${esc(p.state)}" aria-hidden="true"></span>
          <div><b>${esc(p.label)}</b><p>${p.state === 'done' ? 'Completed' : p.state === 'current' ? 'In progress' : 'Pending'}</p></div>
        </div>`).join('\n') + '\n      </div>';
}

function paymentRows(payments) {
  if (!payments.length) {
    return '<tr><td colspan="4">No payments recorded yet.</td></tr>';
  }
  return payments.map((p) => `            <tr>
              <td>${esc(formatDate(p.paid_on))}</td>
              <td>${esc(p.reference)}</td>
              <td>${esc(money(p.amount_cents))}</td>
              <td>${esc(p.status)}</td>
            </tr>`).join('\n');
}

function documentRows(docs) {
  if (!docs.length) return '<p class="muted">No documents have been shared with you yet.</p>';
  return '<div class="document-list">' + docs.map((d) => `        <div class="document">
          <span>${esc(d.title)}<br><small class="muted">${esc(formatBytes(d.size_bytes))} &middot; ${esc(formatDate(d.uploaded_at))}</small></span>
          <a href="/api/documents/${encodeURIComponent(d.id)}/download">Download</a>
        </div>`).join('\n') + '\n      </div>';
}

/**
 * Renders the client dashboard.
 * `user` comes from the session; `data` comes from the database.
 */
function renderDashboard({ user, ownership, payments, paidTotal, documents, progress, csrf }) {
  const purchase = ownership ? ownership.purchase_price_cents : 0;
  const balance = Math.max(purchase - paidTotal, 0);
  const pct = purchase > 0 ? Math.min(Math.round((paidTotal / purchase) * 100), 100) : 0;

  const propertyBlock = ownership ? `
      <div class="portal-stat-grid">
        <div class="portal-stat"><small>Project</small><strong>${esc(ownership.project_name)}</strong></div>
        <div class="portal-stat"><small>Stand</small><strong>${esc(ownership.stand_number)}</strong></div>
        <div class="portal-stat"><small>Size</small><strong>${esc(ownership.size_sqm)}m&sup2;</strong></div>
      </div>

      <div class="client-grid">
        <div class="client-card dark">
          <span class="eyebrow">ACCOUNT BALANCE</span>
          <div class="balance">${esc(money(balance))}</div>
          <p>Outstanding balance on your property account.</p>
          <div class="progress" role="img" aria-label="${pct}% of the purchase price has been paid">
            <span style="width:${pct}%"></span>
          </div>
          <p style="margin-top:10px">${esc(money(paidTotal))} paid of ${esc(money(purchase))} (${pct}%)</p>
        </div>
        <div class="client-card">
          <span class="eyebrow dark">PROPERTY</span>
          <h3>${esc(ownership.stand_number)}</h3>
          <p>${esc(ownership.project_name)}<br>${esc(ownership.size_sqm)}m&sup2; &bull; ${esc(ownership.type)}</p>
          <span class="status">&#9679; ${esc(ownership.status.toUpperCase())}</span>
        </div>
      </div>` : `
      <div class="notice info">No property is linked to this account yet. Please contact the office.</div>`;

  const projectBlock = ownership ? `
      <div class="client-card" style="margin-top:20px">
        <h3>Project progress</h3>
        ${progressTimeline(progress)}
      </div>` : '';

  return `  <section class="container inner-page">
    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">MY HERITAGE</span>
        <h1>Welcome, ${esc(user.fullName)}</h1>
        <p class="muted">Client ${esc(user.clientNumber)}</p>
      </div>
      <button class="btn outline" id="signOut" type="button" data-csrf="${esc(csrf)}">Log out</button>
    </div>
${propertyBlock}

    <div class="client-grid">
      <div class="client-card">
        <h3>Payment history</h3>
        <table class="portal-table">
          <caption>Payments recorded against your account</caption>
          <thead>
            <tr><th scope="col">Date</th><th scope="col">Reference</th><th scope="col">Amount</th><th scope="col">Status</th></tr>
          </thead>
          <tbody>
${paymentRows(payments)}
          </tbody>
        </table>
        <p class="field-hint" style="margin-top:14px">To make a payment, please contact the office. Online payment is not yet enabled on this deployment.</p>
        <p style="margin-top:14px"><a class="btn outline" href="/api/statement.pdf">Download statement (PDF)</a></p>
      </div>
      <div class="client-card">
        <h3>My documents</h3>
        ${documentRows(documents)}
      </div>
    </div>

${projectBlock}

    <div class="client-card" style="margin-top:20px">
      <h3>Need help?</h3>
      <p>Submit a support request about payments, documents, your stand or project progress.</p>
      <div class="card-actions">
        ${whatsappButton(content.settings())}
        <a class="btn outline" href="/contact.html">Contact support</a>
      </div>
    </div>
  </section>`;
}

/** Simple, consistent error page. */
function renderError({ status, title, message }) {
  return layout({
    title: `${status} — ${title}`,
    description: title,
    body: `  <section class="container inner-page">
    <div class="page-hero">
      <span class="eyebrow dark">ERROR ${esc(status)}</span>
      <h1>${esc(title)}</h1>
      <p>${esc(message)}</p>
      <p><a class="btn primary" href="/index.html">Return to the home page</a></p>
    </div>
  </section>`
  });
}

module.exports = {
  esc, safeLink, money, moneyIn, formatDate, formatBytes, percent, slugify,
  layout, renderDashboard, renderError, whatsappButton
};
