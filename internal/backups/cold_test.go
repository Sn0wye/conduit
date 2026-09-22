package backups

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A cold backup has to be readable by Restore, which expects the archive to be
// rooted at the world directory. Otherwise the backup taken before an upgrade
// is exactly the one that cannot be put back.
func TestCreateRoundTripsThroughRestore(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "world", "level.dat"), "save")
	writeFile(t, filepath.Join(dir, "world", "region", "r.0.0.mca"), "chunks")
	writeFile(t, filepath.Join(dir, "mods", "a.jar"), "a mod")

	b, err := Create(dir, "ATM10 1.2.1")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(b.Path) != Dir(dir) {
		t.Fatalf("backup landed outside the backups directory: %s", b.Path)
	}

	zr, err := zip.OpenReader(b.Path)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if f.Name == "mods/a.jar" {
			t.Fatal("a cold backup of the world swallowed the mods")
		}
	}
	zr.Close()

	writeFile(t, filepath.Join(dir, "world", "level.dat"), "a later save")
	if _, err := Restore(dir, b.File); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "world", "level.dat"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "save" {
		t.Fatalf("the world was not put back: %q", got)
	}
}

func TestWorldDirFindsARenamedSave(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "bigworld", "level.dat"), "save")
	writeFile(t, filepath.Join(dir, "config", "x.toml"), "not a world")
	got, err := WorldDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != "bigworld" {
		t.Fatalf("world dir = %q", got)
	}
}

func TestCreateSaysSoWhenThereIsNoWorld(t *testing.T) {
	if _, err := Create(t.TempDir(), "x"); err == nil {
		t.Fatal("a backup of nothing was reported as taken")
	}
}
