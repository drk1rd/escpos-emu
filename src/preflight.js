'use strict';

const os = require('os');

/**
 * Refuse to start if these addresses belong to somebody else.
 *
 * The point of this tool is to answer on the *real* addresses of the printers
 * it emulates, so existing configuration and data work without editing. That is
 * also how it could do real harm: run it on a machine sitting on the same
 * network as the real devices, and claiming one of their addresses means jobs
 * meant for a real printer arrive here instead - silently, because the sender
 * sees a successful connection either way. Under Docker the same subnet on a
 * bridge can capture the host's route to the real network as well.
 *
 * So the check is not "is this address free" - it is "does this machine already
 * live on that network". If it does, the addresses are somebody's, and starting
 * is a decision a human has to make rather than one a default makes for them.
 */

const ipToInt = (ip) =>
  ip.split('.').reduce((n, oct) => (n << 8) + (Number(oct) & 0xff), 0) >>> 0;

const inSubnet = (ip, cidr) => {
  const [base, bitsRaw] = String(cidr).split('/');
  const bits = Number(bitsRaw);
  if (!base || !Number.isFinite(bits)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
};

/** Non-loopback IPv4 addresses this machine holds, with their interface. */
const hostAddresses = () => {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      out.push({ iface: name, address: a.address });
    }
  }
  return out;
};

/**
 * @param {string[]} deviceIps  the addresses about to be bound
 * @param {string}   subnet     the CIDR they live in, e.g. "192.168.1.0/24"
 * @returns {{ ok: boolean, conflicts: Array, message: string|null }}
 */
function preflight(deviceIps, subnet) {
  if (!subnet) return { ok: true, conflicts: [], message: null };

  const held = hostAddresses();
  const conflicts = held.filter((h) => inSubnet(h.address, subnet));

  if (conflicts.length === 0) return { ok: true, conflicts: [], message: null };

  const claimed = deviceIps.filter((ip) => conflicts.some((c) => c.address === ip));

  const lines = [
    `This machine is already on ${subnet}:`,
    ...conflicts.map((c) => `    ${c.address}  (${c.iface})`),
    '',
    'Binding the emulated printers here risks taking traffic meant for real',
    'devices on that network.',
  ];

  if (claimed.length) {
    lines.push('', `Worse: ${claimed.join(', ')} is an address this machine already holds.`);
  }

  lines.push(
    '',
    'Either move the emulator to another subnet (edit "subnet" and the device',
    'IPs in devices.json), run it under Docker on an isolated bridge, or pass',
    '--allow-subnet-conflict if you are certain this network is yours.'
  );

  return { ok: false, conflicts, message: lines.join('\n') };
}

module.exports = { preflight, inSubnet, hostAddresses };
