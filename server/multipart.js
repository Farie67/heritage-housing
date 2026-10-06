'use strict';

/* ==========================================================================
   Minimal multipart/form-data parser.

   There is no runtime dependency available for this, so it is written here.
   It works on Buffers end to end: an uploaded PDF must never pass through a
   string conversion, or the bytes are mangled.

   Scope: exactly what an HTML <form enctype="multipart/form-data"> produces.
   It is not a general MIME parser — no nested multipart, no encodings.
   ========================================================================== */

/* A form is not allowed to send an unbounded number of parts. */
const MAX_PARTS = 24;

/** Pulls the boundary out of a Content-Type header. */
function boundaryFrom(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  const value = (m[1] || m[2] || '').trim();
  return value || null;
}

/** True when the header describes a multipart form body. */
function isMultipart(contentType) {
  return /^multipart\/form-data/i.test(String(contentType || '')) && Boolean(boundaryFrom(contentType));
}

/** Parses the Content-Disposition header into its name and filename. */
function disposition(header) {
  const name = /(?:^|;)\s*name="([^"]*)"/i.exec(header);
  const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(header);
  return {
    name: name ? name[1] : null,
    filename: filename ? filename[1] : null
  };
}

/**
 * Splits a multipart body into fields and files.
 *
 * Returns { fields, files, truncated } where:
 *   fields — { name: string }        for ordinary inputs
 *   files  — [{ name, filename, contentType, data: Buffer }]
 *   truncated — true if MAX_PARTS was reached, so the caller can refuse
 */
function parseMultipart(buffer, boundary) {
  const result = { fields: Object.create(null), files: [], truncated: false };

  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(delimiter);

  if (cursor === -1) return result;
  cursor += delimiter.length;

  while (cursor < buffer.length) {
    /* After a delimiter comes either "--" (the end) or CRLF. */
    if (buffer[cursor] === 0x2d && buffer[cursor + 1] === 0x2d) break;
    if (buffer[cursor] === 0x0d && buffer[cursor + 1] === 0x0a) cursor += 2;
    else break;

    const headerEnd = buffer.indexOf('\r\n\r\n', cursor, 'latin1');
    if (headerEnd === -1) break;

    const rawHeaders = buffer.toString('latin1', cursor, headerEnd);
    const bodyStart = headerEnd + 4;

    /* The next delimiter ends this part. A boundary appearing inside the file
       data is possible in theory but astronomically unlikely, because the
       browser generates a fresh random boundary per submission. */
    const next = buffer.indexOf(delimiter, bodyStart);
    if (next === -1) break;

    let bodyEnd = next;
    if (buffer[bodyEnd - 2] === 0x0d && buffer[bodyEnd - 1] === 0x0a) bodyEnd -= 2;

    const headers = Object.create(null);
    for (const line of rawHeaders.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }

    const { name, filename } = disposition(headers['content-disposition'] || '');
    const data = buffer.subarray(bodyStart, bodyEnd);

    if (name) {
      if (filename !== null && filename !== undefined) {
        result.files.push({
          name,
          filename,
          contentType: (headers['content-type'] || '').trim(),
          data
        });
      } else {
        result.fields[name] = data.toString('utf8');
      }
    }

    if (result.files.length + Object.keys(result.fields).length > MAX_PARTS) {
      result.truncated = true;
      break;
    }

    cursor = next + delimiter.length;
  }

  return result;
}

/** Content types we are willing to store and hand back to a client. */
const ALLOWED_UPLOAD_TYPES = new Map([
  ['application/pdf', '.pdf']
]);

/** Image types accepted for the site logo. */
const ALLOWED_IMAGE_TYPES = new Map([
  ['image/svg+xml', '.svg'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp']
]);

/**
 * An SVG is a document, not just a picture: it can carry script and event
 * handlers. The logo is only ever referenced from an <img>, where browsers do
 * not run scripts, but the file is still web-reachable on its own — so markup
 * that could execute is refused outright rather than stored.
 */
const SVG_BLOCKLIST = [
  /<script/i, /<foreignObject/i, /<iframe/i, /<embed/i, /<object/i,
  /<use[^>]+xlink:href\s*=\s*["']?(?!#)/i,
  /\son[a-z]+\s*=/i,
  /javascript:/i,
  /<!ENTITY/i
];

/** True when the bytes look like the image type they claim to be. */
function looksLikeImage(data, declared) {
  if (declared === 'image/png') {
    return data.length > 8 && data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG';
  }
  if (declared === 'image/jpeg') {
    return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (declared === 'image/webp') {
    return data.length > 12
      && data.subarray(0, 4).toString('latin1') === 'RIFF'
      && data.subarray(8, 12).toString('latin1') === 'WEBP';
  }
  if (declared === 'image/svg+xml') {
    const head = data.subarray(0, 4096).toString('utf8').trimStart();
    return head.startsWith('<');
  }
  return false;
}

/**
 * Validates a logo upload. As with documents, the declared type is only a
 * hint; the bytes have to agree.
 */
function validateLogoUpload(file, maxBytes) {
  if (!file || !file.data || file.data.length === 0) {
    return { ok: false, error: 'Please choose a file to upload.' };
  }
  if (file.data.length > maxBytes) {
    const mb = (maxBytes / 1024 / 1024).toFixed(1);
    return { ok: false, error: `That file is larger than the ${mb} MB limit.` };
  }

  const declared = String(file.contentType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(declared)) {
    return { ok: false, error: 'The logo must be an SVG, PNG, JPEG or WebP image.' };
  }
  if (!looksLikeImage(file.data, declared)) {
    return { ok: false, error: 'That file does not look like the image type it claims to be.' };
  }

  if (declared === 'image/svg+xml') {
    const text = file.data.toString('utf8');
    if (!/<svg[\s>]/i.test(text)) {
      return { ok: false, error: 'That SVG does not contain an <svg> element.' };
    }
    if (SVG_BLOCKLIST.some((re) => re.test(text))) {
      return {
        ok: false,
        error: 'That SVG contains scripting or embedded content, which is not accepted. '
          + 'Please supply a flattened SVG or a PNG.'
      };
    }
  }

  return { ok: true, extension: ALLOWED_IMAGE_TYPES.get(declared) };
}

/**
 * Validates an uploaded file for storage.
 *
 * The declared content type is a hint from the client and is never trusted on
 * its own — the magic bytes must agree. Without this, an HTML file renamed to
 * .pdf would be stored and later served back to a client's browser.
 *
 * Returns { ok: true, extension } or { ok: false, error }.
 */
function validateUpload(file, maxBytes) {
  if (!file || !file.data || file.data.length === 0) {
    return { ok: false, error: 'The uploaded file is empty.' };
  }
  if (file.data.length > maxBytes) {
    const mb = (maxBytes / 1024 / 1024).toFixed(0);
    return { ok: false, error: `That file is larger than the ${mb} MB limit.` };
  }

  const declared = String(file.contentType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_UPLOAD_TYPES.has(declared)) {
    return { ok: false, error: 'Only PDF documents can be uploaded.' };
  }

  const isPdf = file.data.subarray(0, 5).toString('latin1') === '%PDF-';
  if (!isPdf) {
    return { ok: false, error: 'That file does not look like a PDF. Please check the file and try again.' };
  }

  return { ok: true, extension: ALLOWED_UPLOAD_TYPES.get(declared) };
}

module.exports = {
  boundaryFrom,
  isMultipart,
  parseMultipart,
  validateUpload,
  validateLogoUpload,
  ALLOWED_UPLOAD_TYPES,
  ALLOWED_IMAGE_TYPES
};
