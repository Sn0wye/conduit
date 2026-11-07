import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bytes, since, type Artifact, type Run, type Step, type Version } from "./api";
import { Button, Hint, Label, Notice, Problem, Section, Sheet, Spinner, Window } from "./ui";

// The versions tab is one question asked twice: which files should this server
// be running, and how do I get back. Everything on screen is either a pack
// waiting to be applied or a version that can be returned to.

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function Upgrades({ name, online, freeBytes }: { name: string; online: boolean; freeBytes?: number }) {
  const qc = useQueryClient();
  const [staged, setStaged] = useState<Artifact | null>(null);
  const [label, setLabel] = useState("");

  const versions = useQuery({
    queryKey: ["versions", name],
    queryFn: () => api.versions(name),
    // A run is minutes of work with no other way to see it, so the list polls
    // itself while one is in flight and sits still the rest of the time.
    refetchInterval: (q) => (q.state.data?.run && !q.state.data.run.done ? 1500 : false),
  });
  const run = versions.data?.run ?? null;
  const running = !!run && !run.done;

  // The rest of the app is looking at the same server, so a finished run has
  // to refresh the status, the backup list and the version in the header.
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
  const active = versions.data?.active;

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-2 border-b border-edge">
        <div className="border-r border-edge px-4 py-3 sm:px-6">
          <Label>files in use</Label>
          <div className="mt-1 truncate font-mono text-[14px]">{active?.label ?? "not recorded yet"}</div>
        </div>
        <div className="px-4 py-3 sm:px-6">
          <Label>can come back to it</Label>
          <div className="mt-1 truncate font-mono text-[14px]">
            {!active
              ? "after the first upgrade"
              : active.snapshot_bytes > 0
                ? `yes, ${bytes(active.snapshot_bytes)}`
                : "archived on next upgrade"}
          </div>
        </div>
      </div>

      {run && (
        <div className="border-b border-edge p-3 sm:p-6">
          <RunWindow run={run} name={name} />
        </div>
      )}

      {!running && (
        <PackPicker
          name={name}
          staged={staged}
          label={label}
          freeBytes={freeBytes}
          online={online}
          onStaged={(a) => {
            setStaged(a);
            setLabel(a.layout.label || a.name.replace(/\.zip$/i, ""));
          }}
          onLabel={setLabel}
          onGo={() => staged && setConfirming(staged)}
        />
      )}
      {start.error && (
        <div className="px-4 sm:px-6">
          <Problem error={start.error} />
        </div>
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

// RunWindow shows an upgrade the way a script would print it, because that is
// what it is: steps minutes apart, each one either done or not.
function RunWindow({ run, name }: { run: Run; name: string }) {
  const cmd = `conduit ${run.kind} ${name} --to "${run.label}"`;
  return (
    <Window
      title={`${name} — ${run.kind}`}
      right={
        run.done ? (
          <span className={`font-mono text-[10.5px] ${run.error ? "text-bad" : "text-live"}`}>
            {run.error ? "failed" : "done"}
          </span>
        ) : (
          <span className="font-mono text-[10.5px] text-faint">
            <Spinner /> running
          </span>
        )
      }
    >
      <div className="px-4 py-3 font-mono text-[11.5px] leading-[1.9]">
        <div className="text-ink">
          <span className="text-accent">$</span> {cmd}
        </div>
        {run.steps.map((s, i) => (
          <StepLine key={i} s={s} />
        ))}
        {run.done ? (
          <div className={`mt-1 ${run.error ? "text-bad" : "text-live"}`}>
            {run.error
              ? `✗ ${run.error}`
              : `✓ ${run.kind === "upgrade" ? "upgraded to" : "back on"} ${run.label}, the server booted`}
          </div>
        ) : (
          <div className="mt-1 text-faint"># safe to close this page, the run keeps going</div>
        )}
      </div>
    </Window>
  );
}

function StepLine({ s }: { s: Step }) {
  const mark =
    s.state === "running" ? (
      <Spinner className="text-accent" />
    ) : s.state === "done" ? (
      "✓"
    ) : s.state === "failed" ? (
      "✗"
    ) : s.state === "skipped" ? (
      "–"
    ) : (
      "·"
    );
  const tone =
    s.state === "done"
      ? "text-mute"
      : s.state === "running"
        ? "text-ink"
        : s.state === "failed"
          ? "text-bad"
          : "text-faint/60";
  return (
    <div className={`flex gap-[1ch] ${tone}`}>
      <span className={`w-[1ch] shrink-0 ${s.state === "done" ? "text-live" : ""}`}>{mark}</span>
      <span>
        {s.name}
        {s.detail && <span className="text-faint"> {s.detail}</span>}
      </span>
    </div>
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
  online,
  onStaged,
  onLabel,
  onGo,
}: {
  name: string;
  staged: Artifact | null;
  label: string;
  freeBytes?: number;
  online: boolean;
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
    <Section title="Upgrade to a new pack" aside={online ? <Label>stops the server first</Label> : undefined}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-4 sm:px-6">
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
        <Button onClick={() => fileInput.current?.click()} disabled={upload.isPending} busy={upload.isPending}>
          {upload.isPending ? "Uploading" : "Upload a zip"}
        </Button>
        <Label className="px-1">or</Label>
        <form
          className="flex min-w-[16rem] flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) fromPath.mutate();
          }}
        >
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded border border-edge bg-term px-2.5 focus-within:border-edge-strong">
            <span className="font-mono text-[12px] text-accent">$</span>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              aria-label="Path to a pack zip on the server"
              spellCheck={false}
              autoCapitalize="off"
              placeholder="~/packs/atm10-1.3.1-server.zip"
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint"
            />
          </label>
          <Button disabled={!path.trim() || fromPath.isPending} busy={fromPath.isPending}>
            Read
          </Button>
        </form>
      </div>

      {progress !== null && (
        <div className="mx-4 mb-4 h-px bg-edge sm:mx-6">
          <div className="h-px bg-accent transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {(upload.error || fromPath.error) && (
        <div className="px-4 sm:px-6">
          {upload.error && <Problem error={upload.error} />}
          {fromPath.error && <Problem error={fromPath.error} />}
        </div>
      )}

      {staged && (
        <div className="border-t border-edge">
          <div className="truncate px-4 pt-4 font-mono text-[13px] sm:px-6">{staged.name}</div>
          <dl className="mx-4 mt-3 grid grid-cols-3 border border-edge sm:mx-6">
            {[
              ["mods", String(staged.layout.mods)],
              ["files", String(staged.layout.files)],
              ["unpacked", bytes(staged.layout.unpacked_bytes)],
            ].map(([l, v], i) => (
              <div key={l} className={`px-3 py-2 ${i < 2 ? "border-r border-edge" : ""}`}>
                <dt>
                  <Label>{l}</Label>
                </dt>
                <dd className="font-mono text-[14px]">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="px-4 sm:px-6">
            {!staged.layout.has_run_sh && <Notice>No run.sh in the pack, so the current one is kept.</Notice>}
            {staged.layout.root && <Notice>The pack sits inside {staged.layout.root}/; that folder is unwrapped.</Notice>}
            {tight && (
              <Notice tone="warn">
                Only {bytes(freeBytes!)} free. The upgrade also writes a world backup and an archive of
                the current files.
              </Notice>
            )}
          </div>
          <form
            className="flex items-center gap-2 px-4 py-4 sm:px-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (label.trim()) onGo();
            }}
          >
            <input
              value={label}
              onChange={(e) => onLabel(e.target.value)}
              aria-label="Version name"
              placeholder="what to call this version"
              className="h-8 min-w-0 flex-1 rounded border border-edge bg-term px-2.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-edge-strong"
            />
            <Button variant="primary" disabled={!label.trim()}>
              Upgrade
            </Button>
          </form>
        </div>
      )}

      {others.length > 0 && (
        <details className="group border-t border-edge">
          <summary className="flex h-10 cursor-pointer list-none items-center px-4 font-mono text-[10.5px] text-faint hover:text-mute sm:px-6">
            <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
            {others.length} pack{others.length === 1 ? "" : "s"} already on this machine
          </summary>
          <ul className="border-t border-edge">
            {others.map((a) => (
              <li key={a.sha256} className="flex items-center gap-3 border-b border-edge px-4 py-2.5 last:border-b-0 sm:px-6">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-mute">{a.name}</span>
                <Label>
                  {a.layout.mods} mods, {bytes(a.size)}
                </Label>
                <Button size="sm" onClick={() => onStaged(a)}>
                  Use
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <Hint className="border-t border-edge px-4 py-3 sm:px-6">
        {name} keeps its world, server.properties, ops, whitelist and JVM args. Mods are replaced, not
        merged, and configs the pack ships are overwritten.
      </Hint>
    </Section>
  );
}

// History is the way back. Every row that still has an archive is a version
// this server can be put back on.
function History({ name, versions, busy }: { name: string; versions: Version[]; busy: boolean }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["versions", name] });
  const revert = useMutation({
    mutationFn: ({ id, world }: { id: number; world: boolean }) => api.revert(name, id, world),
    onSuccess: refresh,
  });
  const drop = useMutation({ mutationFn: (id: number) => api.dropSnapshot(name, id), onSuccess: refresh });
  const [confirming, setConfirming] = useState<Version | null>(null);

  return (
    <Section title="History" aside={<Label>the newest 3 archives are kept</Label>}>
      {versions.length === 0 && (
        <Hint className="px-4 py-5 sm:px-6">No upgrades yet. Each one lands here, with a way back.</Hint>
      )}
      <ul>
        {versions.map((v) => (
          <li
            key={v.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge px-4 py-3 last:border-b-0 sm:px-6"
          >
            <span
              className={`h-9 w-[2px] shrink-0 ${
                v.state === "active"
                  ? "bg-live"
                  : v.state === "failed"
                    ? "bg-bad"
                    : v.state === "rolled_back"
                      ? "bg-warn"
                      : "bg-edge-strong"
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-mono text-[13px]">{v.label}</span>
                <StateTag state={v.state} />
              </div>
              <div className="truncate font-mono text-[10.5px] text-faint">
                {fmtDate(v.applied_at)}
                {v.source === "revert" && ", put back"}
                {v.source === "baseline" && ", already on disk"}
                {v.snapshot_bytes > 0
                  ? `, ${bytes(v.snapshot_bytes)} archived`
                  : v.state !== "active"
                    ? ", archive pruned"
                    : ""}
                {v.world_backup && ", world backup kept"}
              </div>
              {v.note && <div className="font-mono text-[10.5px] text-faint">{v.note}</div>}
            </div>
            {v.state !== "active" && v.snapshot_bytes > 0 && (
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" disabled={busy || revert.isPending} onClick={() => setConfirming(v)}>
                  Go back
                </Button>
                <Button size="sm" variant="ghost" disabled={busy || drop.isPending} onClick={() => drop.mutate(v.id)}>
                  Free archive
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {(revert.error || drop.error) && (
        <div className="px-4 sm:px-6">
          {revert.error && <Problem error={revert.error} />}
          {drop.error && <Problem error={drop.error} />}
        </div>
      )}

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
    </Section>
  );
}

function StateTag({ state }: { state: Version["state"] }) {
  const [tone, word] =
    state === "active"
      ? ["text-live", "in use"]
      : state === "failed"
        ? ["text-bad", "did not boot"]
        : state === "rolled_back"
          ? ["text-warn", "abandoned"]
          : ["text-faint", "replaced"];
  return <span className={`shrink-0 font-mono text-[10.5px] ${tone}`}>{word}</span>;
}

function Steps({ lines }: { lines: string[] }) {
  return (
    <ol className="space-y-1.5 font-mono text-[11.5px]">
      {lines.map((l, i) => (
        <li key={l} className="flex gap-[1ch]">
          <span className="w-[2ch] shrink-0 text-right text-faint">{i + 1}</span>
          <span className="text-mute">{l}</span>
        </li>
      ))}
    </ol>
  );
}

// The confirmations list what will happen, in order, because the order is
// the reason it is safe.
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
      title={`Upgrade to ${label}?`}
      onCancel={onCancel}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onGo}>
            Upgrade
          </Button>
        </>
      }
    >
      <Steps
        lines={[
          online ? "stop the server" : "the server is already stopped",
          "back up the world while nothing writes to it",
          "archive the current mods, configs and run.sh",
          `replace the mods with the ${a.layout.mods} in this pack`,
          "start it; if it does not boot in 15 min, put the old files back",
        ]}
      />
    </Sheet>
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
      title={`Go back to ${v.label}?`}
      onCancel={onCancel}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onGo(world)}>
            Go back
          </Button>
        </>
      }
    >
      <Steps
        lines={[
          "stop the server and back up the world",
          "archive the files in use now, so this is undoable too",
          world ? `rewind the world to the backup from ${since(v.applied_at)} ago` : "keep the world as it is",
        ]}
      />
      {v.world_backup && (
        <label className="mt-4 flex items-start gap-2.5 border-t border-edge pt-4 text-[12.5px] text-mute">
          <input
            type="checkbox"
            checked={world}
            onChange={(e) => setWorld(e.target.checked)}
            className="mt-0.5 accent-[var(--color-accent)]"
          />
          <span>
            Also restore the world from that version. Tick this when the world has been played on
            newer mods and would break on the old ones.
          </span>
        </label>
      )}
    </Sheet>
  );
}
