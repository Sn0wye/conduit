// Package backups reads what FTB Backups 2 already wrote and restores from it.
// Conduit does not invent a backup format: the mod on the server owns creating
// them, and asking it over RCON is the only way to get a consistent world.
package backups

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Backup is one entry of backups/backups.json.
type Backup struct {
	File     string    `json:"file"`
	Path     string    `json:"-"`
	Size     int64     `json:"size"`
	Created  time.Time `json:"created"`
	SHA1     string    `json:"sha1,omitempty"`
	Ratio    float64   `json:"ratio,omitempty"`
	World    string    `json:"world,omitempty"`
	Preview  string    `json:"preview,omitempty"` // data: URI thumbnail, when the mod stored one
	Manifest bool      `json:"from_manifest"`
}

type manifest struct {
	Backups []struct {
		WorldName      string  `json:"worldName"`
		CreateTime     int64   `json:"createTime"`
		BackupLocation string  `json:"backupLocation"`
		Size           int64   `json:"size"`
		Ratio          float64 `json:"ratio"`
		SHA1           string  `json:"sha1"`
		Preview        string  `json:"preview"`
	} `json:"backups"`
}

// rollbackPrefix marks a world directory that Conduit moved aside before
// replacing it. The prefix is the flag: anything carrying it is a pre-restore
// copy made by Conduit, never a backup the server's mod produced.
const rollbackPrefix = "world.before-restore-"

// Rollback is a world directory saved just before a restore overwrote it.
// It is not a backup: no mod made it, it is a plain directory, and undoing is
// a rename rather than an unzip.
type Rollback struct {
	Dir         string    `json:"dir"`
	Kind        string    `json:"kind"` // always "pre_restore"
	Created     time.Time `json:"created"`
	SizeBytes   int64     `json:"size_bytes"`
	ReplacedBy  string    `json:"replaced_by"` // the backup that was restored over it
	InstanceDir string    `json:"-"`
}

// marker records what replaced a world, so the undo list can say "this is the
// world that ATM10 1.2.1 overwrote" instead of just showing a timestamp.
type marker struct {
	Kind       string    `json:"kind"`
	Created    time.Time `json:"created"`
	ReplacedBy string    `json:"replaced_by"`
	// World is the directory name this copy was taken from. Restoring puts it
	// back under this name, which is "world" for every pack seen so far but is
	// not guaranteed by anything.
	World string `json:"world"`
}

func markerPath(worldDir string) string { return worldDir + ".conduit.json" }

// nextRollbackDir picks a free name. The timestamp is only second-resolution,
// so undoing twice in the same second would otherwise try to rename onto an
// existing directory and fail.
func nextRollbackDir(instanceDir string) string {
	base := filepath.Join(instanceDir, rollbackPrefix+time.Now().Format("20060102-150405"))
	candidate := base
	for i := 2; ; i++ {
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
		candidate = fmt.Sprintf("%s-%d", base, i)
	}
}

func writeMarker(worldDir, replacedBy, world string) {
	b, err := json.Marshal(marker{Kind: "pre_restore", Created: time.Now(),
		ReplacedBy: replacedBy, World: world})
	if err == nil {
		os.WriteFile(markerPath(worldDir), b, 0o644)
	}
}

func readMarker(worldDir string) marker {
	var m marker
	if b, err := os.ReadFile(markerPath(worldDir)); err == nil {
		json.Unmarshal(b, &m)
	}
	return m
}

// Dir is the backups directory of an instance.
func Dir(instanceDir string) string { return filepath.Join(instanceDir, "backups") }

// ErrBadName means the caller asked for something that is not ours to touch.
// It is a bad request, not a server fault, and the API maps it to 400.
var ErrBadName = errors.New("not a name this instance owns")

