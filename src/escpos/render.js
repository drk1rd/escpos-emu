'use strict';

/**
 * Lay an interpreted job out on paper of a given width.
 *
 * Width is the thing test suites get wrong, because a double-width character
 * occupies two columns and `String.length` says one. A 48-column roll fits 24
 * double-width characters, and a line that looks fine in a string comparison
 * wraps on the actual device. So width here is *visual* width, and a line that
 * exceeds the roll is flagged rather than silently truncated - that flag is
 * what turns "the receipt looks odd" into "line 7 is 52 columns on a 48 column
 * roll".
 */

/** Columns a span occupies: double-width characters take two. */
const spanWidth = (span) => [...span.text].length * (span.w || 1);

/** Columns a whole line occupies. */
const lineWidth = (line) => (line.spans || []).reduce((n, s) => n + spanWidth(s), 0);

const padFor = (align, width, columns) => {
  const slack = Math.max(0, columns - width);
  if (align === 'center') return Math.floor(slack / 2);
  if (align === 'right') return slack;
  return 0;
};

/**
 * Render to the lines a printer would produce.
 *
 * Each line keeps its spans so a UI can show emphasis and size, and also
 * carries the flat text with the leading pad applied so a plain-text diff of
 * two receipts compares what was actually on the paper.
 */
const renderLines = (doc, columns = 48) =>
  (doc.lines || []).map((line, index) => {
    const width = lineWidth(line);
    const pad = padFor(line.align, width, columns);
    const text = ' '.repeat(pad) + (line.spans || []).map((s) => s.text).join('');
    return {
      index,
      align: line.align,
      spans: line.spans || [],
      text,
      width,
      pad,
      over: width > columns,
    };
  });

/** The paper as plain text, one line per line, trailing blanks trimmed. */
const toText = (doc, columns = 48) =>
  renderLines(doc, columns)
    .map((l) => l.text.replace(/\s+$/, ''))
    .join('\n');

/**
 * The same, with what is allowed to differ between two runs masked: the clock.
 * Everything else has to match, because everything else is a decision somebody
 * made about the document. This is what a layout regression test compares.
 */
const toLayout = (doc, columns = 48) =>
  toText(doc, columns)
    .split('\n')
    .map((l) =>
      l
        .replace(/\d{2}[/-]\d{2}[/-]\d{2,4}/g, '<date>')
        .replace(/\d{1,2}:\d{2}(:\d{2})?\s*([ap]\.?m\.?)?/gi, '<time>')
    )
    .join('\n');

/** Lines that do not fit the roll, for the warning strip in the UI. */
const overWidthLines = (doc, columns = 48) =>
  renderLines(doc, columns).filter((l) => l.over);

module.exports = { renderLines, toText, toLayout, overWidthLines, lineWidth, spanWidth };
