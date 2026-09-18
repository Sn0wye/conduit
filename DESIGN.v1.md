# Conduit — Design

Self-hosted Minecraft server fleet manager. Single Go binary per machine, embedded PWA,
Tailscale-native, pm2 process backend, CurseForge modpack install/update.

Stack: **Go** for agent, API, job engine, everything server-side.
**Bun + Vite + React + TypeScript + Tailwind** for the PWA. Nothing else.

Single operator. Fleet < 5 machines. No central control plane.

---

## 1. Topology

```
        browser (PWA, installed)
              |
              |  HTTPS over tailnet (MagicDNS + LE certs)
              |
   +----------+----------+----------+
   |                     |          |
conduitd@nuc      conduitd@vps   conduitd@homelab
   |                     |          |
 pm2 -> java         pm2 -> java  pm2 -> java
```

Each `conduitd` is identical and independent:
- joins tailnet as its own node via **tsnet** (no `tailscaled` on host)
- serves embedded PWA + JSON API + WebSockets
- owns a local SQLite DB (its own instances only)
- knows about peers via Tailscale status, for the PWA's machine switcher

PWA is served by whichever agent you open. It then talks **directly** to every other
agent. No proxying, no shared state, no single point of failure.

## 2. Auth

Network-level. Tailnet ACL is the auth boundary. Agent listens on the tsnet interface
only — never on `0.0.0.0`.

On top of that, `tsnet.Server.LocalClient().WhoIs()` identifies the calling tailnet user
per request. Agent config carries an `allow_users` list (your Tailscale login). Requests
from anyone else get 403. No passwords, no sessions, no JWT, no login screen.

## 3. HTTPS is mandatory (not optional)

PWA install + service worker need a **secure context**. `http://conduit-nuc.ts.net` is not
one. So:

- Tailscale admin: enable **MagicDNS** and **HTTPS Certificates**
- agent uses `tsnet.Server.ListenTLS("tcp", ":443")` — Tailscale provisions and renews
  the Let's Encrypt cert for `conduit-<host>.<tailnet>.ts.net` automatically
- CORS: agents allow origins matching `https://*.<tailnet>.ts.net`. Auth is network-level,
  so no credentialed-CORS complexity.

## 4. Repo layout

Monorepo, one binary. `go:embed` pulls the built PWA in.

```
conduit/
  cmd/conduitd/main.go
  internal/
    api/            HTTP handlers, WS hubs, CORS, whois middleware
    tsnetsrv/       tsnet bootstrap, TLS listener, identity
    store/          SQLite schema + queries (modernc.org/sqlite, CGO_ENABLED=0)
    instance/       Instance model, lifecycle state machine
    procman/        ProcessBackend interface; pm2 impl (docker impl later)
    rcon/           RCON client
    curseforge/     API client, file listing, server-pack + manifest resolution
    packs/          install / update / rollback orchestration, artifact cache
    backups/        discover, list, download, restore existing backups
    jobs/           durable queue, workers, progress events
    discovery/      tailscale peer scan + conduit probe
    config/         agent config file
  web/              bun + vite + react + ts + tailwind, vite-plugin-pwa
    bun.lockb
    package.json
    vite.config.ts
    src/
  Makefile          bun run build -> embed web/dist -> go build (linux amd64/arm64)
  DESIGN.md
```

## 5. Disk layout

```
/srv/conduit/
  artifacts/                       cached CF downloads, keyed by fileId
  db.sqlite
  instances/<id>/
    current -> versions/2026-09-17T14-03-11Z/
    versions/<ts>/                 mods/ config/ server.jar start flags — the pack
    world/                         OUTSIDE versions. never touched by updates
    backups/                       your existing backup target points here
    logs/
    conduit.json                   metadata mirror (human-readable, DB is truth)
```

`current` is a symlink. Pack update builds a new `versions/<ts>/`, then swaps the symlink.
Rollback = swap it back. World lives outside, so an update can never eat it.
`current/world` symlinks to `../../world`.

Retention: keep last 3 versions, GC older.

