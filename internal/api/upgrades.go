package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/snowye/conduit/internal/settings"
	"github.com/snowye/conduit/internal/store"
	"github.com/snowye/conduit/internal/upgrade"
)

// An upgrade takes minutes: a snapshot of a gigabyte of mods, a world backup,
// an unzip and a full modded boot. None of that fits in a request, so the call
// answers 202 with a run and the page polls it. The instance stays claimed in
// s.busy for the whole run, so nothing else can start or restore underneath.

// Step is one line of the progress list the page shows.
type Step struct {
	Name   string    `json:"name"`
	State  string    `json:"state"` // pending | running | done | skipped | failed
	Detail string    `json:"detail,omitempty"`
	Ended  time.Time `json:"ended,omitzero"`
}

// Run is the live state of an upgrade or a revert.
type Run struct {
	Instance  string    `json:"instance"`
	Kind      string    `json:"kind"` // upgrade | revert
	Label     string    `json:"label"`
	Steps     []Step    `json:"steps"`
	Started   time.Time `json:"started"`
	Ended     time.Time `json:"ended,omitzero"`
	Done      bool      `json:"done"`
	Error     string    `json:"error,omitempty"`
	VersionID int64     `json:"version_id,omitempty"`
}

// run is the mutable side of a Run. The handler goroutine writes it and the
// polling handler reads it, so every access goes through the mutex and the
// reader gets a copy.
type run struct {
	mu sync.Mutex
	r  Run
}

func (x *run) snapshot() Run {
	x.mu.Lock()
	defer x.mu.Unlock()
	out := x.r
	// A copy, and never nil: the page maps over this the moment it arrives,
	// before the first step has been recorded.
	out.Steps = append([]Step{}, x.r.Steps...)
	return out
}

func (x *run) begin(name string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.r.Steps = append(x.r.Steps, Step{Name: name, State: "running"})
}

func (x *run) finish(state, detail string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if n := len(x.r.Steps); n > 0 {
		x.r.Steps[n-1].State = state
		x.r.Steps[n-1].Detail = detail
		x.r.Steps[n-1].Ended = time.Now()
	}
}

func (x *run) fail(err error) {
	x.mu.Lock()
	x.r.Error = err.Error()
	x.mu.Unlock()
}

func (x *run) end(versionID int64) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.r.VersionID = versionID
	x.r.Done = true
	x.r.Ended = time.Now()
}

// startRun claims the instance and hands back a recorder. The claim is
// released by the runner, not by the request, because the work outlives it.
func (s *Server) startRun(name, kind, label string) (*run, error) {
	if err := s.acquire(name, kind+" in progress"); err != nil {
		return nil, err
	}
	x := &run{r: Run{Instance: name, Kind: kind, Label: label, Started: time.Now(), Steps: []Step{}}}
	s.runMu.Lock()
	if s.runs == nil {
		s.runs = map[string]*run{}
	}
	s.runs[name] = x
	s.runMu.Unlock()
	return x, nil
}

func (s *Server) lastRun(name string) *Run {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	x := s.runs[name]
	if x == nil {
		return nil
	}
	out := x.snapshot()
	return &out
}

// --- artifacts ---

// maxUpload is a ceiling, not a target. The biggest server pack seen is under
// 2 GB; this stops a wrong file from filling the boot disk.
const maxUpload = 8 << 30

// putArtifact takes a pack zip, either uploaded from the browser or already on
// the machine. It probes the zip before saying yes, so a screenshot or a
// client-only zip is rejected here rather than half way through an upgrade.
func (s *Server) putArtifact(w http.ResponseWriter, r *http.Request) error {
	dir := settings.ArtifactDir()

	ct := r.Header.Get("Content-Type")
	var (
		a   upgrade.Artifact
		err error
	)
	switch {
	case strings.HasPrefix(ct, "multipart/form-data"):
		mr, mrErr := r.MultipartReader()
		if mrErr != nil {
			fail(w, 400, "bad_request", mrErr)
			return nil
		}
		part, partErr := mr.NextPart()
		for partErr == nil && part.FormName() != "file" {
			part.Close()
			part, partErr = mr.NextPart()
		}
		if partErr != nil {
			fail(w, 400, "bad_request", errors.New("no file part in the upload"))
			return nil
		}
		defer part.Close()
		a, err = upgrade.Stage(dir, http.MaxBytesReader(w, part, maxUpload), part.FileName())
	default:
		var body struct {
			Path string `json:"path"`
		}
		if decErr := json.NewDecoder(r.Body).Decode(&body); decErr != nil {
			fail(w, 400, "bad_request", decErr)
			return nil
		}
		if strings.TrimSpace(body.Path) == "" {
			fail(w, 400, "bad_request", errors.New("upload a file or give a path on the server"))
			return nil
		}
		a, err = upgrade.StageFile(dir, expandHome(strings.TrimSpace(body.Path)))
	}
	if err != nil {
		if errors.Is(err, upgrade.ErrBadArtifact) {
			fail(w, 400, "bad_artifact", err)
			return nil
		}
		if os.IsNotExist(err) {
			fail(w, 404, "not_found", err)
			return nil
		}
		return err
	}
	writeJSON(w, 200, a)
	return nil
}

