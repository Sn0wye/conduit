BIN := dist/conduitd

.PHONY: web build dist dev test clean deploy

web:
	cd web && bun install && bun run build

# Linux binaries for a quick scp. Releases use `make dist`.
build: web
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o $(BIN)-linux-arm64 ./cmd/conduitd
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o $(BIN)-linux-amd64 ./cmd/conduitd

# Every platform install.sh downloads, as tarballs with checksums.txt.
# Tag and push to publish: git tag v0.1.0 && git push origin v0.1.0
dist: web
	scripts/dist.sh

# Runs against the local machine with plain http and no tailnet identity.
dev:
	CGO_ENABLED=0 go run ./cmd/conduitd --dev

test:
	go vet ./...
	go test ./...

# Build and install on one tailnet machine: make deploy HOST=ubuntu@snowye
deploy:
	@test -n "$(HOST)" || (echo "usage: make deploy HOST=[user@]host" >&2; exit 2)
	scripts/deploy.sh $(HOST)

clean:
	rm -rf dist web/dist
