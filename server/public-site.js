'use strict';

/* ==========================================================================
   Assembles everything a public page needs and hands it to the renderer.

   Shared by the live server and by the static exporter, so a page can never
   look different depending on how it was produced.
   ========================================================================== */

const { content, portal, admin } = require('./db');
const { PAGES } = require('./content');
const viewsPublic = require('./views-public');

const BY_FILE = new Map(PAGES.map((p) => [p.file, p.key]));
const ALL_FILES = PAGES.map((p) => p.file);

/** Data shared by every page. */
function baseContext() {
  const projects = portal.projects();
  const featured = projects.find((p) => p.name === 'Heritage Park') || projects[0] || null;

  return {
    settings: content.settings(),
    projects,
    stands: portal.stands(),
    featuredImage: featured ? featured.image_url : null
  };
}

/**
 * Renders the page for a filename such as "about.html".
 * Returns null when the filename is not one of the editable pages.
 */
function renderFile(file) {
  const pageKey = BY_FILE.get(file);
  if (!pageKey) return null;

  const ctx = baseContext();
  ctx.content = content.resolve(pageKey);

  return viewsPublic.render(pageKey, ctx);
}

/** The signed-out client login page. */
function renderPortalPage() {
  const settings = content.settings();

  return viewsPublic.layout({
    settings,
    title: 'Client Login | My Heritage',
    description: 'Sign in to the My Heritage client portal to view your stand, payment history, documents and project progress.',
    active: '',
    canonicalPath: 'portal.html',
    body: viewsPublic.portal(settings)
  });
}

/** One individual property, addressed by its stand number. */
function renderProperty(stand) {
  return viewsPublic.renderPropertyPage(baseContext(), stand);
}

/** One development, together with the properties it contains. */
function renderDevelopment(project) {
  const ctx = baseContext();
  /* Matched on the id rather than the name — a development can be renamed. */
  const stands = ctx.stands.filter((s) => s.project_id === project.id);
  return viewsPublic.renderDevelopmentPage(ctx, project, stands, admin.pricingFor(project.id));
}

/** A plain 404 that still carries the site chrome and a way out. */
function renderNotFound() {
  const ctx = baseContext();
  return viewsPublic.layout({
    settings: ctx.settings,
    title: 'Not found | Heritage Housing Projects',
    description: 'That page could not be found.',
    active: '',
    canonicalPath: '404',
    body: `  <section class="container inner-page">
    <span class="eyebrow dark">NOT FOUND</span>
    <h1>We could not find that</h1>
    <p class="muted">The property or development may have been sold or removed.</p>
    <p><a class="btn primary" href="/properties.html">See available properties</a>
       <a class="btn outline" href="/projects.html">See developments</a></p>
  </section>`
  });
}

/** Every filename the CMS owns, so the exporter and router agree. */
function allFiles() { return ALL_FILES.slice(); }

/** True when a filename is served from the database rather than from disk. */
function isContentPage(file) { return BY_FILE.has(file); }

module.exports = {
  renderFile, renderPortalPage, allFiles, isContentPage, baseContext, BY_FILE,
  renderProperty, renderDevelopment, renderNotFound
};
