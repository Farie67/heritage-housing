'use strict';

/* ==========================================================================
   HTML sanitiser for the staff activity log.
   No dependencies — this project has none, and a hand-written allowlist is
   easier to audit than a parser for the handful of tags an editor emits.

   The approach is "escape everything, then re-allow a short list":

     1. Every character that could start markup is escaped, so the whole input
        becomes inert text. Nothing in it can execute, whatever it contains.
     2. Only exact, attribute-free forms of the allowed tags are turned back
        into real markup.

   Step 2 only matches a bare `<tag>` or `</tag>` with no attributes at all, so
   `<img onerror=...>`, `<a href="javascript:...">` and friends can never be
   revived — they stay visible as text. That is deliberately stricter than
   stripping attributes: a tag we did not plan for disappears rather than
   surviving in some reduced form.
   ========================================================================== */

/* What the toolbar can produce. Anything else is not worth keeping. */
const ALLOWED_TAGS = new Set([
  'h2', 'h3', 'p', 'br',
  'strong', 'b', 'em', 'i', 'u',
  'ul', 'ol', 'li'
]);

/* Tags to drop along with everything inside them.
   Stripping only the tag would leave the payload as visible text; for script
   and style the contents are noise at best and confusing at worst. */
const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'template'];

const MAX_LENGTH = 20000;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Returns HTML that is safe to put in a page, keeping only simple formatting.
 *
 * Empty input returns '', so "did they write anything" is a plain length check
 * on the caller's side.
 */
function sanitizeRichText(input) {
  let text = String(input == null ? '' : input).slice(0, MAX_LENGTH);

  /* Drop whole dangerous elements first, while the markup is still markup, so
     their contents go too. */
  for (const tag of DROP_WITH_CONTENT) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    text = text.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  /* Everything else becomes inert. From here on, the string cannot execute. */
  const escaped = escapeHtml(text);

  /* Revive only bare open/close tags from the allowlist. The pattern demands
     that nothing at all sits between the tag name and the closing bracket, so
     any tag carrying an attribute fails to match and stays escaped text. */
  const withTags = escaped.replace(/&lt;(\/?)([a-zA-Z0-9]+)(\s*\/?)&gt;/g, (match, slash, name) => {
    const tag = name.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    /* <br> and <br/> are the only void tags we allow. */
    if (tag === 'br') return '<br>';
    return `<${slash}${tag}>`;
  });

  /* Undo ONE level of escaping for a short list of harmless entities.
     escapeHtml turns every & into &amp;, so a stored `&nbsp;` arrives here as
     `&amp;nbsp;` and the browser would print the five visible characters
     "&nbsp;". Decoding it back to `&nbsp;` makes it a space again.
     This is safe because each replacement produces an entity reference, never a
     tag: `&amp;lt;` becomes `&lt;`, which the browser shows as the text "<". */
  return withTags.replace(/&amp;(nbsp|amp|lt|gt|quot|apos|#39|#x27);/gi, '&$1;');
}

/**
 * True when the HTML holds more than an empty editor's worth of markup.
 *
 * A Quill-style editor leaves `<p><br></p>` behind when nothing was typed, and
 * that would otherwise pass a naive length check.
 */
function hasRichText(html) {
  const text = String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0;
}

module.exports = { sanitizeRichText, escapeHtml, hasRichText, ALLOWED_TAGS };
