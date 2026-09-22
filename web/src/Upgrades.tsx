import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bytes, since, type Artifact, type Run, type Step, type Version } from "./api";
import { Problem, Spinner } from "./ui";

// The upgrades tab is one question asked twice: which files should this server
// be running, and how do I get back. Everything on screen is either a pack
// waiting to be applied or a version that can be returned to.

export function Upgrades({
  name,
  online,
  freeBytes,
}: {
  name: string;
  online: boolean;
  freeBytes?: number;
}) {
  const qc = useQueryClient();
  const [staged, setStaged] = useState<Artifact | null>(null);
  const [label, setLabel] = useState("");

  const versions = useQuery({
    queryKey: ["versions", name],
    queryFn: () => api.versions(name),
    // A run is minutes of work with no other way to see it, so the list polls
    // itself while one is in flight and sits still the rest of the time.
    refetchInterval: (q) => (q.state.data?.run && !q.state.data.run.done ? 2000 : false),
  });
  const run = versions.data?.run ?? null;
  const running = !!run && !run.done;

  // The rest of the app is looking at the same server, so a finished run has
  // to refresh the status, the backup list and the version on the dashboard.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: ["instances"] });
      qc.invalidateQueries({ queryKey: ["stats", name] });
      qc.invalidateQueries({ queryKey: ["backups", name] });
    }
    wasRunning.current = running;
  }, [running, name, qc]);

  const start = useMutation({
    mutationFn: (a: Artifact) => api.upgrade(name, a.sha256, label.trim() || a.layout.label || a.name),
    onSuccess: () => {
      setStaged(null);
      qc.invalidateQueries({ queryKey: ["versions", name] });
    },
  });

  const [confirming, setConfirming] = useState<Artifact | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <Current v={versions.data?.active} online={online} />

      {running ? (
        <RunPane run={run!} />
      ) : (
        <PackPicker
          name={name}
          staged={staged}
          label={label}
          freeBytes={freeBytes}
          onStaged={(a) => {
            setStaged(a);
            setLabel(a.layout.label || a.name.replace(/\.zip$/i, ""));
          }}
          onLabel={setLabel}
          onGo={() => staged && setConfirming(staged)}
        />
      )}

      {start.error && <Problem error={start.error} />}
      {run?.done && run.error && (
        <p className="my-3 rounded border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          the {run.kind} failed: {run.error}
        </p>
      )}
      {run?.done && !run.error && (
        <p className="my-3 rounded border border-live/40 bg-live/10 px-3 py-2 text-xs text-live">
          {run.kind === "upgrade" ? "upgraded to" : "back on"} {run.label}, the server booted
        </p>
      )}

      <History name={name} versions={versions.data?.versions ?? []} busy={running} />

      {confirming && (
        <ConfirmUpgrade
          a={confirming}
          label={label.trim() || confirming.layout.label || confirming.name}
          online={online}
          onCancel={() => setConfirming(null)}
          onGo={() => {
            const a = confirming;
            setConfirming(null);
            start.mutate(a);
          }}
        />
      )}
    </div>
  );
}

function Current({ v, online }: { v?: Version; online: boolean }) {
  return (
    <section className="mb-5 rounded border border-edge bg-panel p-3">
      <div className="text-[11px] text-faint">running these server files</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-sm text-ink">{v?.label ?? "never upgraded through conduit"}</span>
        {v && <span className="text-[11px] text-faint">· applied {since(v.applied_at)} ago</span>}
      </div>
      <div className="mt-1 text-[11px] text-faint">
        {!v
          ? "the first upgrade records whatever is in the directory now, so there is something to go back to"
          : v.snapshot_bytes > 0
            ? `${bytes(v.snapshot_bytes)} archived, this version can be returned to`
            : "archived when the next upgrade runs"}
        {online && " · the server is up, an upgrade stops it first"}
      </div>
    </section>
  );
}

