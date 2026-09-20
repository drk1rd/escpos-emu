'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Device, MODES } = require('./device');
const { Store } = require('./store');
const { preflight } = require('./preflight');
const { interpret } = require('./escpos/interpret');
const { renderLines, toText, toLayout, overWidthLines } = require('./escpos/render');
const { monoPngDataUri } = require('./escpos/png');

/**
 * The emulator: a set of devices, a job log, a control API and a UI.
 *
 * Deliberately `node:http` and no framework. This is a tool people will read
 * before they trust it with their test suite, and the whole server is one file
 * they can read in a sitting.
 */

const UI_DIR = path.join(__dirname, '..', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Turn a device's raw job into the record the store keeps. */
function describeJob(device, raw) {
  const doc = interpret(raw.bytes, { page: device.page });
  const lines = renderLines(doc, device.columns);

  const images = doc.events
    .filter((e) => e.type === 'image' && e.kind === 'raster' && e.data)
    .map((e) => ({
      width: e.width,
      height: e.height,
      dataUri: monoPngDataUri(Buffer.from(e.data, 'base64'), e.widthBytes, e.height),
    }))
    .filter((i) => i.dataUri);

  return {
    deviceId: device.id,
    at: raw.startedAt.toISOString(),
    durationMs: raw.endedAt - raw.startedAt,
    clientAddr: raw.clientAddr,
    bytes: raw.bytes,
    columns: device.columns,
    text: toText(doc, device.columns),
    layout: toLayout(doc, device.columns),
    lines: lines.map(({ spans, text, align, over, width }) => ({ spans, text, align, over, width })),
    events: doc.events.map(({ data, ...rest }) => (rest.type === 'image' ? rest : { ...rest, data })),
    codePages: doc.codePages,
    overWidth: overWidthLines(doc, device.columns).map((l) => l.index),
    images,
  };
}

function createEmulator(config = {}) {
  const store = new Store({
    dir: config.dataDir,
    maxJobs: config.maxJobs,
    retainMs: config.retainMs,
    duplicateWindowMs: config.duplicateWindowMs,
  });

  const devices = new Map();
  for (const d of config.devices || []) devices.set(d.id, new Device(d));

  /** Everyone watching the live feed. */
  const listeners = new Set();
  const broadcast = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of listeners) {
      try {
        res.write(frame);
      } catch (_) {
        listeners.delete(res);
      }
    }
  };

  for (const device of devices.values()) {
    device.on('job', (raw) => {
      let job;
      try {
        job = store.add(describeJob(device, raw));
      } catch (err) {
        process.emitWarning(`escpos-emu: could not record a job: ${err.message}`);
        return;
      }
      const { bytesB64, ...wire } = job;
      broadcast('job', wire);
    });
    device.on('mode', (e) => broadcast('mode', { ...e, device: device.toJSON() }));
    device.on('paperOut', (e) => broadcast('paperOut', e));
    device.on('hung', (e) => broadcast('hung', e));
    device.on('refused', (e) => broadcast('refused', e));
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(text);
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (_) {
          resolve({});
        }
      });
    });

  const serveUi = (res, urlPath) => {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(UI_DIR, rel);
    // Never serve outside the ui directory.
    if (!file.startsWith(UI_DIR)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    // Live feed.
    if (p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      listeners.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch (_) {
          /* dropped below */
        }
      }, 25000);
      req.on('close', () => {
        clearInterval(keepAlive);
        listeners.delete(res);
      });
      return undefined;
    }

    if (p === '/api/devices' && req.method === 'GET') {
      return json(res, 200, {
        devices: [...devices.values()].map((d) => d.toJSON()),
        stats: store.stats(),
      });
    }

    const deviceMatch = p.match(/^\/api\/devices\/([^/]+)(\/.*)?$/);
    if (deviceMatch) {
      const device = devices.get(decodeURIComponent(deviceMatch[1]));
      const rest = deviceMatch[2] || '';
      if (!device) return json(res, 404, { error: 'no such device' });

      if (rest === '/jobs' && req.method === 'GET') {
        return json(res, 200, {
          jobs: store.list({ ...q, deviceId: device.id, limit: Number(q.limit) || 200 }),
        });
      }
      if (rest === '/mode' && req.method === 'POST') {
        const body = await readBody(req);
        if (!MODES.includes(body.mode)) {
          return json(res, 400, { error: `mode must be one of ${MODES.join(', ')}` });
        }
        try {
          await device.setMode(body.mode);
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
        return json(res, 200, { device: device.toJSON() });
      }
      if (rest === '/paper' && req.method === 'POST') {
        const body = await readBody(req);
        device.setPaper(body.sheets);
        return json(res, 200, { device: device.toJSON() });
      }
      if (rest === '/reset' && req.method === 'POST') {
        store.clear(device.id);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    }

    const jobMatch = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === 'GET') {
      const job = store.get(decodeURIComponent(jobMatch[1]));
      if (!job) return json(res, 404, { error: 'no such job' });
      return json(res, 200, { job });
    }

    if (p === '/api/jobs' && req.method === 'GET') {
      return json(res, 200, { jobs: store.list({ ...q, limit: Number(q.limit) || 200 }) });
    }

    if (p === '/api/stats' && req.method === 'GET') return json(res, 200, store.stats());

    if (p === '/api/reset' && req.method === 'POST') {
      store.clear();
      broadcast('reset', {});
      return json(res, 200, { ok: true });
    }

    if (p === '/api/export' && req.method === 'GET') {
      const as = q.format === 'csv' ? 'csv' : 'jsonl';
      const body = as === 'csv' ? store.toCsv(q) : store.toJsonl(q);
      res.writeHead(200, {
        'Content-Type': as === 'csv' ? 'text/csv' : 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="escpos-jobs.${as}"`,
      });
      return res.end(body);
    }

    if (req.method === 'GET') return serveUi(res, p);
    return json(res, 404, { error: 'not found' });
  });

  return {
    devices,
    store,

    async start({ httpPort = 7070, httpHost = '0.0.0.0', allowSubnetConflict = false } = {}) {
      const ips = [...devices.values()].map((d) => d.ip);
      const check = preflight(ips, config.subnet);
      if (!check.ok && !allowSubnetConflict) {
        const err = new Error(check.message);
        err.code = 'ESUBNETCONFLICT';
        throw err;
      }
      if (!check.ok) {
        process.emitWarning(`escpos-emu: starting despite a subnet conflict on ${config.subnet}`);
      }

      const started = [];
      try {
        for (const device of devices.values()) {
          await device.start();
          started.push(device);
        }
      } catch (err) {
        // Leave nothing half-bound behind.
        for (const d of started) await d.stop().catch(() => {});
        throw err;
      }

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(httpPort, httpHost, resolve);
      });

      return { url: `http://localhost:${server.address().port}` };
    },

    async stop() {
      for (const res of listeners) {
        try {
          res.end();
        } catch (_) {
          /* already gone */
        }
      }
      listeners.clear();
      for (const device of devices.values()) await device.stop().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
    },

    get httpPort() {
      return server.address() ? server.address().port : null;
    },
  };
}

module.exports = { createEmulator, describeJob };
