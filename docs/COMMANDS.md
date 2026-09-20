# ESC/POS coverage

What the interpreter does with each command, so you know what a job's decoded
output can and cannot tell you.

Three levels of handling:

| | |
| :-- | :-- |
| **modelled** | changes the rendered output or produces an event you can assert on |
| **consumed** | parsed and stepped over correctly, but has no effect on the rendering. Its arguments never leak into the text, which is the thing that matters. |
| **recorded** | not modelled: an `unknown` or `control` event carries the bytes, and the job is flagged `?CMD` in the UI |

Anything not listed is **recorded**. Nothing is silently skipped.

---

## Text and layout

| Bytes | Command | Handling |
| :-- | :-- | :-- |
| `1b 40` | `ESC @` initialise | **modelled** — resets style, keeps the code page, emits `init` |
| `1b 61 n` | `ESC a` justification | **modelled** — `0` left, `1` centre, `2` right; applies to the whole line |
| `1b 45 n` | `ESC E` emphasis | **modelled** |
| `1b 47 n` | `ESC G` double strike | **modelled** — rendered as emphasis |
| `1b 2d n` | `ESC -` underline | **modelled** — `1` and `2` both underline |
| `1b 21 n` | `ESC !` print mode | **modelled** — font, emphasis, double height/width, underline from the bit flags |
| `1d 21 n` | `GS !` character size | **modelled** — high nibble width, low nibble height, each "times normal minus one" |
| `1d 42 n` | `GS B` reverse video | **modelled** — rendered as inverted text |
| `1b 4d n` | `ESC M` font | **modelled** — A or B, carried on the span |
| `1b 64 n` | `ESC d` feed n lines | **modelled** — ends the line and adds blanks |
| `0a` | `LF` line feed | **modelled** |
| `0d` | `CR` carriage return | **modelled** — moves the head, prints nothing |
| `09` | `HT` horizontal tab | **modelled** — four spaces |
| `0c` | `FF` form feed | **modelled** — ends the line, emits `formFeed` |
| `18` | `CAN` cancel line | **modelled** — discards the line being composed, as the device does |
| `1b 7b n` | `ESC {` upside-down | consumed |
| `1b 4a n` / `1b 6a n` | `ESC J` / `ESC j` feed dots | consumed |
| `1b 32` / `1b 33 n` | `ESC 2` / `ESC 3` line spacing | consumed |
| `1b 20 n` | `ESC SP` right character spacing | consumed |
| `1b 24 nL nH` | `ESC $` absolute position | consumed |
| `1b 5c nL nH` | `ESC \` relative position | consumed |
| `1b 44 … 00` | `ESC D` tab stops | consumed — NUL-terminated, length read from the stream |
| `1b 34` / `1b 35` | `ESC 4` / `ESC 5` italic | consumed |
| `1b 72 n` | `ESC r` print colour | consumed |
| `1d 4c nL nH` | `GS L` left margin | consumed |
| `1d 57 nL nH` | `GS W` print area width | consumed |
| `1d 50 x y` | `GS P` motion units | consumed |

> Character size is why width is measured in **columns, not characters**. A
> double-width character occupies two columns, so a 48-column roll fits 24 of
> them. Lines exceeding the roll are flagged `WIDE`; the ruler above the paper
> shows where the edge is.

## Encoding

| Bytes | Command | Handling |
| :-- | :-- | :-- |
| `1b 74 n` | `ESC t` select code page | **modelled** — emits `codePage`, and text after it decodes through the new page |
| `1b 52 n` | `ESC R` international character set | **modelled** — emits `charset`; does not alter decoding |

Tabulated pages: **CP437** (the default on nearly every device), **CP850**,
**CP858**, **CP1252**. Selectors for pages that are not tabulated keep their
number (`CP_17`) and decode as latin1, so the receipt stays readable and the
page name tells you it was unusual.

Multi-byte encodings — **GB18030**, **Big5**, **Shift JIS** — are decoded with
the platform's own decoder when a device is configured with one.

Text is accumulated as raw bytes and decoded when the span closes, so a code
page switched mid-job applies from exactly that point and not retroactively.

## Cutting, drawers and status

| Bytes | Command | Handling |
| :-- | :-- | :-- |
| `1d 56 m` | `GS V` cut | **modelled** — emits `cut` with `full` or `partial` |
| `1d 56 m n` | `GS V` cut and feed | **modelled** — the feed argument is consumed, not printed |
| `1b 69` / `1b 6d` | `ESC i` / `ESC m` legacy cut | **modelled** — emits `cut` with `legacy: true` |
| `1b 70 m t1 t2` | `ESC p` drawer kick | **modelled** — emits `drawer` with the pin and pulse timings |
| `10 14 01 m t` | `DLE DC4` real-time drawer kick | **modelled** — emits `drawer` with `realtime: true` |
| `10 04 n` | `DLE EOT` status request | **modelled** — emits `statusRequest` |
| `10 05 n` | `DLE ENQ` real-time request | **modelled** — emits `realtimeRequest` |
| `1b 63 35 n` | `ESC c 5` panel buttons | consumed |
| `1d 61 n` | `GS a` automatic status back | consumed |
| `1d 72 n` / `1d 49 n` | `GS r` / `GS I` transmit status, printer id | consumed |

> The emulator **never sends anything back**. Real printers answer status
> requests, and a client that blocks waiting for a reply will wait here. That is
> deliberate: it is the `hang` failure mode by another route, and code that
> depends on a status reply should be made to prove it handles silence.

## Barcodes, QR and images

| Bytes | Command | Handling |
| :-- | :-- | :-- |
| `1d 6b m d… 00` | `GS k` barcode, NUL-terminated (`m` ≤ 6) | **modelled** — emits `barcode` with the symbology and payload |
| `1d 6b m n d…` | `GS k` barcode, length-prefixed (`m` ≥ 65) | **modelled** — same |
| `1d 28 6b …` | `GS ( k` two-dimensional code | **modelled** — emits `qr` with the payload for the store-data function (`cn 49`, `fn 80`); the other functions are length-prefixed and stepped over exactly |
| `1d 76 30 m …` | `GS v 0` raster bit image | **modelled** — emits `image`, decoded and rendered as a PNG in the UI |
| `1b 2a m nL nH d…` | `ESC *` bit image | **modelled** — emits `image`; the data length is computed from the mode |
| `1c 70 n m` | `FS p` print NV logo | **modelled** — emits `image` with the logo id |

Symbologies recognised by name: UPC-A, UPC-E, EAN13, EAN8, CODE39, ITF, CODABAR,
CODE93, CODE128. Others are reported as `mode_<n>` with the payload intact.

Image and barcode payloads are the classic source of garbage on a decoded
receipt: their bytes look like text. All of these are length-determined, so the
interpreter steps over them exactly and none of it reaches the paper.

## Control bytes

Any byte below `0x20` that is not handled above emits a `control` event and is
**not printed**. A printer does not put `0x14` on the paper.

This is worth knowing because it catches a common upstream mistake: a string
containing a character outside latin1 — an em dash, a curly quote — written to a
latin1 buffer truncates to its low byte. An em dash (`U+2014`) becomes `0x14`.
The `control` event is how you find that rather than wondering why the receipt
has a gap in it.

---

## Adding a command

`src/escpos/interpret.js` is one loop over the byte stream.

- **Fixed-length**: add the byte to `ESC_FIXED` or `GS_FIXED` with its argument
  count, then handle it in the `switch` if it should do something. Argument
  counts matter even for commands you do not model — an argument left in the
  stream is a character printed on the receipt.
- **Variable-length**: handle it before the fixed-length lookup, the way
  `GS k`, `GS ( k` and `GS v 0` are, and advance `i` past the whole sequence.
- **Style changes**: mutate `state`, then call `syncStyle()`. Never before —
  bytes already pending belong to the previous style.

Add a test in `tests/interpret.test.js` asserting two things: the command does
what it should, **and** its arguments do not appear in `doc.text`.
