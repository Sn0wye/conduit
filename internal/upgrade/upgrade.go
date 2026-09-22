// Package upgrade swaps the server files of an instance for a newer pack and
// keeps the files it replaced, so the swap can be undone.
//
// The unit it works on is the version-owned set: everything in the instance
// directory except the world, the backups and the logs. That split is the
// whole design. Worlds are tens of gigabytes and must survive an upgrade;
// mods, configs and the launch script are hundreds of megabytes and are
// exactly what an upgrade replaces. Snapshotting only the second kind makes
// "go back to the previous version" a cheap, exact operation instead of a
// second copy of the world.
package upgrade

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
)

// ErrBadArtifact means the zip is not a server pack. It is a bad request: the
// instance has not been touched when this is returned.
var ErrBadArtifact = errors.New("not a server pack")

// preserved are the files an upgrade must not overwrite. They are the operator's
// answers, not the pack's: ports, ops, whitelist, memory. A pack ships its own
// defaults for most of them and they would silently undo a working setup.
//
// run.sh is deliberately absent. It pins the java path and the pack decides
// that, so a new pack's run.sh wins; the snapshot holds the old one.
var preserved = map[string]bool{
	"server.properties":   true,
	"ops.json":            true,
	"whitelist.json":      true,
	"banned-players.json": true,
	"banned-ips.json":     true,
	"usercache.json":      true,
	"eula.txt":            true,
	"user_jvm_args.txt":   true,
}

// owned reports whether a top-level entry of the instance directory belongs to
// the pack rather than to the world or to the server's own output.
//
// The world prefix covers world, world_nether, world_the_end and the
// world.before-restore-* directories the backups package leaves behind.
func owned(name string) bool {
	if strings.HasPrefix(name, "world") {
		return false
	}
	switch name {
	case "backups", "logs", "crash-reports", ".conduit":
		return false
	}
	return true
}

// Layout is what a probe found inside an artifact zip.
type Layout struct {
	// Root is the prefix inside the zip that maps to the instance directory.
	// It is "" for a zip whose mods/ sits at the top.
	Root string `json:"root"`
	// Label is the pack name and version when the zip carries a CurseForge
	// manifest. It is only a suggestion for the version label.
	Label    string `json:"label"`
	Mods     int    `json:"mods"`
	Files    int    `json:"files"`
	HasRun   bool   `json:"has_run_sh"`
	HasJar   bool   `json:"has_server_jar"`
	Unpacked int64  `json:"unpacked_bytes"`
}

// Probe reads the zip's index without extracting anything, so a wrong file is
// rejected before the instance is stopped.
func Probe(zipPath string) (Layout, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return Layout{}, fmt.Errorf("%w: %v", ErrBadArtifact, err)
	}
	defer zr.Close()
	return probe(&zr.Reader)
}

func probe(zr *zip.Reader) (Layout, error) {
	var l Layout
	roots := map[string]bool{}
	for _, f := range zr.File {
		if i := strings.IndexByte(f.Name, '/'); i > 0 {
			roots[f.Name[:i]] = true
		} else if !strings.HasSuffix(f.Name, "/") {
			roots[""] = true
		}
	}
	// A pack zipped with its directory included has exactly one top-level
	// directory and nothing beside it. A pack that is only a mods folder also
	// has one, which is why the candidate has to look like an instance from
	// the inside before it is believed.
	if len(roots) == 1 {
		for r := range roots {
			if r != "" && looksLikeInstance(zr, r+"/") {
				l.Root = r
			}
		}
	}

	// A CurseForge client zip keeps the files under overrides/ and the name
	// under manifest.json. Server packs have neither.
	if _, err := find(zr, join(l.Root, "manifest.json")); err == nil {
		l.Label = manifestLabel(zr, join(l.Root, "manifest.json"))
		if hasPrefix(zr, join(l.Root, "overrides")+"/") {
			l.Root = join(l.Root, "overrides")
		}
	}

	prefix := ""
	if l.Root != "" {
		prefix = l.Root + "/"
	}
	for _, f := range zr.File {
		if !strings.HasPrefix(f.Name, prefix) || strings.HasSuffix(f.Name, "/") {
			continue
		}
		rel := strings.TrimPrefix(f.Name, prefix)
		l.Files++
		l.Unpacked += int64(f.UncompressedSize64)
		switch {
		case strings.HasPrefix(rel, "mods/") && strings.HasSuffix(rel, ".jar"):
			l.Mods++
		case rel == "run.sh":
			l.HasRun = true
		case !strings.Contains(rel, "/") && strings.HasSuffix(rel, ".jar"):
			l.HasJar = true
		}
	}

	if l.Mods == 0 && !l.HasRun && !l.HasJar {
		return l, fmt.Errorf("%w: no mods/, no run.sh and no server jar inside", ErrBadArtifact)
	}
	return l, nil
}

