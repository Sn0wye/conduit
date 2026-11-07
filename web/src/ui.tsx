// The pieces every screen is built from. They live apart from App so the tabs
// can use them without importing the file that imports the tabs.

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// Spinner is a terminal spinner rather than a ring, so waiting looks the same
// inside the terminal and outside it.
export function Spinner({ className = "" }: { className?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <span aria-hidden className={`inline-block w-[1ch] font-mono ${className}`}>
      {frames[i]}
    </span>
  );
}

type Tone = "bad" | "warn" | "live" | "plain";

const toneText: Record<Tone, string> = {
  bad: "border-bad text-bad",
  warn: "border-warn text-warn",
  live: "border-live text-live",
  plain: "border-edge-strong text-mute",
};

// Notice is a line of text with a rule beside it, not a box.
export function Notice({ tone = "plain", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <p
      role={tone === "bad" ? "alert" : undefined}
      className={`my-3 border-l-2 py-0.5 pl-3 text-[13px] leading-relaxed ${toneText[tone]}`}
    >
      {children}
    </p>
  );
}

export function Problem({ error }: { error: unknown }) {
  return <Notice tone="bad">{error instanceof Error ? error.message : String(error)}</Notice>;
}

export function Dot({ status }: { status: string }) {
  const tone =
    status === "online"
      ? "dot-live"
      : status === "errored"
        ? "bg-bad"
        : // unknown means pm2 could not be reached, which is a problem.
          status === "unknown"
          ? "bg-warn"
          : status === "launching" || status === "stopping"
            ? "bg-warn animate-pulse"
            : "bg-dead";
  return <span aria-hidden className={`inline-block size-[7px] shrink-0 rounded-full ${tone}`} />;
}

export function statusWord(status: string): string {
  switch (status) {
    case "online":
      return "running";
    case "errored":
      return "crashed";
    case "unknown":
      return "pm2 unreachable";
    case "launching":
      return "starting";
    case "stopping":
      return "stopping";
    case "not_started":
      return "never started";
    default:
      return "stopped";
  }
}

type Variant = "primary" | "default" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary: "border-ink bg-ink text-bg hover:bg-white hover:border-white",
  default: "border-edge-strong text-ink hover:bg-raised",
  danger: "border-bad/60 text-bad hover:bg-bad/10",
  ghost: "border-transparent text-mute hover:text-ink",
};

export function Button({
  variant = "default",
  size = "md",
  busy,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  busy?: boolean;
}) {
  const pad = size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]";
  return (
    <button
      {...rest}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded border font-medium transition-colors disabled:pointer-events-none disabled:opacity-35 ${pad} ${variants[variant]} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

// Label is the small monospace caption that names a value or a column.
export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[10.5px] text-faint ${className}`}>{children}</span>;
}

// Section is a block with a ruled header: name on the left, an optional note
// or action on the right, and the content below the line.
export function Section({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-edge">
      <header className="flex min-h-10 items-center gap-3 border-b border-edge px-4 sm:px-6">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <span className="flex-1" />
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Hint({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[12.5px] leading-relaxed text-faint ${className}`}>{children}</p>;
}

// Window is the terminal frame: a title bar with the three lights, a title in
// monospace, something on the right, and a black body.
export function Window({
  title,
  right,
  children,
  className = "",
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-h-0 flex-col overflow-hidden rounded-md border border-edge-strong/70 bg-term ${className}`}>
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-edge px-3.5">
        <span className="flex gap-1.5" aria-hidden>
          <i className="size-[9px] rounded-full bg-[#3a3a3e]" />
          <i className="size-[9px] rounded-full bg-[#3a3a3e]" />
          <i className="size-[9px] rounded-full bg-[#3a3a3e]" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

// Sheet is every confirmation. It sits at the bottom on a phone, so the second
// tap never lands where the first one was, and in the middle on a desk.
// Escape and the backdrop both cancel.
export function Sheet({
  title,
  children,
  actions,
  onCancel,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onCancel?: () => void;
}) {
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center">
      {onCancel && (
        <button aria-label="Cancel" onClick={onCancel} className="absolute inset-0 cursor-default bg-black/70" />
      )}
      <div
        role="dialog"
        aria-modal
        className="relative mx-auto w-full max-w-lg border-t border-edge-strong bg-bg sm:rounded-md sm:border"
      >
        <div className="border-b border-edge px-5 py-4 text-[15px] font-semibold">{title}</div>
        {children && <div className="px-5 py-4 text-[13px] leading-relaxed text-mute">{children}</div>}
        <div className="flex justify-end gap-2 border-t border-edge px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {actions}
        </div>
      </div>
    </div>
  );
}
