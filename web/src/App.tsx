import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, uptime, type Instance, type SettingsPatch } from "./api";

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
  if (status === "unregistered") return "bg-warn";
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
  const invalidate = () => qc.invalidateQueries({ queryKey: ["instances"] });

  const instances = useQuery({ queryKey: ["instances"], queryFn: api.instances });
  const inst = instances.data?.find((i) => i.name === name);

  const logs = useQuery({
    queryKey: ["logs", name],
    queryFn: () => api.logs(name),
    refetchInterval: 4000,
  });

  const start = useMutation({ mutationFn: () => api.start(name), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => api.stop(name), onSuccess: invalidate });
  const restart = useMutation({ mutationFn: () => api.restart(name), onSuccess: invalidate });
  const busy = start.isPending || stop.isPending || restart.isPending;
  const err = start.error ?? stop.error ?? restart.error;

  const online = inst?.status === "online";

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
        <button onClick={onBack} className="text-sm text-mute hover:text-ink">
          back
        </button>
        <span className={`size-2 rounded-full ${dot(inst?.status ?? "stopped")}`} />
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

      {/* Starting anything stops whatever else is online first. */}
      {!online && !busy && (
        <p className="px-4 pb-2 text-xs text-mute">starting this stops whatever else is running</p>
      )}

      {err && <Problem error={err} />}

      <pre className="mx-4 mb-4 flex-1 overflow-auto rounded border border-edge bg-panel p-3 text-[11px] leading-relaxed text-mute">
        {logs.data ?? (logs.error ? String(logs.error) : "…")}
      </pre>
    </main>
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