## 6. Instance lifecycle

States: `stopped | starting | running | stopping | crashed | updating`

**Start**: `pm2 start ecosystem.config.js` → poll until RCON port accepts → `running`.

**Graceful stop**: RCON `stop` → poll for process exit (timeout 120s) → if still alive,
`pm2 stop` → if still alive, `pm2 delete`.

**pm2 gotcha — autorestart must be OFF.** With `autorestart: true`, an RCON `stop` looks
like a crash to pm2 and it resurrects the server immediately. So ecosystem sets
`autorestart: false`, and `conduitd` owns the crash-restart policy itself (watch `pm2 jlist`,
restart if exit was unexpected and policy allows, with backoff). This is the main argument
for moving to Docker later — `restart: unless-stopped` plus a real stop signal does this
correctly for free.

Generated `ecosystem.config.js`:

```js
module.exports = { apps: [{
  name: "mc-<id>",
  cwd: "/srv/conduit/instances/<id>/current",
  script: "/usr/lib/jvm/<jdk>/bin/java",
  interpreter: "none",
  args: ["-Xms4G", "-Xmx8G", ...aikarFlags, "-jar", "server.jar", "nogui"],
  autorestart: false,
  kill_timeout: 120000,
  out_file: "../logs/out.log",
  error_file: "../logs/err.log",
  time: true
}]};
```

## 7. CurseForge

API key lives in agent config, server-side only. PWA never sees it; it calls the agent's
`/v1/cf/*` proxy.

Endpoints used (`x-api-key` header, `api.curseforge.com`):
- `GET /v1/mods/search?gameId=432&classId=4471` — 4471 = Modpacks
- `GET /v1/mods/{modId}/files`
- `GET /v1/mods/{modId}/files/{fileId}/download-url`

**Two install paths, decided by `serverPackFileId` on the file object:**

1. **Server pack present** (`serverPackFileId != null`) — download that one zip. Self-contained:
   `mods/`, `config/`, start script. No per-mod resolution. Use this whenever available.

2. **No server pack** — download the client zip, read `manifest.json`, resolve each
   `{projectID, fileID}` via the download-url endpoint. Some mods return `null` /
   403 because the author disabled third-party distribution. Those cannot be fetched,
   by anyone, ever.

   Handling: collect the blocked list, fail the job with a structured result listing each
   blocked mod + its CurseForge URL. PWA shows them with download links and a drop zone;
   user drops the jars in, job resumes. Do not silently skip — a missing mod means a
   server that won't boot or a corrupted world.

**Manual upload path stays permanently.** `PackSource` interface, two impls:
`CurseForgeSource` and `UploadSource`. Upload is the escape hatch for blocked packs,
private packs, and hand-rolled ones.

**Artifact cache**: downloads land in `/srv/conduit/artifacts/<fileId>.zip`. Re-installing
the same pack on the same machine is free. Cross-machine reuse is not automatic here
(no central store) — each agent fetches its own copy. Acceptable at this fleet size.

## 8. Backups — read and restore only

Servers already produce their own backups. Conduit does not create them.

- config points at an existing backup dir per instance (glob pattern for the files)
- list: name, size, mtime, parsed timestamp
- download: stream the file
- restore: stop instance → move current world aside as `world.pre-restore-<ts>` →
  extract → start
- delete / prune by count or age

**Separate from this**: before every pack update, Conduit takes an *instance snapshot* —
`tar.zst` of `versions/<current>/` only, excluding world. Seconds, tiny, and it makes
rollback trivial. Different thing from your world backups, don't conflate them.

## 9. Job engine

Every long operation is a durable `Job` row in SQLite.

Types: `create`, `update_pack`, `rollback`, `start`, `stop`, `restart`, `restore_backup`,
`delete`, `snapshot`.

- one worker per instance — operations on a single instance serialize, never interleave
- global cap of 2 concurrent downloads
- progress + log lines appended to the job, streamed over WS, persisted
- on agent boot, any job still marked `running` is marked `interrupted` with a reason
- `update_pack` is transactional at the symlink level: build new version dir fully,
  verify, then swap. Any failure before the swap leaves the running server untouched.

