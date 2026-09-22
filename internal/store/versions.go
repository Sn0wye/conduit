package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Version is one state of an instance's server files. The table is append
// only: an upgrade adds a row, and so does going back, so the list reads as
// what happened to this server in the order it happened.
type Version struct {
	ID       int64  `json:"id"`
	Instance string `json:"instance"`
	// Label is what the operator calls this pack version, defaulted from the
	// pack manifest when it has one.
	Label string `json:"label"`
	// Source says where the files came from: baseline for whatever was on disk
	// before Conduit ever touched it, upload or path for a pack zip, revert for
	// a row that put an older version back.
	Source       string `json:"source"`
	Artifact     string `json:"artifact,omitempty"`
	ArtifactName string `json:"artifact_name,omitempty"`
	// Snapshot is the zip of this version's server files. It is written when
	// the version is replaced, because that is the moment the files still on
	// disk are known to be exactly this version. An empty value means the
	// snapshot was pruned and this version can no longer be returned to.
	Snapshot      string `json:"-"`
	SnapshotBytes int64  `json:"snapshot_bytes"`
	// WorldBackup is the backup taken just before leaving this version, so a
	// world from the right era can be restored alongside the right files.
	WorldBackup string    `json:"world_backup,omitempty"`
	AppliedAt   time.Time `json:"applied_at"`
	// State is active for the files on disk now, superseded for one an upgrade
	// replaced, rolled_back for one abandoned by going back, and failed for an
	// upgrade that never booted and was undone automatically.
	State    string `json:"state"`
	RevertOf int64  `json:"revert_of,omitempty"`
	Note     string `json:"note,omitempty"`
}

// Revertible reports whether going back to this version is still possible.
func (v Version) Revertible() bool { return v.Snapshot != "" }

func (d *DB) migrateVersions() error {
	_, err := d.sql.Exec(`
CREATE TABLE IF NOT EXISTS instance_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  instance       TEXT NOT NULL,
  label          TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL,
  artifact       TEXT NOT NULL DEFAULT '',
  artifact_name  TEXT NOT NULL DEFAULT '',
  snapshot       TEXT NOT NULL DEFAULT '',
  snapshot_bytes INTEGER NOT NULL DEFAULT 0,
  world_backup   TEXT NOT NULL DEFAULT '',
  applied_at     TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'active',
  revert_of      INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS instance_versions_by_instance
  ON instance_versions (instance, applied_at DESC);`)
	return err
}

const versionCols = `id, instance, label, source, artifact, artifact_name, snapshot,
 snapshot_bytes, world_backup, applied_at, state, revert_of, note`

func scanVersion(row interface{ Scan(...any) error }) (Version, error) {
	var v Version
	var applied string
	err := row.Scan(&v.ID, &v.Instance, &v.Label, &v.Source, &v.Artifact, &v.ArtifactName,
		&v.Snapshot, &v.SnapshotBytes, &v.WorldBackup, &applied, &v.State, &v.RevertOf, &v.Note)
	if err != nil {
		return v, err
	}
	v.AppliedAt, _ = time.Parse(time.RFC3339Nano, applied)
	return v, nil
}

// ListVersions returns the history of an instance, newest first.
func (d *DB) ListVersions(ctx context.Context, instance string) ([]Version, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+versionCols+`
 FROM instance_versions WHERE instance = ? ORDER BY applied_at DESC, id DESC`, instance)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Version{}
	for rows.Next() {
		v, err := scanVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (d *DB) GetVersion(ctx context.Context, instance string, id int64) (Version, error) {
	row := d.sql.QueryRowContext(ctx, `SELECT `+versionCols+`
 FROM instance_versions WHERE instance = ? AND id = ?`, instance, id)
	v, err := scanVersion(row)
	if errors.Is(err, sql.ErrNoRows) {
		return v, fmt.Errorf("version %d of %q: %w", id, instance, ErrNotFound)
	}
	return v, err
}

// ActiveVersion is the one whose files are on disk right now.
func (d *DB) ActiveVersion(ctx context.Context, instance string) (Version, error) {
	row := d.sql.QueryRowContext(ctx, `SELECT `+versionCols+`
 FROM instance_versions WHERE instance = ? AND state = 'active'
 ORDER BY applied_at DESC, id DESC LIMIT 1`, instance)
	v, err := scanVersion(row)
	if errors.Is(err, sql.ErrNoRows) {
		return v, fmt.Errorf("active version of %q: %w", instance, ErrNotFound)
	}
	return v, err
}

// AddVersion inserts a row and returns it with its assigned id.
func (d *DB) AddVersion(ctx context.Context, v Version) (Version, error) {
	if v.AppliedAt.IsZero() {
		v.AppliedAt = time.Now().UTC()
	}
	if v.State == "" {
		v.State = "active"
	}
	res, err := d.sql.ExecContext(ctx, `
INSERT INTO instance_versions (instance, label, source, artifact, artifact_name,
 snapshot, snapshot_bytes, world_backup, applied_at, state, revert_of, note)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		v.Instance, v.Label, v.Source, v.Artifact, v.ArtifactName, v.Snapshot,
		v.SnapshotBytes, v.WorldBackup, v.AppliedAt.Format(time.RFC3339Nano), v.State,
		v.RevertOf, v.Note)
	if err != nil {
		return v, err
	}
	v.ID, err = res.LastInsertId()
	return v, err
}

// SetVersionSnapshot records the archive of a version's files. It is called
// when the version is about to be replaced.
func (d *DB) SetVersionSnapshot(ctx context.Context, id int64, path string, size int64) error {
	_, err := d.sql.ExecContext(ctx,
		`UPDATE instance_versions SET snapshot = ?, snapshot_bytes = ? WHERE id = ?`, path, size, id)
	return err
}

func (d *DB) SetVersionState(ctx context.Context, id int64, state, note string) error {
	_, err := d.sql.ExecContext(ctx,
		`UPDATE instance_versions SET state = ?, note = ? WHERE id = ?`, state, note, id)
	return err
}

func (d *DB) SetVersionWorldBackup(ctx context.Context, id int64, file string) error {
	_, err := d.sql.ExecContext(ctx,
		`UPDATE instance_versions SET world_backup = ? WHERE id = ?`, file, id)
	return err
}

// ClearVersionSnapshot forgets a pruned archive. The row stays: the history of
// what ran on this server is worth more than the bytes it costs.
func (d *DB) ClearVersionSnapshot(ctx context.Context, id int64) error {
	_, err := d.sql.ExecContext(ctx,
		`UPDATE instance_versions SET snapshot = '', snapshot_bytes = 0 WHERE id = ?`, id)
	return err
}
