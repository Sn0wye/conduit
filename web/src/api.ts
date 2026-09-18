// Every machine runs the same agent, so the browser talks to each one directly.
// The machine list is typed in by hand and kept in localStorage: under five
// boxes does not justify discovery.

export type Machine = { name: string; url: string };

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

const KEY = "conduit.machines";

export function loadMachines(): Machine[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveMachines(m: Machine[]) {
  localStorage.setItem(KEY, JSON.stringify(m));
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base.replace(/\/$/, "") + path, {
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
  info: (base: string) => call<Info>(base, "/v1/info"),
  instances: (base: string) => call<Instance[]>(base, "/v1/instances"),
  scan: (base: string) => call<Instance[]>(base, "/v1/instances/scan"),
  register: (base: string, body: Partial<Instance>) =>
    call<Instance>(base, "/v1/instances", { method: "POST", body: JSON.stringify(body) }),
  start: (base: string, name: string) =>
    call<unknown>(base, `/v1/instances/${name}/start`, { method: "POST" }),
  stop: (base: string, name: string) =>
    call<unknown>(base, `/v1/instances/${name}/stop`, { method: "POST" }),
  restart: (base: string, name: string) =>
    call<unknown>(base, `/v1/instances/${name}/restart`, { method: "POST" }),
  logs: async (base: string, name: string, tail = 300) => {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/instances/${name}/logs?tail=${tail}`);
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
