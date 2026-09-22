package upgrade

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

// packZip writes a zip whose entries are name -> contents.
func packZip(t *testing.T, path string, files map[string]string) string {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestProbeFlatServerPack(t *testing.T) {
	zipPath := packZip(t, filepath.Join(t.TempDir(), "pack.zip"), map[string]string{
		"mods/a.jar": "a", "mods/b.jar": "b", "run.sh": "java", "config/x.toml": "x",
	})
	l, err := Probe(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	if l.Root != "" || l.Mods != 2 || !l.HasRun {
		t.Fatalf("got %+v", l)
	}
}

func TestProbeSingleRootDirectory(t *testing.T) {
	zipPath := packZip(t, filepath.Join(t.TempDir(), "pack.zip"), map[string]string{
		"ATM10-1.3/mods/a.jar": "a", "ATM10-1.3/run.sh": "java",
	})
	l, err := Probe(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	if l.Root != "ATM10-1.3" || l.Mods != 1 {
		t.Fatalf("got %+v", l)
	}
}

func TestProbeCurseForgeClientZip(t *testing.T) {
	zipPath := packZip(t, filepath.Join(t.TempDir(), "pack.zip"), map[string]string{
		"manifest.json":          `{"name":"All the Mods 10","version":"1.3.0"}`,
		"overrides/mods/a.jar":   "a",
		"overrides/config/x.cfg": "x",
	})
	l, err := Probe(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	if l.Root != "overrides" {
		t.Fatalf("root = %q", l.Root)
	}
	if l.Label != "All the Mods 10 1.3.0" {
		t.Fatalf("label = %q", l.Label)
	}
}

// A zip of nothing but a mods folder also has exactly one top-level directory,
// and reading that as the pack root would unpack the jars loose into the
// instance and leave it with no mods at all.
func TestProbeDoesNotMistakeModsForThePackRoot(t *testing.T) {
	zipPath := packZip(t, filepath.Join(t.TempDir(), "mods.zip"), map[string]string{
		"mods/a.jar": "a", "mods/b.jar": "b",
	})
	l, err := Probe(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	if l.Root != "" || l.Mods != 2 {
		t.Fatalf("got %+v", l)
	}
}

func TestProbeRejectsSomethingThatIsNotAPack(t *testing.T) {
	zipPath := packZip(t, filepath.Join(t.TempDir(), "holiday.zip"), map[string]string{
		"photo.png": "not a modpack",
	})
	if _, err := Probe(zipPath); err == nil {
		t.Fatal("a zip with no mods, no run.sh and no jar was accepted")
	}
}

// A mod dropped by the new pack must not survive the upgrade: a stale jar is a
// crash on boot or a corrupted world, and merging is what leaves one behind.
func TestApplyReplacesModsAndKeepsOperatorFiles(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "mods", "old.jar"), "old")
	write(t, filepath.Join(dir, "server.properties"), "level-name=world\nrcon.password=secret\n")
	write(t, filepath.Join(dir, "ops.json"), `[{"name":"me"}]`)
	write(t, filepath.Join(dir, "config", "mine.toml"), "hand edited")
	write(t, filepath.Join(dir, "world", "level.dat"), "save")
	write(t, filepath.Join(dir, "run.sh"), "old launcher")

	zipPath := packZip(t, filepath.Join(t.TempDir(), "pack.zip"), map[string]string{
		"mods/new.jar":      "new",
		"config/pack.toml":  "pack",
		"server.properties": "level-name=world\nrcon.password=\n",
		"ops.json":          "[]",
		"run.sh":            "new launcher",
		"world/level.dat":   "a world from the pack",
	})
	l, err := Probe(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	rep, err := Apply(dir, zipPath, l)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(dir, "mods", "old.jar")); !os.IsNotExist(err) {
		t.Fatal("the old mod is still there")
	}
	if read(t, filepath.Join(dir, "mods", "new.jar")) != "new" {
		t.Fatal("the new mod was not written")
	}
	if got := read(t, filepath.Join(dir, "server.properties")); got != "level-name=world\nrcon.password=secret\n" {
		t.Fatalf("server.properties was overwritten: %q", got)
	}
	if read(t, filepath.Join(dir, "ops.json")) != `[{"name":"me"}]` {
		t.Fatal("ops.json was overwritten")
	}
	if read(t, filepath.Join(dir, "config", "mine.toml")) != "hand edited" {
		t.Fatal("a config the new pack does not ship was lost")
	}
	if read(t, filepath.Join(dir, "config", "pack.toml")) != "pack" {
		t.Fatal("the pack config was not written")
	}
	if read(t, filepath.Join(dir, "run.sh")) != "new launcher" {
		t.Fatal("run.sh should come from the pack, it pins the java path")
	}
	if read(t, filepath.Join(dir, "world", "level.dat")) != "save" {
		t.Fatal("the pack overwrote the world")
	}
	if len(rep.Preserved) != 2 {
		t.Fatalf("preserved = %v", rep.Preserved)
	}
}

func TestApplyKeepsRunShExecutable(t *testing.T) {
	dir := t.TempDir()
	zipPath := packZip(t, filepath.Join(t.TempDir(), "pack.zip"), map[string]string{
		"mods/a.jar": "a", "run.sh": "#!/bin/sh\n",
	})
	l, err := Probe(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(dir, zipPath, l); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, "run.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&0o111 == 0 {
		t.Fatalf("run.sh is not executable: %v", fi.Mode())
	}
}

// The snapshot is the downgrade path, so what it does and does not contain is
// the load bearing part: every pack file, no world.
func TestSnapshotAndRestoreLeaveTheWorldAlone(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "mods", "v1.jar"), "v1")
	write(t, filepath.Join(dir, "config", "c.toml"), "v1 config")
	write(t, filepath.Join(dir, "user_jvm_args.txt"), "-Xmx8G")
	write(t, filepath.Join(dir, "world", "level.dat"), "the save")
	write(t, filepath.Join(dir, "backups", "old.zip"), "a backup")
	write(t, filepath.Join(dir, "logs", "latest.log"), "log")

	snap := filepath.Join(t.TempDir(), "v1.zip")
	if _, err := Snapshot(dir, snap); err != nil {
		t.Fatal(err)
	}

	zr, err := zip.OpenReader(snap)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		switch {
		case f.Name == "world/" || f.Name == "world/level.dat":
			t.Fatal("the world is inside the snapshot")
		case f.Name == "backups/old.zip":
			t.Fatal("the backups are inside the snapshot")
		case f.Name == "logs/latest.log":
			t.Fatal("the logs are inside the snapshot")
		}
	}
	zr.Close()

	// Upgrade to v2: new mod, world moves on, a config is deleted.
	os.RemoveAll(filepath.Join(dir, "mods"))
	write(t, filepath.Join(dir, "mods", "v2.jar"), "v2")
	os.Remove(filepath.Join(dir, "config", "c.toml"))
	write(t, filepath.Join(dir, "world", "level.dat"), "the save, later")

	if err := Restore(dir, snap); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "mods", "v2.jar")); !os.IsNotExist(err) {
		t.Fatal("a mod from the version being undone survived")
	}
	if read(t, filepath.Join(dir, "mods", "v1.jar")) != "v1" {
		t.Fatal("the old mod did not come back")
	}
	if read(t, filepath.Join(dir, "config", "c.toml")) != "v1 config" {
		t.Fatal("the old config did not come back")
	}
	if read(t, filepath.Join(dir, "world", "level.dat")) != "the save, later" {
		t.Fatal("going back to older files rewound the world")
	}
	if read(t, filepath.Join(dir, "backups", "old.zip")) != "a backup" {
		t.Fatal("going back deleted the backups")
	}
}

