#!/usr/bin/env bash
# Build conduitd and install it on one tailnet machine as a systemd service.
#
#   scripts/deploy.sh mine@100.111.136.104
#   TS_AUTHKEY=tskey-auth-... scripts/deploy.sh ubuntu@snowye
#   HOST_PORT=8420 scripts/deploy.sh mine@100.111.136.104
#
# HOST_PORT serves on the machine's existing tailnet address instead of joining
# the tailnet as a second node: no login URL, no certificate, plain
# http://<tailnet-ip>:<port>. The machine keeps whatever account it is
# registered under.
#
# The target decides how it gets installed: with passwordless sudo the binary
# goes system-wide and runs as a system unit, without it everything lands under
# the login user's home as a systemd --user unit kept alive by linger.
#
# Re-running upgrades in place: the binary is replaced and the service restarted.
# State lives in ~/.conduit on the target and is never touched.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
	echo "usage: $0 [user@]host    (any name your tailnet or ssh config resolves)" >&2
	exit 2
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)

case "$(ssh "${SSH_OPTS[@]}" "$TARGET" 'uname -m')" in
	aarch64 | arm64) ARCH=arm64 ;;
	x86_64 | amd64) ARCH=amd64 ;;
	*) echo "unsupported target arch" >&2; exit 1 ;;
esac

echo "==> building linux/$ARCH"
cd "$REPO"
make web
CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -o "dist/conduitd-linux-$ARCH" ./cmd/conduitd

echo "==> shipping to $TARGET"
scp "${SSH_OPTS[@]}" "dist/conduitd-linux-$ARCH" "$TARGET:/tmp/conduitd.new"

# The auth key only rides along when one is given; otherwise the first run prints
# a login URL to the journal and waits there.
if [ -n "${TS_AUTHKEY:-}" ]; then
	printf 'TS_AUTHKEY=%s\n' "$TS_AUTHKEY" | ssh "${SSH_OPTS[@]}" "$TARGET" 'cat > /tmp/conduit.env && chmod 600 /tmp/conduit.env'
else
	ssh "${SSH_OPTS[@]}" "$TARGET" ': > /tmp/conduit.env'
fi

echo "==> installing"
ssh "${SSH_OPTS[@]}" "$TARGET" "HOST_PORT='${HOST_PORT:-}' bash -s" <<'REMOTE'
set -euo pipefail
me="$(id -un)"
args=""
if [ -n "${HOST_PORT:-}" ]; then
	args=" --host-port $HOST_PORT"
fi

if sudo -n true 2>/dev/null; then
	sudo install -m 0755 -o root -g root /tmp/conduitd.new /usr/local/bin/conduitd
	sudo install -d -m 0755 /etc/conduit
	if [ -s /tmp/conduit.env ]; then
		sudo install -m 0600 -o root -g root /tmp/conduit.env /etc/conduit/conduitd.env
	else
		[ -f /etc/conduit/conduitd.env ] || sudo install -m 0600 /dev/null /etc/conduit/conduitd.env
	fi

	sudo tee /etc/systemd/system/conduitd.service >/dev/null <<UNIT
[Unit]
Description=Conduit Minecraft server manager
After=network-online.target
Wants=network-online.target

[Service]
# Runs as the same user that owns the servers and the pm2 daemon, so conduitd
# drives the exact pm2 instance that is already running them.
User=$me
EnvironmentFile=/etc/conduit/conduitd.env
ExecStart=/usr/local/bin/conduitd$args
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

	sudo systemctl daemon-reload
	sudo systemctl enable conduitd
	sudo systemctl restart conduitd
	scope=system
else
	# No root on this box. Everything the service needs lives in the home dir,
	# and linger keeps the user manager running while nobody is logged in.
	install -d -m 0755 "$HOME/.local/bin" "$HOME/.config/systemd/user" "$HOME/.config/conduit"
	install -m 0755 /tmp/conduitd.new "$HOME/.local/bin/conduitd"
	if [ -s /tmp/conduit.env ]; then
		install -m 0600 /tmp/conduit.env "$HOME/.config/conduit/conduitd.env"
	else
		[ -f "$HOME/.config/conduit/conduitd.env" ] || install -m 0600 /dev/null "$HOME/.config/conduit/conduitd.env"
	fi

	cat > "$HOME/.config/systemd/user/conduitd.service" <<UNIT
[Unit]
Description=Conduit Minecraft server manager
After=network-online.target

[Service]
EnvironmentFile=%h/.config/conduit/conduitd.env
ExecStart=%h/.local/bin/conduitd$args
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT

	loginctl enable-linger "$me" >/dev/null 2>&1 || true
	systemctl --user daemon-reload
	systemctl --user enable conduitd
	systemctl --user restart conduitd
	scope=user
fi

rm -f /tmp/conduitd.new /tmp/conduit.env
sleep 3

# An auth key is spent the moment the node registers, and tsnet keeps its own
# node key from then on. Leaving the dead key in the env file only guarantees
# that the next restart fails on "invalid key" and loops, so drop it once the
# node has state.
if [ "$scope" = system ]; then
	sudo sh -c ': > /etc/conduit/conduitd.env'
else
	: > "$HOME/.config/conduit/conduitd.env"
fi
if [ "$scope" = system ]; then
	systemctl is-active conduitd || { journalctl -u conduitd -n 30 --no-pager; exit 1; }
	echo "installed as a system unit"
else
	systemctl --user is-active conduitd || { journalctl --user -u conduitd -n 30 --no-pager; exit 1; }
	echo "installed as a --user unit"
fi
REMOTE

echo "==> done. logs: ssh $TARGET 'journalctl --user -u conduitd -f'  (drop --user if it installed system-wide)"
