# Setup

Everything you need to get printers answering on your machine, in the order you
will actually need it.

- [Requirements](#requirements)
- [Fastest: loopback ports](#fastest-loopback-ports)
- [Real IP addresses](#real-ip-addresses) — the reason this tool exists
  - [macOS](#macos) · [Linux](#linux) · [Docker](#docker) · [Windows](#windows)
- [The subnet conflict, and why it refuses to start](#the-subnet-conflict)
- [Pointing your application at it](#pointing-your-application-at-it)
- [Proving it works](#proving-it-works)
- [Using it in a test suite](#using-it-in-a-test-suite)
- [Continuous integration](#continuous-integration)
- [Troubleshooting](#troubleshooting)

---

## Requirements

Node 18 or newer. Nothing else — there are no runtime dependencies, no native
modules and no build step.

```bash
node --version   # v18.0.0 or later
git clone https://github.com/drk1rd/escpos-emu && cd escpos-emu
```

There is nothing to `npm install`. You can run it immediately.

---

## Fastest: loopback ports

Three printers on `127.0.0.1`, no permissions, no network changes:

```bash
npx escpos-emu --config devices.loopback.json
```

```
escpos-emu

  KITCHEN  127.0.0.1:9101  48 col  accept
  BAR      127.0.0.1:9102  48 col  accept
  TILL     127.0.0.1:9103  32 col  accept

  paper feed   http://localhost:7070
  job log      ./data
```

Open <http://localhost:7070>, then send it something:

```bash
node examples/send-demo.js
```

This is the right choice for a test suite and for CI. It is the wrong choice if
you want to exercise the code that decides *which* printer a ticket goes to,
because every device is the same host and only the port differs.

---

## Real IP addresses

Applications route to printers **by IP address**. A job goes to
`192.168.10.101` because that is what that printer's record says. If your
emulated printers are all `127.0.0.1` on different ports, that routing is never
exercised, and any existing configuration has to be rewritten before it works.

So the emulator binds whatever addresses `devices.json` lists. The addresses
have to exist on the machine first. Three ways, below.

### macOS

Loopback aliases. `scripts/aliases.sh` reads your config and prints the exact
commands — it does not run them, because they change your machine's networking
and you should read them first.

```bash
./scripts/aliases.sh up devices.json
```

```
# Run these to bring the emulated printers up on lo0:

sudo ifconfig lo0 alias 192.168.10.101
sudo ifconfig lo0 alias 192.168.10.102
sudo ifconfig lo0 alias 192.168.10.103
sudo ifconfig lo0 alias 192.168.10.104

# Then: npx escpos-emu --config devices.json
```

Paste them, start the emulator, and take them down when you are finished:

```bash
./scripts/aliases.sh down devices.json
```

Aliases do not survive a reboot, which is usually what you want.

### Linux

Same script, different commands:

```bash
./scripts/aliases.sh up devices.json
# sudo ip addr add 192.168.10.101/32 dev lo
```

If your distribution has `rp_filter` set strictly, traffic your own machine
sends to these addresses still works — it never leaves the host — but traffic
from *other* machines will not reach them. Run the emulator on the same machine
as the system under test, or use Docker with a bridge those machines can route
to.

### Docker

The cleanest option, because the bridge owns the subnet and nothing touches your
host's networking:

```bash
docker compose up --build
```

To run the published image instead of building, with each printer on its own
published port and no static addresses at all:

```bash
docker run --rm -p 7070:7070 -p 9100-9103:9100-9103 ghcr.io/drk1rd/escpos-emu
```

That is the quickest way in, and it needs no Node on the host. Use the compose
file when you want the printers on their own addresses.

One container holds all four addresses. Compose can only assign a container one
address per network, so `docker-entrypoint.sh` reads `devices.json` and adds the
rest with `ip addr add` — which is why the service is granted `NET_ADMIN`.

To change the addresses, edit **both** `devices.json` and the `subnet` in
`docker-compose.yml`, keeping them consistent.

### Windows

There is no loopback-alias equivalent worth recommending. Use one of:

- **WSL2** — follow the Linux instructions inside the WSL distribution.
- **Docker Desktop** — `docker compose up --build`.
- **Loopback ports** — `devices.loopback.json`, giving up IP-level routing.

---

## The subnet conflict

**Read this if your workstation is on the same network as real printers.**

The emulator refuses to start when this machine already holds an address in the
subnet it is about to emulate:

```
escpos-emu: This machine is already on 192.168.10.0/24:
    192.168.10.23  (en0)

Binding the emulated printers here risks taking traffic meant for real
devices on that network.

Either move the emulator to another subnet (edit "subnet" and the device
IPs in devices.json), run it under Docker on an isolated bridge, or pass
--allow-subnet-conflict if you are certain this network is yours.
```

This is not pedantry. If you are on the same network as the real printers and
you claim one of their addresses, then **your** machine answers for that
printer. Every job sent to it lands in this log instead of on paper, and it
happens silently, because the sender sees a successful connection either way.
Under Docker, a bridge on a colliding subnet can also capture the host's route
to the real network, so you lose those devices from that machine entirely.

Three honest ways out, in order of preference:

1. **Move the emulator's subnet.** Change `subnet` and every device `ip` to
   something nothing else uses — `10.77.0.0/24` with `10.77.0.101` and up keeps
   the last octets familiar. Update your test fixtures to match.
2. **Run it under Docker**, where the bridge is isolated from your host's LAN.
3. **`--allow-subnet-conflict`**, only when you know the network is yours — a
   lab, a spare VLAN, or a machine that is not on the printers' network.

Disable the check entirely by setting `"subnet": null` in the config. The
loopback config does this, because `127.0.0.1` cannot collide with anything.

---

## Pointing your application at it

Whatever holds your printer records — a database table, a config file — set the
address and port to the emulated device:

| field | value |
| :-- | :-- |
| address / host / IP | `192.168.10.101`, or `127.0.0.1` on loopback |
| port | `9100`, or `9101` etc. on loopback |
| characters per line | match the device's `columns` (48 for 80mm, 32 for 58mm) |

Many systems encode a non-default port into the address as `host:port`. That
works here: the emulator is a plain TCP listener and does not care how the
client arrived at the address.

If your printers live in a database or a config file, the loopback setup means
rewriting those records; real addresses mean you do not have to. That is the
whole argument for the extra work.

---

## Proving it works

Send bytes by hand before you blame your application:

```bash
printf 'HELLO FROM NETCAT\n' | nc 127.0.0.1 9101
```

A job should appear in the UI within a second. If you have no `nc`:

```bash
node -e 'require("net").connect(9101,"127.0.0.1",function(){this.end("HELLO\n")})'
```

Then check it from the API rather than the screen:

```bash
curl -s localhost:7070/api/stats
curl -s 'localhost:7070/api/jobs?q=HELLO' | head -c 400
```

---

## Using it in a test suite

Start the emulator alongside your stack and drive it with the client. It works
with any runner — the examples use Jest's names, but nothing is Jest-specific.

```js
const { Client } = require('escpos-emu');
const emu = new Client('http://localhost:7070');

beforeEach(() => emu.reset());

test('a round reaches the kitchen exactly once', async () => {
  await placeOrder({ table: 'B4', items: ['CAPPUCCINO x3'] });
  await emu.expectExactlyOne('3 x CAPPUCCINO', { device: 'kitchen' });
  expect(await emu.count({ device: 'bar' })).toBe(0);
});
```

Or run one inside the process, with no ports to coordinate:

```js
const { createEmulator } = require('escpos-emu');

let emu;
beforeAll(async () => {
  emu = createEmulator({
    subnet: null,
    dataDir: null,                    // memory only
    devices: [{ id: 'kitchen', ip: '127.0.0.1', port: 0, columns: 48 }],
  });
  const { url } = await emu.start({ httpPort: 0, httpHost: '127.0.0.1' });
  process.env.PRINTER_HOST = `127.0.0.1:${emu.devices.get('kitchen').port}`;
  process.env.EMULATOR_URL = url;
});
afterAll(() => emu.stop());
```

`port: 0` and `httpPort: 0` take any free port, so parallel test workers never
collide.

**Printing is asynchronous.** Reading the log immediately after triggering a
print usually reads nothing. Use `waitForJob` or `expectExactlyOne`, both of
which poll.

### Testing the failure paths

The reason to reach for this rather than a stub:

```js
test('a ticket that fails to print is not reported as sent', async () => {
  await emu.setMode('kitchen', 'hang');       // accepts bytes, never answers
  await placeOrder({ table: 'B4', items: ['CAPPUCCINO x3'] });

  expect(await emu.count({ device: 'kitchen' })).toBe(0);
  expect(await orderStatus('B4')).toBe('print-failed');
});

test('a printer that comes back can be reprinted to', async () => {
  await emu.setMode('kitchen', 'refuse');
  await placeOrder({ table: 'B4', items: ['CAPPUCCINO x3'] });

  await emu.setMode('kitchen', 'accept');     // plugged back in
  await reprintFailedTickets();
  await emu.expectExactlyOne('3 x CAPPUCCINO', { device: 'kitchen' });
});
```

---

## Continuous integration

Use the loopback config, keep the log in memory, and bind only the loopback
interface:

```yaml
- name: Start printer emulator
  run: |
    npx escpos-emu --config devices.loopback.json --no-data --host 127.0.0.1 &
    npx wait-on tcp:7070
- run: npm test
```

`--no-data` keeps nothing on disk, so runs cannot contaminate each other.
`--host 127.0.0.1` keeps the control API off the runner's network.

---

## Troubleshooting

| What you see | What it means |
| :-- | :-- |
| `the address 192.168.10.101 is not on this machine` | The alias is not up. Run `./scripts/aliases.sh up`, or use Docker, or switch to the loopback config. |
| `192.168.10.101:9100 is already in use` | Something else holds that port — often a previous emulator still running. `pkill -f escpos-emu`. |
| `This machine is already on 192.168.10.0/24` | See [the subnet conflict](#the-subnet-conflict). Do not reach for `--allow-subnet-conflict` until you have read it. |
| Nothing appears when your app prints | Check the device is not on `hang` or `refuse` in the rail. Then `printf 'x\n' \| nc <ip> <port>` — if that shows up, the emulator is fine and your app is not reaching it. |
| A job appears only when you stop your app | Your client holds the connection open between tickets. That is handled by `idleFlushMs` (default 1s); lower it if your client is slower to be quiet. |
| One ticket arrives split into two jobs | The opposite: your client stalls mid-ticket for longer than `idleFlushMs`. Raise it, or set it to `0` to close jobs only when the socket does. |
| `EADDRNOTAVAIL` under Docker | The container's address is not in the compose subnet. Keep `devices.json` and `docker-compose.yml` consistent. |
| The paper looks like mojibake | The code page. The job's detail header shows which pages were selected; if it says `CP437` and you sent UTF-8, your client is not encoding for the device. |
| Lines flagged `WIDE` | The line is wider than the device's `columns`. Either the roll is set wrong in the config, or your layout genuinely overflows — the ruler above the paper shows where. |
