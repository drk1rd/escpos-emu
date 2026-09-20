#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createEmulator } = require('../src/server');

/**
 * What to emulate when nothing has been configured.
 *
 * `npx github:drk1rd/escpos-emu` should print something within seconds of a
 * first try, and
 * requiring a config file before it will start makes the first try fail - with
 * advice to copy a file that is buried inside node_modules, at that.
 *
 * Loopback, because it is the only thing guaranteed to be bindable on a machine
 * we know nothing about. Port 9100 is the one every ESC/POS client already
 * defaults to, so the first device needs no configuring on the sending side
 * either.
 */
const BUILT_IN = {
  subnet: null,
  devices: [
    { id: 'kitchen', name: 'KITCHEN', ip: '127.0.0.1', port: 9100, columns: 48 },
    { id: 'bar', name: 'BAR', ip: '127.0.0.1', port: 9101, columns: 48 },
    { id: 'counter', name: 'COUNTER', ip: '127.0.0.1', port: 9102, columns: 32 },
  ],
};

const USAGE = `
escpos-emu — a multi-IP ESC/POS printer emulator

  escpos-emu [options]

Options
  -c, --config <file>         device configuration (default: ./devices.json if
                              present, otherwise three printers on 127.0.0.1)
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
  const haveFile = fs.existsSync(configPath);

  // A config asked for by name and not found is a mistake worth stopping on.
  // One merely not present is the first-run case, and gets the built-in.
  if (args.config && !haveFile) {
    process.stderr.write(`escpos-emu: no config at ${configPath}\n`);
    process.exitCode = 1;
    return;
  }

  let config = BUILT_IN;
  let source = 'built-in default';

  if (haveFile) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      process.stderr.write(`escpos-emu: ${configPath} is not valid JSON — ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    source = configPath;

    if (!Array.isArray(config.devices) || config.devices.length === 0) {
      process.stderr.write(`escpos-emu: ${configPath} lists no devices.\n`);
      process.exitCode = 1;
      return;
    }
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
  process.stdout.write(`  job log      ${dataDir || '(memory only)'}\n`);
  process.stdout.write(`  config       ${source}\n\n`);
  if (source === 'built-in default') {
    process.stdout.write(
      `  Copy a starting point to customise:\n` +
      `    cp ${path.join(__dirname, '..', 'devices.example.json')} devices.json\n\n`
    );
  }

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
