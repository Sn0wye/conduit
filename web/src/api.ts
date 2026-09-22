// The PWA is served by the agent it talks to, so every call is same origin and
// there is no machine list. A second machine is a second URL with its own
// installed copy of this app.

export type Instance = {
  name: string;
  dir: string;
  script: string;
  port: number;
  rcon_ready: boolean;
  backup_cmd: string;
  version: string;
  status: string;
  pid: number;
  memory_mb: number;
  cpu_pct: number;
  uptime_ms: number;
  restarts: number;
  known_to_pm2: boolean;
};

export type Info = {
  node: string;
  hostname: string;
  arch: string;
  pm2: string;
  pm2_error?: string;
  user: string;
};

export type Disk = {
  instance_bytes: number;
  world_bytes: number;
  backup_bytes: number;
  free_bytes: number;
  total_bytes: number;
  measured_at: string;
};

export type Stats = {
  name: string;
  status: string;
  pid?: number;
  cpu_pct?: number;
  memory_mb?: number;
  uptime_ms?: number;
  restarts?: number;
  disk?: Disk;
  // -1 when the server reworded its reply to "list" and the count could not
  // be read. Names are whatever it listed, which may be empty.
  players_online?: number;
  players_max?: number;
  players?: string[];
  // true while a console connection is open. Players are only readable then.
  rcon_open?: boolean;
};

export type Backup = {
  file: string;
  size: number;
  created: string;
  sha1?: string;
  world?: string;
  preview?: string;
  from_manifest: boolean;
  // The pack version the server was running when this was taken. Restoring a
  // world into different mods than it grew up in is the mistake this prevents.
  version?: string;
};

// Layout is what the agent found inside a pack zip. It is shown before the
// upgrade runs, because "0 mods" on screen is cheaper than a failed boot.
export type Layout = {
  root: string;
  label: string;
  mods: number;
  files: number;
  has_run_sh: boolean;
  has_server_jar: boolean;
  unpacked_bytes: number;
};

export type Artifact = {
  sha256: string;
  name: string;
  size: number;
  added: string;
  layout: Layout;
};

// A version is one state of the server files. snapshot_bytes of 0 means the
// archive was pruned and the version can no longer be returned to.
export type Version = {
  id: number;
  instance: string;
  label: string;
  source: "baseline" | "upload" | "revert";
  artifact?: string;
  artifact_name?: string;
  snapshot_bytes: number;
  world_backup?: string;
  applied_at: string;
  state: "active" | "superseded" | "rolled_back" | "failed";
  revert_of?: number;
  note?: string;
};

export type Step = {
  name: string;
  state: "pending" | "running" | "done" | "skipped" | "failed";
  detail?: string;
  ended?: string;
};

// An upgrade outlives the request that asked for it, so the page polls this
// instead of waiting on a response for ten minutes.
export type Run = {
  instance: string;
  kind: "upgrade" | "revert";
  label: string;
  steps: Step[];
  started: string;
  ended?: string;
  done: boolean;
  error?: string;
  version_id?: number;
};

export type VersionList = {
  versions: Version[];
  active?: Version;
  run: Run | null;
};

// A rollback is a world Conduit moved aside before a restore replaced it.
// kind separates it from the zips the server's backup mod writes.
export type Rollback = {
  dir: string;
  kind: "pre_restore";
  created: string;
  size_bytes: number;
  replaced_by: string;
};

export type Settings = {
  pm2_bin: string;
  node_bin_dir: string;
  servers_root: string;
  has_curseforge_key: boolean;
  detected: Record<string, boolean>;
  owner: string;
};

