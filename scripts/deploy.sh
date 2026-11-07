#!/usr/bin/env bash
# Build conduitd from this checkout and install it on one machine over ssh.
# For released versions, run install.sh on the machine instead:
#
#   curl -fsSL https://raw.githubusercontent.com/Sn0wye/conduit/main/install.sh | bash
#
# This is the same installer, fed a locally built binary, so the service setup
# lives in exactly one place.
#
#   scripts/deploy.sh mine@100.111.136.104
#   TS_AUTHKEY=tskey-auth-... scripts/deploy.sh ubuntu@snowye
#   HOST_PORT=8420 scripts/deploy.sh mine@100.111.136.104
#
# HOST_PORT serves on the machine's existing tailnet address instead of joining
# the tailnet as a second node. Over ssh there is no terminal for sudo to ask
# on, so without passwordless sudo it installs as a systemd --user unit.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
	echo "usage: $0 [user@]host    (any name your tailnet or ssh config resolves)" >&2
	exit 2
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)

read -r OS ARCH <<<"$(ssh "${SSH_OPTS[@]}" "$TARGET" 'uname -s; uname -m' | tr '\n' ' ')"
case "$OS" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) echo "unsupported target os $OS" >&2; exit 1 ;; esac
case "$ARCH" in aarch64 | arm64) ARCH=arm64 ;; x86_64 | amd64) ARCH=amd64 ;; *) echo "unsupported target arch $ARCH" >&2; exit 1 ;; esac

VERSION="$(git -C "$REPO" describe --tags --always --dirty 2>/dev/null || echo dev)"
echo "==> building $OS/$ARCH $VERSION"
cd "$REPO"
make web
CGO_ENABLED=0 GOOS="$OS" GOARCH="$ARCH" go build -trimpath -ldflags "-X main.version=$VERSION" \
	-o "dist/conduitd-$OS-$ARCH" ./cmd/conduitd

echo "==> shipping to $TARGET"
scp "${SSH_OPTS[@]}" "dist/conduitd-$OS-$ARCH" "$TARGET:/tmp/conduitd.new"
scp "${SSH_OPTS[@]}" install.sh "$TARGET:/tmp/conduit-install.sh"

echo "==> installing"
# The auth key travels on stdin, never on a command line where ps can see it.
args=(--binary /tmp/conduitd.new)
[ -n "${HOST_PORT:-}" ] && args+=(--host-port "$HOST_PORT")
printf '%s' "${TS_AUTHKEY:-}" | ssh "${SSH_OPTS[@]}" "$TARGET" \
	"read -r TS_AUTHKEY || true; export TS_AUTHKEY; bash /tmp/conduit-install.sh ${args[*]}; s=\$?; rm -f /tmp/conduitd.new /tmp/conduit-install.sh; exit \$s"
