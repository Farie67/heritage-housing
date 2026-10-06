'use strict';

/* ==========================================================================
   Branding resolution.

   The supplied logo is a wide wordmark, which means three separate files are
   in play and each has to be referenced differently:

     logo.png        the wordmark, for light backgrounds  (header, login)
     logo-light.png  the same artwork with the navy repainted white, for the
                     dark footer where the navy would be nearly invisible
     logo-mark.png   the house mark alone, square, for the browser tab

   Public pages use relative paths so the static export works from a plain
   file; the dashboard and admin are served from /dashboard and /admin, so
   they need absolute ones.
   ========================================================================== */

const { content } = require('./db');

const FALLBACK = {
  logo: 'assets/img/logo.png',
  light: 'assets/img/logo-light.png',
  favicon: 'assets/img/logo-mark.png'
};

function settingValue(key, fallback) {
  const raw = content.settings()[key];
  return (raw && String(raw).trim()) || fallback;
}

/** Makes a stored path absolute unless it is already a URL. */
function absolute(raw) {
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('data:')) return raw;
  return '/' + raw.replace(/^\/+/, '');
}

/** The wordmark, as stored (relative). */
const logoPath = () => settingValue('logo_url', FALLBACK.logo);
/** The wordmark for dark backgrounds, as stored (relative). */
const logoLightPath = () => settingValue('logo_light_url', FALLBACK.light);
/** The square mark, as stored (relative). */
const faviconPath = () => settingValue('favicon_url', FALLBACK.favicon);

/** Absolute forms, for pages served from a nested route. */
const logoAbsolute = () => absolute(logoPath());
const logoLightAbsolute = () => absolute(logoLightPath());
const faviconAbsolute = () => absolute(faviconPath());

/** True when the wordmark is the bundled file rather than an upload. */
const isDefaultLogo = () => !/logo-custom\./.test(logoPath());

/**
 * The registered company name. The wordmark image already shows the name, so
 * this is what its alt text should say — the logo is the only place the site
 * name appears in the header.
 */
const brandName = () => settingValue('company_legal', 'Heritage Housing Projects (Pvt) Ltd');

module.exports = {
  logoPath, logoLightPath, faviconPath,
  logoAbsolute, logoLightAbsolute, faviconAbsolute,
  isDefaultLogo, brandName, FALLBACK
};
