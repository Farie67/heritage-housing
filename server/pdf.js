'use strict';

/* ==========================================================================
   A small PDF writer.

   Enough to produce a genuine, openable document: text in two weights, rules,
   filled rectangles, right and centre alignment, and multiple pages.

   There is no dependency available for this, so it is written here. Two
   details make the difference between a usable file and a broken one:

     - Text is measured using the real Helvetica font metrics, so columns can
       be right-aligned. Without widths you can only left-align, which makes
       an amount column look wrong.
     - Byte offsets in the xref table are accumulated as objects are written.
       A wrong offset makes the file unopenable rather than merely ugly.

   Coordinates are given top-down because that is how a page is laid out; they
   are flipped to PDF's bottom-up system internally.
   ========================================================================== */

/* Widths in 1/1000 em for ASCII 32..126, taken from the standard Helvetica
   and Helvetica-Bold Adobe font metrics. */
const REGULAR_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584
];

const BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611,
  611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
  389, 280, 389, 584
];

/* Characters outside Latin-1 that WinAnsiEncoding places at specific bytes. */
const WINANSI = {
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
  '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
  '\u2030': 0x89, '\u0160': 0x8a, '\u2039': 0x8b, '\u0152': 0x8c,
  '\u017D': 0x8e, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
  '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u2122': 0x99, '\u0161': 0x9a, '\u203A': 0x9b, '\u0153': 0x9c,
  '\u017E': 0x9e, '\u0178': 0x9f
};

/** Converts a string to WinAnsi bytes, replacing anything unmappable with '?'. */
function toBytes(str) {
  const out = [];
  for (const ch of String(str)) {
    if (Object.prototype.hasOwnProperty.call(WINANSI, ch)) { out.push(WINANSI[ch]); continue; }
    const cp = ch.codePointAt(0);
    out.push(cp <= 0xff ? cp : 0x3f);
  }
  return out;
}

/** Escapes the three characters that are special inside a PDF string. */
function escapeLiteral(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b === 0x28) out += '\\(';
    else if (b === 0x29) out += '\\)';
    else if (b === 0x5c) out += '\\\\';
    else out += String.fromCharCode(b);
  }
  return out;
}

const num = (n) => (Math.round(n * 100) / 100).toFixed(2);

class PdfDoc {
  constructor({ width = 595.28, height = 841.89 } = {}) {
    this.width = width;
    this.height = height;
    this.pages = [[]];
  }

  get pageCount() { return this.pages.length; }

  /** Starts a new page and returns its index. */
  addPage() { this.pages.push([]); return this.pages.length - 1; }

  _op(op, page) { this.pages[page === undefined ? this.pages.length - 1 : page].push(op); }

  /* Top-down y becomes bottom-up. */
  _y(y) { return this.height - y; }

  /** Width of a string in points at the given size. */
  measure(str, { font = 'regular', size = 10 } = {}) {
    const table = font === 'bold' ? BOLD_WIDTHS : REGULAR_WIDTHS;
    let total = 0;
    for (const b of toBytes(str)) {
      total += (b >= 32 && b <= 126) ? table[b - 32] : table[0];
    }
    return total * size / 1000;
  }

  text(str, x, y, { font = 'regular', size = 10, gray = 0, page } = {}) {
    const f = font === 'bold' ? '/F2' : '/F1';
    this._op(
      `BT ${f} ${num(size)} Tf ${num(gray)} g ${num(x)} ${num(this._y(y))} Td `
      + `(${escapeLiteral(toBytes(str))}) Tj ET`, page);
    return this;
  }

  /** Right-aligns so the string ends at xRight. */
  textRight(str, xRight, y, opts = {}) {
    return this.text(str, xRight - this.measure(str, opts), y, opts);
  }

  /** Centres so the string is balanced around xCentre. */
  textCenter(str, xCentre, y, opts = {}) {
    return this.text(str, xCentre - this.measure(str, opts) / 2, y, opts);
  }

  line(x1, y1, x2, y2, { width = 0.5, gray = 0, page } = {}) {
    this._op(`${num(width)} w ${num(gray)} G ${num(x1)} ${num(this._y(y1))} m `
      + `${num(x2)} ${num(this._y(y2))} l S`, page);
    return this;
  }

  /** y is the top edge of the rectangle. */
  fillRect(x, y, w, h, { gray = 0.9, page } = {}) {
    this._op(`${num(gray)} g ${num(x)} ${num(this._y(y + h))} ${num(w)} ${num(h)} re f`, page);
    return this;
  }

  /** Emitted as a real page break so long statements stay readable. */
  build() {
    const objects = [];
    const pageCount = this.pages.length;

    /* Object numbers are contiguous: 1 catalogue, 2 page tree, 3 and 4 the font
       pair, then a page/content pair per page. Leaving a gap would require a
       free xref entry for an object that never exists, which is legal but
       makes some readers complain. */
    const fontRegular = 3;
    const fontBold = 4;
    const firstPageObj = 5;

    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${this.pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`;
    objects[fontRegular] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[fontBold] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    this.pages.forEach((ops, i) => {
      const pageObj = firstPageObj + i * 2;
      const contentObj = pageObj + 1;
      const stream = ops.join('\n');

      objects[pageObj] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] `
        + `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> `
        + `/Contents ${contentObj} 0 R >>`;
      objects[contentObj] =
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
    });

    let pdf = '%PDF-1.4\n';
    const offsets = [];

    for (let i = 1; i < objects.length; i++) {
      if (objects[i] === null || objects[i] === undefined) continue;
      offsets[i] = Buffer.byteLength(pdf, 'latin1');
      pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }

    const xrefStart = Buffer.byteLength(pdf, 'latin1');
    const size = objects.length;
    pdf += `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 1; i < size; i++) {
      const off = offsets[i];
      pdf += (off === undefined ? '0000000000 00000 f ' : String(off).padStart(10, '0') + ' 00000 n ') + '\n';
    }
    pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

    return Buffer.from(pdf, 'latin1');
  }
}

module.exports = { PdfDoc, toBytes };
