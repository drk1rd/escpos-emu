'use strict';

const zlib = require('zlib');

/**
 * A minimal PNG encoder, so a logo on a receipt is visible as a logo.
 *
 * ESC/POS raster data (`GS v 0`) is one bit per dot, packed left to right, a
 * set bit meaning "fire the head" - that is, black. PNG greyscale is the other
 * way round: 0 is black. So the bits are inverted on the way out.
 *
 * Written by hand rather than pulled from npm because this tool has no runtime
 * dependencies, and a PNG with one image, no interlacing and no palette is
 * about thirty lines: signature, IHDR, IDAT, IEND, each with a CRC.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};

/**
 * Encode packed 1-bit rows as a greyscale PNG.
 *
 * @param {Buffer} packed      raster bytes, `widthBytes * height` of them
 * @param {number} widthBytes  bytes per row (the image is 8x this wide)
 * @param {number} height      rows
 * @returns {Buffer} a complete PNG file
 */
function monoPng(packed, widthBytes, height) {
  const width = widthBytes * 8;
  if (!widthBytes || !height) return null;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // no filtering beyond per-scanline
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type, here always 0 (none).
  const raw = Buffer.alloc((widthBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const at = y * (widthBytes + 1);
    raw[at] = 0;
    for (let x = 0; x < widthBytes; x += 1) {
      // Invert: an ESC/POS set bit is ink, a PNG set bit is white.
      raw[at + 1 + x] = ~(packed[y * widthBytes + x] || 0) & 0xff;
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The same, as a data URI the UI can put straight into an `img` tag. */
const monoPngDataUri = (packed, widthBytes, height) => {
  const png = monoPng(packed, widthBytes, height);
  return png ? `data:image/png;base64,${png.toString('base64')}` : null;
};

module.exports = { monoPng, monoPngDataUri, crc32 };
