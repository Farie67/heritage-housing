'use strict';

/* ==========================================================================
   Public site rendering.

   Every marketing page is built here from two sources:
     - site_settings and content_blocks, which the office edits in the admin
     - the projects and stands tables, so a price change is made once and
       shows up on the site, in the portal and in the export together

   Relative asset paths ("assets/css/...") are deliberate: the same markup is
   served live at /about.html and written to public/about.html for static
   hosting, and relative paths work in both.
   ========================================================================== */

const { esc, money, moneyIn, safeLink, whatsappButton, slugify } = require('./views');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { PAGES } = require('./content');

const NAV = [
  ['index.html', 'Home'],
  ['about.html', 'About'],
  ['services.html', 'Services'],
  ['projects.html', 'Projects'],
  ['properties.html', 'Properties'],
  ['news.html', 'News'],
  ['contact.html', 'Contact']
];

const lines = (value) => String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/* ── Cache-busting ────────────────────────────────────────────────────────
   Replacing a photograph while keeping its filename is a normal thing to do,
   but a browser told `max-age=3600` keeps showing its saved copy for an hour
   without ever asking the server — so the new picture appears not to load.

   Appending the file's modification time makes the address change whenever the
   file changes, so the new photograph is fetched immediately.

   The timestamp is read on every render rather than cached, because caching it
   would reintroduce exactly the staleness this exists to prevent. At most a
   handful of stat calls per page. */
