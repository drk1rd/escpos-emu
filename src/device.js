'use strict';

const net = require('net');
const { EventEmitter } = require('events');

/**
 * One emulated printer, listening on its own IP.
 *
 * A thermal printer is a dumb TCP socket on port 9100. There is no protocol:
 * the client connects, writes an ESC/POS byte stream, and closes. One
 * connection is one job, which is why job boundaries here are socket
 * boundaries and not some guess about the content.
 *
 * The four modes are the ones that matter when something goes wrong in
 * production, and they are named after the failures rather than after their
 * implementation:
 *
 *   accept  a working printer: takes the bytes and records them
 *   reset   accepts, then drops the connection - paper-out on some firmware
 *   hang    accepts and never reads or closes. The worst case, because the
 *           client blocks on a socket that will never answer, and a print
 *           path without a timeout waits for ever
 *   refuse  powered off or unplugged: the connection is refused outright
 *
 * `hang` and `refuse` are the two that find bugs. Most print code is written
 * against a printer that works and a printer that is missing; almost none of
 * it is written against a printer that accepts your bytes and says nothing.
 */

const MODES = ['accept', 'reset', 'hang', 'refuse'];

class Device extends EventEmitter {
  constructor(config) {
    super();
    this.id = config.id;
    this.name = config.name || config.id;
    this.ip = config.ip || '127.0.0.1';
    // `|| 9100` would turn an explicit 0 - "give me any free port", which is
    // how a test binds safely - into the real printer port, and then every
    // device in the config fights over it.
    this.port = config.port === undefined || config.port === null ? 9100 : Number(config.port);
    this.columns = Number(config.columns) || 48;
    this.page = config.page || 'CP437';
    this.mode = MODES.includes(config.mode) ? config.mode : 'accept';
    this.throttleBps = Number(config.throttleBps) || 0;

    /**
     * Close a job after this long with no new bytes, without waiting for the
     * socket to close.
     *
     * One connection is one job, and most ESC/POS clients open, write and close
     * - `escpos-network` does - so the socket closing is the natural boundary.
     * But a client that holds its connection open between tickets would
     * otherwise never produce a job at all: the bytes would sit in the buffer
     * until it disconnected, which might be hours later. Found by exactly that:
     * a test that wrote and kept the socket open recorded nothing.
     *
     * The risk the other way is splitting one job in two if a client stalls
     * mid-ticket for longer than this. A second is far longer than any local
     * write takes, and throttled devices turn it off by default because
     * throttling introduces stalls on purpose.
     */
    this.idleFlushMs =
      config.idleFlushMs === undefined
        ? this.throttleBps > 0
          ? 0
          : 1000
        : Number(config.idleFlushMs) || 0;

    /**
     * Sheets left before the device starts refusing paper. `null` is an
     * endless roll, which is what you want almost always; a number is how you
     * reproduce "it ran out halfway through the busy period".
     */
    this.paper = config.paper === undefined ? null : config.paper;

    this.server = null;
    this.sockets = new Set();
    this.jobCount = 0;
    this.lastError = null;
  }

  /** Bind, unless the device is meant to be unreachable. */
  async start() {
    if (this.mode === 'refuse') return;
    await this._listen();
  }

  _listen() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._onConnection(socket));

      server.once('error', (err) => {
        this.lastError = err.message;
        if (err.code === 'EADDRNOTAVAIL') {
          return reject(
            new Error(
              `${this.id}: the address ${this.ip} is not on this machine. ` +
                `Bring it up first - 'scripts/aliases.sh up' for loopback aliases, ` +
                `or run under Docker where the bridge owns the subnet.`
            )
          );
        }
        if (err.code === 'EADDRINUSE') {
          return reject(
            new Error(`${this.id}: ${this.ip}:${this.port} is already in use by something else.`)
          );
        }
        reject(err);
      });

      server.listen(this.port, this.ip, () => {
        this.server = server;
        this.lastError = null;
        // Port 0 means "any free port", which is how a test binds without
        // guessing at what else is running on the machine. Record what the OS
        // actually gave us so callers can dial it.
        this.port = server.address().port;
        resolve();
      });
    });
  }

  _onConnection(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    // A hung printer never errors. It simply never progresses.
    socket.on('error', () => {});

    const startedAt = new Date();
    const clientAddr = `${socket.remoteAddress || '?'}:${socket.remotePort || 0}`;

    if (this.mode === 'reset') {
      this.emit('refused', { deviceId: this.id, reason: 'reset', at: startedAt });
      socket.destroy();
      return;
    }

    if (this.mode === 'hang') {
      // Deliberately register no 'data' handler and never end the socket. The
      // connection stays open and silent until the client gives up.
      this.emit('hung', { deviceId: this.id, at: startedAt });
      return;
    }

    const chunks = [];
    let idleTimer = null;

    const armIdle = () => {
      if (!this.idleFlushMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), this.idleFlushMs);
      // A pending flush must never hold the process open on its own.
      if (idleTimer.unref) idleTimer.unref();
    };

    const finish = () => {
      clearTimeout(idleTimer);
      if (chunks.length === 0) return;
      const bytes = Buffer.concat(chunks);
      chunks.length = 0;
      this.jobCount += 1;

      if (typeof this.paper === 'number') {
        this.paper = Math.max(0, this.paper - 1);
        if (this.paper === 0) {
          // Out of paper: from here the device accepts and drops, which is what
          // the firmware does and why a job can look sent and never exist.
          this.setMode('reset');
          this.emit('paperOut', { deviceId: this.id, at: new Date() });
        }
      }

      this.emit('job', {
        deviceId: this.id,
        bytes,
        startedAt,
        endedAt: new Date(),
        clientAddr,
        mode: 'accept',
      });
    };

    if (this.throttleBps > 0) {
      // Drain slowly, the way a 9600-baud head does, so a client that writes
      // faster than the printer can take it is actually made to wait.
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        armIdle();
        socket.pause();
        const ms = Math.ceil((chunk.length / this.throttleBps) * 1000);
        setTimeout(() => socket.resume(), Math.min(ms, 5000));
      });
    } else {
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        armIdle();
      });
    }

    socket.on('end', finish);
    socket.on('close', finish);
  }

  /**
   * Change behaviour while the stack is running.
   *
   * Going to `refuse` closes the listener outright so connections are genuinely
   * refused rather than accepted and dropped - those are different errors on
   * the client, and code often handles one and not the other. Coming back binds
   * again, which models a printer plugged back in: the case a reprint has to
   * survive.
   */
  async setMode(next) {
    if (!MODES.includes(next)) throw new Error(`unknown mode: ${next}`);
    const previous = this.mode;
    this.mode = next;
    if (previous === next) return;

    if (next === 'refuse') {
      await this.stop({ keepMode: true });
    } else if (!this.server) {
      await this._listen();
    }
    this.emit('mode', { deviceId: this.id, mode: next, previous });
  }

  setPaper(sheets) {
    this.paper = sheets === null || sheets === undefined ? null : Math.max(0, Number(sheets) || 0);
    if (this.paper === null || this.paper > 0) {
      if (this.mode === 'reset') this.setMode('accept');
    }
  }

  async stop({ keepMode = false } = {}) {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
    if (!keepMode) this.mode = 'refuse';
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      ip: this.ip,
      port: this.port,
      columns: this.columns,
      page: this.page,
      mode: this.mode,
      paper: this.paper,
      throttleBps: this.throttleBps,
      idleFlushMs: this.idleFlushMs,
      listening: Boolean(this.server),
      jobCount: this.jobCount,
      lastError: this.lastError,
    };
  }
}

module.exports = { Device, MODES };