// looksLikeInstance reports whether a directory inside the zip holds the files
// an instance directory holds, rather than being one of those files itself.
func looksLikeInstance(zr *zip.Reader, prefix string) bool {
	for _, f := range zr.File {
		rel := strings.TrimPrefix(f.Name, prefix)
		if rel == f.Name {
			continue
		}
		switch {
		case strings.HasPrefix(rel, "mods/"), strings.HasPrefix(rel, "config/"),
			strings.HasPrefix(rel, "libraries/"), strings.HasPrefix(rel, "overrides/"),
			rel == "run.sh", rel == "manifest.json", rel == "server.properties":
			return true
		}
	}
	return false
}

func join(root, name string) string {
	if root == "" {
		return name
	}
	return root + "/" + name
}

func find(zr *zip.Reader, name string) (*zip.File, error) {
	for _, f := range zr.File {
		if f.Name == name {
			return f, nil
		}
	}
	return nil, os.ErrNotExist
}

func hasPrefix(zr *zip.Reader, prefix string) bool {
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, prefix) {
			return true
		}
	}
	return false
}

// manifestLabel pulls "name version" out of a CurseForge manifest. A failure
// is not an error: the label is a suggestion and the operator can type one.
func manifestLabel(zr *zip.Reader, name string) string {
	f, err := find(zr, name)
	if err != nil {
		return ""
	}
	rc, err := f.Open()
	if err != nil {
		return ""
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, 1<<20))
	if err != nil {
		return ""
	}
	var m struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(b, &m); err != nil || m.Name == "" {
		return ""
	}
	return strings.TrimSpace(m.Name + " " + m.Version)
}

// Report says what an apply did, for the job log and for the version row.
type Report struct {
	Root      string   `json:"root"`
	Files     int      `json:"files"`
	Mods      int      `json:"mods"`
	Preserved []string `json:"preserved"`
}

// Apply overlays a pack onto a stopped instance. mods/ is deleted first rather
// than merged: a jar the new pack dropped would otherwise stay behind, and a
// stale mod is a crash at best and a corrupted world at worst. Everything else
// is an overlay, so config files the pack no longer ships and anything hand
// added survive.
//
// The caller must have stopped the server and taken a snapshot first. This
// function does not check either, because it is also how a fresh install runs.
func Apply(dir, zipPath string, l Layout) (Report, error) {
	rep := Report{Root: l.Root, Preserved: []string{}}
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return rep, fmt.Errorf("%w: %v", ErrBadArtifact, err)
	}
	defer zr.Close()

	if err := os.RemoveAll(filepath.Join(dir, "mods")); err != nil {
		return rep, fmt.Errorf("clear the old mods: %w", err)
	}

	prefix := ""
	if l.Root != "" {
		prefix = l.Root + "/"
	}
	for _, f := range zr.File {
		if !strings.HasPrefix(f.Name, prefix) {
			continue
		}
		rel := strings.TrimPrefix(f.Name, prefix)
		if rel == "" || rel == "manifest.json" {
			continue
		}
		top := rel
		if i := strings.IndexByte(rel, '/'); i >= 0 {
			top = rel[:i]
		}
		// A pack that ships a world is shipping a new save, not an upgrade.
		if !owned(top) {
			continue
		}
		target, err := safeJoin(dir, rel)
		if err != nil {
			return rep, err
		}
		if strings.HasSuffix(f.Name, "/") {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return rep, err
			}
			continue
		}
		if preserved[rel] {
			if _, err := os.Stat(target); err == nil {
				rep.Preserved = append(rep.Preserved, rel)
				continue
			}
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return rep, err
		}
		if err := writeEntry(f, target); err != nil {
			return rep, err
		}
		rep.Files++
		if strings.HasPrefix(rel, "mods/") && strings.HasSuffix(rel, ".jar") {
			rep.Mods++
		}
	}
	sort.Strings(rep.Preserved)
	return rep, nil
}