function assetUrl(url) {
  const raw = String(url || '').trim();
  if (!raw || /^(https?:)?\/\//i.test(raw) || raw.startsWith('data:')) return raw;

  /* Works for both "/images/x.jpg" and the relative "assets/css/styles.css". */
  const relative = (raw.startsWith('/') ? raw.slice(1) : raw).split('?')[0];

  try {
    const { mtimeMs } = fs.statSync(path.join(config.PUBLIC_DIR, relative));
    return `${raw}?v=${Math.floor(mtimeMs)}`;
  } catch {
    /* Missing file: hand back the path unchanged so the caller renders what it
       intended and the page still shows its background colour. */
    return raw;
  }
}

/**
 * Makes an internal path root-absolute.
 *
 * Nested addresses such as /development/heritage-park and /property/HP-0245 are
 * one level deep, so a relative "assets/css/styles.css" resolves to
 * /development/assets/css/styles.css and 404s — the page then renders with no
 * styling at all. Every internal reference therefore starts at the root.
 *
 * Anything already absolute, a fragment, or a non-http scheme is left alone.
 */
function sitePath(url) {
  const raw = String(url || '').trim();
  if (!raw || /^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(raw)) return raw;
  return `/${raw}`;
}

/* ── Shell ──────────────────────────────────────────────────────────────── */

function layout({ settings, title, description, active, body, canonicalPath }) {
  const s = settings;
  /* Three files: the wordmark for light surfaces, a light variant for the dark
     footer, and the square mark for the tab. */
  const logo = sitePath(s.logo_url || 'assets/img/logo.png');
  const logoLight = sitePath(s.logo_light_url || 'assets/img/logo-light.png');
  const favicon = sitePath(s.favicon_url || 'assets/img/logo-mark.png');
  const wa = safeLink(s.whatsapp_url);
  /* The deployed address, editable in Site settings. Hard-coding it meant every
     canonical tag pointed at a domain that might not be the one serving the
     site. */
  const base = String(s.site_url || '').trim().replace(/\/+$/, '') || 'https://heritagehousing.co.zw';
  const canonical = `${base}/${canonicalPath}`;

  /* The href is rooted but the comparison is against the bare filename the
     schema uses, so the active tab still highlights. */
  const links = NAV.map(([href, label]) =>
    `    <a href="/${href}"${href === active ? ' aria-current="page"' : ''}>${esc(label)}</a>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="${esc(assetUrl(favicon))}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${esc(assetUrl('/assets/css/styles.css'))}">
</head>
<body>

<a class="skip-link" href="#main">Skip to content</a>
<div id="toast" class="toast" role="status" aria-live="polite"></div>

<header class="site-header">
  <a href="/" class="brand">
    <img class="brand-logo" src="${esc(logo)}" alt="${esc(s.company_legal)}">
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
        <img class="brand-logo" src="${esc(logoLight)}" alt="${esc(s.company_legal)}">
      </div>
      <p>${esc(s.footer_note)}</p>
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
      <p>${esc(s.office_short)}</p>
      <p><a href="tel:${esc(s.phone_link)}">${esc(s.phone)}</a></p>
      <p><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></p>
      ${wa ? `<p><a href="${esc(wa)}" target="_blank" rel="noopener noreferrer">WhatsApp us</a></p>` : ''}
    </div>
  </div>
  <div class="container copyright">
    &copy; <span data-year>2026</span> ${esc(s.company_legal)}. All rights reserved.
  </div>
</footer>

<script src="/assets/js/site.js" defer></script>
</body>
</html>
`;
}

/* ── Shared fragments ───────────────────────────────────────────────────── */

function pageHero(c, section = 'hero') {
  return `    <div class="page-hero">
      <span class="eyebrow dark">${esc(c.get(section, 'eyebrow'))}</span>
      <h1>${esc(c.get(section, 'heading'))}</h1>
      <p>${esc(c.get(section, 'body'))}</p>
    </div>`;
}

function projectCards(projects, c) {
  return projects.map((p) => {
    const soldOut = Boolean(p.sold_out);
    const href = `/development/${slugify(p.name)}`;

    return `    <article class="project-card${soldOut ? ' is-sold-out' : ''}">
      <div class="project-thumb" role="img" aria-label="${esc(p.type)} development at ${esc(p.name)}, ${esc(p.location)}" style="background-image:url('${esc(assetUrl(p.image_url))}')">${soldOut ? '<span class="sold-out-stamp">Sorry &mdash; sold out</span>' : ''}</div>
      <div class="project-card-body">
        <span class="status">&#9679; ${esc(String(p.status).toUpperCase())}</span>
        <h3><a href="${esc(href)}">${esc(p.name)}</a></h3>
        <p><strong>${esc(p.location)}</strong></p>
        <p>${esc(p.description)}</p>
        ${soldOut
      ? `<p class="sold-out-body">Every stand at ${esc(p.name)} has now been sold. Get in touch and we
          will tell you what is coming next.</p>
        <a class="btn outline" href="/contact.html" data-enquire="${esc(p.name)}">Ask about other developments</a>`
      : `<a class="btn outline" href="${esc(href)}">View properties in ${esc(p.name)}</a>`}
      </div>
    </article>`;
  }).join('\n');
}

function propertyCards(stands) {
  return stands.map((s) => {
    const price = s.price_cents == null ? 'Enquire' : moneyIn(s.price_cents, s.currency);
    const href = `/property/${encodeURIComponent(s.stand_number)}`;
    const devHref = `/development/${slugify(s.project_name)}`;

    /* The STAND is the headline and the development is the context. Headlining
       the development made a dozen different stands all look like the same
       property. */
    return `    <article class="property-card" data-project="${esc(s.project_name)}" data-type="${esc(s.type)}" data-size="${esc(s.size_sqm)}">
      <div class="property-img" role="img" aria-label="${esc(s.type)} stand ${esc(s.stand_number)} at ${esc(s.project_name)}" style="background-image:url('${esc(assetUrl(s.image_url || s.project_image_url))}')"></div>
      <div class="property-body">
        <span class="status">&#9679; ${esc(String(s.status).toUpperCase())}</span>
        <h3><a href="${esc(href)}">Stand ${esc(s.stand_number)}</a></h3>
        <p class="dev-name">in <a href="${esc(devHref)}">${esc(s.project_name)}</a></p>
        <div class="property-meta">
          <div><small>Size</small><strong>${esc(s.size_sqm)}m&sup2;</strong></div>
          <div><small>Type</small><strong>${esc(s.type)}</strong></div>
        </div>
        <div class="price">${esc(price)}</div>
        <a class="btn primary" href="${esc(href)}">View this property</a>
        <a class="text-btn" href="/contact.html" data-enquire="${esc(s.project_name)}, stand ${esc(s.stand_number)}">Enquire about this stand</a>
      </div>
    </article>`;
  }).join('\n');
}

/* ── Pages ──────────────────────────────────────────────────────────────── */

function home(c, ctx) {
  /* The photograph for the featured block, in order of preference: the one set
     on the block itself in the content editor, then the featured development's
     own photograph, then nothing — which leaves the stylesheet's own default
     (also /images/featured-development.jpg) to show. */
  const featuredImage = c.get('featured', 'image') || ctx.featuredImage || '';

  const featureCards = c.items('feature').map((i) => `        <article class="feature-card">
          <div class="icon" aria-hidden="true">${esc(c.get('feature', 'icon', i))}</div>
          <h3>${esc(c.get('feature', 'title', i))}</h3>
          <p>${esc(c.get('feature', 'body', i))}</p>
        </article>`).join('\n');

  const trust = c.items('trust').map((i) =>
    `      <div><strong>${esc(c.get('trust', 'strong', i))}</strong><span>${esc(c.get('trust', 'span', i))}</span></div>`
  ).join('\n');

  const stats = [1, 2, 3, 4].map((n) =>
    `            <div><small>${esc(c.get('featured', `stat${n}_label`))}</small><strong>${esc(c.get('featured', `stat${n}_value`))}</strong></div>`
  ).join('\n');

  return `  <section class="hero" style="--hero-image:url('${esc(assetUrl('/images/hero-home.jpg'))}')">
    <div class="hero-content container">
      <span class="eyebrow">${esc(c.get('hero', 'eyebrow'))}</span>
      <h1>${esc(c.get('hero', 'heading'))}<br><span>${esc(c.get('hero', 'heading_accent'))}</span></h1>
      <p>${esc(c.get('hero', 'body'))}</p>
      <div class="hero-actions">
        <a class="btn primary" href="/projects.html">${esc(c.get('hero', 'cta1_label'))}</a>
        <a class="btn light" href="/properties.html">${esc(c.get('hero', 'cta2_label'))}</a>
      </div>
    </div>
  </section>

  <section class="trust-strip" aria-label="What we do">
    <div class="container trust-grid">
${trust}
    </div>
  </section>

  <section class="section">
    <div class="container">
      <div class="section-head">
        <div>
          <span class="eyebrow dark">${esc(c.get('whatwedo', 'eyebrow'))}</span>
          <h2>${esc(c.get('whatwedo', 'heading'))}</h2>
        </div>
        <a class="text-btn" href="/about.html">${esc(c.get('whatwedo', 'link_label'))}</a>
      </div>
      <div class="cards four">
${featureCards}
      </div>
    </div>
  </section>

  <section class="section soft">
    <div class="container">
      <div class="section-head">
        <div>
          <span class="eyebrow dark">${esc(c.get('featured', 'eyebrow'))}</span>
          <h2>${esc(c.get('featured', 'heading'))}</h2>
          <p class="lead">${esc(c.get('featured', 'lead'))}</p>
        </div>
        <a class="btn primary" href="/projects.html">${esc(c.get('featured', 'cta_label'))}</a>
      </div>
      <div class="project-feature">
        <div class="project-image heritage-image" role="img" aria-label="Artist's impression of the featured development"${featuredImage ? ` style="background-image:linear-gradient(0deg,rgba(16,42,67,.6),transparent),url('${esc(assetUrl(featuredImage))}')"` : ''}>
          <div class="image-label">${esc(c.get('featured', 'image_label'))}</div>
        </div>
        <div class="project-info">
          <span class="status">&#9679; ${esc(c.get('featured', 'status'))}</span>
          <h3>${esc(c.get('featured', 'title'))}</h3>
          <p>${esc(c.get('featured', 'body'))}</p>
          <div class="mini-grid">
${stats}
          </div>
          <a class="btn primary" href="/properties.html">${esc(c.get('featured', 'stands_label'))}</a>
        </div>
      </div>
    </div>
  </section>

  <section class="section portal-callout container">
    <div>
      <span class="eyebrow dark">${esc(c.get('callout', 'eyebrow'))}</span>
      <h2>${esc(c.get('callout', 'heading'))}</h2>
      <p>${esc(c.get('callout', 'body'))}</p>
    </div>
    <a class="btn primary" href="/portal.html">${esc(c.get('callout', 'cta_label'))}</a>
  </section>`;
}

/* Small inline icons for the four core values, chosen by the value's own name.
   Inline rather than an image file so they inherit the brand colour and add no
   request. Renaming or adding a value in the content editor falls back to a
   neutral marker instead of leaving a gap. */
const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" '
  + 'aria-hidden="true" focusable="false">';

const VALUE_ICONS = {
  // A shield with a tick.
  integrity: `${SVG_OPEN}<path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"/>`
    + '<path d="M9.2 12l2 2 3.8-3.8"/></svg>',
  // Two blocks under construction.
  development: `${SVG_OPEN}<path d="M4 21V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15"/>`
    + '<path d="M15 21V10h4a1 1 0 0 1 1 1v10"/><path d="M3 21h18"/>'
    + '<path d="M7.5 9h1.5M7.5 13h1.5M7.5 17h1.5M11.5 9h1.5M11.5 13h1.5M11.5 17h1.5"/></svg>',
  // Clasped hands.
  'client focus': `${SVG_OPEN}<path d="m11 17 2 2a1 1 0 1 0 3-3"/>`
    + '<path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/>'
    + '<path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/></svg>',
  // A rising line on an axis.
  'value creation': `${SVG_OPEN}<path d="M3 3v18h18"/><path d="M7 16l4-4 3 3 5-6"/>`
    + '<path d="M15 9h4v4"/></svg>'
};

const VALUE_ICON_FALLBACK = `${SVG_OPEN}<path d="M12 4l8 8-8 8-8-8z"/></svg>`;

function about(c) {
  const values = c.items('value').map((i) => {
    const title = String(c.get('value', 'title', i) || '').trim();
    const icon = VALUE_ICONS[title.toLowerCase()] || VALUE_ICON_FALLBACK;

    return `      <div>
        <span class="value-icon">${icon}</span>
        <b>${esc(c.get('value', 'number', i))}</b>
        <h3>${esc(title)}</h3>
        <p>${esc(c.get('value', 'body', i))}</p>
      </div>`;
  }).join('\n');

  /* The Chief Executive block. Only rendered when there is a photograph, so an
     unfinished section leaves no empty frame behind. */
  const ceoImage = c.get('ceo', 'image');
  const ceoName = c.get('ceo', 'name');
  const ceoBlock = ceoImage && ceoName ? `
    <div class="ceo-block">
      <div class="ceo-photo">
        <img src="${esc(assetUrl(ceoImage))}" alt="${esc(ceoName)}, ${esc(c.get('ceo', 'role'))}" loading="lazy">
      </div>
      <div class="ceo-message">
        <span class="eyebrow dark">${esc(c.get('ceo', 'eyebrow'))}</span>
        <blockquote>${esc(c.get('ceo', 'message'))}</blockquote>
        <p class="ceo-name">
          <strong>${esc(ceoName)}</strong>
          <span>${esc(c.get('ceo', 'role'))}</span>
        </p>
      </div>
    </div>` : '';

  return `  <section class="container inner-page about-page">
${pageHero(c)}
    <div class="two-col">
      <div>
        <h2>${esc(c.get('who', 'heading'))}</h2>
        <p>${esc(c.get('who', 'body1'))}</p>
        <p>${esc(c.get('who', 'body2'))}</p>
      </div>
      <div class="mission-card">
        <span>${esc(c.get('mission', 'eyebrow'))}</span>
        <h3>${esc(c.get('mission', 'body'))}</h3>
      </div>
    </div>

    <p class="trust-strip">A multi-award-winning company in property development.</p>

    <div class="values">
${values}
    </div>
${ceoBlock}
  </section>`;
}

function services(c) {
  const cards = c.items('service').map((i) => {
    const title = c.get('service', 'title', i) || '';
    const bullets = lines(c.get('service', 'bullets', i))
      .map((b) => `            <li>${esc(b)}</li>`).join('\n');

    /* The path is edited alongside the service, so it follows whatever the
       card is called. The fallback keeps an un-migrated row honest instead of
       rendering an empty src. */
    const image = c.get('service', 'image', i) || `/images/service-${slugify(title)}.jpg`;

    return `      <article class="service-card">
        <img class="service-image" src="${esc(assetUrl(image))}" alt="${esc(title)}" loading="lazy">
        <div class="service-body">
          <div class="icon" aria-hidden="true">${esc(c.get('service', 'icon', i))}</div>
          <h2>${esc(title)}</h2>
          <ul>
${bullets}
          </ul>
        </div>
      </article>`;
  }).join('\n');

  return `  <section class="container inner-page">
${pageHero(c)}
    <div class="cards three service-grid">
${cards}
    </div>
  </section>`;
}

function projectsPage(c, ctx) {
  return `  <section class="container inner-page">
${pageHero(c)}
    <div class="cards three">
${projectCards(ctx.projects, c)}
    </div>
  </section>`;
}

function propertiesPage(c, ctx) {
  /* A sold-out development has nothing left to offer, so its stands are left
     out of the available list entirely rather than shown as unavailable. */
  const available = ctx.stands.filter((s) => !s.project_sold_out);
  const soldOut = (ctx.projects || []).filter((p) => p.sold_out);

  const projectOptions = [...new Set(available.map((s) => s.project_name))]
    .map((n) => `        <option value="${esc(n)}">${esc(n)}</option>`).join('\n');

  const sizes = [...new Set(available.map((s) => s.size_sqm))].sort((a, b) => a - b);
  const sizeOptions = sizes.map((n) => `          <option value="${esc(n)}">${esc(n)}m&sup2;</option>`).join('\n');

  const soldOutNote = soldOut.length ? `
    <div class="notice info sold-out-note-page">
      <strong>Sorry &mdash; sold out:</strong>
      ${soldOut.map((p) => esc(p.name)).join(', ')}.
      Every stand there has been sold.
      <a href="/contact.html">Contact us</a> about our other developments.
    </div>` : '';

  return `  <section class="container inner-page">
${pageHero(c)}

    <!-- Hidden until JavaScript reveals it: with JS off the filters would do
         nothing, so every property is simply listed in full instead. -->
    <div class="filters" id="filterBar" hidden>
      <div class="field">
        <label for="projectFilter">Project</label>
        <select id="projectFilter">
          <option value="all">All projects</option>
${projectOptions}
        </select>
      </div>
      <div class="field">
        <label for="typeFilter">Property type</label>
        <select id="typeFilter">
          <option value="all">All property types</option>
          <option value="Residential">Residential</option>
          <option value="Commercial">Commercial</option>
        </select>
      </div>
      <div class="field">
        <label for="sizeFilter">Size</label>
        <select id="sizeFilter">
          <option value="all">All sizes</option>
${sizeOptions}
        </select>
      </div>
      <p class="filter-status" id="filterStatus" role="status" aria-live="polite"></p>
    </div>

    <div class="property-grid cards three" id="propertyGrid">
${propertyCards(available)}
    </div>
${soldOutNote}
  </section>`;
}

function news(c) {
  const cards = c.items('item').map((i) => `      <article class="news-card">
        <span>${esc(c.get('item', 'tag', i))}</span>
        <h2>${esc(c.get('item', 'title', i))}</h2>
        <p>${esc(c.get('item', 'body', i))}</p>
        <a class="text-btn" href="${esc(c.get('item', 'link_href', i))}">${esc(c.get('item', 'link_label', i))}</a>
      </article>`).join('\n');

  return `  <section class="container inner-page">
${pageHero(c)}
    <div class="cards three">
${cards}
    </div>
  </section>`;
}

function contact(c, ctx) {
  /* Every page renderer receives (content, ctx). Settings live at
     ctx.settings — reading them straight off ctx silently produced an empty
     address, phone and email on this card. */
  const settings = ctx.settings;
  const options = lines(c.get('card', 'interest_options'))
    .map((o) => `          <option>${esc(o)}</option>`).join('\n');

  return `  <section class="container inner-page">
${pageHero(c)}
    <div class="contact-layout">
      <div class="contact-card">
        <h2>${esc(c.get('card', 'heading'))}</h2>
        <p><b>Office:</b> ${esc(settings.office)}</p>
        <p><b>Phone:</b> <a href="tel:${esc(settings.phone_link)}">${esc(settings.phone)}</a></p>
        <p><b>Email:</b> <a href="mailto:${esc(settings.email)}">${esc(settings.email)}</a></p>
        <div class="contact-actions">
          ${whatsappButton(settings)}
          <a class="btn outline" href="tel:${esc(settings.phone_link)}">Call us</a>
          <a class="btn outline" href="mailto:${esc(settings.email)}">Email us</a>
        </div>
      </div>

      <form class="contact-form" id="enquiryForm" method="post" action="/api/enquiries" novalidate>
        <h2>${esc(c.get('card', 'form_heading'))}</h2>
        <p class="notice" id="formStatus" role="status" aria-live="polite"></p>

        <label for="name">Name</label>
        <input id="name" name="name" type="text" autocomplete="name" required>
        <p class="field-error" data-error-for="name"></p>

        <label for="phone">Phone / WhatsApp</label>
        <input id="phone" name="phone" type="tel" autocomplete="tel" required>
        <p class="field-error" data-error-for="phone"></p>

        <label for="interest">Interested in</label>
        <select id="interest" name="interest">
${options}
        </select>

        <label for="message">Message</label>
        <textarea id="message" name="message" rows="5" required></textarea>
        <p class="field-error" data-error-for="message"></p>

        <button class="btn primary" type="submit">Send enquiry</button>
      </form>
    </div>
  </section>`;
}

/* ── Portal login (public, but signed-out only) ─────────────────────────── */

function portal(settings) {
  const logo = settings.logo_url || 'assets/img/logo.png';
  return `  <section class="portal-shell">
    <div class="portal-panel narrow">
      <div class="portal-brand">
        <img class="brand-logo" src="${esc(logo)}" alt="${esc(settings.company_legal)}">
      </div>
      <p class="brand-tag">CLIENT PORTAL</p>

      <h1 style="font-size:30px">Client Login</h1>
      <p class="muted">Access your stand, payment and project information.</p>

      <p class="notice" id="loginStatus" role="status" aria-live="polite"></p>

      <form id="loginForm" method="post" action="/api/auth/login" class="login-form">
        <label for="clientNumber">Client number</label>
        <input id="clientNumber" name="clientNumber" type="text" autocomplete="username" placeholder="e.g. HP-10245" required>

        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>

        <button class="btn primary full" type="submit">Sign in</button>
      </form>
    </div>
  </section>`;
}

/* ── Entry point ────────────────────────────────────────────────────────── */

const RENDERERS = {
  home,
  about,
  services,
  projects: projectsPage,
  properties: propertiesPage,
  news,
  contact
};

/**
 * Renders one public page.
 * `ctx` = { settings, content: resolved content, projects, stands }
 */
function render(pageKey, ctx) {
  const schema = PAGES.find((p) => p.key === pageKey);
  if (!schema) return '';

  const body = RENDERERS[pageKey](ctx.content, ctx);

  return layout({
    settings: ctx.settings,
    title: schema.meta.title,
    description: schema.meta.description,
    active: schema.file,
    canonicalPath: schema.file,
    body
  });
}

/* ── Property and development detail pages ──────────────────────────────── */

/**
 * One individual property, in full.
 *
 * Addressed by stand number rather than an internal id, so the link a client
 * copies says which property it is.
 */
function renderPropertyPage(ctx, stand) {
  const price = stand.price_cents == null
    ? 'Price on request'
    : moneyIn(stand.price_cents, stand.currency);
  const devHref = `/development/${slugify(stand.project_name)}`;
  const available = stand.status === 'Available';

  const body = `  <section class="container inner-page">
    <p><a class="text-btn" href="/properties.html">&larr; All properties</a></p>

    <div class="detail-hero">
      <div class="detail-image" role="img" aria-label="${esc(stand.type)} stand ${esc(stand.stand_number)}"
           style="background-image:url('${esc(assetUrl(stand.image_url || stand.project_image_url))}')"></div>
      <div class="detail-summary">
        <span class="status">&#9679; ${esc(String(stand.status).toUpperCase())}</span>
        <h1>Stand ${esc(stand.stand_number)}</h1>
        <p class="dev-name">in <a href="${esc(devHref)}">${esc(stand.project_name)}</a></p>
        <p class="detail-price">${esc(price)}</p>

        <dl class="detail-list">
          <div><dt>Stand number</dt><dd>${esc(stand.stand_number)}</dd></div>
          <div><dt>Development</dt><dd><a href="${esc(devHref)}">${esc(stand.project_name)}</a></dd></div>
          <div><dt>Location</dt><dd>${esc(stand.location || stand.project_location || '&mdash;')}</dd></div>
          <div><dt>Size</dt><dd>${esc(stand.size_sqm)}m&sup2;</dd></div>
          <div><dt>Property type</dt><dd>${esc(stand.type)}</dd></div>
          <div><dt>Price</dt><dd>${esc(price)}</dd></div>
          <div><dt>Availability</dt><dd>${esc(stand.status)}</dd></div>
        </dl>

        ${available
      ? `<a class="btn primary" href="/contact.html" data-enquire="${esc(stand.project_name)}, stand ${esc(stand.stand_number)}">Enquire about this property</a>`
      : `<p class="notice info">This property is <strong>${esc(String(stand.status).toLowerCase())}</strong>
            and is not currently available. <a href="/properties.html">See what is available</a>.</p>`}
      </div>
    </div>

    ${stand.description ? `    <div class="client-card" style="margin-top:24px">
      <h2>About this property</h2>
      <p>${esc(stand.description)}</p>
    </div>` : ''}
  </section>`;

  return layout({
    settings: ctx.settings,
    title: `Stand ${stand.stand_number} | ${stand.project_name} | Heritage Housing Projects`,
    description: `${stand.size_sqm}m² ${stand.type} stand ${stand.stand_number} at `
      + `${stand.project_name}, ${stand.location || stand.project_location || 'Zimbabwe'}. ${price}.`,
    active: 'properties.html',
    canonicalPath: `property/${stand.stand_number}`,
    body
  });
}

/**
 * One development, with a breakdown of what it contains.
 *
 * The counts are worked out from the properties themselves, so this page can
 * never claim a number the list underneath it disagrees with.
 */
function renderDevelopmentPage(ctx, project, stands, pricing = []) {
  const of = (status) => stands.filter((s) => s.status === status).length;
  const available = stands.filter((s) => s.status === 'Available');

  /* The overview keeps its blank lines: each becomes a paragraph. */
  const overview = lines(project.long_description || '')
    .length
    ? String(project.long_description).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      .map((p) => `      <p>${esc(p)}</p>`).join('\n')
    : (project.description ? `      <p>${esc(project.description)}</p>` : '');

  /* A feature line may start "Location: ..." — the part before the colon is
     shown as a heading, the rest as the detail. */
  const featureItems = lines(project.features || []).map((line) => {
    const at = line.indexOf(':');
    const label = at > 0 ? line.slice(0, at).trim() : '';
    const rest = at > 0 ? line.slice(at + 1).trim() : line;
    return label
      ? `        <li><strong>${esc(label)}:</strong> ${esc(rest)}</li>`
      : `        <li>${esc(rest)}</li>`;
  }).join('\n');

  const priceTable = pricing.length ? `
    <h2 class="section-title">Stand sizes and pricing</h2>
    <div class="client-card">
      <table class="portal-table price-table">
        <caption>Indicative prices for ${esc(project.name)}. Payment terms are flexible.</caption>
        <thead>
          <tr>
            <th scope="col">Stand size</th>
            <th scope="col">Cash price</th>
            <th scope="col">Credit price</th>
            <th scope="col">Minimum deposit</th>
          </tr>
        </thead>
        <tbody>
${pricing.map((r) => `          <tr>
            <td data-label="Stand size"><strong>${esc(r.size_label)}</strong></td>
            <td data-label="Cash price">${esc(r.cash || '&mdash;')}</td>
            <td data-label="Credit price">${esc(r.credit || '&mdash;')}</td>
            <td data-label="Minimum deposit">${esc(r.deposit || '&mdash;')}</td>
          </tr>`).join('\n')}
        </tbody>
      </table>
    </div>` : '';

  const featuresBlock = featureItems ? `
    <h2 class="section-title">Main features</h2>
    <div class="client-card">
      <ul class="feature-list">
${featureItems}
      </ul>
    </div>` : '';

  const body = `  <section class="container inner-page">
    <p><a class="text-btn" href="/projects.html">&larr; All developments</a></p>

    <div class="dashboard-top">
      <div>
        <span class="eyebrow dark">DEVELOPMENT</span>
        <h1>${esc(project.name)}</h1>
        <p class="muted">${esc(project.location)} &middot; ${esc(project.status)}</p>
      </div>
    </div>

    ${project.sold_out ? `<div class="notice info sold-out-note-page">
      <strong>Sorry &mdash; sold out:</strong> ${esc(project.name)}. Every stand here has been sold.
      <a href="/properties.html">See our other developments</a>.
    </div>` : ''}

    <div class="kpi-grid">
      <div class="kpi"><span class="kpi-label">Properties</span><strong class="kpi-value">${esc(stands.length)}</strong></div>
      <div class="kpi"><span class="kpi-label">Available</span><strong class="kpi-value good">${esc(available.length)}</strong></div>
      <div class="kpi"><span class="kpi-label">Reserved</span><strong class="kpi-value">${esc(of('Reserved'))}</strong></div>
      <div class="kpi"><span class="kpi-label">Sold</span><strong class="kpi-value">${esc(of('Sold'))}</strong></div>
      ${of('On Hold') ? `<div class="kpi"><span class="kpi-label">On hold</span><strong class="kpi-value warn">${esc(of('On Hold'))}</strong></div>` : ''}
    </div>

    <div class="client-card">
      <h2>About ${esc(project.name)}</h2>
      ${project.image_url ? `<div class="detail-image" role="img" aria-label="${esc(project.name)}" style="background-image:url('${esc(assetUrl(project.image_url))}')"></div>` : ''}
${overview}
    </div>
${featuresBlock}
${priceTable}

    <h2 class="section-title">Available properties in ${esc(project.name)}</h2>
    <div class="property-grid cards three">
${available.length
      ? propertyCards(available)
      : `      <p class="muted">No properties at ${esc(project.name)} are available at the moment.</p>`}
    </div>
  </section>`;

  return layout({
    settings: ctx.settings,
    title: `${project.name} | Heritage Housing Projects`,
    description: `${project.name}, ${project.location}. ${stands.length} properties, `
      + `${available.length} available. ${project.description || ''}`.slice(0, 300),
    active: 'projects.html',
    canonicalPath: `development/${slugify(project.name)}`,
    body
  });
}

module.exports = { render, layout, portal, NAV, renderPropertyPage, renderDevelopmentPage };
