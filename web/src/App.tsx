import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  bytes,
  since,
  uptime,
  type Backup,
  type Instance,
  type Rollback,
  type SettingsPatch,
} from "./api";

type Screen = { view: "list" } | { view: "detail"; name: string } | { view: "settings" };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ view: "list" });
  const info = useQuery({ queryKey: ["info"], queryFn: api.info });

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col overflow-hidden">
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

  // The backup watch lives here rather than in the tab, so switching to the
  // console while the mod zips does not throw the wait away.
  const [watch, setWatch] = useState<{ known: string[]; startedAt: number } | null>(null);
  const [fresh, setFresh] = useState<Backup | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  // One shared query key, so the tab reads the same cache this poll fills.
  const backups = useQuery({
    queryKey: ["backups", name],
    queryFn: () => api.backups(name),
    refetchInterval: watch ? 2000 : false,
  });

  useEffect(() => {
    if (!watch || !backups.data) return;
    const added = backups.data.find((b) => !watch.known.includes(b.file));
    if (added) {
      setFresh(added);
      setWatch(null);
      return;
    }
    // The mod zips in the background and says nothing when it finishes, so the
    // only honest end to the wait is a file appearing or a deadline passing.
    if (Date.now() - watch.startedAt > 180_000) {
      setWatch(null);
      setGaveUp(true);
    }
  }, [backups.data, watch]);

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
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
        <button onClick={onBack} className="text-sm text-mute hover:text-ink">
          back
        </button>
        <span className={`size-2 rounded-full ${dot(stats.data?.status ?? inst?.status ?? "stopped")}`} />
        <h1 className="flex-1 truncate text-sm">{name}</h1>
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

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "console" ? (
          <Console name={name} inst={inst} online={online} />
        ) : (
          <Backups
            name={name}
            online={online}
            rconReady={!!inst?.rcon_ready}
            watching={!!watch}
            gaveUp={gaveUp}
            freshFile={fresh?.file ?? null}
            onStarted={(known) => {
              setFresh(null);
              setGaveUp(false);
              setWatch({ known, startedAt: Date.now() });
            }}
          />
        )}
      </div>

      {fresh && <NewBackup b={fresh} onClose={() => setFresh(null)} />}
    </main>
  );
}

