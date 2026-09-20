// Package store holds settings. It deliberately does not hold status: whether a
// server is running comes from pm2 on every request, so the two can never drift.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

type Instance struct {
	Name      string `json:"name"` // also the pm2 app name
	Dir       string `json:"dir"`
	Script    string `json:"script"` // ./run.sh for Forge and NeoForge packs
	Port      int    `json:"port"`
	RCONPort  int    `json:"rcon_port"`
	RCONPass  string `json:"-"` // never sent to the browser
	RCONReady bool   `json:"rcon_ready"`
	Backups   string `json:"backups"` // glob for existing backup files
	// BackupCmd is what Conduit sends over RCON to take a backup. The server
	// mod owns the format, so this is its command, not ours. FTB Backups 2
	// answers to "backup start".
	BackupCmd string    `json:"backup_cmd"`
	ProjectID int       `json:"project_id"`
	FileID    int       `json:"file_id"`
	Version   string    `json:"version"`
	CreatedAt time.Time `json:"created_at"`
}

type DB struct{ sql *sql.DB }

func Open(path string) (*DB, error) {
	sq, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	// modernc's driver is not safe for unlimited parallel writers.
	sq.SetMaxOpenConns(1)
	db := &DB{sql: sq}
	if err := db.migrate(); err != nil {
		sq.Close()
		return nil, err
	}
	if err := db.migrateSettings(); err != nil {
		sq.Close()
		return nil, err
	}
	return db, nil
}

func (d *DB) Close() error { return d.sql.Close() }

func (d *DB) migrate() error {
	_, err := d.sql.Exec(`
CREATE TABLE IF NOT EXISTS instances (
  name       TEXT PRIMARY KEY,
  dir        TEXT NOT NULL,
  script     TEXT NOT NULL DEFAULT './run.sh',
  port       INTEGER NOT NULL DEFAULT 25565,
  rcon_port  INTEGER NOT NULL DEFAULT 25575,
  rcon_pass  TEXT NOT NULL DEFAULT '',
  rcon_ready INTEGER NOT NULL DEFAULT 0,
  backups    TEXT NOT NULL DEFAULT '',
  backup_cmd TEXT NOT NULL DEFAULT 'backup start',
  project_id INTEGER NOT NULL DEFAULT 0,
  file_id    INTEGER NOT NULL DEFAULT 0,
  version    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);`)
	if err != nil {
		return err
	}
	return d.addColumns()
}

// addColumns brings an existing database up to the schema above. CREATE TABLE
// IF NOT EXISTS does nothing to a table that already exists, so a new column
// needs its own ALTER or older databases keep failing every query.
func (d *DB) addColumns() error {
	rows, err := d.sql.Query(`PRAGMA table_info(instances)`)
	if err != nil {
		return err
	}
	have := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			rows.Close()
			return err
		}
		have[name] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	added := []struct{ name, ddl string }{
		{"backup_cmd", `ALTER TABLE instances ADD COLUMN backup_cmd TEXT NOT NULL DEFAULT 'backup start'`},
	}
	for _, c := range added {
		if have[c.name] {
			continue
		}
		if _, err := d.sql.Exec(c.ddl); err != nil {
			return fmt.Errorf("add column %s: %w", c.name, err)
		}
	}
	return nil
}

const cols = `name, dir, script, port, rcon_port, rcon_pass, rcon_ready, backups, backup_cmd, project_id, file_id, version, created_at`

func scan(row interface{ Scan(...any) error }) (Instance, error) {
	var i Instance
	var created string
	var ready int
	err := row.Scan(&i.Name, &i.Dir, &i.Script, &i.Port, &i.RCONPort, &i.RCONPass,
		&ready, &i.Backups, &i.BackupCmd, &i.ProjectID, &i.FileID, &i.Version, &created)
	if err != nil {
		return i, err
	}
	i.RCONReady = ready == 1
	i.CreatedAt, _ = time.Parse(time.RFC3339, created)
	return i, nil
}

func (d *DB) ListInstances(ctx context.Context) ([]Instance, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+cols+` FROM instances ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Instance{}
	for rows.Next() {
		i, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (d *DB) GetInstance(ctx context.Context, name string) (Instance, error) {
	row := d.sql.QueryRowContext(ctx, `SELECT `+cols+` FROM instances WHERE name = ?`, name)
	i, err := scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return i, fmt.Errorf("instance %q: %w", name, ErrNotFound)
	}
	return i, err
}

func (d *DB) PutInstance(ctx context.Context, i Instance) error {
	if i.CreatedAt.IsZero() {
		i.CreatedAt = time.Now().UTC()
	}
	if i.Script == "" {
		i.Script = "./run.sh"
	}
	if i.BackupCmd == "" {
		i.BackupCmd = "backup start"
	}
	if i.RCONPort == 0 {
		i.RCONPort = 25575
	}
	ready := 0
	if i.RCONReady {
		ready = 1
	}
	_, err := d.sql.ExecContext(ctx, `
INSERT INTO instances (`+cols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(name) DO UPDATE SET
  dir=excluded.dir, script=excluded.script, port=excluded.port,
  rcon_port=excluded.rcon_port, rcon_pass=excluded.rcon_pass,
  rcon_ready=excluded.rcon_ready, backups=excluded.backups,
  backup_cmd=excluded.backup_cmd,
  project_id=excluded.project_id, file_id=excluded.file_id, version=excluded.version`,
		i.Name, i.Dir, i.Script, i.Port, i.RCONPort, i.RCONPass, ready,
		i.Backups, i.BackupCmd, i.ProjectID, i.FileID, i.Version, i.CreatedAt.Format(time.RFC3339))
	return err
}

func (d *DB) DeleteInstance(ctx context.Context, name string) error {
	res, err := d.sql.ExecContext(ctx, `DELETE FROM instances WHERE name = ?`, name)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("instance %q: %w", name, ErrNotFound)
	}
	return nil
}

// --- settings ---
//
// Settings live in a key/value table rather than a config file: everything is
// set from the PWA, and the file would be a second place to look.

func (d *DB) migrateSettings() error {
	_, err := d.sql.Exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`)
	return err
}

// Setting returns the empty string when the key was never set.
func (d *DB) Setting(ctx context.Context, key string) (string, error) {
	var v string
	err := d.sql.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (d *DB) SetSetting(ctx context.Context, key, value string) error {
	if value == "" {
		_, err := d.sql.ExecContext(ctx, `DELETE FROM settings WHERE key = ?`, key)
		return err
	}
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO settings (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

func (d *DB) Settings(ctx context.Context) (map[string]string, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT key, value FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}
