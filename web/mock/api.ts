// A fake conduitd for working on the UI without a server, pm2 or Minecraft.
// It keeps state in memory and behaves like the real one closely enough to
// click through every screen: starting takes a few seconds and stops whatever
// else is running, backups appear after a delay, an upgrade walks its steps.
//
//   bun run dev:mock                     everything works
//   MOCK=empty bun run dev:mock          a fresh machine with no servers
//   MOCK=broken bun run dev:mock         pm2 unreachable, a crashed server
//
// Plain Node APIs only: Vite runs this inside its own dev server.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type Status = "online" | "stopped" | "errored" | "launching" | "stopping" | "not_started" | "unknown";

type Inst = {
  name: string;
  dir: string;
  script: string;
  port: number;
  rcon_ready: boolean;
  backup_cmd: string;
  version: string;
  status: Status;
  pid: number;
  memory_mb: number;
  cpu_pct: number;
  uptime_ms: number;
  restarts: number;
  known_to_pm2: boolean;
  startedAt: number;
  log: string[];
  backups: Backup[];
  rollbacks: Rollback[];
  versions: Version[];
  run: Run | null;
  world: number;
};
type Backup = { file: string; size: number; created: string; from_manifest: boolean; version?: string; preview?: string };
type Rollback = { dir: string; kind: "pre_restore"; created: string; size_bytes: number; replaced_by: string };
type Version = {
  id: number;
  instance: string;
  label: string;
  source: "baseline" | "upload" | "revert";
  snapshot_bytes: number;
  world_backup?: string;
  applied_at: string;
  state: "active" | "superseded" | "rolled_back" | "failed";
  note?: string;
};
type Step = { name: string; state: "pending" | "running" | "done" | "skipped" | "failed"; detail?: string };
type Run = { instance: string; kind: "upgrade" | "revert"; label: string; steps: Step[]; started: string; ended?: string; done: boolean; error?: string };

const scenario = process.env.MOCK ?? "live";
const GB = 1024 ** 3;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const H = 3600_000;
const D = 24 * H;
const players = ["Steve", "Alex", "gabriel", "Notch_fan_99"];
const clock = () => new Date().toTimeString().slice(0, 8);

// A tiny map thumbnail, so backup rows have something to show.
function thumb(seed: number): string {
  const c = ["#4a7a2c", "#6b9b3a", "#3b5f8a", "#c9b36b", "#7a7a7a"];
  let cells = "";
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c[(x * 7 + y * 13 + seed * 5 + ((x * y) % 3)) % c.length]}"/>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges">${cells}</svg>`)}`;
}

function bootLog(name: string): string[] {
  return [
    `[${clock()}] [main/INFO] [net.neoforged.fml.loading.FMLLoader/]: Loading NeoForge 21.1.77`,
    `[${clock()}] [main/INFO] [mixin/]: Mixin subsystem initialised`,
    `[${clock()}] [main/WARN] [net.minecraft.server.dedicated.DedicatedServer/]: Ambiguity between arguments [teleport, location] and [teleport, destination]`,
    `[${clock()}] [Server thread/INFO] [minecraft/DedicatedServer]: Starting minecraft server version 1.21.1`,
    `[${clock()}] [Server thread/INFO] [minecraft/DedicatedServer]: Preparing level "world"`,
    `[${clock()}] [Server thread/INFO] [${name}/]: Loaded 412 mods`,
  ];
}

function make(name: string, version: string, status: Status, extra: Partial<Inst> = {}): Inst {
  const seed = name.length;
  return {
    name,
    dir: `/home/ubuntu/mine_servers/${name}`,
    script: "./run.sh",
    port: 25565,
    rcon_ready: true,
    backup_cmd: "backup start",
    version,
    status,
    pid: status === "online" ? 41_000 + seed : 0,
    memory_mb: 0,
    cpu_pct: 0,
    uptime_ms: 0,
    restarts: 0,
    known_to_pm2: status !== "not_started",
    startedAt: status === "online" ? Date.now() - 3.2 * H : 0,
    log: status === "online" ? [...bootLog(name), `[${clock()}] [Server thread/INFO] [minecraft/DedicatedServer]: Done (33.481s)! For help, type "help"`] : [`[${clock()}] [Server thread/INFO] [minecraft/MinecraftServer]: Stopping server`],
    backups: [0.7, 6.6, 26, 50, 74].map((h, i) => ({
      file: `${name}-${i}.zip`,
      size: (3.1 - i * 0.1) * GB,
      created: ago(h * H),
      from_manifest: true,
      version: i < 3 ? version : "older",
      preview: thumb(seed + i),
    })),
    rollbacks: [],
    versions: [
      { id: 3, instance: name, label: version, source: "upload", snapshot_bytes: 0, world_backup: "x", applied_at: ago(2 * D), state: "active" },
      { id: 2, instance: name, label: version.replace(/(\d+)\.(\d+)$/, (_, a, b) => (+b > 0 ? `${a}.${+b - 1}` : `${Math.max(0, +a - 1)}.9`)), source: "upload", snapshot_bytes: 812e6, world_backup: "x", applied_at: ago(12 * D), state: "superseded" },
      { id: 1, instance: name, label: "baseline", source: "baseline", snapshot_bytes: 790e6, applied_at: ago(30 * D), state: "superseded" },
    ],
    run: null,
    world: 14.2 * GB,
    ...extra,
  };
}

