import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bytes, uptime, type Backup, type Instance, type SettingsPatch } from "./api";

type Screen = { view: "list" } | { view: "detail"; name: string } | { view: "settings" };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ view: "list" });
  const info = useQuery({ queryKey: ["info"], queryFn: api.info });

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-4 py-3">
        <button onClick={() => setScreen({ view: "list" })} className="text-sm">
          {info.data?.hostname ?? "conduit"}
        </button>
        <span className="flex-1" />
        {info.data?.pm2_error && <span className="text-xs text-bad">pm2 unusable</span>}
        <button
          onClick={() => setScreen({ view: "settings" })}
          className="text-xs text-mute hover:text-ink"
        >
          settings
        </button>
      </header>

      {screen.view === "settings" && <SettingsScreen onBack={() => setScreen({ view: "list" })} />}
      {screen.view === "detail" && (
        <Detail name={screen.name} onBack={() => setScreen({ view: "list" })} />
      )}
      {screen.view === "list" && (
        <InstanceList onOpen={(name) => setScreen({ view: "detail", name })} />
      )}
    </div>
  );
}

function dot(status: string) {
  if (status === "online") return "bg-live";
  if (status === "errored") return "bg-bad";
  // unknown means pm2 could not be reached, which is a problem. not_started
  // just means this instance has never been launched through Conduit.
  if (status === "unknown") return "bg-warn";
  return "bg-dead";
}

