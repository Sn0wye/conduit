#!/usr/bin/env bash
# Install Conduit on this machine and keep it running.
#
#   curl -fsSL https://raw.githubusercontent.com/Sn0wye/conduit/main/install.sh | bash
#
# Options go after `bash -s --`:
#
#   curl -fsSL .../install.sh | bash -s -- --host-port 8420
#
#   --version vX.Y.Z   install that release instead of the latest
#   --host-port PORT   serve on this machine's own tailnet address and port,
#                      through the tailscaled already running here, instead of
#                      joining the tailnet as a node of its own
#   --binary PATH      install this local conduitd instead of downloading one
#   --no-service       only put the binary in place
#   --uninstall        stop the service and remove the binary; ~/.conduit stays
#
# TS_AUTHKEY in the environment registers the node without a browser login.
#
# Running it again upgrades in place: the binary is replaced and the service
# restarted. State lives in ~/.conduit and is never touched.
#
# Where it goes:
#   Linux, as root or with sudo   /usr/local/bin/conduitd, systemd system unit
#   Linux, no sudo                ~/.local/bin/conduitd, systemd --user unit
#   macOS                         ~/.local/bin/conduitd, launchd agent
#
# The service always runs as the user who owns the Minecraft servers and the
# pm2 daemon (the one who ran sudo, when run with sudo), because conduitd has
# to drive the pm2 that is already running them.

set -euo pipefail

REPO="${CONDUIT_REPO:-Sn0wye/conduit}"
LABEL="dev.conduit.conduitd"

# Everything lives in main so a download cut off halfway runs nothing.
main() {
	local version="${CONDUIT_VERSION:-latest}" host_port="${CONDUIT_HOST_PORT:-}"
	local binary="" service=1 uninstall=0

	while [ $# -gt 0 ]; do
		case "$1" in
		--version) version="${2:?--version needs a value}"; shift 2 ;;
		--host-port) host_port="${2:?--host-port needs a port}"; shift 2 ;;
		--binary) binary="${2:?--binary needs a path}"; shift 2 ;;
		--no-service) service=0; shift ;;
		--uninstall) uninstall=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) die "unknown option $1 (try --help)" ;;
		esac
	done

	detect_platform
	pick_scope

	if [ "$uninstall" = 1 ]; then
		do_uninstall
		return
	fi

	if [ -n "$host_port" ] && ! command -v tailscale >/dev/null 2>&1; then
		die "--host-port serves through the local tailscaled, and tailscale is not installed here"
	fi

	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	local tmp="$TMP"

	if [ -n "$binary" ]; then
		[ -f "$binary" ] || die "no file at $binary"
		cp "$binary" "$tmp/conduitd"
	else
		download "$version" "$tmp"
	fi
	chmod 0755 "$tmp/conduitd"

	install_binary "$tmp/conduitd"
	local installed
	installed="$("$BIN" --version 2>/dev/null | awk '{print $2}')"
	ok "conduitd ${installed:-} installed to $(tildify "$BIN")"

	if [ "$service" = 0 ]; then
		info "run it with: $(tildify "$BIN")${host_port:+ --host-port $host_port}"
		return
	fi

	local args=""
	[ -n "$host_port" ] && args=" --host-port $host_port"

	case "$OS" in
	linux) service_systemd "$args" ;;
	darwin) service_launchd "$args" ;;
	esac

	check_pm2
	echo
	info "upgrade later by running the same command again"
}

usage() {
	cat <<'USAGE'
usage: install.sh [--version vX.Y.Z] [--host-port PORT] [--binary PATH] [--no-service] [--uninstall]

  --version vX.Y.Z   install that release instead of the latest
  --host-port PORT   serve on this machine's tailnet address through the local
                     tailscaled instead of joining the tailnet as its own node
  --binary PATH      install a local conduitd instead of downloading one
  --no-service       only put the binary in place
  --uninstall        stop the service and remove the binary; ~/.conduit stays

TS_AUTHKEY in the environment registers the node without a browser login.
USAGE
}