const instances: Inst[] =
  scenario === "empty"
    ? []
    : [
        make("atm-10-lite", "ATM10 Lite 1.3.0", scenario === "broken" ? "errored" : "online"),
        make("co", "Craftoria 1.12", scenario === "broken" ? "unknown" : "stopped", { rcon_ready: false }),
        make("atm9-sky", "ATM9 To the Sky 1.1.5", "stopped"),
        make("create-arcane", "Create: Arcane Engineering 1.9", "not_started", { rcon_ready: false }),
        make("vault-hunters", "Vault Hunters 3rd Edition 3.18", "stopped", { backups: [] }),
      ];
let scan = scenario === "empty" ? [] : [{ name: "gtnh-2.7", dir: "/home/ubuntu/mine_servers/gtnh-2.7", script: "./run.sh", port: 25565 }];
const settings = {
  pm2_bin: scenario === "empty" ? "" : "/home/ubuntu/n/bin/pm2",
  node_bin_dir: scenario === "empty" ? "" : "/home/ubuntu/n/bin",
  servers_root: "/home/ubuntu/mine_servers",
  has_curseforge_key: scenario !== "empty",
  detected: { pm2_bin: scenario !== "empty", node_bin_dir: scenario !== "empty", servers_root: true } as Record<string, boolean>,
  owner: "gabriel@github",
};
const artifacts: unknown[] = [];
const consoleOpen = new Set<string>();

// The world ticks: live servers use CPU, write log lines and gain uptime.
// Started from the dev server only, so `vite build` never waits on it.
const tickWorld = () => setInterval(() => {
  for (const i of instances) {
    if (i.status !== "online") continue;
    i.uptime_ms = Date.now() - i.startedAt;
    i.cpu_pct = 25 + Math.random() * 40;
    i.memory_mb = 8800 + Math.random() * 1200;
    const r = Math.random();
    i.log.push(
      r < 0.08
        ? `[${clock()}] [Server thread/WARN] [minecraft/MinecraftServer]: Can't keep up! Is the server overloaded? Running 2140ms or 42 ticks behind`
        : r < 0.12
          ? `[${clock()}] [Server thread/ERROR] [mekanism/]: Failed to load chunk data for (12, -4)`
          : r < 0.2
            ? `[${clock()}] [Server thread/INFO] [minecraft/MinecraftServer]: ${players[Math.floor(Math.random() * players.length)]} joined the game`
            : `[${clock()}] [Server thread/INFO] [ftbchunks/]: Saved claimed chunks`,
    );
    if (i.log.length > 400) i.log.splice(0, i.log.length - 400);
  }
}, 2500);

const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

function boot(i: Inst) {
  i.status = "launching";
  i.log.push(...bootLog(i.name));
  later(4000, () => {
    i.status = "online";
    i.startedAt = Date.now();
    i.uptime_ms = 0;
    i.pid = 40_000 + Math.floor(Math.random() * 999);
    i.log.push(`[${clock()}] [Server thread/INFO] [minecraft/DedicatedServer]: Done (31.204s)! For help, type "help"`);
  });
}

function halt(i: Inst, then?: () => void) {
  i.status = "stopping";
  i.log.push(`[${clock()}] [Server thread/INFO] [minecraft/MinecraftServer]: Stopping server`);
  later(2500, () => {
    i.status = "stopped";
    i.pid = 0;
    i.cpu_pct = 0;
    i.memory_mb = 0;
    i.uptime_ms = 0;
    consoleOpen.delete(i.name);
    then?.();
  });
}

function walk(i: Inst, run: Run, onDone: () => void) {
  i.run = run;
  let k = 0;
  const tick = () => {
    if (k > 0) run.steps[k - 1].state = "done";
    if (k === run.steps.length) {
      run.done = true;
      run.ended = new Date().toISOString();
      onDone();
      return;
    }
    run.steps[k].state = "running";
    k++;
    later(1800, tick);
  };
  tick();
}

