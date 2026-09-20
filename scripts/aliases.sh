#!/usr/bin/env bash
#
# Bring the emulated printers' addresses up on the loopback interface, so the
# emulator can bind them without Docker.
#
#   ./scripts/aliases.sh up      [devices.json]
#   ./scripts/aliases.sh down    [devices.json]
#
# This needs root, so it PRINTS the commands rather than running them. Read
# them before you paste them: they add addresses to your machine, and if one of
# them belongs to a real device on your network you will take its traffic.
set -euo pipefail

action="${1:-}"
config="${2:-devices.json}"

if [[ "$action" != "up" && "$action" != "down" ]]; then
  echo "usage: $0 up|down [devices.json]" >&2
  exit 64
fi

if [[ ! -f "$config" ]]; then
  echo "$0: no such config: $config" >&2
  exit 66
fi

ips=$(node -e '
  const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const d of cfg.devices || []) if (d.ip && d.ip !== "127.0.0.1") console.log(d.ip);
' "$config")

if [[ -z "$ips" ]]; then
  echo "$0: nothing to do - every device is on 127.0.0.1 already." >&2
  exit 0
fi

case "$(uname -s)" in
  Darwin) iface="lo0"  ; add="sudo ifconfig $iface alias"      ; del="sudo ifconfig $iface -alias" ;;
  Linux)  iface="lo"   ; add="sudo ip addr add"                ; del="sudo ip addr del" ;;
  *) echo "$0: unsupported platform $(uname -s)" >&2 ; exit 70 ;;
esac

echo "# Run these to bring the emulated printers $action on $iface:"
echo
while read -r ip; do
  [[ -z "$ip" ]] && continue
  if [[ "$action" == "up" ]]; then
    [[ "$iface" == "lo" ]] && echo "$add $ip/32 dev $iface" || echo "$add $ip"
  else
    [[ "$iface" == "lo" ]] && echo "$del $ip/32 dev $iface" || echo "$del $ip"
  fi
done <<< "$ips"
echo
echo "# Then: npx escpos-emu --config $config"
