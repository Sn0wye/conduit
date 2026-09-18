# Conduit — Design

Minecraft server fleet manager. One Go binary per machine, embedded PWA, Tailscale-only,
pm2 process backend, CurseForge modpack install/update.

Single operator (me). Under 5 machines. No control plane. **Dead simple — no abstractions
until a second implementation actually exists.**

Stack: **Go** server-side. **Bun + Vite + React + TS + Tailwind** for the PWA. Nothing else.

---

## Reality on the target box (`snowye`, 100.83.147.40, Oracle ARM64)

- 9 instances under `~/mine_servers/<name>/`, flat dirs, world inside each
- every instance launches via `./run.sh` (NeoForge/Forge standard), JVM flags in
  `user_jvm_args.txt`, java path hardcoded inside `run.sh`
- `ecosystem.config.js` lists all 9 with `interpreter: /bin/sh`, `autorestart: true`
- JDK 11 / 17 / 21 installed; each pack pins its own java path in `run.sh`
- pm2 6.0.13 lives at `/home/ubuntu/n/bin/pm2`, installed through `n`. It is not on the
  default non-login PATH, so the agent reads its location from config
- all 9 share `server-port=25565` and `rcon.port=25575`, so exactly one runs at a time
- RCON is off everywhere and every `rcon.password` is blank. Left that way for now

Design follows this. Conduit does not restructure anything.

## Topology

```
browser (PWA)  ──HTTPS over tailnet──>  conduitd@snowye ──> pm2 ──> ./run.sh ──> java
                                   └──> conduitd@<next box>
```

Every agent is identical and independent. PWA is served by whichever agent you open, then
talks directly to the others. Machine list lives in PWA localStorage — typed in by hand.
No discovery, no registry, no shared state.

## Auth

Tailnet ACL is the boundary. Agent binds to the tsnet interface only, never `0.0.0.0`.
`tsnet.LocalClient().WhoIs()` per request, allowlist one login. No passwords, no sessions,
no login screen.

## HTTPS is mandatory

PWA install + service worker need a secure context, and `http://…ts.net` is not one.
Enable **MagicDNS** and **HTTPS Certificates** in the tailnet admin; agent uses
`tsnet.Server.ListenTLS("tcp", ":443")` and Tailscale handles cert issue and renewal.

## State

SQLite at `~/.conduit/conduit.db`, using `modernc.org/sqlite` so the build stays
`CGO_ENABLED=0` and cross-compiles from a Mac with one command.

Three tables. `instances` holds settings. `jobs` holds one row per long operation.
`job_logs` holds their output lines.

Settings are stored. Status is not. Whether a server is running comes from `pm2 jlist`
every time, and player count comes from RCON. Two sources of truth for the same fact is
how they drift apart.

## Instance model

```go
type Instance struct {
    Name    string // pm2 app name, also the key
    Dir     string // /home/ubuntu/mine_servers/atm-10-lite
    Port    int    // server-port
    RCON    struct{ Port int; Password string }
    Backups string // glob for existing backup files, optional
    Pack    struct{ ProjectID, FileID int; Version string } // CurseForge, optional
}
```

Only one instance runs at a time, because they all share port 25565. Conduit enforces
this rather than letting the port collision decide: starting B stops A first, in one job,
and the UI shows which instance is live as a single choice rather than nine toggles.

## Process control — pm2, no ecosystem file

```
start:  pm2 start ./run.sh --name <n> --cwd <dir> --interpreter /bin/sh \
                  --no-autorestart --time
stop:   pm2 stop (SIGINT, kill_timeout 120s)      [phase 1]
        RCON "stop" -> wait for exit -> pm2 stop    [phase 2, once RCON is on]
status: pm2 jlist   (pid, status, cpu, mem, uptime, restarts)
logs:   tail ~/.pm2/logs/<n>-out.log
```

The agent runs pm2 with `PATH=/home/ubuntu/n/bin:$PATH`. The pm2 shim is a node script,
so it fails with `env: node: No such file or directory` if node is missing from the
environment, even when pm2 itself is called by absolute path.

**`--no-autorestart` is required.** With autorestart on, an RCON `stop` looks like a crash
to pm2, which relaunches the server straight away. The current `ecosystem.config.js` has
`autorestart: true`, and the `co` app has accumulated 15,795 restarts. That is the failure
mode, already happening.

Conduit owns the restart policy instead. It watches `pm2 jlist`, relaunches on an
unexpected exit, backs off exponentially, and stops trying after 5 attempts.

## RCON comes later

Phase 1 ships without it. Everything works: list, start, stop, logs, install, update.

What is missing until RCON is on:

- stop sends SIGINT through pm2 instead of asking the server to shut down. Minecraft's
  shutdown handler saves the world on SIGINT and usually gets there, but a heavily
  modded server can be slow enough to hit `kill_timeout` mid-save
- no web console. pm2 cannot write to a running process's stdin, so RCON is the only
  way to send a command from outside
- no player list, so no "3 online" badge

