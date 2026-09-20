'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { interpret } = require('../src/escpos/interpret');
const { toText, toLayout, lineWidth, overWidthLines } = require('../src/escpos/render');

/** A tiny builder, so each test reads as the byte stream it is. */
const bytes = (...parts) =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)))
  );

const ESC_INIT = [0x1b, 0x40];
const LF = [0x0a];

test('text with no commands is the text', () => {
  const doc = interpret(bytes('HELLO', LF));
  assert.strictEqual(doc.text, 'HELLO');
  assert.strictEqual(doc.lines.length, 1);
});

test('command arguments are not printed as text', () => {
  // The classic failure: a stripper that removes 1b but keeps 61 and 01 turns
  // `ESC a 1` into the letter "a" on the receipt.
  const doc = interpret(bytes(ESC_INIT, [0x1b, 0x61, 0x01], 'CENTRED', LF));
  assert.strictEqual(doc.text, 'CENTRED');
  assert.ok(!doc.text.includes('a'), 'the alignment argument leaked into the text');
});

test('alignment places the line on the paper', () => {
  const doc = interpret(bytes([0x1b, 0x61, 0x01], 'MID', LF, [0x1b, 0x61, 0x02], 'END', LF));
  const paper = toText(doc, 20).split('\n');
  assert.strictEqual(paper[0], '        MID');
  assert.strictEqual(paper[1], '                 END');
});

test('emphasis applies to the text after it and not before', () => {
  const doc = interpret(bytes('plain', [0x1b, 0x45, 0x01], 'BOLD', [0x1b, 0x45, 0x00], 'after', LF));
  const spans = doc.lines[0].spans;
  assert.deepStrictEqual(
    spans.map((s) => [s.text, s.bold]),
    [
      ['plain', false],
      ['BOLD', true],
      ['after', false],
    ]
  );
});

test('GS ! sets character size for the span that follows it', () => {
  // Regression: the style snapshot was taken before the command was applied,
  // so double size landed one span late and the title came out normal.
  const doc = interpret(bytes([0x1d, 0x21, 0x11], 'BIG', [0x1d, 0x21, 0x00], 'small', LF));
  const [big, small] = doc.lines[0].spans;
  assert.deepStrictEqual([big.text, big.w, big.h], ['BIG', 2, 2]);
  assert.deepStrictEqual([small.text, small.w, small.h], ['small', 1, 1]);
});

test('a double-width character occupies two columns', () => {
  const doc = interpret(bytes([0x1d, 0x21, 0x10], 'ABCD', LF));
  assert.strictEqual(lineWidth(doc.lines[0]), 8, 'four double-wide characters are eight columns');
});

test('a line wider than the roll is reported, not truncated', () => {
  const doc = interpret(bytes('THIS LINE IS FORTY-ONE CHARACTERS LONG!!!', LF));
  assert.strictEqual(overWidthLines(doc, 32).length, 1);
  assert.strictEqual(overWidthLines(doc, 48).length, 0);
});

test('bytes are decoded through the selected code page', () => {
  // 0x9C is the pound sign in CP437 and a quote in CP1252.
  const cp437 = interpret(bytes([0x1b, 0x74, 0x00], [0x9c], LF));
  assert.strictEqual(cp437.text, '£');

  const cp1252 = interpret(bytes([0x1b, 0x74, 0x10], [0x80], LF));
  assert.strictEqual(cp1252.text, '€');
});

test('a code page switched mid-job applies only from that point', () => {
  const doc = interpret(bytes([0x1b, 0x74, 0x00], [0x9c], [0x1b, 0x74, 0x10], [0x80], LF));
  assert.strictEqual(doc.text, '£€');
  assert.deepStrictEqual(doc.codePages, ['CP437', 'CP1252']);
});

test('a cut is recorded, with its kind', () => {
  const full = interpret(bytes('x', LF, [0x1d, 0x56, 0x00]));
  const partial = interpret(bytes('x', LF, [0x1d, 0x56, 0x42, 0x03]));
  assert.strictEqual(full.events.find((e) => e.type === 'cut').kind, 'full');

  const p = partial.events.find((e) => e.type === 'cut');
  assert.strictEqual(p.kind, 'partial');
  assert.strictEqual(p.feed, 3, 'the feed argument must be consumed, not printed');
  assert.strictEqual(partial.text.trim(), 'x');
});

