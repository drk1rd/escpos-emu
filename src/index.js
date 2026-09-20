'use strict';

const { createEmulator, describeJob } = require('./server');
const { Device, MODES } = require('./device');
const { Store, sha256 } = require('./store');
const { interpret } = require('./escpos/interpret');
const { renderLines, toText, toLayout, overWidthLines } = require('./escpos/render');
const { monoPng, monoPngDataUri } = require('./escpos/png');
const { preflight } = require('./preflight');
const { Client } = require('./client');

module.exports = {
  createEmulator,
  describeJob,
  Device,
  MODES,
  Store,
  sha256,
  interpret,
  renderLines,
  toText,
  toLayout,
  overWidthLines,
  monoPng,
  monoPngDataUri,
  preflight,
  Client,
};