Turning it on is three lines in `server.properties` plus a restart, exposed as a button
per instance rather than a migration. Access control is the tailnet, not the RCON
password, so the password is a fixed generated string stored in the DB and never shown.
It exists because the server disables RCON outright when the field is blank.

Port 25575 must stay closed in the Oracle security group.

## Modpack update

No symlink farm, no version directories. The instance dir stays exactly where it is.

```
1. stop instance (graceful)
2. tar.zst  mods/ config/ kubejs/ defaultconfigs/ scripts/ *.txt *.json  ->  <dir>/.conduit/rollback-<ts>.tar.zst
   (world, libraries, backups excluded — rollback archive stays in the hundreds of MB)
3. download + unzip new pack into a temp dir
4. rm mods/, overlay new mods/ config/ etc onto <dir>
5. preserve server.properties, ops.json, whitelist.json, user_jvm_args.txt
6. start; if it fails to reach RCON in 5 min, auto-rollback from the archive
```

Keep the last 2 rollback archives per instance.

## CurseForge

API key in agent config, server-side only. PWA calls the agent's `/v1/cf/*` proxy.

`api.curseforge.com`, `x-api-key` header:
- `GET /v1/mods/search?gameId=432&classId=4471` (4471 = modpacks)
- `GET /v1/mods/{modId}/files`
- `GET /v1/mods/{modId}/files/{fileId}/download-url`

Two install paths, chosen by `serverPackFileId` on the file object:

1. **set** — download that single self-contained server zip. Done. Prefer always.
2. **null** — download the client zip, read `manifest.json`, fetch each mod individually.
   Some return null/403 because the author disabled third-party distribution. Those are
   unobtainable by any tool. Fail the job with `cf_distribution_blocked` and the mod list;
   PWA shows CurseForge links plus a drop zone; user supplies the jars; job resumes.
   Never skip silently — a missing mod means no boot or a corrupted world.

Manual zip upload stays as a permanent alternative path for blocked or private packs.

Downloads cache at `~/.conduit/artifacts/<fileId>.zip`.

## Backups — read only

The servers already make their own. Conduit lists them from a configured glob, shows
size and date, streams downloads, restores (stop → move world aside → extract → start),
and deletes. It never creates one. The pre-update rollback archive above is a separate
thing and is not a world backup.

## API — `/v1`

```
GET    /v1/info
GET    /v1/instances                        list + live pm2 status
POST   /v1/instances                        register existing dir, or create from CF -> job
GET    /v1/instances/:name
PATCH  /v1/instances/:name                  port, rcon, memory, backup glob
DELETE /v1/instances/:name                  unregister (files untouched unless ?purge)

POST   /v1/instances/:name/start|stop|restart   -> job
POST   /v1/instances/:name/update           { fileId } -> job
POST   /v1/instances/:name/rollback         -> job

GET    /v1/instances/:name/logs?tail=200
WS     /v1/instances/:name/console          log stream down, RCON commands up

GET    /v1/instances/:name/properties       parsed server.properties
PUT    /v1/instances/:name/properties
GET    /v1/instances/:name/jvmargs          user_jvm_args.txt
PUT    /v1/instances/:name/jvmargs

GET    /v1/instances/:name/backups
GET    /v1/instances/:name/backups/:file    download
POST   /v1/instances/:name/backups/:file/restore -> job
DELETE /v1/instances/:name/backups/:file

GET    /v1/jobs            GET /v1/jobs/:id            WS /v1/jobs/:id/stream

GET    /v1/cf/search?q=&gameVersion=
GET    /v1/cf/packs/:projectId/files
POST   /v1/uploads                          manual pack zip
```

No generic file browser. Two editable files, both parsed and validated.

Errors: `{"error":{"code":"…","message":"…","details":{…}}}`.

## Layout

```
conduit/
  cmd/conduitd/main.go
  internal/
    api/          handlers, WS, whois middleware
    tsnetsrv/     tsnet + TLS
    state/        state.json load/save
    pm2/          jlist, start, stop, logs
    rcon/
    curseforge/   client + pack resolution
    update/       update + rollback
    backups/
    jobs/         in-memory queue, one worker per instance
  web/            bun + vite + react + ts + tailwind, vite-plugin-pwa
  Makefile
```

No `ProcessBackend` interface until Docker is actually being written. One pm2 package,
concrete functions.

## Build

```make
build:
	cd web && bun install && bun run build
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o dist/conduitd ./cmd/conduitd
```

Target is `linux/arm64` (Oracle Ampere). PWA embedded via `go:embed web/dist`.
Deploy: scp the binary, `conduitd --authkey tskey-…`, systemd unit.

## Frontend

Bun as package manager and runner. Tailwind v4 via `@tailwindcss/vite`, theme in CSS,
no `tailwind.config.js`. TanStack Query for REST, raw WebSocket for console and jobs.
No component library. Console needs `@tanstack/react-virtual` — modpack servers emit
thousands of log lines.

Screens: machine switcher → instance list → instance detail (console, properties,
backups, update). Four screens total.

## Deferred

Docker backend, control plane, web push, Modrinth, scheduled restarts, multi-user.