test('a drawer kick is recorded rather than printed', () => {
  const doc = interpret(bytes('x', [0x1b, 0x70, 0x00, 0x19, 0xfa], LF));
  const kick = doc.events.find((e) => e.type === 'drawer');
  assert.ok(kick, 'the drawer kick was not seen');
  assert.strictEqual(kick.pin, 0);
  assert.strictEqual(doc.text, 'x');
});

test('a barcode payload is captured, both length-prefixed and NUL-terminated', () => {
  const prefixed = interpret(bytes([0x1d, 0x6b, 73, 0x06], 'JB1663', LF));
  const bc = prefixed.events.find((e) => e.type === 'barcode');
  assert.strictEqual(bc.data, 'JB1663');
  assert.strictEqual(bc.symbology, 'CODE128');
  assert.strictEqual(prefixed.text.trim(), '', 'barcode data must not appear as text');

  const terminated = interpret(bytes([0x1d, 0x6b, 0x04], 'ABC', [0x00], LF));
  assert.strictEqual(terminated.events.find((e) => e.type === 'barcode').data, 'ABC');
});

test('a QR payload is captured', () => {
  const data = 'https://example.test/bill/1';
  const len = data.length + 3;
  const doc = interpret(
    bytes([0x1d, 0x28, 0x6b, len & 0xff, len >> 8, 49, 80, 48], data, LF)
  );
  assert.strictEqual(doc.events.find((e) => e.type === 'qr').data, data);
  assert.strictEqual(doc.text.trim(), '');
});

test('raster image data is consumed whole and never printed as text', () => {
  const widthBytes = 2;
  const height = 3;
  const pixels = Buffer.alloc(widthBytes * height, 0xff);
  const doc = interpret(
    bytes([0x1d, 0x76, 0x30, 0x00, widthBytes, 0x00, height, 0x00], pixels, 'after', LF)
  );
  const img = doc.events.find((e) => e.type === 'image');
  assert.strictEqual(img.width, 16);
  assert.strictEqual(img.height, 3);
  assert.strictEqual(doc.text, 'after', 'image bytes leaked into the text');
});

test('an unknown sequence is recorded instead of silently dropped', () => {
  const doc = interpret(bytes('a', [0x1b, 0x99], 'b', LF));
  const unknown = doc.events.find((e) => e.type === 'unknown');
  assert.ok(unknown, 'an unmodelled command should be visible');
  assert.strictEqual(unknown.prefix, 'ESC');
});

test('a stream that ends mid-line still shows what was printed', () => {
  const doc = interpret(bytes('no newline at the end'));
  assert.strictEqual(doc.text, 'no newline at the end');
});

test('layout masks the clock so two prints of one ticket compare equal', () => {
  const at = (t) => interpret(bytes('TICKET 1183', LF, `Printed ${t}`, LF));
  assert.strictEqual(
    toLayout(at('21:40:33'), 48),
    toLayout(at('21:40:35'), 48),
    'two prints of the same round must have the same layout'
  );
  assert.notStrictEqual(
    toLayout(at('21:40:33'), 48),
    toLayout(interpret(bytes('TICKET 1184', LF, 'Printed 21:40:33', LF)), 48),
    'different rounds must not collapse together'
  );
});

test('a stray control byte is recorded, not printed', () => {
  // An em dash put through a latin1 buffer truncates to 0x14. A printer does
  // not put that on the paper, and neither should the decoded text.
  const doc = interpret(bytes('A', [0x14], 'B', LF));
  assert.strictEqual(doc.text, 'AB');
  assert.strictEqual(doc.events.find((e) => e.type === 'control').hex, '14');
});

test('the real-time drawer kick is recognised', () => {
  // DLE DC4 fn m t - what a till sends when it wants the drawer open now.
  const doc = interpret(bytes('x', [0x10, 0x14, 0x01, 0x00, 0x01], LF));
  const kick = doc.events.find((e) => e.type === 'drawer');
  assert.ok(kick, 'the real-time drawer kick was missed');
  assert.strictEqual(kick.realtime, true);
  assert.strictEqual(doc.text, 'x', 'the command leaked into the text');
});

test('a real-time status request is stepped over cleanly', () => {
  const doc = interpret(bytes('before', [0x10, 0x04, 0x01], 'after', LF));
  assert.strictEqual(doc.text, 'beforeafter');
  assert.ok(doc.events.some((e) => e.type === 'statusRequest'));
});
