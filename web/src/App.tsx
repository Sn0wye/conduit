import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  type Stats as StatsT,
} from "./api";
import {
  Button,
  Dot,
  Hint,
  Label,
  Notice,
  Problem,
  Section,
  Sheet,
  Spinner,
  Window,
  statusWord,
} from "./ui";
import { Upgrades, fmtDate } from "./Upgrades";

type Screen = { view: "list" } | { view: "detail"; name: string } | { view: "settings" };

// The screen lives in the hash so a refresh keeps it and the phone's back
// button walks back out of a server instead of closing the app.
function parseHash(): Screen {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (h === "settings") return { view: "settings" };
  if (h.startsWith("s/") && h.length > 2) return { view: "detail", name: h.slice(2).split("/")[0] };
  return { view: "list" };
}

function useScreen(): [Screen, (s: Screen) => void] {
  const [screen, set] = useState<Screen>(parseHash);
  useEffect(() => {
    const on = () => set(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((s: Screen) => {
    location.hash =
      s.view === "detail" ? `/s/${encodeURIComponent(s.name)}` : s.view === "settings" ? "/settings" : "/";
  }, []);
  return [screen, go];
}

function useWide() {
  const q = "(min-width: 768px)";
  const [wide, set] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => set(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

export default function App() {
  const [screen, go] = useScreen();
  const wide = useWide();
  const info = useQuery({ queryKey: ["info"], queryFn: api.info });
  const instances = useQuery({ queryKey: ["instances"], queryFn: api.instances });

  // On a desk the list and the server sit side by side, so the list route
  // still shows a server: the running one, or the first.
  const live = instances.data?.find((i) => i.status === "online");
  const shown =
    screen.view === "detail"
      ? screen.name
      : screen.view === "list" && wide
        ? (live?.name ?? instances.data?.[0]?.name)
        : undefined;
  const showList = wide || screen.view === "list";
  const showMain = wide || screen.view !== "list";

  return (
    <div className="flex h-full flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex h-12 shrink-0 items-stretch border-b border-edge">
        <button
          onClick={() => go({ view: "list" })}
          className="flex min-w-0 items-center gap-2.5 px-4 md:w-72 md:border-r md:border-edge"
        >
          <img src="/icon.svg" alt="" className="size-5" />
          <span className="text-[14px] font-semibold tracking-tight">conduit</span>
          <span className="truncate font-mono text-[11px] text-faint">/ {info.data?.hostname ?? "…"}</span>
        </button>
        <span className="flex-1" />
        {info.data?.pm2_error && (
          <button
            onClick={() => go({ view: "settings" })}
            title={info.data.pm2_error}
            className="flex items-center gap-2 border-l border-edge px-4 font-mono text-[11px] text-bad"
          >
            <Dot status="errored" /> pm2
          </button>
        )}
        {info.data?.pm2 && (
          <span className="hidden items-center border-l border-edge px-4 font-mono text-[11px] text-faint sm:flex">
            pm2 {info.data.pm2}
          </span>
        )}
        {info.data?.version && (
          <span className="hidden items-center border-l border-edge px-4 font-mono text-[11px] text-faint sm:flex">
            {info.data.version}
          </span>
        )}
        <button
          onClick={() => go({ view: "settings" })}
          className={`flex items-center border-l border-edge px-4 text-[13px] ${
            screen.view === "settings" ? "bg-panel text-ink" : "text-mute hover:text-ink"
          }`}
        >
          Settings
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {showList && (
          <aside className="scroll-quiet flex w-full shrink-0 flex-col overflow-y-auto md:w-72 md:border-r md:border-edge">
            <ServerList
              instances={instances.data}
              error={instances.error}
              loading={instances.isPending}
              selected={screen.view === "settings" ? undefined : shown}
              onOpen={(name) => go({ view: "detail", name })}
            />
          </aside>
        )}
        {showMain && (
          <main className="flex min-w-0 flex-1 flex-col">
            {screen.view === "settings" ? (
              <SettingsScreen onBack={() => go({ view: "list" })} />
            ) : shown ? (
              <Detail key={shown} name={shown} onBack={() => go({ view: "list" })} />
            ) : (
              wide && instances.data && <Empty />
            )}
          </main>
        )}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm">
        <div className="display text-[44px]">No servers yet.</div>
        <Hint className="mt-3">
          Conduit lists what pm2 runs and any server folder under the servers root. Folders it
          finds show up on the left to add. Point the servers root somewhere else in settings if
          the list stays empty.
        </Hint>
      </div>
    </div>
  );
}

function ServerList({
  instances,
  error,
  loading,
  selected,
  onOpen,
}: {
  instances?: Instance[];
  error: unknown;
  loading: boolean;
  selected?: string;
  onOpen: (n: string) => void;
}) {
  const qc = useQueryClient();
  const scan = useQuery({ queryKey: ["scan"], queryFn: api.scan, refetchInterval: false });
  const adopt = useMutation({
    mutationFn: (i: Partial<Instance>) => api.register(i),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instances"] });
      qc.invalidateQueries({ queryKey: ["scan"] });
    },
  });

  // Only one server runs at a time, because they all share port 25565. The
  // running one goes first so the list reads as "this one, and the others".
  const sorted = useMemo(
    () =>
      [...(instances ?? [])].sort(
        (a, b) => Number(b.status === "online") - Number(a.status === "online"),
      ),
    [instances],
  );

  return (
    <>
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-edge px-4">
        <Label>servers</Label>
        <Label>{instances ? instances.length : ""}</Label>
      </div>
      {error ? (
        <div className="px-4">
          <Problem error={error} />
        </div>
      ) : null}
      {loading && (
        <div className="flex items-center gap-2 border-b border-edge px-4 py-4 font-mono text-[11px] text-faint">
          <Spinner /> asking pm2
        </div>
      )}
      {instances?.length === 0 && (
        <Hint className="border-b border-edge px-4 py-4">No servers registered yet.</Hint>
      )}
      <ul>
        {sorted.map((i) => {
          const on = i.name === selected;
          return (
            <li key={i.name}>
              <button
                onClick={() => onOpen(i.name)}
                aria-current={on ? "page" : undefined}
                className={`relative flex w-full items-center gap-3 border-b border-edge px-4 py-3 text-left transition-colors ${
                  on ? "bg-panel" : "hover:bg-panel/60"
                }`}
              >
                {on && <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
                <Dot status={i.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{i.name}</span>
                  <span className="block truncate font-mono text-[10.5px] text-faint">
                    {i.version || i.dir.split("/").pop()}
                  </span>
                </span>
                <span
                  className={`shrink-0 font-mono text-[10.5px] ${
                    i.status === "online"
                      ? "text-live"
                      : i.status === "errored"
                        ? "text-bad"
                        : i.status === "unknown" || i.status === "launching" || i.status === "stopping"
                          ? "text-warn"
                          : "text-faint"
                  }`}
                >
                  {i.status === "online" ? uptime(i.uptime_ms) || "up" : statusWord(i.status)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {scan.data && scan.data.length > 0 && (
        <>
          <div className="mt-6 flex h-10 shrink-0 items-center border-y border-edge px-4">
            <Label>found on disk, not managed yet</Label>
          </div>
          <ul>
            {scan.data.map((i) => (
              <li key={i.name} className="flex items-center gap-3 border-b border-edge px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-mute">{i.name}</span>
                  <span className="block truncate font-mono text-[10.5px] text-faint">{i.dir}</span>
                </span>
                <Button
                  size="sm"
                  onClick={() => adopt.mutate(i)}
                  busy={adopt.isPending && adopt.variables?.name === i.name}
                >
                  Add
                </Button>
              </li>
            ))}
          </ul>
          {adopt.error && (
            <div className="px-4">
              <Problem error={adopt.error} />
            </div>
          )}
        </>
      )}
    </>
  );
}

type Tab = "console" | "backups" | "upgrades";
const tabNames: Record<Tab, string> = { console: "Console", backups: "Backups", upgrades: "Versions" };

function Detail({ name, onBack }: { name: string; onBack: () => void }) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["instances"] });
    qc.invalidateQueries({ queryKey: ["stats", name] });
  };

  // The tab rides in the hash too, replaced rather than pushed, so a refresh
  // keeps it without every tab switch becoming a back-button stop.
  const [tab, setTabState] = useState<Tab>(() => {
    const t = location.hash.split("/")[3] as Tab;
    return t in tabNames ? t : "console";
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    history.replaceState(null, "", `#/s/${encodeURIComponent(name)}${t === "console" ? "" : `/${t}`}`);
  };

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
  const other = instances.data?.find((i) => i.status === "online" && i.name !== name)?.name;

  const stats = useQuery({
    queryKey: ["stats", name],
    queryFn: () => api.stats(name),
    refetchInterval: (q) =>
      q.state.data?.status === "launching" || q.state.data?.status === "stopping" ? 1500 : 5000,
  });

  const start = useMutation({ mutationFn: () => api.start(name), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => api.stop(name), onSuccess: invalidate });
  const restart = useMutation({ mutationFn: () => api.restart(name), onSuccess: invalidate });
  const busy = start.isPending || stop.isPending || restart.isPending;
  const err = start.error ?? stop.error ?? restart.error;

  const status = stats.data?.status ?? inst?.status ?? "stopped";
  const online = status === "online";
  const moving = status === "launching" || status === "stopping";
  const disk = stats.data?.disk;
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const known = !!stats.data || !!inst;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-edge px-4 pb-5 pt-4 sm:px-6">
        <button onClick={onBack} className="mb-3 font-mono text-[11px] text-faint hover:text-ink md:hidden">
          ← servers
        </button>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <Dot status={status} />
              <span className={online ? "text-live" : status === "errored" ? "text-bad" : moving ? "text-warn" : "text-faint"}>
                {busy && !moving
                  ? start.isPending
                    ? "starting"
                    : stop.isPending
                      ? "stopping"
                      : "restarting"
                  : statusWord(status)}
                {online && stats.data?.uptime_ms ? ` for ${uptime(stats.data.uptime_ms)}` : ""}
              </span>
            </div>
            <h1 className="display mt-2.5 truncate text-[40px] sm:text-[52px]">{name}</h1>
            <div className="mt-2 truncate font-mono text-[11px] text-faint">
              {inst?.version || "no version recorded"}
            </div>
          </div>
          {/* Nothing until the status is known: a Start that turns into Stop
              a second later is a tap on the wrong button. */}
          {known && (
            <div className="flex gap-2">
              {online || status === "stopping" ? (
                <>
                  <Button key="restart" disabled={busy || moving} busy={restart.isPending} onClick={() => restart.mutate()}>
                    Restart
                  </Button>
                  <Button
                    key="stop"
                    variant="danger"
                    disabled={busy || moving}
                    busy={stop.isPending || status === "stopping"}
                    onClick={() => stop.mutate()}
                  >
                    Stop
                  </Button>
                </>
              ) : (
                <Button
                  key="start"
                  variant="primary"
                  disabled={busy || moving}
                  busy={start.isPending || status === "launching"}
                  onClick={() => (other ? setConfirmSwitch(true) : start.mutate())}
                >
                  {status === "launching" ? "Starting" : "Start"}
                </Button>
              )}
            </div>
          )}
        </div>
        {err && <Problem error={err} />}
      </div>

      <Stats stats={stats.data} online={online} />

      <nav className="flex h-10 shrink-0 items-stretch border-b border-edge">
        {(Object.keys(tabNames) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-current={tab === t ? "page" : undefined}
            className={`relative flex items-center gap-2 border-r border-edge px-4 text-[13px] transition-colors sm:px-6 ${
              tab === t ? "bg-panel text-ink" : "text-faint hover:text-mute"
            }`}
          >
            {tabNames[t]}
            {t === "backups" && watch && <Spinner className="text-accent" />}
            {tab === t && <span className="absolute inset-x-0 -bottom-px h-px bg-accent" />}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "console" ? (
          <Console name={name} inst={inst} online={online} />
        ) : tab === "upgrades" ? (
          <Upgrades name={name} online={online} freeBytes={disk?.free_bytes} />
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
      {confirmSwitch && other && (
        <Sheet
          title={`Switch to ${name}?`}
          onCancel={() => setConfirmSwitch(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirmSwitch(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmSwitch(false);
                  start.mutate();
                }}
              >
                Stop {other} and start
              </Button>
            </>
          }
        >
          {other} is running. Every server here shares one port, so it is stopped first and its
          players are disconnected.
        </Sheet>
      )}
    </div>
  );
}

// Stats is one ruled row of cells: whether the server is healthy, and how much
// room it takes.
function Stats({ stats, online }: { stats?: StatsT; online: boolean }) {
  const d = stats?.disk;
  const count = stats?.players_online ?? -1;
  // The count comes over RCON, and RCON is only connected while the console
  // prompt is in use. A dash says "not being read" rather than "nobody online".
  const players = online && stats?.rcon_open && count >= 0 ? `${count}/${stats?.players_max ?? "?"}` : "—";
  const who = stats?.rcon_open ? stats?.players?.join(", ") : "Click the console prompt to read the player list";

  const cells: [string, string, string?][] = [
    ["players", players, who],
    ["cpu", online ? `${(stats?.cpu_pct ?? 0).toFixed(0)}%` : "—"],
    ["memory", online && stats?.memory_mb ? `${(stats.memory_mb / 1024).toFixed(1)} GB` : "—"],
    ["world", d ? bytes(d.world_bytes) : "…"],
    ["backups", d ? bytes(d.backup_bytes) : "…"],
    ["disk free", d ? `${bytes(d.free_bytes)}` : "…", d ? `of ${bytes(d.total_bytes)}` : undefined],
  ];
  return (
    <dl className="grid shrink-0 grid-cols-3 border-b border-edge lg:grid-cols-6">
      {cells.map(([label, value, title], i) => (
        <div
          key={label}
          title={title || undefined}
          className={`border-edge px-4 py-3 sm:px-6 ${i % 3 !== 2 ? "border-r" : ""} ${
            i < 3 ? "border-b lg:border-b-0" : ""
          } lg:border-r lg:last:border-r-0`}
        >
          <dt>
            <Label>{label}</Label>
          </dt>
          <dd className="mt-1 font-mono text-[15px] tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// lineTone picks out the lines worth seeing in a wall of modded-server noise.
function lineTone(l: string): string {
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception|^\s+at |\tat /.test(l)) return "text-bad";
  if (/\bWARN(ING)?\b/.test(l)) return "text-warn";
  if (/Done \(|joined the game|left the game/.test(l)) return "text-ink";
  return "";
}

// Console is the server's log as a terminal, with the RCON prompt at the end
// of it. Reading the log needs no connection. The RCON connection opens the
// first time the prompt gets focus and is held until the tab goes away:
// nothing should open one just because a screen was looked at, and a
// connection per command wrote a connect and a disconnect line every time.
function Console({ name, inst, online }: { name: string; inst?: Instance; online: boolean }) {
  const qc = useQueryClient();
  const logs = useQuery({
    queryKey: ["logs", name],
    queryFn: () => api.logs(name),
    refetchInterval: online ? 2500 : 8000,
  });
  const [sent, setSent] = useState<{ cmd: string; reply: string; err?: boolean }[]>([]);
  const [cmd, setCmd] = useState("");
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);
  const input = useRef<HTMLInputElement>(null);

  const rconOff = !inst?.rcon_ready;
  const [rcon, setRcon] = useState<"idle" | "opening" | "open" | "failed">("idle");
  const [rconErr, setRconErr] = useState("");
  const opened = useRef(false);

  const connect = () => {
    if (opened.current || rconOff || !online) return;
    opened.current = true;
    setRcon("opening");
    api
      .openConsole(name)
      .then(() => {
        setRcon("open");
        qc.invalidateQueries({ queryKey: ["stats", name] });
      })
      .catch((e: Error) => {
        opened.current = false;
        setRcon("failed");
        setRconErr(e.message);
      });
  };

  useEffect(() => {
    if (!online) {
      opened.current = false;
      setRcon("idle");
    }
  }, [online]);

  // Hang up on the way out. Best effort: if the page is closing the request
  // may never land, and the agent drops idle sessions anyway.
  useEffect(
    () => () => {
      if (opened.current) {
        api.closeConsole(name).catch(() => {});
        qc.invalidateQueries({ queryKey: ["stats", name] });
      }
    },
    [name, qc],
  );

  const run = useMutation({
    mutationFn: (c: string) => api.console(name, c),
    onSuccess: (res) => setSent((s) => [...s, { cmd: res.command, reply: res.reply }]),
    onError: (e: Error, c) => setSent((s) => [...s, { cmd: c, reply: e.message, err: true }]),
  });

  const enable = useMutation({
    mutationFn: () => api.enableRcon(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instances"] }),
  });

  const lines = useMemo(
    () => (logs.data ?? (logs.error ? String(logs.error) : "")).split("\n"),
    [logs.data, logs.error],
  );

  const pane = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);

  // Record whether the reader was at the bottom before new text lands,
  // otherwise the check always sees the post-update scroll height.
  const onScroll = () => {
    const el = pane.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAway(!stick.current);
  };
  useLayoutEffect(() => {
    const el = pane.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, sent, run.isPending, cmd]);

  const jump = () => {
    const el = pane.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAway(false);
  };

  const submit = () => {
    const c = cmd.trim();
    if (!c || run.isPending) return;
    history.current = [c, ...history.current.filter((h) => h !== c)].slice(0, 50);
    cursor.current = -1;
    stick.current = true;
    run.mutate(c);
    setCmd("");
  };

  const title = `${inst?.dir?.replace(/^\/home\/[^/]+/, "~") ?? name} — latest.log`;
  const right =
    rcon === "open" ? (
      <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-live">
        <Dot status="online" /> rcon
      </span>
    ) : rcon === "opening" ? (
      <span className="font-mono text-[10.5px] text-faint">
        <Spinner /> rcon
      </span>
    ) : (
      <span className="font-mono text-[10.5px] text-faint">{online ? "tail -f" : "offline"}</span>
    );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col p-3 sm:p-6">
      <Window title={title} right={right} className="flex-1">
        <div
          ref={pane}
          onScroll={onScroll}
          // A click anywhere that is not a text selection goes to the prompt,
          // the way a terminal behaves.
          onMouseUp={() => {
            if (!window.getSelection()?.toString()) input.current?.focus({ preventScroll: true });
          }}
          className="scroll-quiet min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[11.5px] leading-[1.75] text-faint"
        >
          {logs.isPending && (
            <div>
              <Spinner /> reading the log
            </div>
          )}
          {lines.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap break-all ${lineTone(l)}`}>
              {l || " "}
            </div>
          ))}
          {sent.map((s, i) => (
            <div key={`s${i}`}>
              <div className="whitespace-pre-wrap break-all text-ink">
                <span className="text-accent">&gt;</span> {s.cmd}
              </div>
              <div className={`whitespace-pre-wrap break-all ${s.err ? "text-bad" : "text-mute"}`}>
                {s.reply || "(no reply)"}
              </div>
            </div>
          ))}

          {!online ? (
            <div className="mt-1 text-faint"># the server is not running</div>
          ) : rconOff ? (
            <div className="mt-1 text-faint">
              # the console is off.{" "}
              <button
                onClick={() => enable.mutate()}
                disabled={enable.isPending}
                className="text-accent underline underline-offset-4 hover:text-ink"
              >
                {enable.isPending ? "turning it on…" : "turn it on"}
              </button>{" "}
              (writes 3 lines into server.properties, takes effect on restart)
              {enable.data?.restart_required && <div className="text-warn"># written. restart the server to connect.</div>}
              {enable.error && <div className="text-bad"># {enable.error.message}</div>}
            </div>
          ) : (
            <label className="prompt relative mt-1 flex cursor-text items-baseline whitespace-pre-wrap break-all text-ink">
              <span className="mr-[1ch] shrink-0 text-accent">&gt;</span>
              <span className="min-w-0">
                {run.isPending ? (
                  <>
                    {history.current[0]} <Spinner className="text-faint" />
                  </>
                ) : (
                  <>
                    {cmd}
                    <span className="cursor" />
                    {!cmd && rcon !== "open" && (
                      <span className="ml-[1ch] text-faint">
                        {rcon === "failed" ? `rcon did not answer: ${rconErr}` : "type a command"}
                      </span>
                    )}
                  </>
                )}
              </span>
              <input
                ref={input}
                value={cmd}
                onFocus={connect}
                onChange={(e) => setCmd(e.target.value)}
                // Enter sends; up and down walk back through what was sent.
                onKeyDown={(e) => {
                  const h = history.current;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  } else if (e.key === "ArrowUp" && cursor.current < h.length - 1) {
                    e.preventDefault();
                    cursor.current++;
                    setCmd(h[cursor.current]);
                  } else if (e.key === "ArrowDown" && cursor.current >= 0) {
                    e.preventDefault();
                    cursor.current--;
                    setCmd(cursor.current < 0 ? "" : h[cursor.current]);
                  }
                }}
                aria-label="Server command"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="send"
                className="absolute inset-0 w-full cursor-text opacity-0"
              />
            </label>
          )}
        </div>
      </Window>
      {away && (
        <button
          onClick={jump}
          className="absolute bottom-6 right-7 rounded border border-edge-strong bg-term px-2.5 py-1 font-mono text-[10.5px] text-mute hover:text-ink sm:bottom-9 sm:right-10"
        >
          ↓ latest
        </button>
      )}
    </div>
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
  const rollbacks = useQuery({ queryKey: ["rollbacks", name], queryFn: () => api.rollbacks(name) });

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
  const rollback = useMutation({ mutationFn: (file: string) => api.restoreBackup(name, file), onSuccess: refresh });
  const undo = useMutation({ mutationFn: (dir: string) => api.undoRollback(name, dir), onSuccess: refresh });
  const dropRollback = useMutation({ mutationFn: (dir: string) => api.deleteRollback(name, dir), onSuccess: refresh });
  const dropBackup = useMutation({ mutationFn: (file: string) => api.deleteBackup(name, file), onSuccess: refresh });

  const [confirming, setConfirming] = useState<Backup | null>(null);
  const [droppingRollback, setDroppingRollback] = useState<string | null>(null);
  const [droppingBackup, setDroppingBackup] = useState<string | null>(null);
  const working = rollback.isPending || undo.isPending;
  const backingUp = create.isPending || watching;

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge px-4 py-4 sm:px-6">
        <Button
          variant="primary"
          onClick={() => create.mutate()}
          disabled={!online || !rconReady || backingUp || working}
          busy={backingUp}
        >
          {backingUp ? "Backing up" : "Back up now"}
        </Button>
        <Hint className="min-w-0 flex-1">
          {!rconReady
            ? "Needs the console turned on."
            : !online
              ? "The server has to be running."
              : create.isPending
                ? "Asking the server…"
                : watching
                  ? "The mod is zipping the world. This can take a minute."
                  : "Runs the server's own backup command."}
        </Hint>
      </div>

      <div className="px-4 sm:px-6">
        {create.error && <Problem error={create.error} />}
        {rollback.error && <Problem error={rollback.error} />}
        {undo.error && <Problem error={undo.error} />}
        {dropRollback.error && <Problem error={dropRollback.error} />}
        {dropBackup.error && <Problem error={dropBackup.error} />}
        {gaveUp && (
          <Notice tone="warn">
            No new backup showed up after three minutes. The command was sent, so check the console
            for what the mod said.
          </Notice>
        )}
        {working && (
          <Notice tone="warn">
            Working. This stops the server, swaps the world and starts it again, so it takes a few
            minutes. Do not reload.
          </Notice>
        )}
        {rollback.data && (
          <Notice>
            Rolled back. The world you had is kept as {rollback.data.previous_world}
            {rollback.data.restarted && ", and the server is starting again"}.
          </Notice>
        )}
        {undo.data && (
          <Notice>
            Put back. The world you had is kept as {undo.data.previous_world}
            {undo.data.restarted && ", and the server is starting again"}.
          </Notice>
        )}
      </div>

      {rollbacks.data && rollbacks.data.length > 0 && (
        <Section title="Worlds saved before a rollback" aside={<Label>kept until you delete them</Label>}>
          <ul>
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
        </Section>
      )}

      <Section title="Backups" aside={list.data?.length ? <Label>the mod keeps the newest 5</Label> : undefined}>
        <ul>
          {watching && (
            <li className="flex items-center gap-4 border-b border-edge px-4 py-3 sm:px-6">
              <span className="flex size-10 shrink-0 items-center justify-center border border-dashed border-edge-strong text-accent">
                <Spinner />
              </span>
              <span className="font-mono text-[11px] text-mute">zipping the world…</span>
            </li>
          )}
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
          <Hint className="px-4 py-5 sm:px-6">No backups on disk yet. They show up here once the server makes one.</Hint>
        )}
      </Section>

      {confirming && (
        <Sheet
          title={`Roll back to ${fmtDate(confirming.created)}?`}
          onCancel={() => setConfirming(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const file = confirming.file;
                  setConfirming(null);
                  rollback.mutate(file);
                }}
              >
                Roll back
              </Button>
            </>
          }
        >
          {since(confirming.created)} of play since then is gone: blocks, inventories, quests,
          everything. The world you have now is kept as a copy you can put back.
        </Sheet>
      )}
    </div>
  );
}

function Thumb({ src }: { src?: string }) {
  // FTB Backups 2 stores a map thumbnail in backups.json.
  return src ? (
    <img src={src} alt="" className="size-10 shrink-0 border border-edge object-cover [image-rendering:pixelated]" />
  ) : (
    <span className="size-10 shrink-0 border border-edge bg-panel" />
  );
}

// NewBackup confirms the file landed, with the map thumbnail so it is obvious
// which world was captured.
function NewBackup({ b, onClose }: { b: Backup; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 12_000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="fixed bottom-0 right-0 z-20 w-full p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:w-96 sm:p-6">
      <div role="status" className="flex items-center gap-3 rounded-md border border-live/60 bg-bg p-3">
        <Thumb src={b.preview} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-live">Backup done</div>
          <div className="truncate font-mono text-[10.5px] text-faint">
            {fmtDate(b.created)} {bytes(b.size)}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function DeleteConfirm({ question, onDelete, onCancel }: { question: string; onDelete: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-edge px-4 py-2.5 sm:px-6">
      <span className="min-w-0 flex-1 text-[12.5px] text-bad">{question}</span>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" variant="danger" onClick={onDelete}>
        Delete
      </Button>
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
    <li className="border-b border-edge last:border-b-0">
      <div className="flex items-center gap-4 px-4 py-3 sm:px-6">
        <span className="h-10 w-[2px] shrink-0 bg-warn" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{since(r.created)} ago</div>
          <div className="truncate font-mono text-[10.5px] text-faint">
            {fmtDate(r.created)} {bytes(r.size_bytes)}
            {r.replaced_by && `, replaced by ${r.replaced_by}`}
          </div>
        </div>
        {!confirmingDelete && (
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" onClick={onUndo} disabled={busy}>
              Put back
            </Button>
            <Button size="sm" variant="ghost" onClick={onAskDelete} disabled={busy}>
              Delete
            </Button>
          </div>
        )}
      </div>
      {confirmingDelete && (
        <DeleteConfirm question="Delete this world for good? It is the only copy." onDelete={onDelete} onCancel={onCancelDelete} />
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
    <li className={`border-b border-edge last:border-b-0 ${isNew ? "bg-live/[0.05]" : ""}`}>
      <div className="flex items-center gap-4 px-4 py-3 sm:px-6">
        <Thumb src={b.preview} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="truncate">{since(b.created)} ago</span>
            {isNew && <span className="font-mono text-[10.5px] text-live">new</span>}
          </div>
          <div className="truncate font-mono text-[10.5px] text-faint">
            {fmtDate(b.created)}
            <span className="sm:hidden"> {bytes(b.size)}</span>
          </div>
        </div>
        <span className="hidden w-44 truncate font-mono text-[10.5px] text-faint xl:block">{b.version}</span>
        <span className="hidden w-16 text-right font-mono text-[11px] text-mute sm:block">{bytes(b.size)}</span>
        {!confirmingDelete && (
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" onClick={onAsk} disabled={busy}>
              Roll back
            </Button>
            <Button size="sm" variant="ghost" onClick={onAskDelete} disabled={busy}>
              Delete
            </Button>
          </div>
        )}
      </div>
      {confirmingDelete && <DeleteConfirm question="Delete this backup file?" onDelete={onDelete} onCancel={onCancelDelete} />}
    </li>
  );
}

function SettingsScreen({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const info = useQuery({ queryKey: ["info"], queryFn: api.info });
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
  const [releasing, setReleasing] = useState(false);
  const s = settings.data;

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-edge px-4 pb-5 pt-4 sm:px-6">
        <button onClick={onBack} className="mb-3 font-mono text-[11px] text-faint hover:text-ink md:hidden">
          ← servers
        </button>
        <h1 className="display text-[40px] sm:text-[52px]">Settings</h1>
      </div>

      {(settings.error || save.error || info.data?.pm2_error) && (
        <div className="px-4 sm:px-6">
          {settings.error && <Problem error={settings.error} />}
          {save.error && <Problem error={save.error} />}
          {info.data?.pm2_error && <Notice tone="bad">pm2 did not answer: {info.data.pm2_error}</Notice>}
        </div>
      )}

      {s && (
        <>
          <Section title="Paths" aside={<Label>empty means detect it</Label>}>
            <Field label="pm2" value={s.pm2_bin} detected={s.detected?.pm2_bin} onSave={(v) => save.mutate({ pm2_bin: v })} />
            <Field
              label="node bin folder"
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
          </Section>

          <Section title="CurseForge" aside={<Label>{s.has_curseforge_key ? "key stored" : "no key"}</Label>}>
            <form
              className="grid items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[13rem_1fr_auto] sm:px-6"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate({ curseforge_key: key });
                setKey("");
              }}
            >
              <Label className="text-mute">api key</Label>
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                aria-label="CurseForge API key"
                placeholder={s.has_curseforge_key ? "paste a new key to replace it" : "paste key"}
                className="h-8 min-w-0 rounded border border-edge bg-term px-2.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-edge-strong"
              />
              <Button disabled={!key.trim()}>Save</Button>
            </form>
            <Hint className="px-4 pb-3 sm:px-6">Kept on this machine. It is never sent back to the browser.</Hint>
          </Section>

          <Section title="Access">
            <div className="grid items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[13rem_1fr_auto] sm:px-6">
              <Label className="text-mute">owner</Label>
              <span className="truncate font-mono text-[12px]">{s.owner || "unclaimed"}</span>
              {s.owner && !releasing ? (
                <Button size="sm" variant="danger" onClick={() => setReleasing(true)}>
                  Release
                </Button>
              ) : (
                <span />
              )}
            </div>
            {releasing && (
              <DeleteConfirm
                question="The next tailnet login to open Conduit becomes the owner."
                onCancel={() => setReleasing(false)}
                onDelete={() => {
                  setReleasing(false);
                  save.mutate({ owner: "" });
                }}
              />
            )}
            <div className="border-t border-edge px-4 py-3 sm:px-6">
              <Hint>Let someone else in, from a shell on this machine:</Hint>
              <code className="mt-1.5 block font-mono text-[11.5px] text-mute">
                <span className="text-accent">$</span> conduitd --allow friend@example.com
              </code>
            </div>
          </Section>

          {info.data && (
            <Section title="This machine">
              <dl className="grid grid-cols-2 lg:grid-cols-4">
                {[
                  ["conduit", info.data.version ?? "dev"],
                  ["pm2", info.data.pm2 || "—"],
                  ["platform", `${info.data.os ?? ""}/${info.data.arch}`],
                  ["signed in as", info.data.user],
                ].map(([l, v], i) => (
                  <div
                    key={l}
                    className={`border-edge px-4 py-3 sm:px-6 ${i % 2 === 0 ? "border-r" : ""} ${
                      i < 2 ? "border-b lg:border-b-0" : ""
                    } lg:border-r lg:last:border-r-0`}
                  >
                    <dt>
                      <Label>{l}</Label>
                    </dt>
                    <dd className="mt-1 truncate font-mono text-[13px]">{v}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}
        </>
      )}
    </div>
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
    <form
      className="grid items-center gap-x-4 gap-y-2 border-b border-edge px-4 py-3 last:border-b-0 sm:grid-cols-[13rem_1fr_auto] sm:px-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(shown);
        setDraft(null);
      }}
    >
      <span className="flex items-baseline gap-2">
        <Label className="text-mute">{label}</Label>
        {detected ? (
          <Label className="text-live">detected</Label>
        ) : value ? (
          <Label>set by you</Label>
        ) : (
          <Label className="text-bad">not found</Label>
        )}
      </span>
      <input
        value={shown}
        placeholder={value || "not found"}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={label}
        spellCheck={false}
        autoCapitalize="off"
        className="h-8 min-w-0 rounded border border-edge bg-term px-2.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-edge-strong"
      />
      <Button disabled={draft === null}>Save</Button>
    </form>
  );
}