// expandHome makes ~/packs/x.zip work, since that is how the path is written
// when you just scp'd the file.
func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

func (s *Server) listArtifacts(w http.ResponseWriter, r *http.Request) error {
	list, err := upgrade.ListArtifacts(settings.ArtifactDir())
	if err != nil {
		return err
	}
	writeJSON(w, 200, list)
	return nil
}

func (s *Server) deleteArtifact(w http.ResponseWriter, r *http.Request) error {
	if err := upgrade.DeleteArtifact(settings.ArtifactDir(), r.PathValue("sha")); err != nil {
		if errors.Is(err, upgrade.ErrBadArtifact) {
			fail(w, 400, "bad_request", err)
			return nil
		}
		if os.IsNotExist(err) {
			fail(w, 404, "not_found", err)
			return nil
		}
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// --- versions ---

// listVersions is everything the upgrades tab draws: the history, which one is
// live, and the run in flight if there is one.
func (s *Server) listVersions(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	if _, err := s.db.GetInstance(ctx, name); err != nil {
		return err
	}
	list, err := s.db.ListVersions(ctx, name)
	if err != nil {
		return err
	}
	out := map[string]any{"versions": list, "run": s.lastRun(name)}
	for _, v := range list {
		if v.State == "active" {
			out["active"] = v
			break
		}
	}
	writeJSON(w, 200, out)
	return nil
}

func (s *Server) upgradeStatus(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	if _, err := s.db.GetInstance(r.Context(), name); err != nil {
		return err
	}
	if cur := s.lastRun(name); cur != nil {
		writeJSON(w, 200, cur)
		return nil
	}
	writeJSON(w, 200, nil)
	return nil
}

// dropSnapshot frees the archive of one version. The row stays and the version
// becomes un-revertible, which the list says out loud.
func (s *Server) dropSnapshot(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		fail(w, 400, "bad_request", err)
		return nil
	}
	v, err := s.db.GetVersion(ctx, name, id)
	if err != nil {
		return err
	}
	if v.State == "active" {
		fail(w, 409, "conflict", errors.New("that is the version running now"))
		return nil
	}
	if err := s.db.ClearVersionSnapshot(ctx, id); err != nil {
		return err
	}
	if err := s.removeUnreferenced(ctx, name, v.Snapshot); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// removeUnreferenced deletes a snapshot file once no version row points at it.
// Reverting makes two rows share one archive, so the check is not optional.
func (s *Server) removeUnreferenced(ctx context.Context, instance, path string) error {
	if path == "" {
		return nil
	}
	list, err := s.db.ListVersions(ctx, instance)
	if err != nil {
		return err
	}
	for _, v := range list {
		if v.Snapshot == path {
			return nil
		}
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// keepSnapshots is how many versions can still be returned to. Each archive is
// the mods, configs and libraries of one pack, so a few hundred megabytes;
// three is two upgrades of headroom and a bounded disk cost.
const keepSnapshots = 3

func (s *Server) pruneSnapshots(ctx context.Context, instance string) {
	list, err := s.db.ListVersions(ctx, instance)
	if err != nil {
		return
	}
	kept := 0
	for _, v := range list {
		if v.Snapshot == "" {
			continue
		}
		kept++
		if kept <= keepSnapshots {
			continue
		}
		if err := s.db.ClearVersionSnapshot(ctx, v.ID); err != nil {
			return
		}
		s.removeUnreferenced(ctx, instance, v.Snapshot)
	}
}

func snapshotPath(instance string, id int64) string {
	return filepath.Join(settings.VersionDir(), instance, fmt.Sprintf("v%d.zip", id))
}

// baseline records whatever is on disk before Conduit ever upgraded this
// instance, so the first upgrade has something to go back to.
func (s *Server) baseline(ctx context.Context, inst store.Instance) (store.Version, error) {
	v, err := s.db.ActiveVersion(ctx, inst.Name)
	if err == nil {
		return v, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return v, err
	}
	label := inst.Version
	if label == "" {
		label = "before conduit"
	}
	return s.db.AddVersion(ctx, store.Version{
		Instance: inst.Name, Label: label, Source: "baseline", State: "active",
		Note: "the files already in the directory when the first upgrade ran",
	})
}
