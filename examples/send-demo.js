#!/usr/bin/env node
'use strict';

/**
 * Send a few representative jobs, so there is paper to look at.
 *
 *   node examples/send-demo.js [host] [port]
 *
 * Includes a deliberate duplicate - the same kitchen round sent twice with a
 * different clock - because that is the case the emulator exists to catch and
 * it should be visible the moment you open the UI.
 */

const net = require('net');

const host = process.argv[2] || '127.0.0.1';
const KITCHEN = Number(process.argv[3]) || 9101;
const BAR = KITCHEN + 1;
const TILL = KITCHEN + 2;

class Ticket {
  constructor() {
    this.b = [];
  }
  raw(...bytes) {
    this.b.push(...bytes);
    return this;
  }
  text(s) {
    this.b.push(...Buffer.from(String(s), 'latin1'));
    return this;
  }
  init() {
    return this.raw(0x1b, 0x40);
  }
  page(n) {
    return this.raw(0x1b, 0x74, n);
  }
  align(a) {
    return this.raw(0x1b, 0x61, { left: 0, center: 1, right: 2 }[a]);
  }
  bold(on) {
    return this.raw(0x1b, 0x45, on ? 1 : 0);
  }
  underline(on) {
    return this.raw(0x1b, 0x2d, on ? 1 : 0);
  }
  size(w, h) {
    return this.raw(0x1d, 0x21, ((w - 1) << 4) | (h - 1));
  }
  line(s = '') {
    return this.text(s).raw(0x0a);
  }
  rule(n = 48, ch = '-') {
    return this.line(ch.repeat(n));
  }
  cols(left, right, width = 48) {
    const pad = Math.max(1, width - left.length - right.length);
    return this.line(left + ' '.repeat(pad) + right);
  }
  barcode(data) {
    return this.raw(0x1d, 0x6b, 73, data.length).text(data);
  }
  qr(data) {
    const payload = Buffer.from(data, 'latin1');
    const len = payload.length + 3;
    return this.raw(0x1d, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 49, 80, 48).text(data);
  }
  drawer() {
    return this.raw(0x1b, 0x70, 0x00, 0x19, 0xfa);
  }
  cut() {
    return this.raw(0x1d, 0x56, 66, 3);
  }
  get bytes() {
    return Buffer.from(this.b);
  }
}

const send = (port, bytes) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => socket.end(bytes));
    socket.on('close', resolve);
    socket.on('error', reject);
  });

const ticket = (at) =>
  new Ticket()
    .init()
    .page(0)
    .align('center')
    .size(2, 2)
    .line('KITCHEN')
    .size(1, 1)
    .bold(true)
    .line('Table B4   TICKET 1183')
    .bold(false)
    .align('left')
    .rule()
    .line('2 x HAKKA NOODLES VEG')
    .line('1 x CHILLI PANEER')
    .line('   no onion')
    .line('3 x CAPPUCCINO')
    .rule()
    .cols('Waiter', 'Sanju')
    .cols('Printed', at)
    .cut();

const bill = new Ticket()
  .init()
  .page(0)
  .align('center')
  .size(2, 1)
  .line('THE EXAMPLE CAFE')
  .size(1, 1)
  .line('12 Example Street')
  .align('left')
  .rule()
  .cols('2 x HAKKA NOODLES VEG', '598.00')
  .cols('1 x CHILLI PANEER', '389.00')
  .cols('3 x CAPPUCCINO', '597.00')
  .rule()
  .cols('Subtotal', '1584.00')
  .cols('CGST 2.5%', '39.60')
  .cols('SGST 2.5%', '39.60')
  .bold(true)
  .cols('TOTAL \x9c', '1663.20')
  .bold(false)
  .cols('Cover paid', '1000.00')
  .cols('Cash', '663.20')
  .rule()
  .align('center')
  .line('Thank you')
  .barcode('R1663')
  .qr('https://example.com/receipt/1663')
  .drawer()
  .cut();

/** A 32-column roll asked to print a 48-column line — the width warning. */
const tooWide = new Ticket()
  .init()
  .align('left')
  .line('TILL 2 - reprint')
  .line('THIS LINE IS DELIBERATELY LONGER THAN THIRTY-TWO COLUMNS')
  .cut();

(async () => {
  await send(KITCHEN, ticket('21:40:33').bytes);
  await new Promise((r) => setTimeout(r, 400));

  // The same round again, two seconds later on the clock. Byte-different,
  // layout-identical: exactly what a duplicated ticket looks like in the wild.
  await send(KITCHEN, ticket('21:40:35').bytes);
  await new Promise((r) => setTimeout(r, 300));

  await send(BAR, bill.bytes);
  await send(TILL, tooWide.bytes);

  process.stdout.write('sent: 2 kitchen tickets (one a repeat), 1 bill, 1 over-wide receipt\n');
})().catch((err) => {
  process.stderr.write(`could not send: ${err.message}\n`);
  process.exitCode = 1;
});
