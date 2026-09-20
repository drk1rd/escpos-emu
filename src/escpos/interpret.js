'use strict';

const { decode, pageForSelector } = require('./codepages');

/**
 * Turn a job's bytes into what a printer would have put on paper.
 *
 * Not a filter. The common shortcut is to strip bytes that look like commands
 * and keep the rest, but the arguments of an ESC/POS command are ordinary
 * bytes: `ESC a 1` is 1b 61 01 and `ESC E 1` is 1b 45 01, so a stripper leaves
 * the `a` and the `E` behind and every line comes out several characters too
 * wide. Worse, it cannot tell you anything about the job - what was centred,
 * what was bold, whether the drawer was kicked, whether the paper was cut.
 *
 * So this walks the stream as a printer does, holding the state a printer
 * holds: alignment, emphasis, underline, character size, font and the selected
 * code page. Text is accumulated as raw bytes and decoded at the moment a span
 * ends, through whichever page was selected *then* - which is the only way a
 * mid-job `ESC t` shows up as the encoding change it is.
 *
 * Unknown sequences are recorded rather than dropped. A device that does
 * something we have not modelled should show up as a question, not as silence.
 *
 *   const doc = interpret(bytes);
 *   doc.lines     // [{ align, spans: [{ text, bold, underline, w, h }] }]
 *   doc.events    // cut / drawer / barcode / qr / image / unknown
 *   doc.text      // plain text, one line per line
 */

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const LF = 0x0a;
const CR = 0x0d;
const HT = 0x09;
const FF = 0x0c;
const CAN = 0x18;

/** Pages that are not a simple 128-entry table and need a real decoder. */
const MULTIBYTE = { GB18030: 'gb18030', BIG5: 'big5', SHIFT_JIS: 'shift_jis' };

const ALIGN = { 0: 'left', 1: 'center', 2: 'right', 48: 'left', 49: 'center', 50: 'right' };

/** How many arguments follow ESC <cmd>, for the fixed-length commands. */
const ESC_FIXED = {
  0x40: 0, // @   initialise
  0x32: 0, // 2   default line spacing
  0x69: 0, // i   full cut (legacy)
  0x6d: 0, // m   partial cut (legacy)
  0x34: 0, // 4   italic on
  0x35: 0, // 5   italic off
  0x61: 1, // a   justification
  0x21: 1, // !   print mode
  0x45: 1, // E   emphasis
  0x47: 1, // G   double strike
  0x2d: 1, // -   underline
  0x7b: 1, // {   upside down
  0x64: 1, // d   feed n lines
  0x4a: 1, // J   feed n dots
  0x6a: 1, // j   reverse feed
  0x4d: 1, // M   font
  0x52: 1, // R   international charset
  0x74: 1, // t   code page
  0x33: 1, // 3   line spacing
  0x20: 1, // SP  right character spacing
  0x72: 1, // r   print colour
  0x63: 2, // c   panel buttons / paper sensors (ESC c 5 n)
  0x24: 2, // $   absolute position
  0x5c: 2, // \   relative position
  0x70: 3, // p   drawer kick
};

/** How many arguments follow GS <cmd>, for the fixed-length commands. */
const GS_FIXED = {
  0x21: 1, // !   character size
  0x42: 1, // B   reverse video
  0x68: 1, // h   barcode height
  0x77: 1, // w   barcode width
  0x48: 1, // H   HRI position
  0x66: 1, // f   HRI font
  0x61: 1, // a   automatic status back
  0x72: 1, // r   transmit status
  0x49: 1, // I   printer id
  0x4c: 2, // L   left margin
  0x57: 2, // W   print area width
  0x50: 2, // P   motion units
};

const newState = () => ({
  align: 'left',
  bold: false,
  underline: false,
  w: 1,
  h: 1,
  font: 'A',
  page: 'CP437',
  invert: false,
});

/**
 * @param {Buffer|Uint8Array} input
 * @param {{ page?: string }} [opts] starting code page, as a device would have
 *        been left by whatever printed before - defaults to CP437 like hardware
 */
