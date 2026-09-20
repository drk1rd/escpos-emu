'use strict';

/**
 * The client a test suite drives.
 *
 * The assertions worth making about printing are almost all about *counting*:
 * did this ticket come out, did it come out once, did it come out on the right
 * device. `expectExactlyOne` is the one that matters - it is the assertion that
 * was impossible to write on the night 22 extra dishes were made, because
 * nothing recorded what the printers received.
 *
 *   const emu = new Client('http://localhost:7070');
 *   await emu.reset();
 *   // ... drive the system under test ...
 *   await emu.expectExactlyOne('CAPPUCCINO x3', { device: 'kitchen' });
 */

const asJson = async (res) => {
  const text = await res.text();
  if (!res.ok) throw new Error(`escpos-emu ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`escpos-emu: expected JSON, got ${text.slice(0, 120)}`);
  }
};

class Client {
  constructor(baseUrl = 'http://localhost:7070') {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
  }

  _url(p, query) {
    const url = new URL(this.baseUrl + p);
    for (const [k, v] of Object.entries(query || {})) {
      // `false` is left out rather than sent: it would arrive as the string
      // "false", which is truthy, and quietly turn a filter on.
      if (v === undefined || v === null || v === '' || v === false) continue;
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  async devices() {
    return (await asJson(await fetch(this._url('/api/devices')))).devices;
  }

  /** Jobs, newest last. `device` and `q` narrow it. */
  async jobs({ device, q, duplicatesOnly, limit } = {}) {
    const p = device ? `/api/devices/${encodeURIComponent(device)}/jobs` : '/api/jobs';
    return (await asJson(await fetch(this._url(p, { q, duplicatesOnly, limit })))).jobs;
  }

  /** One job in full, including its raw bytes. */
  async job(id) {
    return (await asJson(await fetch(this._url(`/api/jobs/${encodeURIComponent(id)}`)))).job;
  }

  /** Jobs whose printed text contains `text`. */
  async jobsContaining(text, opts = {}) {
    return this.jobs({ ...opts, q: text });
  }

  async count(opts = {}) {
    return (await this.jobs({ ...opts, limit: 0 })).length;
  }

  async stats() {
    return asJson(await fetch(this._url('/api/stats')));
  }

  /** Clear the log. Call this in `beforeEach`. */
  async reset(device) {
    const p = device ? `/api/devices/${encodeURIComponent(device)}/reset` : '/api/reset';
    return asJson(await fetch(this._url(p), { method: 'POST' }));
  }

  /** Flip a device to accept / reset / hang / refuse while the stack runs. */
  async setMode(device, mode) {
    return asJson(
      await fetch(this._url(`/api/devices/${encodeURIComponent(device)}/mode`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
    );
  }

  async setPaper(device, sheets) {
    return asJson(
      await fetch(this._url(`/api/devices/${encodeURIComponent(device)}/paper`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheets }),
      })
    );
  }

  /**
   * Wait for a job matching `text` to arrive, because printing is asynchronous
   * and a test that reads immediately reads nothing.
   */
  async waitForJob(text, { device, timeoutMs = 5000, intervalMs = 50 } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.jobsContaining(text, { device });
      if (found.length) return found[found.length - 1];
      if (Date.now() >= until) {
        throw new Error(
          `escpos-emu: no job containing ${JSON.stringify(text)} within ${timeoutMs}ms` +
            (device ? ` on ${device}` : '')
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * Assert exactly one job carries `text`.
   *
   * Throws with the times of every match when there is more than one, because
   * the gap between them is what tells you whether it was a genuine second
   * round or the same round printed twice.
   */
  async expectExactlyOne(text, { device, timeoutMs = 5000, settleMs = 300 } = {}) {
    await this.waitForJob(text, { device, timeoutMs });
    // Let a duplicate arrive if one is coming; otherwise the assertion passes
    // before the second ticket is even sent.
    await new Promise((r) => setTimeout(r, settleMs));

    const found = await this.jobsContaining(text, { device });
    if (found.length === 1) return found[0];

    const when = found.map((j) => `${j.at} (${j.deviceId})`).join('\n    ');
    throw new Error(
      `escpos-emu: expected exactly one job containing ${JSON.stringify(text)}, found ${found.length}:\n    ${when}`
    );
  }
}

module.exports = { Client };