# --- output -----------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	C_DIM=$'\033[2m' C_BOLD=$'\033[1m' C_GREEN=$'\033[32m' C_RED=$'\033[31m' C_YELLOW=$'\033[33m' C_RESET=$'\033[0m'
else
	C_DIM="" C_BOLD="" C_GREEN="" C_RED="" C_YELLOW="" C_RESET=""
fi

info() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok() { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() {
	printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
	exit 1
}
tildify() { case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac }

# --- platform ---------------------------------------------------------------

detect_platform() {
	case "$(uname -s)" in
	Linux) OS=linux ;;
	Darwin) OS=darwin ;;
	*) die "conduit runs on Linux and macOS, not $(uname -s)" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) ARCH=amd64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) die "no conduitd build for $(uname -m)" ;;
	esac
	# Rosetta reports x86_64 from a translated shell on Apple silicon.
	if [ "$OS" = darwin ] && [ "$ARCH" = amd64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
		ARCH=arm64
	fi
}

# pick_scope decides between a system install and one under the user's home,
# and who the service runs as. SUDO is the prefix for privileged commands.
pick_scope() {
	SUDO=""
	if [ "$OS" = darwin ]; then
		if [ "$(id -u)" = 0 ]; then
			die "on macOS run the installer as yourself, without sudo; it installs a launchd agent for your user"
		fi
		SCOPE=user
		RUN_AS="$(id -un)"
		RUN_HOME="$HOME"
		BIN="$HOME/.local/bin/conduitd"
		return
	fi

	if [ "$(id -u)" = 0 ]; then
		SCOPE=system
		RUN_AS="${SUDO_USER:-root}"
	elif command -v sudo >/dev/null 2>&1 && { sudo -n true 2>/dev/null || (: </dev/tty) 2>/dev/null; }; then
		# Either passwordless, or there is a terminal for sudo to ask on. A
		# piped installer still has /dev/tty even though stdin is the script.
		SCOPE=system
		SUDO="sudo"
		RUN_AS="$(id -un)"
	else
		SCOPE=user
		RUN_AS="$(id -un)"
	fi

	if [ "$SCOPE" = system ]; then
		BIN=/usr/local/bin/conduitd
	else
		BIN="$HOME/.local/bin/conduitd"
	fi
	RUN_HOME="$(getent passwd "$RUN_AS" 2>/dev/null | cut -d: -f6)"
	RUN_HOME="${RUN_HOME:-$HOME}"
}

# --- download ---------------------------------------------------------------

fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 3 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$2" "$1"
	else
		die "curl or wget is needed to download conduitd"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

download() {
	local version="$1" dir="$2" asset="conduitd-$OS-$ARCH.tar.gz" base
	if [ -n "${CONDUIT_DOWNLOAD_URL:-}" ]; then
		# A mirror, or a local directory served over http for testing.
		base="${CONDUIT_DOWNLOAD_URL%/}"
	elif [ "$version" = latest ]; then
		base="https://github.com/$REPO/releases/latest/download"
	else
		case "$version" in v*) ;; *) version="v$version" ;; esac
		base="https://github.com/$REPO/releases/download/$version"
	fi

	info "downloading $asset ($version)"
	fetch "$base/$asset" "$dir/$asset" || die "could not download $base/$asset"
	fetch "$base/checksums.txt" "$dir/checksums.txt" || die "could not download checksums.txt"

	local want got
	want="$(awk -v f="$asset" '$2 == f || $2 == "*"f {print $1}' "$dir/checksums.txt")"
	[ -n "$want" ] || die "$asset is not listed in checksums.txt"
	got="$(sha256 "$dir/$asset")"
	[ "$want" = "$got" ] || die "checksum mismatch for $asset (want $want, got $got)"

	tar -xzf "$dir/$asset" -C "$dir" conduitd || die "could not unpack $asset"
}

install_binary() {
	$SUDO mkdir -p "$(dirname "$BIN")"
	# Write beside the target and rename, so a running conduitd keeps its old
	# inode and the swap is atomic.
	$SUDO cp "$1" "$BIN.new"
	$SUDO chmod 0755 "$BIN.new"
	$SUDO mv -f "$BIN.new" "$BIN"
	if [ "$SCOPE" = user ]; then
		case ":$PATH:" in
		*":$(dirname "$BIN"):"*) ;;
		*) warn "$(tildify "$(dirname "$BIN")") is not on your PATH; add it to call conduitd by name" ;;
		esac
	fi
}