// A pack zip is a file the operator uploaded, so its entry names are not
// trusted. A traversal is clamped into the instance directory rather than
// reaching the rest of the disk.
func TestSafeJoinClampsEscapingEntries(t *testing.T) {
	got, err := safeJoin("/srv/atm10", "../../etc/passwd")
	if err != nil {
		t.Fatal(err)
	}
	if got != "/srv/atm10/etc/passwd" {
		t.Fatalf("a traversal entry escaped: %q", got)
	}
}

func TestStageRejectsAndForgetsABadZip(t *testing.T) {
	cache := t.TempDir()
	bad := packZip(t, filepath.Join(t.TempDir(), "holiday.zip"), map[string]string{"photo.png": "x"})
	f, err := os.Open(bad)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := Stage(cache, f, "holiday.zip"); err == nil {
		t.Fatal("a zip that is not a pack was staged")
	}
	entries, err := os.ReadDir(cache)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the rejected upload was left in the cache: %v", entries)
	}
}

func TestStageIsContentAddressed(t *testing.T) {
	cache := t.TempDir()
	pack := packZip(t, filepath.Join(t.TempDir(), "pack.zip"), map[string]string{
		"mods/a.jar": "a", "run.sh": "java",
	})
	first, err := StageFile(cache, pack)
	if err != nil {
		t.Fatal(err)
	}
	second, err := StageFile(cache, pack)
	if err != nil {
		t.Fatal(err)
	}
	if first.SHA256 != second.SHA256 {
		t.Fatal("the same pack got two hashes")
	}
	list, err := ListArtifacts(cache)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("the same pack was stored twice: %d", len(list))
	}
	if got, err := FindArtifact(cache, first.SHA256); err != nil || got.Layout.Mods != 1 {
		t.Fatalf("find: %+v %v", got, err)
	}
}
