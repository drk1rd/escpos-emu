'use strict';

/**
 * Byte-to-character tables for the code pages a thermal printer actually uses.
 *
 * A printer does not receive text. It receives bytes, and it renders them
 * through whichever code page it was last told to select with `ESC t n`. Get
 * that wrong and a receipt is not corrupt in an obvious way - it is subtly,
 * silently wrong in exactly the characters an English test never exercises:
 * currency symbols, accents, the degree sign, box drawing.
 *
 * Decoding through the *selected* page is the whole point. A decoder that
 * assumed latin1 would render byte 0x9C as an unprintable control and hide the
 * fact that the printer was about to put a pound sign there - or not.
 *
 * Only the high half (0x80-0xFF) is tabulated; 0x00-0x7F is ASCII in every one
 * of these.
 */

/** 0x80-0xFF for IBM PC US, the default on virtually every ESC/POS device. */
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** Multilingual Latin 1. The common European alternative to 437. */
const CP850 =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' +
  'áíóúñÑªº¿®¬½¼¡«»' +
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' +
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' +
  '­±‗¾¶§÷¸°¨·¹³²■ ';

/** 858 is 850 with the euro replacing the dotless i at 0xD5. */
const CP858 = CP850.slice(0, 0x55) + '€' + CP850.slice(0x56);

/** Windows Latin 1. Differs from latin1 only in 0x80-0x9F. */
const CP1252 =
  '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž�' +
  '�‘’“”•–—˜™š›œ�žŸ' +
  ' ¡¢£¤¥¦§¨©ª«¬­®¯' +
  '°±²³´µ¶·¸¹º»¼½¾¿' +
  'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏ' +
  'ÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß' +
  'àáâãäåæçèéêëìíîï' +
  'ðñòóôõö÷øùúûüýþÿ';

/** Plain latin1, used as the fallback for a page we do not tabulate. */
const LATIN1 = Array.from({ length: 128 }, (_, i) =>
  String.fromCharCode(0x80 + i)
).join('');

const TABLES = {
  CP437,
  CP850,
  CP858,
  CP1252,
  LATIN1,
};

/**
 * `ESC t n` selects a page by number. These are the Epson assignments that
 * devices in the field actually honour; anything else falls back rather than
 * throwing, because a real printer does not stop either.
 */
const BY_SELECTOR = {
  0: 'CP437',
  2: 'CP850',
  3: 'CP860',
  4: 'CP863',
  5: 'CP865',
  16: 'CP1252',
  17: 'CP866',
  18: 'CP852',
  19: 'CP858',
};

/** The page name for an `ESC t n` argument. Unknown selectors keep their number. */
const pageForSelector = (n) => BY_SELECTOR[n] || `CP_${n}`;

/**
 * Decode one byte through a page.
 *
 * Unknown pages fall through to latin1 rather than producing a replacement
 * character, so a receipt printed under a page we do not model is still mostly
 * readable and the *page name* is what tells you it was unusual.
 */
const decodeByte = (byte, page) => {
  if (byte < 0x80) return String.fromCharCode(byte);
  const table = TABLES[page] || LATIN1;
  return table[byte - 0x80] || '�';
};

/** Decode a run of bytes through one page. */
const decode = (bytes, page) => {
  let out = '';
  for (const b of bytes) out += decodeByte(b, page);
  return out;
};

module.exports = { TABLES, decode, decodeByte, pageForSelector, BY_SELECTOR };
