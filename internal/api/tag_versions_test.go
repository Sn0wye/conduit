package api

import (
	"testing"
	"time"

	"github.com/snowye/conduit/internal/backups"
	"github.com/snowye/conduit/internal/store"
)

// Restoring a world into the wrong version of the mods is the mistake the tag
// exists to prevent, so a backup taken in the same second as the upgrade that
// followed it must still read as the older version.
func TestTagVersionsUsesTheRecordedBackupFirst(t *testing.T) {
	at := time.Date(2026, 9, 21, 22, 19, 54, 0, time.UTC)
	versions := []store.Version{
		{Label: "ATM10 1.3.0", AppliedAt: at.Add(400 * time.Millisecond)},
		{Label: "ATM10 1.2.1", AppliedAt: at.Add(-72 * time.Hour), WorldBackup: "pre-upgrade.zip"},
	}
	list := []backups.Backup{
		{File: "pre-upgrade.zip", Created: at.Add(100 * time.Millisecond)},
		{File: "nightly.zip", Created: at.Add(-time.Hour)},
		{File: "after.zip", Created: at.Add(time.Hour)},
	}
	tagVersions(list, versions)

	want := map[string]string{
		"pre-upgrade.zip": "ATM10 1.2.1",
		"nightly.zip":     "ATM10 1.2.1",
		"after.zip":       "ATM10 1.3.0",
	}
	for _, b := range list {
		if b.Version != want[b.File] {
			t.Errorf("%s tagged %q, want %q", b.File, b.Version, want[b.File])
		}
	}
}

// A backup older than every version predates Conduit. Guessing a label for it
// would be worse than leaving it blank.
func TestTagVersionsLeavesOlderBackupsAlone(t *testing.T) {
	list := []backups.Backup{{File: "ancient.zip", Created: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)}}
	tagVersions(list, []store.Version{{Label: "ATM10 1.3.0", AppliedAt: time.Now()}})
	if list[0].Version != "" {
		t.Fatalf("got %q, want no label", list[0].Version)
	}
}
