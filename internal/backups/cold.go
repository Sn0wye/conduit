package backups

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// WorldDir finds the save directory of an instance. Vanilla calls it world and
// every pack on the box agrees, but level-name is a server property and the
// file that proves it is level.dat, so that is what is looked for.
func WorldDir(instanceDir string) (string, error) {
	entries, err := os.ReadDir(instanceDir)
	if err != nil {
		return "", err
	}
	best := ""
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), rollbackPrefix) {
			continue
		}
		if _, err := os.Stat(filepath.Join(instanceDir, e.Name(), "level.dat")); err != nil {
			continue
		}
		if e.Name() == "world" {
			return e.Name(), nil
		}
		if best == "" {
			best = e.Name()
		}
	}
	if best == "" {
		return "", fmt.Errorf("no world directory with a level.dat in %s: %w", instanceDir, ErrNotFound)
	}
	return best, nil
}

// Create zips the world directly, without asking the server's backup mod.
//
// This is only safe on a stopped server, and the caller must have stopped it:
// a zip taken while chunks are being written is a torn world. The mod's
// command stays the right way to back up a running server, which is why the
// two are separate calls rather than one with a flag.
//
// The archive is rooted at the world directory name, which is the layout FTB
// Backups 2 uses, so Restore reads it with no special case.
func Create(instanceDir, tag string) (Backup, error) {
	world, err := WorldDir(instanceDir)
	if err != nil {
		return Backup{}, err
	}
	dir := Dir(instanceDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Backup{}, err
	}

	name := fmt.Sprintf("conduit-%s%s.zip", time.Now().Format("2006-01-02-150405"), slug(tag))
	out := filepath.Join(dir, name)
	tmp := out + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return Backup{}, err
	}
	zw := zip.NewWriter(f)

	root := filepath.Join(instanceDir, world)
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(instanceDir, p)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		h, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		h.Name = filepath.ToSlash(rel)
		if d.IsDir() {
			h.Name += "/"
			h.Method = zip.Store
		} else {
			h.Method = zip.Deflate
		}
		w, err := zw.CreateHeader(h)
		if err != nil || d.IsDir() {
			return err
		}
		src, err := os.Open(p)
		if err != nil {
			return err
		}
		defer src.Close()
		_, err = io.Copy(w, src)
		return err
	})
	if err != nil {
		zw.Close()
		f.Close()
		os.Remove(tmp)
		return Backup{}, err
	}
	if err := zw.Close(); err != nil {
		f.Close()
		os.Remove(tmp)
		return Backup{}, err
	}
	size, _ := f.Seek(0, io.SeekEnd)
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return Backup{}, err
	}
	if err := os.Rename(tmp, out); err != nil {
		os.Remove(tmp)
		return Backup{}, err
	}
	return Backup{File: name, Path: out, Size: size, Created: time.Now(), World: world}, nil
}

// slug keeps a version label usable as part of a file name.
func slug(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return ""
	}
	clean := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '-':
			return r
		}
		return '-'
	}, s)
	clean = strings.Trim(clean, "-")
	if len(clean) > 40 {
		clean = strings.Trim(clean[:40], "-")
	}
	if clean == "" {
		return ""
	}
	return "-" + clean
}