// Snapshot zips the version-owned set to out. It is the downgrade target:
// the exact files that were on disk, including edits made by hand, so going
// back never depends on a pack still being downloadable.
func Snapshot(dir, out string) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
		return 0, err
	}
	tmp := out + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return 0, err
	}
	zw := zip.NewWriter(f)

	err = walkOwned(dir, func(rel string, info os.FileInfo) error {
		return addToZip(zw, filepath.Join(dir, rel), rel, info)
	})
	if err != nil {
		zw.Close()
		f.Close()
		os.Remove(tmp)
		return 0, err
	}
	if err := zw.Close(); err != nil {
		f.Close()
		os.Remove(tmp)
		return 0, err
	}
	size, _ := f.Seek(0, io.SeekEnd)
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return 0, err
	}
	if err := os.Rename(tmp, out); err != nil {
		os.Remove(tmp)
		return 0, err
	}
	return size, nil
}

// walkOwned visits every regular file of the version-owned set. Symlinks are
// skipped: none of the packs on the box use them, and following one would put
// a copy of whatever it points at inside the snapshot.
func walkOwned(dir string, fn func(rel string, info os.FileInfo) error) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !owned(e.Name()) {
			continue
		}
		err := filepath.WalkDir(filepath.Join(dir, e.Name()), func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.Type()&os.ModeSymlink != 0 {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(dir, p)
			if err != nil {
				return err
			}
			if d.IsDir() {
				rel += "/"
			}
			return fn(filepath.ToSlash(rel), info)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func addToZip(zw *zip.Writer, path, rel string, info os.FileInfo) error {
	h, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	h.Name = rel
	// Mod jars are already deflated. Re-compressing a gigabyte of them buys a
	// few percent and costs minutes on the box's four ARM cores.
	if info.IsDir() || precompressed(rel) {
		h.Method = zip.Store
	} else {
		h.Method = zip.Deflate
	}
	w, err := zw.CreateHeader(h)
	if err != nil || info.IsDir() {
		return err
	}
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	defer src.Close()
	_, err = io.Copy(w, src)
	return err
}

func precompressed(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jar", ".zip", ".png", ".ogg", ".gz", ".xz", ".zst":
		return true
	}
	return false
}

// Restore puts a snapshot back. The version-owned set is cleared first, so a
// mod added by the version being undone does not survive the undo.
//
// The world is never touched here, by construction: it is not in the set.
func Restore(dir, snapshot string) error {
	zr, err := zip.OpenReader(snapshot)
	if err != nil {
		return err
	}
	defer zr.Close()

	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !owned(e.Name()) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return err
		}
	}

	for _, f := range zr.File {
		top := f.Name
		if i := strings.IndexByte(top, '/'); i >= 0 {
			top = top[:i]
		}
		if !owned(top) {
			continue
		}
		target, err := safeJoin(dir, f.Name)
		if err != nil {
			return err
		}
		if strings.HasSuffix(f.Name, "/") {
			if err := os.MkdirAll(target, f.Mode().Perm()|0o700); err != nil {
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

// safeJoin refuses a zip entry that would write outside the instance. The name
// comes from a file the operator uploaded, so it is not trusted.
func safeJoin(dir, name string) (string, error) {
	target := filepath.Join(dir, filepath.Clean("/"+name))
	if target != filepath.Clean(dir) && !strings.HasPrefix(target, filepath.Clean(dir)+string(os.PathSeparator)) {
		return "", fmt.Errorf("%w: entry %q escapes the instance directory", ErrBadArtifact, name)
	}
	return target, nil
}

// writeEntry keeps the executable bit. run.sh arrives from the pack zip and is
// what pm2 launches, so losing its mode makes the instance unstartable.
func writeEntry(f *zip.File, target string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	mode := f.Mode().Perm()
	if mode == 0 {
		mode = 0o644
	}
	if strings.HasSuffix(target, ".sh") {
		mode |= 0o111
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, rc); err != nil {
		out.Close()
		return err
	}
	if err := out.Chmod(mode); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