const view = ({ log, backups, rollbacks, versions, run, startedAt, world, ...rest }: Inst) => rest;

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { raw };
  }
}

function handle(method: string, path: string, q: URLSearchParams, b: any): [number, unknown] | string {
  if (path === "/v1/info")
    return [200, { node: "conduit-snowye", hostname: "snowye", os: "linux", arch: "arm64", pm2: scenario === "broken" ? "" : "6.0.13", user: "gabriel@github", version: "v0.1.0-mock", ...(scenario === "broken" ? { pm2_error: "env: node: No such file or directory" } : {}) }];
  if (path === "/v1/instances" && method === "GET") return [200, instances.map(view)];
  if (path === "/v1/instances/scan") return [200, scan];
  if (path === "/v1/instances" && method === "POST") {
    if (instances.some((i) => i.name === b.name)) return [409, { error: { code: "exists", message: `${b.name} is already registered` } }];
    instances.push(make(b.name, "", "not_started", { dir: b.dir, backups: [] }));
    scan = scan.filter((s) => s.name !== b.name);
    return [200, b];
  }
  if (path === "/v1/settings" && method === "GET") return [200, settings];
  if (path === "/v1/settings" && method === "PATCH") {
    for (const [k, v] of Object.entries(b as Record<string, string>)) {
      if (k === "curseforge_key") settings.has_curseforge_key = v !== "";
      else if (k in settings) {
        (settings as any)[k] = v;
        settings.detected[k] = v === "";
      }
    }
    return [200, settings];
  }
  if (path === "/v1/artifacts" && method === "GET") return [200, artifacts];
  if (path === "/v1/artifacts" && method === "POST") {
    const name = (b.path ?? "uploaded-pack.zip").split("/").pop();
    const a = { sha256: Math.random().toString(16).slice(2).padEnd(64, "0"), name, size: 1.2 * GB, added: new Date().toISOString(), layout: { root: "", label: name.replace(/\.zip$/, ""), mods: 418, files: 9120, has_run_sh: true, has_server_jar: true, unpacked_bytes: 1.9 * GB } };
    artifacts.push(a);
    return [200, a];
  }

  const m = path.match(/^\/v1\/instances\/([^/]+)(?:\/(.*))?$/);
  if (!m) return [404, { error: { code: "not_found", message: path } }];
  const i = instances.find((x) => x.name === decodeURIComponent(m[1]));
  if (!i) return [404, { error: { code: "not_found", message: `no instance ${m[1]}` } }];
  const sub = m[2] ?? "";

  switch (`${method} ${sub.replace(/backups\/[^/]+/, "backups/:f").replace(/rollbacks\/[^/]+/, "rollbacks/:d").replace(/versions\/\d+/, "versions/:id")}`) {
    case "GET ":
      return [200, view(i)];
    case "POST start": {
      const other = instances.find((x) => x.status === "online" && x !== i);
      if (other) halt(other, () => boot(i));
      else boot(i);
      return [200, { name: i.name, started: true, stopped_first: other?.name ?? "" }];
    }
    case "POST stop":
      halt(i);
      return [200, {}];
    case "POST restart":
      halt(i, () => boot(i));
      return [200, {}];
    case "GET logs":
      return i.log.slice(-Number(q.get("tail") ?? 300)).join("\n");
    case "GET stats": {
      const n = consoleOpen.has(i.name) ? 2 : -1;
      return [200, { name: i.name, status: i.status, pid: i.pid, cpu_pct: i.cpu_pct, memory_mb: i.memory_mb, uptime_ms: i.uptime_ms, rcon_open: consoleOpen.has(i.name), players_online: n, players_max: 20, players: n > 0 ? players.slice(0, n) : [], disk: { instance_bytes: 0, world_bytes: i.world, backup_bytes: i.backups.reduce((s, x) => s + x.size, 0), free_bytes: 88 * GB, total_bytes: 200 * GB, measured_at: new Date().toISOString() } }];
    }
    case "POST console/open":
      consoleOpen.add(i.name);
      return [200, { connected: true }];
    case "POST console/close":
      consoleOpen.delete(i.name);
      return [204, null];
    case "POST console": {
      const c = String(b.command ?? "");
      const reply = c === "list" ? `There are 2 of a max of 20 players online: ${players.slice(0, 2).join(", ")}` : c.startsWith("say ") ? "" : c.startsWith("op ") ? `Made ${c.slice(3)} a server operator` : `Unknown or incomplete command, see below for error`;
      i.log.push(`[${clock()}] [RCON Listener #1/INFO] [minecraft/RconClient]: Rcon issued server command: /${c}`);
      return [200, { command: c, reply }];
    }
    case "POST rcon":
      i.rcon_ready = true;
      return [200, { restart_required: true, connected: false, already_enabled: false }];
    case "GET backups":
      return [200, i.backups];
    case "POST backups":
      later(6000, () => {
        i.backups.unshift({ file: `${i.name}-${Date.now()}.zip`, size: 3.2 * GB, created: new Date().toISOString(), from_manifest: true, version: i.version, preview: thumb(Date.now() % 50) });
        if (i.backups.length > 5) i.backups.pop();
        i.log.push(`[${clock()}] [Backup Thread/INFO] [ftbbackups2/]: Backup done in 6s`);
      });
      return [200, { reply: "Backup started" }];
    case "DELETE backups/:f":
      i.backups = i.backups.filter((x) => x.file !== decodeURIComponent(sub.split("/")[1]));
      return [204, null];
    case "POST backups/:f/restore": {
      const dir = `world-before-restore-${Date.now()}`;
      i.rollbacks.unshift({ dir, kind: "pre_restore", created: new Date().toISOString(), size_bytes: i.world, replaced_by: decodeURIComponent(sub.split("/")[1]) });
      return [200, { previous_world: dir, restarted: i.status === "online" }];
    }
    case "GET rollbacks":
      return [200, i.rollbacks];
    case "POST rollbacks/:d/undo":
      return [200, { previous_world: `world-before-undo-${Date.now()}`, restarted: i.status === "online" }];
    case "DELETE rollbacks/:d":
      i.rollbacks = i.rollbacks.filter((x) => x.dir !== decodeURIComponent(sub.split("/")[1]));
      return [204, null];
    case "GET versions":
      return [200, { versions: [...i.versions].reverse().sort((a, b) => b.id - a.id), active: i.versions.find((v) => v.state === "active"), run: i.run }];
    case "GET upgrade/status":
      return [200, i.run];
    case "POST upgrade": {
      const names = ["stop the server", "back up the world", "archive the current files", "put the new pack in place", "start and wait for Done"];
      const run: Run = { instance: i.name, kind: "upgrade", label: b.label, started: new Date().toISOString(), done: false, steps: names.map((name) => ({ name, state: "pending" })) };
      walk(i, run, () => {
        for (const v of i.versions) if (v.state === "active") Object.assign(v, { state: "superseded", snapshot_bytes: 830e6 });
        i.versions.push({ id: i.versions.length + 1, instance: i.name, label: b.label, source: "upload", snapshot_bytes: 0, world_backup: "x", applied_at: new Date().toISOString(), state: "active" });
        i.version = b.label;
      });
      return [202, run];
    }
    case "POST versions/:id/revert": {
      const target = i.versions.find((v) => v.id === Number(sub.split("/")[1]))!;
      const names = ["stop the server", "back up the world", "archive the current files", `restore ${target.label}`, b.restore_world ? "restore the world" : "keep the world", "start and wait for Done"];
      const run: Run = { instance: i.name, kind: "revert", label: target.label, started: new Date().toISOString(), done: false, steps: names.map((name) => ({ name, state: "pending" })) };
      walk(i, run, () => {
        for (const v of i.versions) if (v.state === "active") v.state = "superseded";
        i.versions.push({ ...target, id: i.versions.length + 1, source: "revert", applied_at: new Date().toISOString(), state: "active" });
        i.version = target.label;
      });
      return [202, run];
    }
    case "DELETE versions/:id/snapshot": {
      const v = i.versions.find((x) => x.id === Number(sub.split("/")[1]));
      if (v) v.snapshot_bytes = 0;
      return [204, null];
    }
  }
  return [404, { error: { code: "not_found", message: `${method} ${path}` } }];
}

export function mockApi(): Plugin {
  return {
    name: "conduit-mock-api",
    configureServer(server) {
      tickWorld();
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (!url.pathname.startsWith("/v1/")) return next();
        // Multipart uploads are not parsed; they just count as a pack.
        const b = (req.headers["content-type"] ?? "").includes("multipart") ? {} : await body(req);
        await new Promise((r) => setTimeout(r, 120 + Math.random() * 200)); // feel like a network
        const out = handle(req.method ?? "GET", url.pathname, url.searchParams, b);
        if (typeof out === "string") {
          res.setHeader("Content-Type", "text/plain");
          res.end(out);
          return;
        }
        const [status, data] = out;
        res.statusCode = status;
        if (data === null) return res.end();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      });
    },
  };
}
