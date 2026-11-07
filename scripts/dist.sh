#!/usr/bin/env bash
# Cross-compile conduitd for every platform install.sh knows, into
# dist/conduitd-<os>-<arch>.tar.gz plus dist/checksums.txt.
#
#   VERSION=v0.3.0 scripts/dist.sh
#
# The PWA must already be built into web/dist (make web); it is embedded.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
PLATFORMS="${PLATFORMS:-linux/amd64 linux/arm64 darwin/amd64 darwin/arm64}"

[ -f web/dist/index.html ] || { echo "web/dist is empty, run make web first" >&2; exit 1; }

# macOS tar stores Finder metadata as extended headers that GNU tar warns
# about on the target; leave it out.
TAR_OPTS=()
if tar --version 2>/dev/null | grep -q bsdtar; then
	export COPYFILE_DISABLE=1
	TAR_OPTS=(--no-xattrs --no-mac-metadata)
fi

rm -rf dist
mkdir -p dist
for p in $PLATFORMS; do
	os="${p%/*}" arch="${p#*/}" out="dist/conduitd-$os-$arch"
	echo "==> $os/$arch $VERSION"
	mkdir -p "$out"
	CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
		-ldflags "-s -w -X main.version=$VERSION" -o "$out/conduitd" ./cmd/conduitd
	tar "${TAR_OPTS[@]}" -czf "$out.tar.gz" -C "$out" conduitd
	rm -rf "$out"
done

cd dist
if command -v sha256sum >/dev/null; then sha256sum ./*.tar.gz; else shasum -a 256 ./*.tar.gz; fi |
	sed 's# \./# #' >checksums.txt
cat checksums.txt
