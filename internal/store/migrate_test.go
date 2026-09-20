package store

import (
	"context"
	"path/filepath"
	"testing"
)

// An instances table written by the previous schema must survive the upgrade.
func TestAddsMissingColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.sql.Exec(`ALTER TABLE instances DROP COLUMN backup_cmd`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	db, err = Open(path)
	if err != nil {
		t.Fatalf("reopen after the column was missing: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	if err := db.PutInstance(ctx, Instance{Name: "a", Dir: "/tmp"}); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetInstance(ctx, "a")
	if err != nil {
		t.Fatal(err)
	}
	if got.BackupCmd != "backup start" {
		t.Fatalf("backup_cmd = %q, want the default", got.BackupCmd)
	}
}
