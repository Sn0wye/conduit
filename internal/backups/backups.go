// Package backups reads what FTB Backups 2 already wrote and restores from it.
// Conduit does not invent a backup format: the mod on the server owns creating
// them, and asking it over RCON is the only way to get a consistent world.
package backups

import (
	"archive/zip"
	"encoding/json"
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

// Dir is the backups directory of an instance.
func Dir(instanceDir string) string { return filepath.Join(instanceDir, "backups") }

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
		return Backup{}, fmt.Errorf("bad backup name %q", file)
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
		movedTo = live + ".before-restore-" + time.Now().Format("20060102-150405")
		if err := os.Rename(live, movedTo); err != nil {
			return "", fmt.Errorf("move the current world aside: %w", err)
		}
	}

	if err := unzip(zr, instanceDir); err != nil {
		// Put the old world back rather than leaving the instance with neither.
		if movedTo != "" {
			os.RemoveAll(live)
			os.Rename(movedTo, live)
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
