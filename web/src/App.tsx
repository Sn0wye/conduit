import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, loadMachines, saveMachines, uptime, type Instance, type Machine } from "./api";

export default function App() {
  const [machines, setMachines] = useState<Machine[]>(loadMachines);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => saveMachines(machines), [machines]);

  const base = machines[active]?.url ?? "";

  if (machines.length === 0) {
    return <AddMachine onAdd={(m) => setMachines([m])} />;
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <MachineBar
        machines={machines}
        active={active}
        onPick={(i) => {
          setActive(i);
          setSelected(null);
        }}
        onAdd={(m) => setMachines([...machines, m])}
      />
      {selected ? (
        <Detail base={base} name={selected} onBack={() => setSelected(null)} />
      ) : (
        <InstanceList base={base} onOpen={setSelected} />
      )}
    </div>
  );
}

function MachineBar({
  machines,
  active,
  onPick,
  onAdd,
}: {
  machines: Machine[];
  active: number;
  onPick: (i: number) => void;
  onAdd: (m: Machine) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-3">
      {machines.map((m, i) => (
        <button
          key={m.url}
          onClick={() => onPick(i)}
          className={`rounded-full px-3 py-1 text-sm ${
            i === active ? "bg-ink text-bg" : "bg-panel text-mute hover:text-ink"
          }`}
        >
          {m.name}
        </button>
      ))}
      <button onClick={() => setAdding(true)} className="px-2 text-sm text-mute hover:text-ink">
        +
      </button>
      {adding && (
        <div className="w-full">
          <AddMachine
            inline
            onAdd={(m) => {
              onAdd(m);
              setAdding(false);
            }}
          />
        </div>
      )}
    </header>
  );
}

function AddMachine({ onAdd, inline }: { onAdd: (m: Machine) => void; inline?: boolean }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (url) onAdd({ name: name || new URL(url).hostname.split(".")[0], url });
      }}
      className={inline ? "flex gap-2 py-2" : "mx-auto flex max-w-sm flex-col gap-3 p-8"}
    >
      {!inline && <h1 className="text-lg">Add a machine</h1>}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name"
        className="rounded border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-mute"
      />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://conduit.tailnet.ts.net"
        className="flex-1 rounded border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-mute"
      />
      <button className="rounded bg-ink px-3 py-2 text-sm text-bg">add</button>
    </form>
  );
}

function dot(status: string) {
  if (status === "online") return "bg-live";
  if (status === "errored") return "bg-bad";
  if (status === "unregistered") return "bg-warn";
  return "bg-dead";
}

function InstanceList({ base, onOpen }: { base: string; onOpen: (n: string) => void }) {
  const qc = useQueryClient();
  const instances = useQuery({
    queryKey: ["instances", base],
    queryFn: () => api.instances(base),
  });
  const scan = useQuery({
    queryKey: ["scan", base],
    queryFn: () => api.scan(base),
    refetchInterval: false,
  });
  const adopt = useMutation({
    mutationFn: (i: Partial<Instance>) => api.register(base, i),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instances", base] });
      qc.invalidateQueries({ queryKey: ["scan", base] });
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
      <p className="mb-3 text-xs text-mute">
        {live ? `${live} is live` : "nothing running"}
      </p>
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

function Detail({ base, name, onBack }: { base: string; name: string; onBack: () => void }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["instances", base] });

  const instances = useQuery({
    queryKey: ["instances", base],
    queryFn: () => api.instances(base),
  });
  const inst = instances.data?.find((i) => i.name === name);

  const logs = useQuery({
    queryKey: ["logs", base, name],
    queryFn: () => api.logs(base, name),
    refetchInterval: 4000,
  });

  const start = useMutation({ mutationFn: () => api.start(base, name), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => api.stop(base, name), onSuccess: invalidate });
  const restart = useMutation({ mutationFn: () => api.restart(base, name), onSuccess: invalidate });
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
        <p className="px-4 pb-2 text-xs text-mute">
          starting this stops whatever else is running
        </p>
      )}

      {err && <Problem error={err} />}

      <pre className="mx-4 mb-4 flex-1 overflow-auto rounded border border-edge bg-panel p-3 text-[11px] leading-relaxed text-mute">
        {logs.data ?? (logs.error ? String(logs.error) : "…")}
      </pre>
    </main>
  );
}

function Problem({ error }: { error: unknown }) {
  return (
    <p className="mx-4 my-3 rounded border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
