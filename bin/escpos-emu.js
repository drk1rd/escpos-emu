#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createEmulator } = require('../src/server');

const USAGE = `
escpos-emu — a multi-IP ESC/POS printer emulator

  escpos-emu [options]

Options
  -c, --config <file>         device configuration (default: ./devices.json)
  -p, --port <n>              HTTP port for the UI and API (default: 7070)
  -H, --host <addr>           HTTP bind address (default: 0.0.0.0)
  -d, --data <dir>            where to keep the job log (default: ./data)
      --allow-subnet-conflict start even if this machine is on the same subnet
      --no-data               keep jobs in memory only
  -h, --help                  this

The emulator binds one TCP listener per device in the config. If a device's IP
is not on this machine it will say so and stop — bring the addresses up with
scripts/aliases.sh, or run under Docker where the bridge owns the subnet.
`;

const parse = (argv) => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '-c' || a === '--config') out.config = next();
    else if (a === '-p' || a === '--port') out.port = Number(next());
    else if (a === '-H' || a === '--host') out.host = next();
    else if (a === '-d' || a === '--data') out.data = next();
    else if (a === '--allow-subnet-conflict') out.allowSubnetConflict = true;
    else if (a === '--no-data') out.noData = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else out._.push(a);
  }
  return out;
};

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const configPath = path.resolve(args.config || 'devices.json');
  if (!fs.existsSync(configPath)) {
    process.stderr.write(
      `escpos-emu: no config at ${configPath}\n` +
        `Copy devices.example.json to devices.json, or pass --config.\n`
    );
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`escpos-emu: ${configPath} is not valid JSON — ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(config.devices) || config.devices.length === 0) {
    process.stderr.write(`escpos-emu: ${configPath} lists no devices.\n`);
    process.exitCode = 1;
    return;
  }

  const dataDir = args.noData
    ? null
    : path.resolve(args.data || config.dataDir || './data');

  const emu = createEmulator({ ...config, dataDir });

  let info;
  try {
    info = await emu.start({
      httpPort: args.port || config.httpPort || 7070,
      httpHost: args.host || '0.0.0.0',
      allowSubnetConflict: args.allowSubnetConflict || false,
    });
  } catch (err) {
    process.stderr.write(`\nescpos-emu: ${err.message}\n\n`);
    process.exitCode = 1;
    return;
  }

  const rows = [...emu.devices.values()].map((d) => d.toJSON());
  const pad = Math.max(...rows.map((r) => r.name.length));
  process.stdout.write('\nescpos-emu\n\n');
  for (const r of rows) {
    process.stdout.write(
      `  ${r.name.padEnd(pad)}  ${r.ip}:${r.port}  ${r.columns} col  ${r.mode}\n`
    );
  }
  process.stdout.write(`\n  paper feed   ${info.url}\n`);
  process.stdout.write(`  job log      ${dataDir || '(memory only)'}\n\n`);

  const shutdown = async (signal) => {
    process.stdout.write(`\nescpos-emu: ${signal}, stopping\n`);
    await emu.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`escpos-emu: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