# --- auth key ---------------------------------------------------------------

# An auth key is spent once the node registers, and tsnet keeps its own node
# key from then on. A dead key left in the environment makes the next restart
# fail on "invalid key", so it is only written for the first start and cleared
# as soon as the node has state.
node_state() { [ -s "$RUN_HOME/.conduit/tsnet/tailscaled.state" ]; }

env_body() {
	if [ -n "${TS_AUTHKEY:-}" ] && ! node_state; then
		printf 'TS_AUTHKEY=%s\n' "$TS_AUTHKEY"
	fi
}

# --- systemd ----------------------------------------------------------------

service_systemd() {
	local args="$1"
	if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
		warn "no systemd here, so nothing will keep conduitd running"
		info "start it by hand: $BIN$args"
		return
	fi

	local unit env ctl journal
	if [ "$SCOPE" = system ]; then
		unit=/etc/systemd/system/conduitd.service
		env=/etc/conduit/conduitd.env
		ctl="$SUDO systemctl"
		journal="$SUDO journalctl -u conduitd"
		$SUDO install -d -m 0755 /etc/conduit
		env_body | $SUDO tee "$env" >/dev/null
		$SUDO chmod 0600 "$env"
		$SUDO tee "$unit" >/dev/null <<UNIT
[Unit]
Description=Conduit Minecraft server manager
After=network-online.target
Wants=network-online.target

[Service]
# Runs as the user that owns the servers and the pm2 daemon, so conduitd
# drives the exact pm2 that is already running them.
User=$RUN_AS
EnvironmentFile=-$env
ExecStart=$BIN$args
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
	else
		unit="$HOME/.config/systemd/user/conduitd.service"
		env="$HOME/.config/conduit/conduitd.env"
		ctl="systemctl --user"
		journal="journalctl --user -u conduitd"
		install -d -m 0755 "$(dirname "$unit")" "$(dirname "$env")"
		(umask 077 && env_body >"$env")
		cat >"$unit" <<UNIT
[Unit]
Description=Conduit Minecraft server manager
After=network-online.target

[Service]
EnvironmentFile=-%h/.config/conduit/conduitd.env
ExecStart=$BIN$args
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
		# Linger keeps the user manager, and with it conduitd, running while
		# nobody is logged in.
		[ -e "/var/lib/systemd/linger/$RUN_AS" ] ||
			loginctl enable-linger "$RUN_AS" >/dev/null 2>&1 ||
			warn "could not enable linger; conduitd stops when you log out (ask an admin for: loginctl enable-linger $RUN_AS)"
		# su and some ssh setups leave no session bus in the environment even
		# though the user manager is up; point at it before giving up.
		if ! systemctl --user show-environment >/dev/null 2>&1; then
			export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
			for _ in 1 2 3 4 5; do
				systemctl --user show-environment >/dev/null 2>&1 && break
				sleep 1
			done
		fi
		if ! systemctl --user show-environment >/dev/null 2>&1; then
			warn "no systemd user session to run the service in (log in over ssh, or install with sudo)"
			info "the unit is written to $(tildify "$unit"); start it later with: systemctl --user enable --now conduitd"
			info "or run it by hand: $BIN$args"
			return
		fi
	fi

	local since
	since="$(date +%s)"
	$ctl daemon-reload
	$ctl enable conduitd >/dev/null 2>&1
	$ctl restart conduitd
	ok "running as a systemd $([ "$SCOPE" = system ] && echo system || echo --user) unit, as $RUN_AS"

	watch_startup "$journal --no-pager -o cat --since @$since" "$args"
	if [ -n "${TS_AUTHKEY:-}" ] && node_state; then
		if [ "$SCOPE" = system ]; then : | $SUDO tee "$env" >/dev/null; else : >"$env"; fi
	fi
	info "logs: $journal -f"
}

# --- launchd ----------------------------------------------------------------

