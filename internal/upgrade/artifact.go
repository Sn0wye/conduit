package upgrade

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Artifact is a pack zip sitting in the cache, already probed. It is named by
// the hash of its contents, so uploading the same pack twice costs one copy
// and an instance can point at it forever without a filename collision.
type Artifact struct {
	SHA256 string    `json:"sha256"`
	Name   string    `json:"name"` // the file name it arrived under, for display
	Size   int64     `json:"size"`
	Added  time.Time `json:"added"`
	Layout Layout    `json:"layout"`
	Path   string    `json:"-"`
}

// sidecar holds the display name and the probe beside the zip, so the artifact
// list does not have to re-read every zip index on every page load.
func sidecar(path string) string { return path + ".json" }

// Stage copies an upload into the cache and probes it. A file that is not a
// server pack is deleted again rather than left to confuse the list.
//
// The hash is computed while the body streams to disk: a 3 GB pack is never
// held in memory, and the browser gets one pass over the wire.
func Stage(dir string, src io.Reader, name string) (Artifact, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Artifact{}, err
	}
	tmp, err := os.CreateTemp(dir, "upload-*.part")
	if err != nil {
		return Artifact{}, err
	}
	defer os.Remove(tmp.Name())

	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, h), src)
	if err != nil {
		tmp.Close()
		return Artifact{}, err
	}
	if err := tmp.Close(); err != nil {
		return Artifact{}, err
	}
	return adopt(dir, tmp.Name(), hex.EncodeToString(h.Sum(nil)), size, name, os.Rename)
}

// StageFile takes a zip that is already on the machine. Uploading a 3 GB pack
// from a laptop over the tailnet is the slow path; wget on the box and paste
// the path is the fast one, and it is the same artifact either way.
func StageFile(dir, path string) (Artifact, error) {
	if !filepath.IsAbs(path) {
		return Artifact{}, fmt.Errorf("%w: %q is not an absolute path", ErrBadArtifact, path)
	}
	fi, err := os.Stat(path)
	if err != nil {
		return Artifact{}, err
	}
	if fi.IsDir() {
		return Artifact{}, fmt.Errorf("%w: %q is a directory", ErrBadArtifact, path)
	}
	f, err := os.Open(path)
	if err != nil {
		return Artifact{}, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return Artifact{}, err
	}
	sum := hex.EncodeToString(h.Sum(nil))

	// The source file belongs to the operator, so it is copied, never moved.
	// A hard link would be free but breaks the moment the original is edited.
	return adopt(dir, path, sum, fi.Size(), filepath.Base(path), copyFile)
}

// adopt gives a staged file its final name and writes the sidecar. install is
// how the bytes get there: a rename for an upload we own, a copy for a file
// that belongs to the operator.
func adopt(dir, src, sum string, size int64, name string, install func(string, string) error) (Artifact, error) {
	final := filepath.Join(dir, sum+".zip")
	if _, err := os.Stat(final); err != nil {
		if err := install(src, final); err != nil {
			return Artifact{}, err
		}
	}
	l, err := Probe(final)
	if err != nil {
		// Nothing else points at it yet: an artifact only becomes referenced
		// once an upgrade runs, and that cannot have happened before Probe.
		os.Remove(final)
		os.Remove(sidecar(final))
		return Artifact{}, err
	}
	a := Artifact{SHA256: sum, Name: name, Size: size, Added: time.Now().UTC(), Layout: l, Path: final}
	b, err := json.Marshal(a)
	if err != nil {
		return Artifact{}, err
	}
	if err := os.WriteFile(sidecar(final), b, 0o600); err != nil {
		return Artifact{}, err
	}
	return a, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".part"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func readSidecar(path string) (Artifact, error) {
	var a Artifact
	b, err := os.ReadFile(sidecar(path))
	if err != nil {
		return a, err
	}
	if err := json.Unmarshal(b, &a); err != nil {
		return a, err
	}
	a.Path = path
	return a, nil
}

// FindArtifact resolves a hash to a cached zip.
func FindArtifact(dir, sum string) (Artifact, error) {
	if len(sum) != 64 || strings.Trim(sum, "0123456789abcdef") != "" {
		return Artifact{}, fmt.Errorf("%w: %q is not a sha256", ErrBadArtifact, sum)
	}
	path := filepath.Join(dir, sum+".zip")
	if _, err := os.Stat(path); err != nil {
		return Artifact{}, err
	}
	if a, err := readSidecar(path); err == nil {
		return a, nil
	}
	l, err := Probe(path)
	if err != nil {
		return Artifact{}, err
	}
	fi, _ := os.Stat(path)
	return Artifact{SHA256: sum, Name: sum[:12] + ".zip", Size: fi.Size(), Layout: l, Path: path}, nil
}

// ListArtifacts returns the cached packs, newest first.
func ListArtifacts(dir string) ([]Artifact, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Artifact{}, nil
		}
		return nil, err
	}
	out := []Artifact{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".zip") {
			continue
		}
		a, err := readSidecar(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Added.After(out[j].Added) })
	return out, nil
}

// DeleteArtifact drops a cached pack. Versions keep their snapshot, so this
// never costs the ability to go back.
func DeleteArtifact(dir, sum string) error {
	a, err := FindArtifact(dir, sum)
	if err != nil {
		return err
	}
	os.Remove(sidecar(a.Path))
	return os.Remove(a.Path)
}
