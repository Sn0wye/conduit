// The two pieces every screen needs. They live apart from App so the tabs can
// use them without importing the file that imports the tabs.

export function Spinner() {
  return (
    <span className="size-3 shrink-0 animate-spin rounded-full border border-mute border-t-transparent" />
  );
}

export function Problem({ error }: { error: unknown }) {
  return (
    <p className="mx-4 my-3 rounded border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
