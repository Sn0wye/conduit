// The PWA is served by the agent it talks to, so every call is same origin and
// there is no machine list. A second machine is a second URL with its own
// installed copy of this app.

export type Instance = {
  name: string;
  dir: string;
  script: string;
  port: number;
  rcon_ready: boolean;
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
  settings: () => call<Settings>("/v1/settings"),
  saveSettings: (body: SettingsPatch) =>
    call<Settings>("/v1/settings", { method: "PATCH", body: JSON.stringify(body) }),
  logs: async (name: string, tail = 300) => {
    const res = await fetch(`/v1/instances/${name}/logs?tail=${tail}`);
    if (!res.ok) throw new Error(await res.text());
    return res.text();
  },
};

export function uptime(ms: number): string {
  if (!ms) return "";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
