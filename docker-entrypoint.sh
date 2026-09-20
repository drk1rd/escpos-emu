#!/bin/sh
#
# Give this container every printer address before starting.
#
# Compose can assign a container one address per network, but a site usually has
# several printers on one subnet and we want them all behind one UI and one job
# log. So the container takes its compose-assigned address and adds the rest
# itself, which needs NET_ADMIN (granted in docker-compose.yml).
#
# Adding an address that is already there is not an error worth stopping for -
# it just means the container was restarted.
set -e

CONFIG="${ESCPOS_CONFIG:-/app/devices.json}"
IFACE="${ESCPOS_IFACE:-eth0}"

if [ -f "$CONFIG" ]; then
  PREFIX=$(node -e '
    const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const bits = String(cfg.subnet || "").split("/")[1] || "24";
    process.stdout.write(bits);
  ' "$CONFIG")

  node -e '
    const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const d of cfg.devices || []) if (d.ip) console.log(d.ip);
  ' "$CONFIG" | while read -r ip; do
    [ -z "$ip" ] && continue
    # A wildcard or loopback bind needs no address adding, and `ip addr add`
    # would fail on it - which would look like an error when it is the normal
    # single-container case.
    case "$ip" in 0.0.0.0|127.0.0.1) continue ;; esac
    if ip addr add "$ip/$PREFIX" dev "$IFACE" 2>/dev/null; then
      echo "escpos-emu: bound $ip on $IFACE"
    else
      echo "escpos-emu: $ip already present on $IFACE"
    fi
  done
fi

exec node /app/bin/escpos-emu.js "$@"