// List prefers backups.json, which carries the size, checksum and map preview
// the mod recorded. Any zip missing from it is still listed, so a file copied
// in by hand is not invisible.
func List(instanceDir string) ([]Backup, error) {
	dir := Dir(instanceDir)
	byPath := map[string]Backup{}

	if b, err := os.ReadFile(filepath.Join(dir, "backups.json")); err == nil {
		var m manifest
		if err := json.Unmarshal(b, &m); err == nil {
			for _, e := range m.Backups {
				p := e.BackupLocation
				byPath[filepath.Clean(p)] = Backup{
					File:     filepath.Base(p),
					Path:     p,
					Size:     e.Size,
					Created:  time.UnixMilli(e.CreateTime),
					SHA1:     e.SHA1,
					Ratio:    e.Ratio,
					World:    e.WorldName,
					Preview:  e.Preview,
					Manifest: true,
				}
			}
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil && len(byPath) == 0 {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".zip") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if _, ok := byPath[filepath.Clean(p)]; ok {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		byPath[filepath.Clean(p)] = Backup{
			File: e.Name(), Path: p, Size: info.Size(), Created: info.ModTime(),
		}
	}

	out := make([]Backup, 0, len(byPath))
	for _, b := range byPath {
		// A manifest entry whose file is gone is noise, not history.
		if _, err := os.Stat(b.Path); err != nil {
			continue
		}
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out, nil
}

// Find resolves a backup by file name. It rejects anything that escapes the
// backups directory, since the name arrives from an HTTP path.
func Find(instanceDir, file string) (Backup, error) {
	if file != filepath.Base(file) || file == "" {
		return Backup{}, fmt.Errorf("bad backup name %q: %w", file, ErrBadName)
	}
	list, err := List(instanceDir)
	if err != nil {
		return Backup{}, err
	}
	for _, b := range list {
		if b.File == file {
			return b, nil
		}
	}
	return Backup{}, fmt.Errorf("backup %q not found", file)
}

// ListRollbacks returns the worlds moved aside by earlier restores, newest
// first. Nothing prunes these, which is deliberate: they are the undo.
func ListRollbacks(instanceDir string, size func(string) int64) ([]Rollback, error) {
	entries, err := os.ReadDir(instanceDir)
	if err != nil {
		return nil, err
	}
	out := []Rollback{}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), rollbackPrefix) {
			continue
		}
		full := filepath.Join(instanceDir, e.Name())
		m := readMarker(full)
		r := Rollback{Dir: e.Name(), Kind: "pre_restore", Created: m.Created,
			ReplacedBy: m.ReplacedBy, InstanceDir: instanceDir}
		if r.Created.IsZero() {
			if info, err := e.Info(); err == nil {
				r.Created = info.ModTime()
			}
		}
		if size != nil {
			r.SizeBytes = size(full)
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out, nil
}

// checkRollbackName rejects anything that is not one of our own moved-aside
// directories, since the name arrives from an HTTP path.
func checkRollbackName(dir string) error {
	if dir != filepath.Base(dir) || !strings.HasPrefix(dir, rollbackPrefix) {
		return fmt.Errorf("%q is not a rollback directory: %w", dir, ErrBadName)
	}
	return nil
}

// Undo puts a moved-aside world back. The world currently in place is moved
// aside in turn rather than deleted, so an undo of an undo is possible and
// nothing is ever destroyed by this call.
func Undo(instanceDir, dir string) (movedTo string, err error) {
	if err := checkRollbackName(dir); err != nil {
		return "", err
	}
	saved := filepath.Join(instanceDir, dir)
	if fi, err := os.Stat(saved); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("rollback %q not found", dir)
	}

	m := readMarker(saved)
	world := m.World
	if world == "" {
		world = "world"
	}
	live := filepath.Join(instanceDir, world)
	if _, err := os.Stat(live); err == nil {
		movedTo = nextRollbackDir(instanceDir)
		if err := os.Rename(live, movedTo); err != nil {
			return "", fmt.Errorf("move the current world aside: %w", err)
		}
		writeMarker(movedTo, "undo of "+dir, world)
	}
	if err := os.Rename(saved, live); err != nil {
		if movedTo != "" {
			os.Rename(movedTo, live)
			os.Remove(markerPath(movedTo))
		}
		return "", err
	}
	os.Remove(markerPath(saved))
	return movedTo, nil
}

// DeleteRollback removes a moved-aside world for good. This is the only call
// in the package that destroys anything.
func DeleteRollback(instanceDir, dir string) error {
	if err := checkRollbackName(dir); err != nil {
		return err
	}
	target := filepath.Join(instanceDir, dir)
	if fi, err := os.Stat(target); err != nil || !fi.IsDir() {
		return fmt.Errorf("rollback %q not found", dir)
	}
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	os.Remove(markerPath(target))
	return nil
}

// Restore swaps the world for the one inside a backup zip. The caller must
// have stopped the server first; restoring under a running server writes into
// chunks the server still has open.
//
// The current world is moved aside rather than deleted, so a restore of the
// wrong backup is undoable with one mv.
func Restore(instanceDir, file string) (movedTo string, err error) {
	b, err := Find(instanceDir, file)
	if err != nil {
		return "", err
	}
	zr, err := zip.OpenReader(b.Path)
	if err != nil {
		return "", err
	}
	defer zr.Close()

	// FTB Backups 2 zips are rooted at the world directory name.
	root := ""
	for _, f := range zr.File {
		parts := strings.SplitN(f.Name, "/", 2)
		if len(parts) == 2 && parts[0] != "" {
			root = parts[0]
			break
		}
	}
	if root == "" {
		return "", fmt.Errorf("%s has no world directory at its root", b.File)
	}

	live := filepath.Join(instanceDir, root)
	if _, err := os.Stat(live); err == nil {
		movedTo = nextRollbackDir(instanceDir)
		if err := os.Rename(live, movedTo); err != nil {
			return "", fmt.Errorf("move the current world aside: %w", err)
		}
		writeMarker(movedTo, b.File, root)
	}

	if err := unzip(zr, instanceDir); err != nil {
		// Put the old world back rather than leaving the instance with neither.
		if movedTo != "" {
			os.RemoveAll(live)
			os.Rename(movedTo, live)
			os.Remove(markerPath(movedTo))
		}
		return "", err
	}
	return movedTo, nil
}

func unzip(zr *zip.ReadCloser, dest string) error {
	for _, f := range zr.File {
		target := filepath.Join(dest, filepath.Clean("/"+f.Name))
		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			return fmt.Errorf("zip entry %q escapes the instance directory", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := writeEntry(f, target); err != nil {
			return err
		}
	}
	return nil
}

func writeEntry(f *zip.File, target string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rc)
	return err
}