// An empty string clears an override and hands the field back to detection, so
// omitted and empty mean different things here.
export type SettingsPatch = Partial<{
  pm2_bin: string;
  node_bin_dir: string;
  servers_root: string;
  curseforge_key: string;
  owner: string;
}>;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {
      /* the body was not JSON, show it raw */
    }
    throw new Error(msg || res.statusText);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  info: () => call<Info>("/v1/info"),
  instances: () => call<Instance[]>("/v1/instances"),
  scan: () => call<Instance[]>("/v1/instances/scan"),
  register: (body: Partial<Instance>) =>
    call<Instance>("/v1/instances", { method: "POST", body: JSON.stringify(body) }),
  start: (name: string) => call<unknown>(`/v1/instances/${name}/start`, { method: "POST" }),
  stop: (name: string) => call<unknown>(`/v1/instances/${name}/stop`, { method: "POST" }),
  restart: (name: string) => call<unknown>(`/v1/instances/${name}/restart`, { method: "POST" }),
  stats: (name: string) => call<Stats>(`/v1/instances/${name}/stats`),
  console: (name: string, command: string) =>
    call<{ command: string; reply: string }>(`/v1/instances/${name}/console`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }),
  // The console connection is opened when the console tab mounts and closed
  // when it goes away. Nothing else opens one, so a server nobody is watching
  // has no RCON connection at all.
  openConsole: (name: string) =>
    call<{ connected: boolean }>(`/v1/instances/${name}/console/open`, { method: "POST" }),
  closeConsole: (name: string) =>
    call<void>(`/v1/instances/${name}/console/close`, { method: "POST" }),
  enableRcon: (name: string) =>
    call<{ restart_required: boolean; connected: boolean; already_enabled: boolean }>(
      `/v1/instances/${name}/rcon`,
      { method: "POST" },
    ),
  backups: (name: string) => call<Backup[]>(`/v1/instances/${name}/backups`),
  createBackup: (name: string) =>
    call<{ reply: string }>(`/v1/instances/${name}/backups`, { method: "POST" }),
  restoreBackup: (name: string, file: string) =>
    call<{ previous_world: string; restarted: boolean }>(
      `/v1/instances/${name}/backups/${encodeURIComponent(file)}/restore`,
      { method: "POST" },
    ),
  deleteBackup: (name: string, file: string) =>
    call<void>(`/v1/instances/${name}/backups/${encodeURIComponent(file)}`, { method: "DELETE" }),
  rollbacks: (name: string) => call<Rollback[]>(`/v1/instances/${name}/rollbacks`),
  undoRollback: (name: string, dir: string) =>
    call<{ previous_world: string; restarted: boolean }>(
      `/v1/instances/${name}/rollbacks/${encodeURIComponent(dir)}/undo`,
      { method: "POST" },
    ),
  deleteRollback: (name: string, dir: string) =>
    call<void>(`/v1/instances/${name}/rollbacks/${encodeURIComponent(dir)}`, { method: "DELETE" }),
  artifacts: () => call<Artifact[]>("/v1/artifacts"),
  // The zip is streamed straight through, so a two gigabyte pack is never held
  // in memory on either side. fetch sets its own multipart boundary, which is
  // why the Content-Type header from call() is not wanted here.
  uploadArtifact: async (file: File, onProgress?: (fraction: number) => void) => {
    const body = new FormData();
    body.append("file", file);
    return await new Promise<Artifact>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/v1/artifacts");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText) as Artifact);
          return;
        }
        let msg = xhr.responseText;
        try {
          msg = JSON.parse(xhr.responseText).error?.message ?? msg;
        } catch {
          /* the body was not JSON, show it raw */
        }
        reject(new Error(msg || xhr.statusText));
      };
      xhr.onerror = () => reject(new Error("the upload was cut off"));
      xhr.send(body);
    });
  },
  // The same pack already on the box: no second copy over the wire.
  addArtifactPath: (path: string) =>
    call<Artifact>("/v1/artifacts", { method: "POST", body: JSON.stringify({ path }) }),
  deleteArtifact: (sha: string) => call<void>(`/v1/artifacts/${sha}`, { method: "DELETE" }),
  versions: (name: string) => call<VersionList>(`/v1/instances/${name}/versions`),
  upgrade: (name: string, artifact: string, label: string) =>
    call<Run>(`/v1/instances/${name}/upgrade`, {
      method: "POST",
      body: JSON.stringify({ artifact, label }),
    }),
  upgradeStatus: (name: string) => call<Run | null>(`/v1/instances/${name}/upgrade/status`),
  revert: (name: string, id: number, restoreWorld: boolean) =>
    call<Run>(`/v1/instances/${name}/versions/${id}/revert`, {
      method: "POST",
      body: JSON.stringify({ restore_world: restoreWorld }),
    }),
  dropSnapshot: (name: string, id: number) =>
    call<void>(`/v1/instances/${name}/versions/${id}/snapshot`, { method: "DELETE" }),
  settings: () => call<Settings>("/v1/settings"),
  saveSettings: (body: SettingsPatch) =>
    call<Settings>("/v1/settings", { method: "PATCH", body: JSON.stringify(body) }),
  logs: async (name: string, tail = 300) => {
    const res = await fetch(`/v1/instances/${name}/logs?tail=${tail}`);
    if (!res.ok) throw new Error(await res.text());
    return res.text();
  },
};

export function bytes(n: number): string {
  if (!n) return "0";
  const u = ["B", "K", "M", "G", "T"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / Math.pow(1024, i);
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}

// since renders the gap a rollback would throw away, in the units a person
// thinks in. "4 hours of play" stops a wrong tap; a timestamp does not.
export function since(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "no time";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

export function uptime(ms: number): string {
  if (!ms) return "";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