// PackPicker takes the pack two ways. Uploading from a laptop is the obvious
// one; pasting a path is the one that matters when the file is three gigabytes
// and already sitting on the box next to a wget.
function PackPicker({
  name,
  staged,
  label,
  freeBytes,
  onStaged,
  onLabel,
  onGo,
}: {
  name: string;
  staged: Artifact | null;
  label: string;
  freeBytes?: number;
  onStaged: (a: Artifact) => void;
  onLabel: (v: string) => void;
  onGo: () => void;
}) {
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const done = (a: Artifact) => {
    setProgress(null);
    qc.invalidateQueries({ queryKey: ["artifacts"] });
    onStaged(a);
  };
  const upload = useMutation({
    mutationFn: (f: File) => api.uploadArtifact(f, setProgress),
    onSuccess: done,
    onError: () => setProgress(null),
  });
  const fromPath = useMutation({ mutationFn: () => api.addArtifactPath(path.trim()), onSuccess: done });

  const cached = useQuery({ queryKey: ["artifacts"], queryFn: api.artifacts });
  const others = (cached.data ?? []).filter((a) => a.sha256 !== staged?.sha256);
  const tight = !!(freeBytes && staged && freeBytes < staged.layout.unpacked_bytes * 2);

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs text-mute">upgrade to a new pack</h2>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={upload.isPending}
          className="flex items-center gap-2 rounded bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-30"
        >
          {upload.isPending && <Spinner />}
          {upload.isPending ? "uploading" : "choose a zip"}
        </button>
        <span className="text-[11px] text-faint">or a path on the server</span>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && path.trim() && fromPath.mutate()}
          placeholder="~/packs/atm10-1.3.0-server.zip"
          className="min-w-0 flex-1 rounded border border-edge bg-bg px-2 py-1.5 text-xs text-ink placeholder:text-faint"
        />
        <button
          onClick={() => fromPath.mutate()}
          disabled={!path.trim() || fromPath.isPending}
          className="flex items-center gap-2 rounded bg-panel px-3 py-1.5 text-xs text-ink disabled:opacity-30"
        >
          {fromPath.isPending && <Spinner />}
          read it
        </button>
      </div>

      {progress !== null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-edge">
          <div className="h-full bg-live transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {upload.error && <Problem error={upload.error} />}
      {fromPath.error && <Problem error={fromPath.error} />}

      {staged && (
        <div className="mt-3 rounded border border-live/40 bg-panel p-3">
          <div className="truncate text-sm text-ink">{staged.name}</div>
          <div className="mt-1 text-[11px] text-faint">
            {staged.layout.mods} mods · {staged.layout.files} files ·{" "}
            {bytes(staged.layout.unpacked_bytes)} unpacked
            {staged.layout.root && ` · inside ${staged.layout.root}/`}
            {!staged.layout.has_run_sh && " · no run.sh, the current one is kept"}
          </div>
          {tight && (
            <p className="mt-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
              only {bytes(freeBytes!)} free. the upgrade also writes a world backup and an archive
              of the current files.
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <input
              value={label}
              onChange={(e) => onLabel(e.target.value)}
              placeholder="what to call this version"
              className="min-w-0 flex-1 rounded border border-edge bg-bg px-2 py-1.5 text-xs text-ink placeholder:text-faint"
            />
            <button
              onClick={onGo}
              disabled={!label.trim()}
              className="rounded bg-live/15 px-3 py-1.5 text-sm text-live disabled:opacity-30"
            >
              upgrade
            </button>
          </div>
        </div>
      )}

      {others.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-faint">
            {others.length} pack{others.length === 1 ? "" : "s"} already on the box
          </summary>
          <ul className="mt-2 space-y-1">
            {others.map((a) => (
              <li key={a.sha256} className="flex items-center gap-3 rounded border border-edge px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-mute">{a.name}</span>
                <span className="shrink-0 text-[11px] text-faint">
                  {a.layout.mods} mods · {bytes(a.size)}
                </span>
                <button
                  onClick={() => onStaged(a)}
                  className="shrink-0 text-[11px] text-ink underline underline-offset-2"
                >
                  use
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-2 text-[11px] text-faint">
        {name} keeps its world, server.properties, ops, whitelist and jvm args. mods are replaced,
        not merged, and configs the pack ships are overwritten.
      </p>
    </section>
  );
}

// RunPane is the only thing on screen worth looking at while a run is going,
// because the steps are minutes apart and a spinner alone says nothing.
function RunPane({ run }: { run: Run }) {
  return (
    <section className="mb-6 rounded border border-warn/40 bg-warn/5 p-3">
      <div className="flex items-center gap-2">
        <Spinner />
        <span className="text-sm text-warn">
          {run.kind === "upgrade" ? "upgrading to" : "going back to"} {run.label}
        </span>
      </div>
      <ol className="mt-3 space-y-1.5">
        {run.steps.map((s, i) => (
          <StepRow key={i} s={s} />
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-faint">
        this survives closing the page. the server is stopped for the whole run.
      </p>
    </section>
  );
}

function StepRow({ s }: { s: Step }) {
  const mark =
    s.state === "running" ? (
      <Spinner />
    ) : (
      <span
        className={`w-3 shrink-0 text-center text-[11px] ${
          s.state === "failed" ? "text-bad" : s.state === "skipped" ? "text-faint" : "text-live"
        }`}
      >
        {s.state === "failed" ? "×" : s.state === "skipped" ? "–" : "✓"}
      </span>
    );
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className="mt-0.5">{mark}</span>
      <span className="min-w-0">
        <span className={s.state === "failed" ? "text-bad" : "text-ink"}>{s.name}</span>
        {s.detail && <span className="text-[11px] text-faint"> · {s.detail}</span>}
      </span>
    </li>
  );
}

// History is the downgrade path. Every row that still has an archive is a
// version this server can be put back on in one tap.
function History({ name, versions, busy }: { name: string; versions: Version[]; busy: boolean }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["versions", name] });
  const revert = useMutation({
    mutationFn: ({ id, world }: { id: number; world: boolean }) => api.revert(name, id, world),
    onSuccess: refresh,
  });
  const drop = useMutation({ mutationFn: (id: number) => api.dropSnapshot(name, id), onSuccess: refresh });
  const [confirming, setConfirming] = useState<Version | null>(null);

  if (versions.length === 0) {
    return <p className="text-xs text-mute">no upgrades yet</p>;
  }
  return (
    <section>
      <h2 className="mb-2 text-xs text-mute">versions · newest first</h2>
      <ul className="space-y-2">
        {versions.map((v) => (
          <li
            key={v.id}
            className={`rounded border p-2 ${
              v.state === "active" ? "border-live/40" : v.state === "failed" ? "border-bad/30" : "border-edge"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{v.label}</span>
              <StateTag state={v.state} />
            </div>
            <div className="mt-1 text-[11px] text-faint">
              {new Date(v.applied_at).toLocaleString()}
              {v.source === "revert" && " · put back"}
              {v.source === "baseline" && " · already on disk"}
              {v.snapshot_bytes > 0 ? ` · ${bytes(v.snapshot_bytes)} archived` : " · archive pruned"}
              {v.world_backup && " · world backup kept"}
            </div>
            {v.note && <div className="mt-1 text-[11px] text-faint">{v.note}</div>}
            {v.state !== "active" && (
              <div className="mt-2 flex items-center gap-3">
                <button
                  disabled={busy || v.snapshot_bytes === 0 || revert.isPending}
                  onClick={() => setConfirming(v)}
                  className="text-[11px] text-ink underline underline-offset-2 disabled:text-faint disabled:no-underline"
                >
                  {v.snapshot_bytes === 0 ? "archive pruned, cannot go back" : "go back to this"}
                </button>
                {v.snapshot_bytes > 0 && (
                  <button
                    disabled={busy || drop.isPending}
                    onClick={() => drop.mutate(v.id)}
                    className="text-[11px] text-faint hover:text-mute"
                  >
                    free the archive
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-faint">
        the newest three archives are kept. older versions stay in this list but can no longer be
        returned to.
      </p>
      {revert.error && <Problem error={revert.error} />}
      {drop.error && <Problem error={drop.error} />}

      {confirming && (
        <ConfirmRevert
          v={confirming}
          onCancel={() => setConfirming(null)}
          onGo={(world) => {
            const id = confirming.id;
            setConfirming(null);
            revert.mutate({ id, world });
          }}
        />
      )}
    </section>
  );
}

function StateTag({ state }: { state: Version["state"] }) {
  const tone =
    state === "active"
      ? "text-live"
      : state === "failed"
        ? "text-bad"
        : state === "rolled_back"
          ? "text-warn"
          : "text-faint";
  const word =
    state === "active"
      ? "running now"
      : state === "failed"
        ? "did not boot"
        : state === "rolled_back"
          ? "abandoned"
          : "replaced";
  return <span className={`shrink-0 text-[11px] ${tone}`}>{word}</span>;
}

// Both confirmations sit at the bottom of the screen rather than where the
// button was, so the second tap never lands on the spot the first one left.
function ConfirmUpgrade({
  a,
  label,
  online,
  onCancel,
  onGo,
}: {
  a: Artifact;
  label: string;
  online: boolean;
  onCancel: () => void;
  onGo: () => void;
}) {
  return (
    <Sheet
      title={`upgrade to ${label}`}
      lines={[
        online ? "the server is stopped first" : "the server is already stopped",
        "the world is backed up cold, with nothing writing to it",
        "the current mods, configs and run.sh are archived so this is undoable",
        `mods are replaced with the ${a.layout.mods} in this pack`,
        "if it does not finish booting in 15 minutes, the old version is put back automatically",
      ]}
      go="upgrade"
      tone="live"
      onCancel={onCancel}
      onGo={onGo}
    />
  );
}

function ConfirmRevert({
  v,
  onCancel,
  onGo,
}: {
  v: Version;
  onCancel: () => void;
  onGo: (restoreWorld: boolean) => void;
}) {
  const [world, setWorld] = useState(false);
  return (
    <Sheet
      title={`go back to ${v.label}`}
      lines={[
        "the server is stopped and the world is backed up first",
        "the files you are on now are archived, so this is undoable too",
        world
          ? `the world is also rewound to the backup taken ${since(v.applied_at)} ago`
          : "the world you have now is kept as it is",
      ]}
      go="go back"
      tone="warn"
      onCancel={onCancel}
      onGo={() => onGo(world)}
      extra={
        v.world_backup ? (
          <label className="flex items-start gap-2 text-[11px] text-mute">
            <input
              type="checkbox"
              checked={world}
              onChange={(e) => setWorld(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              also restore the world from that version. tick this when the world has been played on
              newer mods and would break on the old ones.
            </span>
          </label>
        ) : null
      }
    />
  );
}

function Sheet({
  title,
  lines,
  go,
  tone,
  extra,
  onCancel,
  onGo,
}: {
  title: string;
  lines: string[];
  go: string;
  tone: "live" | "warn";
  extra?: React.ReactNode;
  onCancel: () => void;
  onGo: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 p-4">
      <div className="mx-auto max-w-3xl rounded border border-edge bg-panel p-3 shadow-lg">
        <div className="text-sm text-ink">{title}</div>
        <ul className="mt-2 space-y-1">
          {lines.map((l) => (
            <li key={l} className="text-[11px] text-mute">
              · {l}
            </li>
          ))}
        </ul>
        {extra && <div className="mt-3">{extra}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-mute hover:text-ink">
            cancel
          </button>
          <button
            onClick={onGo}
            className={`rounded px-3 py-1.5 text-sm ${
              tone === "live" ? "bg-live/15 text-live" : "bg-warn/15 text-warn"
            }`}
          >
            {go}
          </button>
        </div>
      </div>
    </div>
  );
}
