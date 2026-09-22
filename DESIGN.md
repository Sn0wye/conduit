# Conduit — Design

Minecraft server manager for one machine. One Go binary, embedded PWA, Tailscale-only,
pm2 process backend, CurseForge modpack install/update.

Single operator (me). No control plane, no fleet, no machine list. A second machine is a
second copy of the binary at its own URL. **Dead simple, no abstractions until a second
implementation actually exists.**

Stack: **Go** server-side. **Bun + Vite + React + TS + Tailwind** for the PWA. Nothing else.

---

## Reality on the target box (`snowye`, 100.83.147.40, Oracle ARM64)

- 9 instances under `~/mine_servers/<name>/`, flat dirs, world inside each
- every instance launches via `./run.sh` (NeoForge/Forge standard), JVM flags in
  `user_jvm_args.txt`, java path hardcoded inside `run.sh`
- `ecosystem.config.js` lists all 9 with `interpreter: /bin/sh`, `autorestart: true`
- JDK 11 / 17 / 21 installed; each pack pins its own java path in `run.sh`
- pm2 6.0.13 lives at `/home/ubuntu/n/bin/pm2`, installed through `n`. It is not on the
  default non-login PATH, so the agent finds it by asking a login shell
- all 9 share `server-port=25565` and `rcon.port=25575`, so exactly one runs at a time
- RCON is off everywhere and every `rcon.password` is blank. Left that way for now

Design follows this. Conduit does not restructure anything.

## Topology

```
browser (PWA)  ──HTTPS over tailnet──>  conduitd@snowye ──> pm2 ──> ./run.sh ──> java
```

The agent joins the tailnet as `conduit-<hostname>` and serves the PWA and the API on
that one origin. The browser never talks to a second agent, so there is no machine
switcher, no peer discovery and no CORS. Another box runs its own copy at its own
hostname, and you install that one as a separate PWA.

Cost of dropping the switcher: the CurseForge key is pasted once per machine, and a pack
is downloaded once per machine. With one VPS neither is worth a control plane.

## Auth

Tailnet ACL is the boundary. Agent binds to the tsnet interface only, never `0.0.0.0`.
`tsnet.LocalClient().WhoIs()` per request. On top of that, trust on first use: the first
login to call the machine is written to `settings.owner` and everyone else gets 403.
`conduitd --claim you@example.com` resets it. No passwords, no sessions, no login screen.

## No config file

Nothing is configured on the machine. Paths are detected at startup and the settings
screen overrides them into SQLite when a guess is wrong.

- **pm2**: `bash -lc 'command -v pm2'` first, which is the only way to see what `n`, nvm,
  fnm or volta put on the login PATH. Then known install globs, then plain `PATH`.
- **node bin dir**: the directory holding pm2.
- **servers root**: first of `~/mine_servers`, `~/servers`, `~/minecraft` that exists.
- **node name**: `conduit-<hostname>`.
- **CurseForge key**: pasted into the settings screen, stored server-side, never sent
  back to the browser.

Clearing an override in the UI hands the field back to detection.

`~/.conduit/` holds `conduit.db`, the tsnet node key, job logs and downloaded packs.
First run with no `--authkey` prints a login URL once; the node key persists after that.

## HTTPS is mandatory

PWA install + service worker need a secure context, and `http://…ts.net` is not one.
Enable **MagicDNS** and **HTTPS Certificates** in the tailnet admin; agent uses
`tsnet.Server.ListenTLS("tcp", ":443")` and Tailscale handles cert issue and renewal.

## State

SQLite at `~/.conduit/conduit.db`, using `modernc.org/sqlite` so the build stays
`CGO_ENABLED=0` and cross-compiles from a Mac with one command.

Four tables. `instances` holds per-server settings. `settings` is a key/value table that
replaces the config file. `jobs` holds one row per long operation, `job_logs` their output.

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

## Upgrades and versions

No symlink farm, no version directories. The instance dir stays exactly where it is.

The unit is the **version-owned set**: everything in the instance directory except
`world*`, `backups/`, `logs/`, `crash-reports/` and `.conduit/`. Worlds are tens of
gigabytes and must survive an upgrade; mods, configs, libraries and `run.sh` are hundreds
of megabytes and are exactly what an upgrade replaces. Archiving only the second kind is
what makes going back cheap and exact.

A pack arrives either as a browser upload or as a path to a zip already on the box, and
is cached at `~/.conduit/artifacts/<sha256>.zip` with a probe beside it. The zip is
probed before anything is stopped: no `mods/`, no `run.sh` and no server jar means it is
not a server pack and the instance is never touched. CurseForge client zips are read
through `manifest.json` and `overrides/`.

```
1. stop the instance
2. cold zip of the world -> backups/conduit-<ts>-<version>.zip, recorded on the version
   being left  (cold because the server is down; the mod's own command is for a running
   server and is what the backups tab uses)
3. zip the version-owned set -> ~/.conduit/versions/<instance>/v<id>.zip
4. rm mods/, overlay the pack; server.properties, ops.json, whitelist.json, banned-*.json,
   usercache.json, eula.txt and user_jvm_args.txt are preserved
   run.sh is NOT preserved: the pack pins the java path, and the archive holds the old one
5. record the new version, start, wait up to 15 min for the Done line in latest.log
6. if it exits or never finishes booting, the archive goes straight back and the server
   is started again on the old version
```

The versions table is append only, so going back adds a row rather than rewriting
history. A revert shares the archive of the row it came from; the file is deleted only
when no row points at it. The newest three archives per instance are kept.

Backups are tagged with the version that was running when they were taken, by the
recorded name first and the clock second. Restoring a world into different mods than it
grew up in is the failure that tag exists to prevent, and going back offers the matching
world restore in the same confirmation.

## CurseForge

API key in the `settings` table, server-side only. PWA calls the agent's `/v1/cf/*` proxy.

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
POST   /v1/artifacts                        pack zip: upload or { path } on the box
GET    /v1/artifacts                        DELETE /v1/artifacts/:sha
GET    /v1/instances/:name/versions         history, active version, run in flight
POST   /v1/instances/:name/upgrade          { artifact, label } -> 202 run
GET    /v1/instances/:name/upgrade/status   the run, polled while it works
POST   /v1/instances/:name/versions/:id/revert  { restore_world } -> 202 run
DELETE /v1/instances/:name/versions/:id/snapshot  free the archive

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
    settings/     path detection + stored overrides
    store/        sqlite: instances and settings
    pm2/          jlist, start, stop, logs
    rcon/
    curseforge/   client + pack resolution
    upgrade/      artifact cache, pack probe, snapshot, apply, restore
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
Deploy: scp the binary, run it, click the login URL once, systemd unit.

## Frontend

Bun as package manager and runner. Tailwind v4 via `@tailwindcss/vite`, theme in CSS,
no `tailwind.config.js`. TanStack Query for REST, raw WebSocket for console and jobs.
No component library. Console needs `@tanstack/react-virtual` — modpack servers emit
thousands of log lines.

Screens: instance list → instance detail (logs, console, backups, upgrades), plus
settings. Three screens total. Every call is same origin.

## Deferred

Docker backend, control plane, peer discovery, web push, Modrinth, scheduled restarts,
multi-user.