function Stats({ stats, online }: { stats?: import("./api").Stats; online: boolean }) {
  const d = stats?.disk;
  const count = stats?.players_online ?? -1;
  const players =
    online && count >= 0 ? `${count}/${stats?.players_max ?? "?"}` : online ? "—" : "—";

  return (
    <div className="grid grid-cols-5 gap-px border-y border-edge bg-edge text-center">
      <Cell label="players" value={players} title={stats?.players?.join(", ")} />
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

// title carries the player names, so the card stays a number and hovering
// still answers "who".
function Cell({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="bg-bg py-2" title={title || undefined}>
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
        className="mx-4 mt-3 min-h-0 flex-1 overflow-auto rounded border border-edge bg-panel p-3 text-[11px] leading-relaxed text-mute"
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
  watching,
  gaveUp,
  freshFile,
  onStarted,
}: {
  name: string;
  online: boolean;
  rconReady: boolean;
  watching: boolean;
  gaveUp: boolean;
  freshFile: string | null;
  onStarted: (known: string[]) => void;
}) {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["backups", name] });
    qc.invalidateQueries({ queryKey: ["rollbacks", name] });
    qc.invalidateQueries({ queryKey: ["instances"] });
  };

  const list = useQuery({ queryKey: ["backups", name], queryFn: () => api.backups(name) });
  const rollbacks = useQuery({
    queryKey: ["rollbacks", name],
    queryFn: () => api.rollbacks(name),
  });

  const create = useMutation({
    // The file names are captured before the command goes out, so the watch
    // knows exactly which entry is the new one.
    mutationFn: async () => {
      const known = (list.data ?? []).map((b) => b.file);
      const res = await api.createBackup(name);
      return { known, reply: res.reply };
    },
    onSuccess: ({ known }) => onStarted(known),
  });
  const rollback = useMutation({
    mutationFn: (file: string) => api.restoreBackup(name, file),
    onSuccess: refresh,
  });
  const undo = useMutation({
    mutationFn: (dir: string) => api.undoRollback(name, dir),
    onSuccess: refresh,
  });
  const dropRollback = useMutation({
    mutationFn: (dir: string) => api.deleteRollback(name, dir),
    onSuccess: refresh,
  });
  const dropBackup = useMutation({
    mutationFn: (file: string) => api.deleteBackup(name, file),
    onSuccess: refresh,
  });

  const [confirming, setConfirming] = useState<Backup | null>(null);
  const [droppingRollback, setDroppingRollback] = useState<string | null>(null);
  const [droppingBackup, setDroppingBackup] = useState<string | null>(null);
  const working = rollback.isPending || undo.isPending;
  const backingUp = create.isPending || watching;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => create.mutate()}
          disabled={!online || !rconReady || backingUp || working}
          className="flex items-center gap-2 rounded bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-30"
        >
          {backingUp && <Spinner />}
          {backingUp ? "backing up" : "back up now"}
        </button>
        <span className="text-xs text-mute">
          {!rconReady
            ? "needs the console turned on"
            : !online
              ? "the server has to be running"
              : create.isPending
                ? "asking the server…"
                : watching
                  ? "the mod is zipping the world, this can take a minute"
                  : "runs the server's own backup command"}
        </span>
      </div>

      {create.error && <Problem error={create.error} />}
      {rollback.error && <Problem error={rollback.error} />}
      {undo.error && <Problem error={undo.error} />}
      {dropRollback.error && <Problem error={dropRollback.error} />}
      {dropBackup.error && <Problem error={dropBackup.error} />}
      {gaveUp && (
        <p className="mb-3 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          no new backup showed up after three minutes. the command was sent, so check the console
          for what the mod said.
        </p>
      )}
      {working && (
        <p className="mb-3 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          working. this stops the server, swaps the world and starts it again, so it takes a few
          minutes. do not reload.
        </p>
      )}
      {rollback.data && (
        <p className="mb-3 rounded border border-edge bg-panel px-3 py-2 text-xs text-mute">
          rolled back. the world you had is kept as {rollback.data.previous_world}
          {rollback.data.restarted && ", server started again"}
        </p>
      )}
      {undo.data && (
        <p className="mb-3 rounded border border-edge bg-panel px-3 py-2 text-xs text-mute">
          put back. the world you had is kept as {undo.data.previous_world}
          {undo.data.restarted && ", server started again"}
        </p>
      )}

      {rollbacks.data && rollbacks.data.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs text-warn">
            worlds saved before a rollback · {rollbacks.data.length}
          </h2>
          <ul className="space-y-2">
            {rollbacks.data.map((r) => (
              <RollbackRow
                key={r.dir}
                r={r}
                busy={working || dropRollback.isPending}
                confirmingDelete={droppingRollback === r.dir}
                onUndo={() => undo.mutate(r.dir)}
                onAskDelete={() => setDroppingRollback(r.dir)}
                onCancelDelete={() => setDroppingRollback(null)}
                onDelete={() => {
                  setDroppingRollback(null);
                  dropRollback.mutate(r.dir);
                }}
              />
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-faint">
            kept until you delete them. nothing removes these on its own.
          </p>
        </section>
      )}

      <h2 className="mb-2 text-xs text-mute">backups the server made</h2>
      <ul className="space-y-2">
        {watching && <PendingRow />}
        {list.data?.map((b) => (
          <BackupRow
            key={b.file}
            b={b}
            busy={working || dropBackup.isPending}
            isNew={b.file === freshFile}
            confirmingDelete={droppingBackup === b.file}
            onAsk={() => setConfirming(b)}
            onAskDelete={() => setDroppingBackup(b.file)}
            onCancelDelete={() => setDroppingBackup(null)}
            onDelete={() => {
              setDroppingBackup(null);
              dropBackup.mutate(b.file);
            }}
          />
        ))}
      </ul>
      {list.data?.length === 0 && !watching && (
        <p className="text-xs text-mute">no backups on disk</p>
      )}
      {list.data && list.data.length > 0 && (
        <p className="mt-2 text-[11px] text-faint">
          the backup mod keeps the newest 5 and deletes the rest on its own.
        </p>
      )}

      {confirming && (
        <ConfirmRollback
          b={confirming}
          onCancel={() => setConfirming(null)}
          onGo={() => {
            const file = confirming.file;
            setConfirming(null);
            rollback.mutate(file);
          }}
        />
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span className="size-3 shrink-0 animate-spin rounded-full border border-mute border-t-transparent" />
  );
}

// PendingRow stands in for the file the mod has not finished writing, so the
// list shows the backup arriving instead of sitting unchanged for a minute.
function PendingRow() {
  return (
    <li className="flex items-center gap-3 rounded border border-dashed border-edge p-2">
      <span className="flex size-12 shrink-0 items-center justify-center rounded bg-edge">
        <Spinner />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-mute">zipping the world…</div>
        <div className="text-[11px] text-faint">appears here when the mod is done</div>
      </div>
    </li>
  );
}

// NewBackup is the pop that confirms the file landed. It carries the map
// thumbnail so it is obvious which world was captured.
function NewBackup({ b, onClose }: { b: Backup; onClose: () => void }) {
  // Long enough to read, short enough not to sit over the list.
  useEffect(() => {
    const t = setTimeout(onClose, 12_000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 p-4">
      <div className="mx-auto flex max-w-3xl items-center gap-3 rounded border border-live/40 bg-panel p-3 shadow-lg">
        {b.preview ? (
          <img src={b.preview} alt="" className="size-12 shrink-0 rounded object-cover" />
        ) : (
          <span className="size-12 shrink-0 rounded bg-edge" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm text-live">backup done</div>
          <div className="truncate text-[11px] text-mute">
            {new Date(b.created).toLocaleString()} · {bytes(b.size)}
          </div>
        </div>
        <button onClick={onClose} className="shrink-0 px-2 text-xs text-mute hover:text-ink">
          dismiss
        </button>
      </div>
    </div>
  );
}

// ConfirmRollback sits at the bottom of the screen rather than where the
// button was, so the second tap never lands on the spot the first one just
// left. It names what goes, not what the button does.
function ConfirmRollback({
  b,
  onCancel,
  onGo,
}: {
  b: Backup;
  onCancel: () => void;
  onGo: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-edge bg-panel p-4">
      <div className="mx-auto max-w-3xl">
        <p className="text-sm">Roll back to {new Date(b.created).toLocaleString()}?</p>
        <p className="mt-1 text-xs text-mute">
          {since(b.created)} of play since then is gone: blocks, inventories, quests, everything.
          The world you have now is kept as a copy you can put back.
        </p>
        <div className="mt-3 flex gap-2">
          <button onClick={onCancel} className="rounded bg-panel px-3 py-2 text-sm text-mute">
            cancel
          </button>
          <button onClick={onGo} className="rounded bg-bad/20 px-3 py-2 text-sm text-bad">
            roll back
          </button>
        </div>
      </div>
    </div>
  );
}

function RollbackRow({
  r,
  busy,
  confirmingDelete,
  onUndo,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  r: Rollback;
  busy: boolean;
  confirmingDelete: boolean;
  onUndo: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="rounded border border-warn/30 bg-panel p-2">
      <div className="flex items-center gap-3">
        <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warn">
          pre-rollback
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs">{new Date(r.created).toLocaleString()}</div>
          <div className="truncate text-[11px] text-faint">
            {bytes(r.size_bytes)}
            {r.replaced_by && ` · replaced by ${r.replaced_by}`}
          </div>
        </div>
        {!confirmingDelete && (
          <div className="flex shrink-0 gap-3">
            <button
              onClick={onUndo}
              disabled={busy}
              className="text-xs text-ink underline underline-offset-2 disabled:opacity-30"
            >
              put back
            </button>
            <button
              onClick={onAskDelete}
              disabled={busy}
              className="text-xs text-faint hover:text-bad disabled:opacity-30"
            >
              delete
            </button>
          </div>
        )}
      </div>
      {confirmingDelete && (
        <div className="mt-2 flex items-center gap-2 border-t border-edge pt-2">
          <span className="flex-1 text-[11px] text-bad">
            delete this world for good? it is the only copy.
          </span>
          <button onClick={onDelete} className="rounded bg-bad/20 px-2 py-1 text-xs text-bad">
            delete
          </button>
          <button onClick={onCancelDelete} className="px-2 py-1 text-xs text-mute">
            cancel
          </button>
        </div>
      )}
    </li>
  );
}

function BackupRow({
  b,
  busy,
  isNew,
  confirmingDelete,
  onAsk,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  b: Backup;
  busy: boolean;
  isNew: boolean;
  confirmingDelete: boolean;
  onAsk: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={`rounded border bg-panel p-2 ${
        isNew ? "border-live/50" : "border-edge"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* FTB Backups 2 stores a map thumbnail in backups.json. */}
        {b.preview ? (
          <img src={b.preview} alt="" className="size-12 shrink-0 rounded object-cover" />
        ) : (
          <span className="size-12 shrink-0 rounded bg-edge" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs">{since(b.created)} ago</span>
            {isNew && (
              <span className="shrink-0 rounded bg-live/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-live">
                new
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-faint">
            {new Date(b.created).toLocaleString()} · {bytes(b.size)}
          </div>
        </div>
        {!confirmingDelete && (
          <div className="flex shrink-0 gap-3">
            <button
              onClick={onAsk}
              disabled={busy}
              className="text-xs text-mute underline underline-offset-2 hover:text-ink disabled:opacity-30"
            >
              roll back
            </button>
            <button
              onClick={onAskDelete}
              disabled={busy}
              className="text-xs text-faint hover:text-bad disabled:opacity-30"
            >
              delete
            </button>
          </div>
        )}
      </div>
      {confirmingDelete && (
        <div className="mt-2 flex items-center gap-2 border-t border-edge pt-2">
          <span className="flex-1 text-[11px] text-bad">delete this backup file?</span>
          <button onClick={onDelete} className="rounded bg-bad/20 px-2 py-1 text-xs text-bad">
            delete
          </button>
          <button onClick={onCancelDelete} className="px-2 py-1 text-xs text-mute">
            cancel
          </button>
        </div>
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