## 10. HTTP API — `/v1`

```
GET    /v1/info                                machine name, version, os, disk, mem, JDKs
GET    /v1/peers                               other conduit nodes on the tailnet

GET    /v1/instances
POST   /v1/instances                           -> Job (create)
GET    /v1/instances/:id                       instance + live stats (cpu, mem, players, tps)
DELETE /v1/instances/:id?keepWorld=true        -> Job

POST   /v1/instances/:id/start                 -> Job
POST   /v1/instances/:id/stop                  { graceful, timeoutSec } -> Job
POST   /v1/instances/:id/restart               -> Job
POST   /v1/instances/:id/update                { fileId } -> Job
POST   /v1/instances/:id/rollback              { version? } -> Job
GET    /v1/instances/:id/versions              installed pack versions + current

GET    /v1/instances/:id/logs?tail=200
WS     /v1/instances/:id/console                stdout stream down, RCON commands up

GET    /v1/instances/:id/backups
GET    /v1/instances/:id/backups/:name          stream download
POST   /v1/instances/:id/backups/:name/restore  -> Job
DELETE /v1/instances/:id/backups/:name

GET    /v1/instances/:id/files?path=            listing
GET    /v1/instances/:id/files/raw?path=        read  (server.properties, configs)
PUT    /v1/instances/:id/files/raw?path=        write

GET    /v1/jobs?state=&instanceId=
GET    /v1/jobs/:id
WS     /v1/jobs/:id/stream                      progress events
POST   /v1/jobs/:id/cancel

GET    /v1/cf/search?q=&pageSize=&gameVersion=
GET    /v1/cf/packs/:projectId
GET    /v1/cf/packs/:projectId/files            fileId, name, gameVersions, serverPackFileId
POST   /v1/uploads                              multipart, manual pack zip -> artifact
```

Errors: `{ "error": { "code": "...", "message": "...", "details": {...} } }`.
Blocked-mod failures use `code: "cf_distribution_blocked"` with the mod list in `details`.

## 11. PWA

Bun as package manager and script runner. Vite + React + TS + Tailwind v4,
`vite-plugin-pwa` for manifest + service worker.

- `bun install`, `bun run dev`, `bun run build` — no npm/pnpm/node_modules churn
- Tailwind v4 via `@tailwindcss/vite` plugin, config in CSS (`@theme`), no tailwind.config.js
- dev: Vite proxies `/v1` to a conduitd over the tailnet, set by `CONDUIT_DEV_TARGET`
- state/data: TanStack Query for REST, raw WebSocket for console and job streams
- no component library — Tailwind + a few local primitives. Console and log views need
  a virtualized list (`@tanstack/react-virtual`); a modpack server dumps thousands of lines

- machine switcher, populated from `/v1/peers` on the current agent, overridable in settings
- per-machine dashboard: instances, state, players online, cpu/mem
- instance view: console (WS), logs, config editor, backups, versions
- pack browser: CF search → pick version → install
- job drawer: live progress for everything running anywhere
- offline shell cached; data requires tailnet reachability
- web push is out of scope without a control plane — notifications only while a tab is open.
  Revisit if it turns out to matter.

## 12. Build

```make
web:            cd web && bun install && bun run build
embed: web      # web/dist is go:embed'd by internal/api
build: embed
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o dist/conduitd-linux-amd64 ./cmd/conduitd
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o dist/conduitd-linux-arm64 ./cmd/conduitd
```

Pure-Go SQLite (`modernc.org/sqlite`), so `CGO_ENABLED=0` cross-compile from the Mac is a
single command. Ship one binary with the PWA inside it.
Install: drop binary, `conduitd auth --authkey tskey-...`, systemd unit, done.

## 13. Deliberately deferred

- Docker process backend (want it; pm2 first for speed)
- control plane, web push, cross-machine artifact sharing
- Modrinth pack source
- multi-user / RBAC
- scheduled restarts (easy to add per-agent once the job engine exists)
