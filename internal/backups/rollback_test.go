package backups

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Undo swaps the worlds and keeps the one it displaced, so undoing twice
// returns to where it started.
func TestUndoIsReversible(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "world", "level.dat"), "restored")
	saved := filepath.Join(dir, rollbackPrefix+"20260101-000000")
	write(t, filepath.Join(saved, "level.dat"), "original")
	writeMarker(saved, "some-backup.zip", "world")

	movedTo, err := Undo(dir, filepath.Base(saved))
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dir, "world", "level.dat")); got != "original" {
		t.Fatalf("world is %q, want the saved one", got)
	}
	if got := read(t, filepath.Join(movedTo, "level.dat")); got != "restored" {
		t.Fatalf("displaced world is %q, want the one that was live", got)
	}

	if _, err := Undo(dir, filepath.Base(movedTo)); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dir, "world", "level.dat")); got != "restored" {
		t.Fatalf("after undoing the undo the world is %q", got)
	}
}

func TestRejectsNamesOutsideTheInstance(t *testing.T) {
	for _, bad := range []string{"../etc", "world", "world.before-restore-x/../..", ".."} {
		if err := checkRollbackName(bad); err == nil {
			t.Fatalf("%q was accepted", bad)
		}
	}
}

func TestListFlagsKindAndSource(t *testing.T) {
	dir := t.TempDir()
	saved := filepath.Join(dir, rollbackPrefix+"20260101-000000")
	write(t, filepath.Join(saved, "level.dat"), "x")
	writeMarker(saved, "2026-9-9_2-0-0.zip", "world")
	write(t, filepath.Join(dir, "world", "level.dat"), "y")

	list, err := ListRollbacks(dir, DirBytesStub)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("got %d entries, want only the moved-aside world", len(list))
	}
	if list[0].Kind != "pre_restore" {
		t.Fatalf("kind is %q", list[0].Kind)
	}
	if list[0].ReplacedBy != "2026-9-9_2-0-0.zip" {
		t.Fatalf("replaced_by is %q", list[0].ReplacedBy)
	}
}

func DirBytesStub(string) int64 { return 1 }

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