service_launchd() {
	local args="$1" plist="$HOME/Library/LaunchAgents/$LABEL.plist" log="$HOME/.conduit/conduitd.log"
	mkdir -p "$(dirname "$plist")" "$HOME/.conduit"

	write_plist() {
		local key="$1" argv="<string>$BIN</string>" a
		for a in $args; do argv="$argv<string>$a</string>"; done
		(
			umask 077
			cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>$argv</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    ${key:+<key>TS_AUTHKEY</key><string>$key</string>}
  </dict>
</dict>
</plist>
PLIST
		)
	}

	local key=""
	if [ -n "${TS_AUTHKEY:-}" ] && ! node_state; then key="$TS_AUTHKEY"; fi
	write_plist "$key"

	local offset=0
	[ -f "$log" ] && offset="$(wc -c <"$log" | tr -d ' ')"
	launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
	launchctl bootstrap "gui/$(id -u)" "$plist"
	ok "running as a launchd agent ($LABEL)"

	watch_startup "tail -c +$((offset + 1)) $log" "$args"
	# The running process already has the key; launchd only rereads the plist
	# on the next load, which must not see a spent key.
	[ -n "$key" ] && node_state && write_plist ""
	info "logs: tail -f $(tildify "$log")"
}

# --- first start ------------------------------------------------------------

# watch_startup reads the fresh log until conduitd says where it is serving or
# hands out a login URL, so the one link that matters ends up on screen instead
# of buried in a journal.
watch_startup() {
	local read_log="$1" args="$2" out url
	for _ in $(seq 1 40); do
		sleep 0.5
		out="$(eval "$read_log" 2>/dev/null || true)"
		url="$(printf '%s\n' "$out" | grep -o 'https://login\.tailscale\.com/[^ ]*' | tail -n1 || true)"
		if [ -n "$url" ]; then
			echo
			printf '%sOne step left:%s sign this machine into your tailnet\n' "$C_BOLD" "$C_RESET"
			printf '  %s\n' "$url"
			info "then open the address it prints in the logs; the first login to open it owns this machine"
			return
		fi
		url="$(printf '%s\n' "$out" | grep -o 'serving https\{0,1\}://[^ ]*' | head -n1 | cut -d' ' -f2 || true)"
		if [ -n "$url" ]; then
			echo
			printf '%sOpen%s %s\n' "$C_BOLD" "$C_RESET" "$url"
			info "the first tailnet login to open it owns this machine"
			return
		fi
		if printf '%s\n' "$out" | grep -q 'conduitd: '; then
			echo
			warn "conduitd failed to start:"
			printf '%s\n' "$out" | grep 'conduitd: ' | tail -n3 >&2
			return
		fi
	done
	info "still starting; the address shows up in the logs"
}

check_pm2() {
	if [ -x "$RUN_HOME/n/bin/pm2" ] || command -v pm2 >/dev/null 2>&1 ||
		ls "$RUN_HOME"/.nvm/versions/node/*/bin/pm2 >/dev/null 2>&1 || [ -x "$RUN_HOME/.volta/bin/pm2" ]; then
		return
	fi
	warn "pm2 was not found; conduit starts and stops servers through it (npm install -g pm2)"
}

# --- uninstall --------------------------------------------------------------

do_uninstall() {
	if [ "$OS" = darwin ]; then
		launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
		rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
	elif command -v systemctl >/dev/null 2>&1; then
		if [ -f /etc/systemd/system/conduitd.service ]; then
			$SUDO systemctl disable --now conduitd >/dev/null 2>&1 || true
			$SUDO rm -f /etc/systemd/system/conduitd.service
			$SUDO rm -rf /etc/conduit
			$SUDO systemctl daemon-reload
		fi
		if [ -f "$HOME/.config/systemd/user/conduitd.service" ]; then
			systemctl --user disable --now conduitd >/dev/null 2>&1 || true
			rm -f "$HOME/.config/systemd/user/conduitd.service"
			rm -rf "$HOME/.config/conduit"
			systemctl --user daemon-reload >/dev/null 2>&1 || true
		fi
	fi
	$SUDO rm -f /usr/local/bin/conduitd 2>/dev/null || true
	rm -f "$HOME/.local/bin/conduitd"
	ok "conduitd removed"
	info "state is still in $(tildify "$RUN_HOME/.conduit") (database, tailnet node key, version archives); delete it by hand if you want it gone"
}

main "$@"