function InstanceList({ onOpen }: { onOpen: (n: string) => void }) {
  const qc = useQueryClient();
  const instances = useQuery({ queryKey: ["instances"], queryFn: api.instances });
  const scan = useQuery({ queryKey: ["scan"], queryFn: api.scan, refetchInterval: false });
  const adopt = useMutation({
    mutationFn: (i: Partial<Instance>) => api.register(i),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instances"] });
      qc.invalidateQueries({ queryKey: ["scan"] });
    },
  });

  // One server runs at a time because they all share port 25565, so the list is
  // a single choice rather than a row of independent toggles.
  const live = useMemo(
    () => instances.data?.find((i) => i.status === "online")?.name ?? null,
    [instances.data],
  );

  if (instances.error) return <Problem error={instances.error} />;

  return (
    <main className="flex-1 overflow-y-auto p-4">
      <p className="mb-3 text-xs text-mute">{live ? `${live} is live` : "nothing running"}</p>
      <ul className="space-y-1">
        {instances.data?.map((i) => (
          <li key={i.name}>
            <button
              onClick={() => onOpen(i.name)}
              className="flex w-full items-center gap-3 rounded border border-edge bg-panel px-3 py-2.5 text-left hover:border-mute"
            >
              <span className={`size-2 shrink-0 rounded-full ${dot(i.status)}`} />
              <span className="flex-1 truncate text-sm">{i.name}</span>
              {i.status === "online" && (
                <span className="text-xs text-mute">
                  {i.memory_mb > 0 && `${(i.memory_mb / 1024).toFixed(1)}G`} {uptime(i.uptime_ms)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {scan.data && scan.data.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-xs text-mute">found on disk, not registered</h2>
          <ul className="space-y-1">
            {scan.data.map((i) => (
              <li
                key={i.name}
                className="flex items-center gap-3 rounded border border-dashed border-edge px-3 py-2"
              >
                <span className="flex-1 truncate text-sm text-mute">{i.name}</span>
                <button
                  onClick={() => adopt.mutate(i)}
                  className="text-xs text-ink underline underline-offset-2"
                >
                  add
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Detail({ name, onBack }: { name: string; onBack: () => void }) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["instances"] });
    qc.invalidateQueries({ queryKey: ["stats", name] });
  };

  const [tab, setTab] = useState<"console" | "backups">("console");

  const instances = useQuery({ queryKey: ["instances"], queryFn: api.instances });
  const inst = instances.data?.find((i) => i.name === name);

  const stats = useQuery({
    queryKey: ["stats", name],
    queryFn: () => api.stats(name),
    refetchInterval: 5000,
  });

  const start = useMutation({ mutationFn: () => api.start(name), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => api.stop(name), onSuccess: invalidate });
  const restart = useMutation({ mutationFn: () => api.restart(name), onSuccess: invalidate });
  const busy = start.isPending || stop.isPending || restart.isPending;
  const err = start.error ?? stop.error ?? restart.error;

  const online = stats.data?.status === "online" || inst?.status === "online";
  const disk = stats.data?.disk;

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
        <button onClick={onBack} className="text-sm text-mute hover:text-ink">
          back
        </button>
        <span className={`size-2 rounded-full ${dot(stats.data?.status ?? inst?.status ?? "stopped")}`} />
        <h1 className="flex-1 truncate text-sm">{name}</h1>
        {stats.data?.players && (
          <span className="truncate text-xs text-mute">{stats.data.players}</span>
        )}
      </div>

      <div className="flex gap-2 px-4 py-3">
        <button
          disabled={busy || online}
          onClick={() => start.mutate()}
          className="rounded bg-live/15 px-3 py-1.5 text-sm text-live disabled:opacity-30"
        >
          start
        </button>
        <button
          disabled={busy || !online}
          onClick={() => stop.mutate()}
          className="rounded bg-bad/15 px-3 py-1.5 text-sm text-bad disabled:opacity-30"
        >
          stop
        </button>
        <button
          disabled={busy || !online}
          onClick={() => restart.mutate()}
          className="rounded bg-panel px-3 py-1.5 text-sm text-mute disabled:opacity-30"
        >
          restart
        </button>
        {busy && <span className="self-center text-xs text-mute">working, this takes a while</span>}
      </div>

      <Stats stats={stats.data} online={online} />

      {err && <Problem error={err} />}

      <div className="flex gap-4 border-b border-edge px-4">
        {(["console", "backups"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 py-2 text-xs ${
              tab === t ? "border-ink text-ink" : "border-transparent text-mute hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
        {disk && (
          <span className="ml-auto self-center text-xs text-faint">
            {bytes(disk.free_bytes)} free of {bytes(disk.total_bytes)}
          </span>
        )}
      </div>

      {tab === "console" ? (
        <Console name={name} inst={inst} online={online} />
      ) : (
        <Backups name={name} online={online} rconReady={!!inst?.rcon_ready} />
      )}
    </main>
  );
}

function Stats({ stats, online }: { stats?: import("./api").Stats; online: boolean }) {
  const d = stats?.disk;
  return (
    <div className="grid grid-cols-4 gap-px border-y border-edge bg-edge text-center">
      <Cell label="cpu" value={online ? `${(stats?.cpu_pct ?? 0).toFixed(0)}%` : "—"} />
      <Cell
        label="memory"
        value={online && stats?.memory_mb ? `${(stats.memory_mb / 1024).toFixed(1)}G` : "—"}
      />
      <Cell label="world" value={d ? bytes(d.world_bytes) : "…"} />
      <Cell label="backups" value={d ? bytes(d.backup_bytes) : "…"} />
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg py-2">
      <div className="text-sm tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
    </div>
  );
}

// Console is the log pane plus an RCON input. The log pane follows the tail
// unless you scroll up, which is the one behaviour that makes a log readable.
function Console({
  name,
  inst,
  online,
}: {
  name: string;
  inst?: Instance;
  online: boolean;
}) {
  const qc = useQueryClient();
  const logs = useQuery({
    queryKey: ["logs", name],
    queryFn: () => api.logs(name),
    refetchInterval: 4000,
  });
  const [sent, setSent] = useState<string[]>([]);
  const [cmd, setCmd] = useState("");

  const run = useMutation({
    mutationFn: (c: string) => api.console(name, c),
    onSuccess: (res) =>
      setSent((s) => [...s, `> ${res.command}`, res.reply || "(no reply)"]),
    onError: (e: Error, c) => setSent((s) => [...s, `> ${c}`, e.message]),
  });

  const enable = useMutation({
    mutationFn: () => api.enableRcon(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instances"] }),
  });

  const body = (logs.data ?? (logs.error ? String(logs.error) : "…")) +
    (sent.length ? "\n" + sent.join("\n") : "");

  const pane = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  // Record whether the user was already at the bottom before the new text
  // lands, otherwise the check always sees the post-update scroll height.
  const onScroll = () => {
    const el = pane.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useLayoutEffect(() => {
    const el = pane.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [body]);

  const rconOff = !inst?.rcon_ready;

  return (
    <>
      <pre
        ref={pane}
        onScroll={onScroll}
        className="mx-4 mt-3 flex-1 overflow-auto rounded border border-edge bg-panel p-3 text-[11px] leading-relaxed text-mute"
      >
        {body}
      </pre>

      {rconOff ? (
        <div className="flex items-center gap-3 p-4">
          <button
            onClick={() => enable.mutate()}
            disabled={enable.isPending}
            className="rounded bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-30"
          >
            turn on the console
          </button>
          <span className="text-xs text-mute">
            writes three lines into server.properties, effective next restart
          </span>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!cmd.trim()) return;
            run.mutate(cmd.trim());
            setCmd("");
          }}
          className="flex gap-2 p-4"
        >
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            placeholder={online ? "say hello" : "server is not running"}
            disabled={!online}
            className="flex-1 rounded border border-edge bg-panel px-3 py-2 font-mono text-xs outline-none focus:border-mute disabled:opacity-40"
          />
          <button
            disabled={!online || run.isPending}
            className="rounded bg-ink px-3 py-2 text-sm text-bg disabled:opacity-30"
          >
            run
          </button>
        </form>
      )}
      {enable.data?.restart_required && (
        <p className="px-4 pb-4 text-xs text-warn">
          written. restart the server for the console to connect.
        </p>
      )}
      {enable.error && <Problem error={enable.error} />}
    </>
  );
}

function Backups({
  name,
  online,
  rconReady,
}: {
  name: string;
  online: boolean;
  rconReady: boolean;
}) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["backups", name],
    queryFn: () => api.backups(name),
  });
  const create = useMutation({
    mutationFn: () => api.createBackup(name),
    // The mod zips in the background, so the file appears a moment later.
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["backups", name] }), 8000),
  });
  const restore = useMutation({
    mutationFn: (file: string) => api.restoreBackup(name, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instances"] });
      qc.invalidateQueries({ queryKey: ["backups", name] });
    },
  });
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3">
        <button
          onClick={() => create.mutate()}
          disabled={!online || !rconReady || create.isPending}
          className="rounded bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-30"
        >
          back up now
        </button>
        <span className="text-xs text-mute">
          {!rconReady
            ? "needs the console turned on"
            : !online
              ? "the server has to be running"
              : create.isPending
                ? "asking the server…"
                : "runs the server's own backup command"}
        </span>
      </div>

      {create.error && <Problem error={create.error} />}
      {restore.error && <Problem error={restore.error} />}
      {restore.data && (
        <p className="mb-3 rounded border border-edge bg-panel px-3 py-2 text-xs text-mute">
          restored. the old world is kept at {restore.data.previous_world}
          {restore.data.restarted && ", server started again"}
        </p>
      )}

      <ul className="space-y-2">
        {list.data?.map((b) => (
          <BackupRow
            key={b.file}
            b={b}
            confirming={confirming === b.file}
            pending={restore.isPending}
            onAsk={() => setConfirming(b.file)}
            onCancel={() => setConfirming(null)}
            onGo={() => {
              setConfirming(null);
              restore.mutate(b.file);
            }}
          />
        ))}
      </ul>
      {list.data?.length === 0 && <p className="text-xs text-mute">no backups on disk</p>}
    </div>
  );
}

function BackupRow({
  b,
  confirming,
  pending,
  onAsk,
  onCancel,
  onGo,
}: {
  b: Backup;
  confirming: boolean;
  pending: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onGo: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded border border-edge bg-panel p-2">
      {/* FTB Backups 2 stores a map thumbnail in backups.json. */}
      {b.preview ? (
        <img src={b.preview} alt="" className="size-10 shrink-0 rounded object-cover" />
      ) : (
        <span className="size-10 shrink-0 rounded bg-edge" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs">{new Date(b.created).toLocaleString()}</div>
        <div className="text-[11px] text-faint">
          {bytes(b.size)} {b.world && `· ${b.world}`}
        </div>
      </div>
      {confirming ? (
        <div className="flex shrink-0 gap-2">
          <button onClick={onGo} className="rounded bg-bad/20 px-2 py-1 text-xs text-bad">
            replace world
          </button>
          <button onClick={onCancel} className="px-2 py-1 text-xs text-mute">
            cancel
          </button>
        </div>
      ) : (
        <button
          onClick={onAsk}
          disabled={pending}
          className="shrink-0 text-xs text-mute underline underline-offset-2 hover:text-ink disabled:opacity-30"
        >
          restore
        </button>
      )}
    </li>
  );
}

function SettingsScreen({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const save = useMutation({
    mutationFn: (p: SettingsPatch) => api.saveSettings(p),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      qc.invalidateQueries({ queryKey: ["info"] });
      qc.invalidateQueries({ queryKey: ["instances"] });
      qc.invalidateQueries({ queryKey: ["scan"] });
    },
  });

  const [key, setKey] = useState("");
  const s = settings.data;

  return (
    <main className="flex-1 overflow-y-auto p-4">
      <button onClick={onBack} className="mb-4 text-sm text-mute hover:text-ink">
        back
      </button>

      {settings.error && <Problem error={settings.error} />}
      {save.error && <Problem error={save.error} />}

      {s && (
        <div className="space-y-5">
          <Field
            label="pm2"
            value={s.pm2_bin}
            detected={s.detected?.pm2_bin}
            onSave={(v) => save.mutate({ pm2_bin: v })}
          />
          <Field
            label="node bin dir"
            value={s.node_bin_dir}
            detected={s.detected?.node_bin_dir}
            onSave={(v) => save.mutate({ node_bin_dir: v })}
          />
          <Field
            label="servers root"
            value={s.servers_root}
            detected={s.detected?.servers_root}
            onSave={(v) => save.mutate({ servers_root: v })}
          />

          <div>
            <label className="mb-1 block text-xs text-mute">
              curseforge key {s.has_curseforge_key && "(stored)"}
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={s.has_curseforge_key ? "•••• stored, paste to replace" : "paste key"}
                className="flex-1 rounded border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-mute"
              />
              <button
                onClick={() => {
                  save.mutate({ curseforge_key: key });
                  setKey("");
                }}
                className="rounded bg-ink px-3 py-2 text-sm text-bg"
              >
                save
              </button>
            </div>
            <p className="mt-1 text-xs text-mute">
              kept on this machine and never sent back to the browser
            </p>
          </div>

          <div>
            <p className="text-xs text-mute">owner</p>
            <p className="text-sm">{s.owner || "unclaimed"}</p>
            {s.owner && (
              <button
                onClick={() => save.mutate({ owner: "" })}
                className="mt-1 text-xs text-bad underline underline-offset-2"
              >
                release, the next login to open this claims it
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

// An empty box means "go back to detection", which is why the placeholder shows
// the detected value rather than the box being prefilled with it.
function Field({
  label,
  value,
  detected,
  onSave,
}: {
  label: string;
  value: string;
  detected?: boolean;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (detected ? "" : value);
  return (
    <div>
      <label className="mb-1 block text-xs text-mute">
        {label} {detected && <span className="text-live">detected</span>}
      </label>
      <div className="flex gap-2">
        <input
          value={shown}
          placeholder={value || "not found"}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1 rounded border border-edge bg-panel px-3 py-2 font-mono text-xs outline-none focus:border-mute"
        />
        <button
          onClick={() => {
            onSave(shown);
            setDraft(null);
          }}
          className="rounded bg-panel px-3 py-2 text-sm text-mute"
        >
          save
        </button>
      </div>
    </div>
  );
}

function Problem({ error }: { error: unknown }) {
  return (
    <p className="mx-4 my-3 rounded border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