function interpret(input, opts = {}) {
  const bytes = Buffer.from(input || []);
  const state = { ...newState(), page: opts.page || 'CP437' };

  const lines = [];
  const events = [];
  const pagesUsed = new Set([state.page]);

  /** The line being built, and the run of bytes not yet decoded into it. */
  let spans = [];
  let lineAlign = state.align;
  let pending = [];
  let pendingStyle = { ...state };

  const decodeRun = (raw, page) => {
    const mb = MULTIBYTE[page];
    if (mb) {
      try {
        return new TextDecoder(mb, { fatal: false }).decode(Buffer.from(raw));
      } catch (_) {
        /* fall through to the table */
      }
    }
    return decode(raw, page);
  };

  /** Close the current run of text into a span. */
  const flushSpan = () => {
    if (pending.length === 0) return;
    const text = decodeRun(pending, pendingStyle.page);
    pending = [];
    if (text.length === 0) return;
    const last = spans[spans.length - 1];
    if (
      last &&
      last.bold === pendingStyle.bold &&
      last.underline === pendingStyle.underline &&
      last.w === pendingStyle.w &&
      last.h === pendingStyle.h &&
      last.font === pendingStyle.font &&
      last.invert === pendingStyle.invert
    ) {
      last.text += text;
      return;
    }
    spans.push({
      text,
      bold: pendingStyle.bold,
      underline: pendingStyle.underline,
      w: pendingStyle.w,
      h: pendingStyle.h,
      font: pendingStyle.font,
      invert: pendingStyle.invert,
    });
  };

  /**
   * Adopt the current state for the text that follows.
   *
   * Called *after* a command has mutated `state`, never before: the bytes
   * already in `pending` belong to the style that was in force when they
   * arrived, and `flushSpan` closes them under it. Taking the snapshot too
   * early was the first bug this file had - `GS ! 0x11` set double size and the
   * span it was meant to apply to still came out single, because the snapshot
   * had been taken from the state one instruction stale.
   */
  const syncStyle = () => {
    pendingStyle = { ...state };
  };

  const endLine = () => {
    flushSpan();
    lines.push({ align: lineAlign, spans });
    spans = [];
    lineAlign = state.align;
  };

  const addEvent = (type, at, extra = {}) => events.push({ type, at, ...extra });

  let i = 0;
  const len = bytes.length;

  while (i < len) {
    const b = bytes[i];

    if (b === LF) {
      endLine();
      i += 1;
      continue;
    }
    if (b === CR) {
      // Carriage return on its own moves the head, it does not print.
      i += 1;
      continue;
    }
    if (b === HT) {
      pending.push(0x20, 0x20, 0x20, 0x20);
      i += 1;
      continue;
    }
    if (b === FF) {
      endLine();
      addEvent('formFeed', i);
      i += 1;
      continue;
    }
    if (b === CAN) {
      // Cancel the line being composed, exactly as the device would.
      pending = [];
      spans = [];
      i += 1;
      continue;
    }

    if (b === ESC) {
      const cmd = bytes[i + 1];
      if (cmd === undefined) {
        addEvent('truncated', i, { bytes: [b] });
        break;
      }

      // ESC * — bit image. Length depends on the mode byte.
      if (cmd === 0x2a) {
        const m = bytes[i + 2];
        const nL = bytes[i + 3];
        const nH = bytes[i + 4];
        const cols = (nL | 0) + ((nH | 0) << 8);
        const perCol = m === 0 || m === 1 ? 1 : 3;
        const size = cols * perCol;
        const data = bytes.subarray(i + 5, i + 5 + size);
        flushSpan();
        addEvent('image', i, { kind: 'bitImage', mode: m, columns: cols, bytes: data.length });
        i += 5 + size;
        continue;
      }

      // ESC D — horizontal tab stops, NUL-terminated.
      if (cmd === 0x44) {
        let j = i + 2;
        while (j < len && bytes[j] !== 0x00) j += 1;
        i = j + 1;
        continue;
      }

      const argc = ESC_FIXED[cmd];
      if (argc === undefined) {
        addEvent('unknown', i, { prefix: 'ESC', command: cmd, hex: hex(bytes, i, 4) });
        i += 2;
        continue;
      }

      const a = bytes[i + 2];

      switch (cmd) {
        case 0x40: // initialise
          flushSpan();
          Object.assign(state, newState(), { page: state.page });
          lineAlign = state.align;
          pendingStyle = { ...state };
          addEvent('init', i);
          break;
        case 0x61: // justification
          flushSpan();
          state.align = ALIGN[a] || 'left';
          // Alignment applies to the whole line, including text already on it.
          lineAlign = state.align;
          break;
        case 0x45: // emphasis
          flushSpan();
          state.bold = (a & 1) === 1;
          break;
        case 0x47: // double strike, rendered as emphasis
          flushSpan();
          state.bold = state.bold || (a & 1) === 1;
          break;
        case 0x2d: // underline
          flushSpan();
          state.underline = a === 1 || a === 2 || a === 49 || a === 50;
          break;
        case 0x21: // print mode: font, emphasis, double height/width
          flushSpan();
          state.font = (a & 0x01) === 0 ? 'A' : 'B';
          state.bold = (a & 0x08) !== 0;
          state.h = (a & 0x10) !== 0 ? 2 : 1;
          state.w = (a & 0x20) !== 0 ? 2 : 1;
          state.underline = (a & 0x80) !== 0;
          break;
        case 0x4d: // font
          flushSpan();
          state.font = a === 0 || a === 48 ? 'A' : 'B';
          break;
        case 0x74: // code page
          flushSpan();
          state.page = pageForSelector(a);
          pagesUsed.add(state.page);
          addEvent('codePage', i, { page: state.page, selector: a });
          break;
        case 0x52: // international character set
          addEvent('charset', i, { charset: a });
          break;
        case 0x64: // feed n lines
          endLine();
          for (let k = 1; k < (a || 0); k += 1) lines.push({ align: 'left', spans: [] });
          break;
        case 0x70: // drawer kick
          addEvent('drawer', i, { pin: a, onMs: bytes[i + 3], offMs: bytes[i + 4] });
          break;
        case 0x69:
        case 0x6d:
          addEvent('cut', i, { kind: cmd === 0x69 ? 'full' : 'partial', legacy: true });
          break;
        default:
          break;
      }

      syncStyle();
      i += 2 + argc;
      continue;
    }

    if (b === GS) {
      const cmd = bytes[i + 1];
      if (cmd === undefined) {
        addEvent('truncated', i, { bytes: [b] });
        break;
      }

      // GS V — cut. Two forms: GS V m, and GS V m n for the feed-and-cut modes.
      if (cmd === 0x56) {
        const m = bytes[i + 2];
        const hasFeed = m === 65 || m === 66 || m === 97 || m === 98;
        endLine();
        addEvent('cut', i, {
          kind: m === 1 || m === 49 || m === 66 || m === 98 ? 'partial' : 'full',
          feed: hasFeed ? bytes[i + 3] : 0,
        });
        i += hasFeed ? 4 : 3;
        continue;
      }

      // GS k — barcode. m <= 6 is NUL-terminated, m >= 65 is length-prefixed.
      if (cmd === 0x6b) {
        const m = bytes[i + 2];
        let data;
        let next;
        if (m >= 65) {
          const n = bytes[i + 3] | 0;
          data = bytes.subarray(i + 4, i + 4 + n);
          next = i + 4 + n;
        } else {
          let j = i + 3;
          while (j < len && bytes[j] !== 0x00) j += 1;
          data = bytes.subarray(i + 3, j);
          next = j + 1;
        }
        flushSpan();
        addEvent('barcode', i, {
          symbology: barcodeName(m),
          mode: m,
          data: data.toString('latin1'),
        });
        i = next;
        continue;
      }

      // GS ( k — two-dimensional codes. Length-prefixed, so it is safe to skip
      // whole even when the function is one we do not interpret.
      if (cmd === 0x28 && bytes[i + 2] === 0x6b) {
        const pL = bytes[i + 3] | 0;
        const pH = bytes[i + 4] | 0;
        const size = pL + (pH << 8);
        const body = bytes.subarray(i + 5, i + 5 + size);
        const cn = body[0];
        const fn = body[1];
        // cn 49 fn 80 is "store the symbol data"; the payload is the rest.
        if (cn === 49 && fn === 80) {
          flushSpan();
          addEvent('qr', i, { data: body.subarray(3).toString('latin1') });
        }
        i += 5 + size;
        continue;
      }

      // GS v 0 — raster bit image.
      if (cmd === 0x76 && (bytes[i + 2] === 0x30 || bytes[i + 2] === 0x00)) {
        const m = bytes[i + 3];
        const xL = bytes[i + 4] | 0;
        const xH = bytes[i + 5] | 0;
        const yL = bytes[i + 6] | 0;
        const yH = bytes[i + 7] | 0;
        const widthBytes = xL + (xH << 8);
        const height = yL + (yH << 8);
        const size = widthBytes * height;
        const data = bytes.subarray(i + 8, i + 8 + size);
        flushSpan();
        addEvent('image', i, {
          kind: 'raster',
          mode: m,
          width: widthBytes * 8,
          height,
          widthBytes,
          data: Buffer.from(data).toString('base64'),
        });
        i += 8 + size;
        continue;
      }

      const argc = GS_FIXED[cmd];
      if (argc === undefined) {
        addEvent('unknown', i, { prefix: 'GS', command: cmd, hex: hex(bytes, i, 4) });
        i += 2;
        continue;
      }

      if (cmd === 0x21) {
        // GS ! — character size. High nibble is width, low nibble is height,
        // both as "times normal minus one".
        const a = bytes[i + 2] | 0;
        flushSpan();
        state.w = ((a >> 4) & 0x07) + 1;
        state.h = (a & 0x07) + 1;
      } else if (cmd === 0x42) {
        const a = bytes[i + 2] | 0;
        flushSpan();
        state.invert = a !== 0;
      }

      syncStyle();
      i += 2 + argc;
      continue;
    }

    if (b === FS) {
      const cmd = bytes[i + 1];
      // FS p m n — print an NV logo. FS ! / FS & / FS . take one argument.
      if (cmd === 0x70) {
        flushSpan();
        addEvent('image', i, { kind: 'nvLogo', id: bytes[i + 2], mode: bytes[i + 3] });
        i += 4;
      } else {
        addEvent('unknown', i, { prefix: 'FS', command: cmd, hex: hex(bytes, i, 4) });
        i += 2;
      }
      continue;
    }

    /*
      DLE - the real-time commands.

      These are the ones a printer acts on immediately rather than in stream
      order: status requests, and the real-time drawer kick that a till uses
      when it wants the cash drawer open now rather than at the end of the
      receipt. They are length-prefixed by their function, so they can be
      stepped over exactly.
    */
    if (b === 0x10) {
      const fn = bytes[i + 1];
      if (fn === 0x04 || fn === 0x05) {
        addEvent(fn === 0x04 ? 'statusRequest' : 'realtimeRequest', i, { n: bytes[i + 2] });
        i += 3;
        continue;
      }
      if (fn === 0x14) {
        const sub = bytes[i + 2];
        if (sub === 0x01) {
          addEvent('drawer', i, { realtime: true, pin: bytes[i + 3], onMs: bytes[i + 4] });
        } else {
          addEvent('unknown', i, { prefix: 'DLE DC4', command: sub, hex: hex(bytes, i, 5) });
        }
        i += 5;
        continue;
      }
      addEvent('unknown', i, { prefix: 'DLE', command: fn, hex: hex(bytes, i, 3) });
      i += 2;
      continue;
    }

    /*
      Any other control byte is not text.

      A printer does not put 0x14 on the paper; the byte means something to the
      device or it means nothing, but either way it is not a character. Letting
      these through put raw control codes into the decoded text - found when a
      receipt built with an em dash in a latin1 buffer, which truncates to 0x14,
      appeared to print one.

      Recorded rather than dropped: a stray control byte in a print stream is
      usually an encoding mistake upstream, and that is worth seeing.
    */
    if (b < 0x20) {
      addEvent('control', i, { byte: b, hex: b.toString(16).padStart(2, '0') });
      i += 1;
      continue;
    }

    // Ordinary text. Held as bytes so the code page in force when the span
    // closes is the one it is decoded through.
    pending.push(b);
    i += 1;
  }

  // Whatever was still being composed when the stream ended is a real line -
  // a job that was cut off mid-line should show what had been printed.
  if (pending.length > 0 || spans.length > 0) endLine();

  const text = lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n');

  return {
    lines,
    events,
    text,
    codePages: [...pagesUsed],
    byteLength: bytes.length,
  };
}

const hex = (buf, from, n) =>
  Buffer.from(buf.subarray(from, from + n))
    .toString('hex')
    .replace(/(..)/g, '$1 ')
    .trim();

const BARCODES = {
  0: 'UPC-A',
  1: 'UPC-E',
  2: 'EAN13',
  3: 'EAN8',
  4: 'CODE39',
  5: 'ITF',
  6: 'CODABAR',
  65: 'UPC-A',
  66: 'UPC-E',
  67: 'EAN13',
  68: 'EAN8',
  69: 'CODE39',
  70: 'ITF',
  71: 'CODABAR',
  72: 'CODE93',
  73: 'CODE128',
};

const barcodeName = (m) => BARCODES[m] || `mode_${m}`;

module.exports = { interpret };
