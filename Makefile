BIN := dist/conduitd

.PHONY: web build dev clean deploy

web:
	cd web && bun install && bun run build

build: web
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o $(BIN)-linux-arm64 ./cmd/conduitd
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o $(BIN)-linux-amd64 ./cmd/conduitd

# Runs against the local machine with plain http and no tailnet identity.
dev:
	CGO_ENABLED=0 go run ./cmd/conduitd --dev

clean:
	rm -rf dist web/dist
