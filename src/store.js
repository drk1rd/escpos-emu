'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * The job log: durable, greppable, and no native dependency.
 *
 * An append-only JSONL file with an index held in memory. A database would be
 * a better answer at a million rows; at the scale this runs - a few thousand
 * jobs - it would only cost the tool its "clone and run" property, and a log
 * you can `grep` and `tail` when the UI is not up is worth more here than
 * query planning.
 *
 * DUPLICATE DETECTION is the reason this exists, so it deserves saying why it
 * is not a hash of the bytes. Two copies of one ticket are rarely identical
 * byte for byte: most documents carry a timestamp, so the two differ by a
 * second and a byte hash sees two unrelated jobs. The key is a hash of the
 * *layout* - the rendered text with dates and times masked - which is the same
 * for two prints of one document and different for two documents that merely
 * list the same items.
 *
 * Getting that distinction wrong in either direction gives a count nobody can
 * act on: hashing bytes finds no duplicates at all, and comparing item names
 * calls every repeated order a duplicate.
 */

const DEFAULTS = {
  maxJobs: 5000,
  retainMs: 7 * 24 * 60 * 60 * 1000,
  duplicateWindowMs: 5 * 60 * 1000,
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

class Store {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.dir = options.dir || null;
    this.file = this.dir ? path.join(this.dir, 'jobs.jsonl') : null;
    this.jobs = [];
    this.byId = new Map();
    this.seq = 0;

    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      this._load();
    }
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    const text = fs.readFileSync(this.file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const job = JSON.parse(line);
        this.jobs.push(job);
        this.byId.set(job.id, job);
        this.seq = Math.max(this.seq, Number(job.seq) || 0);
      } catch (_) {
        // A half-written final line is normal after a hard kill. Skip it
        // rather than refusing to start.
      }
    }
    this._prune();
  }

  _append(job) {
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(job)}\n`);
    } catch (err) {
      // Losing the disk copy must not lose the run.
      process.emitWarning(`escpos-emu: could not write job log: ${err.message}`);
    }
  }

  /** Rewrite the log from the index - used after pruning or a clear. */
  _rewrite() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.jobs.map((j) => JSON.stringify(j)).join('\n') + (this.jobs.length ? '\n' : ''));
    fs.renameSync(tmp, this.file);
  }

  _prune() {
    const { maxJobs, retainMs } = this.options;
    const cutoff = Date.now() - retainMs;
    const before = this.jobs.length;

    let kept = this.jobs.filter((j) => new Date(j.at).getTime() >= cutoff);
    if (kept.length > maxJobs) kept = kept.slice(kept.length - maxJobs);

    if (kept.length !== before) {
      this.jobs = kept;
      this.byId = new Map(kept.map((j) => [j.id, j]));
      this._rewrite();
    }
  }

  /**
   * Record a job.
   *
   * @param {object} input  deviceId, at, durationMs, clientAddr, bytes (Buffer),
   *                        text, layout, lines, events, codePages, columns, overWidth
   */
  add(input) {
    const bytes = input.bytes || Buffer.alloc(0);
    const layoutHash = sha256(input.layout || input.text || '');
    const at = input.at || new Date().toISOString();

    const duplicateOf = this._findDuplicate(input.deviceId, layoutHash, at);

    this.seq += 1;
    const job = {
      id: `job_${Date.now().toString(36)}_${this.seq.toString(36)}`,
      seq: this.seq,
      deviceId: input.deviceId,
      at,
      durationMs: input.durationMs || 0,
      clientAddr: input.clientAddr || null,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      layoutHash,
      duplicateOf,
      columns: input.columns || 48,
      text: input.text || '',
      layout: input.layout || '',
      lines: input.lines || [],
      events: input.events || [],
      codePages: input.codePages || [],
      overWidth: input.overWidth || [],
      images: input.images || [],
      bytesB64: bytes.toString('base64'),
    };

    this.jobs.push(job);
    this.byId.set(job.id, job);
    this._append(job);
    if (this.jobs.length % 200 === 0) this._prune();

    return job;
  }

  _findDuplicate(deviceId, layoutHash, at) {
    const t = new Date(at).getTime();
    const window = this.options.duplicateWindowMs;
    for (let i = this.jobs.length - 1; i >= 0; i -= 1) {
      const j = this.jobs[i];
      const jt = new Date(j.at).getTime();
      if (t - jt > window) break;
      if (j.deviceId === deviceId && j.layoutHash === layoutHash) return j.id;
    }
    return null;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** Jobs, newest last, filtered. `bytesB64` is dropped unless asked for. */
  list({ deviceId, since, sinceSeq, q, duplicatesOnly, limit = 200, withBytes = false } = {}) {
    let out = this.jobs;
    if (deviceId) out = out.filter((j) => j.deviceId === deviceId);
    if (sinceSeq !== undefined) out = out.filter((j) => j.seq > Number(sinceSeq));
    if (since) {
      const t = new Date(since).getTime();
      out = out.filter((j) => new Date(j.at).getTime() > t);
    }
    // Query strings arrive as text, and the string "false" is truthy - so only
    // an explicit true turns this on.
    if (duplicatesOnly === true || duplicatesOnly === 'true' || duplicatesOnly === '1') {
      out = out.filter((j) => j.duplicateOf);
    }
    if (q) {
      const needle = String(q).toLowerCase();
      out = out.filter((j) => j.text.toLowerCase().includes(needle));
    }
    if (limit && out.length > limit) out = out.slice(out.length - limit);
    return withBytes ? out : out.map(({ bytesB64, ...rest }) => rest);
  }

  clear(deviceId) {
    this.jobs = deviceId ? this.jobs.filter((j) => j.deviceId !== deviceId) : [];
    this.byId = new Map(this.jobs.map((j) => [j.id, j]));
    this._rewrite();
  }

  stats() {
    const byDevice = {};
    for (const j of this.jobs) {
      const d = (byDevice[j.deviceId] = byDevice[j.deviceId] || {
        jobs: 0,
        duplicates: 0,
        bytes: 0,
        overWidth: 0,
      });
      d.jobs += 1;
      d.bytes += j.byteLength;
      if (j.duplicateOf) d.duplicates += 1;
      if (j.overWidth && j.overWidth.length) d.overWidth += 1;
    }
    return {
      total: this.jobs.length,
      duplicates: this.jobs.filter((j) => j.duplicateOf).length,
      byDevice,
    };
  }

  /** Export helpers, for taking a run's paper somewhere else. */
  toJsonl(filter = {}) {
    return this.list({ ...filter, limit: 0, withBytes: true })
      .map((j) => JSON.stringify(j))
      .join('\n');
  }

  toCsv(filter = {}) {
    const rows = this.list({ ...filter, limit: 0 });
    const head = 'at,device,bytes,duplicate,lines,text';
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    return [
      head,
      ...rows.map((j) =>
        [
          j.at,
          j.deviceId,
          j.byteLength,
          j.duplicateOf ? 'yes' : '',
          j.lines.length,
          esc(j.text.replace(/\n/g, ' \\n ')),
        ].join(',')
      ),
    ].join('\n');
  }
}

module.exports = { Store, sha256 };
