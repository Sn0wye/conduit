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
	"time"

	"github.com/snowye/conduit/internal/backups"
	"github.com/snowye/conduit/internal/settings"
	"github.com/snowye/conduit/internal/store"
	"github.com/snowye/conduit/internal/upgrade"
)

// runTimeout bounds the whole operation. A pack this large on a four core ARM
// box is minutes of unzip plus a modded boot, and a run that has not finished
// in an hour is stuck rather than slow.
const runTimeout = time.Hour

// bootTimeout is how long a first boot on new mods may take before the upgrade
// counts as failed. New configs, recipe reload and datapack sync make the boot
// after an upgrade much slower than a normal one.
const bootTimeout = 15 * time.Minute

// startUpgrade validates everything it can while the server is still running,
// then answers 202 and does the work in the background.
func (s *Server) startUpgrade(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	inst, err := s.db.GetInstance(ctx, name)
	if err != nil {
		return err
	}
	var body struct {
		Artifact string `json:"artifact"`
		Label    string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, 400, "bad_request", err)
		return nil
	}
	a, err := upgrade.FindArtifact(settings.ArtifactDir(), strings.TrimSpace(body.Artifact))
	if err != nil {
		if errors.Is(err, upgrade.ErrBadArtifact) {
			fail(w, 400, "bad_request", err)
			return nil
		}
		fail(w, 404, "not_found", fmt.Errorf("that pack is no longer in the cache: %w", err))
		return nil
	}
	label := strings.TrimSpace(body.Label)
	if label == "" {
		label = a.Layout.Label
	}
	if label == "" {
		label = strings.TrimSuffix(a.Name, ".zip")
	}

	x, err := s.startRun(name, "upgrade", label)
	if err != nil {
		fail(w, http.StatusConflict, "busy", err)
		return nil
	}
	go s.runUpgrade(inst, a, label, x)
	writeJSON(w, http.StatusAccepted, x.snapshot())
	return nil
}

func (s *Server) runUpgrade(inst store.Instance, a upgrade.Artifact, label string, x *run) {
	defer s.release(inst.Name)
	ctx, cancel := context.WithTimeout(context.Background(), runTimeout)
	defer cancel()

	id, err := s.upgradeSteps(ctx, inst, a, label, x)
	if err != nil {
		x.fail(err)
	}
	x.end(id)
}

func (s *Server) upgradeSteps(ctx context.Context, inst store.Instance, a upgrade.Artifact, label string, x *run) (int64, error) {
	prev, err := s.baseline(ctx, inst)
	if err != nil {
		return 0, err
	}

	x.begin("stop the server")
	wasOnline, err := s.stopIfOnline(ctx, inst.Name)
	if err != nil {
		x.finish("failed", err.Error())
		return 0, err
	}
	if wasOnline {
		x.finish("done", "stopped")
	} else {
		x.finish("done", "was not running")
	}

	// The world is backed up cold, with the server down, because that is the
	// only moment nothing is writing to it. The backup mod's command is the
	// right tool on a running server and the wrong one here.
	x.begin("back up the world")
	b, err := backups.Create(inst.Dir, prev.Label)
	switch {
	case errors.Is(err, backups.ErrNotFound):
		x.finish("skipped", "no world on disk yet")
	case err != nil:
		x.finish("failed", err.Error())
		return 0, fmt.Errorf("back up the world: %w", err)
	default:
		if err := s.db.SetVersionWorldBackup(ctx, prev.ID, b.File); err != nil {
			x.finish("failed", err.Error())
			return 0, err
		}
		x.finish("done", fmt.Sprintf("%s, %s", b.File, human(b.Size)))
	}

	x.begin("archive the current server files")
	snapPath := prev.Snapshot
	if snapPath == "" {
		snapPath = snapshotPath(inst.Name, prev.ID)
	}
	size, err := upgrade.Snapshot(inst.Dir, snapPath)
	if err != nil {
		x.finish("failed", err.Error())
		return 0, fmt.Errorf("archive the current files: %w", err)
	}
	if err := s.db.SetVersionSnapshot(ctx, prev.ID, snapPath, size); err != nil {
		x.finish("failed", err.Error())
		return 0, err
	}
	prev.Snapshot, prev.SnapshotBytes = snapPath, size
	x.finish("done", human(size)+" of mods, configs and scripts")

	x.begin("unpack " + a.Name)
	rep, err := upgrade.Apply(inst.Dir, a.Path, a.Layout)
	if err != nil {
		// The pack is half applied, so put the old one straight back rather
		// than leaving a directory that is neither version.
		if rErr := upgrade.Restore(inst.Dir, snapPath); rErr != nil {
			x.finish("failed", fmt.Sprintf("%v; putting the old files back also failed: %v", err, rErr))
			return 0, err
		}
		x.finish("failed", err.Error()+"; the old files are back")
		return 0, err
	}
	x.finish("done", fmt.Sprintf("%d files, %d mods, kept %s", rep.Files, rep.Mods, keptList(rep.Preserved)))

	x.begin("record the version")
	if err := s.db.SetVersionState(ctx, prev.ID, "superseded", "replaced by "+label); err != nil {
		x.finish("failed", err.Error())
		return 0, err
	}
	next, err := s.db.AddVersion(ctx, store.Version{
		Instance: inst.Name, Label: label, Source: "upload",
		Artifact: a.SHA256, ArtifactName: a.Name, State: "active",
	})
	if err != nil {
		x.finish("failed", err.Error())
		return 0, err
	}
	x.finish("done", "now on "+label)

	// The instance row carries the version too, so the dashboard shows it
	// without reading the history.
	inst.Version = label
	if err := s.db.PutInstance(ctx, inst); err != nil {
		return next.ID, err
	}

	x.begin("start and wait for the world to load")
	if err := s.bootAndWait(ctx, inst); err != nil {
		x.finish("failed", err.Error())
		s.autoRollback(ctx, inst, prev, next, x, err)
		return next.ID, err
	}
	x.finish("done", "the server is up on "+label)

	s.pruneSnapshots(ctx, inst.Name)
	return next.ID, nil
}

// autoRollback puts the previous version back when the new one will not boot.
// This is the whole point of the snapshot: a failed upgrade must not leave the
// server down while you read a stack trace on your phone.
func (s *Server) autoRollback(ctx context.Context, inst store.Instance, prev, failed store.Version, x *run, cause error) {
	x.begin("put " + prev.Label + " back")
	if prev.Snapshot == "" {
		x.finish("failed", "no archive of the previous version to put back")
		return
	}
	if _, err := s.stopIfOnline(ctx, inst.Name); err != nil {
		x.finish("failed", err.Error())
		return
	}
	if err := upgrade.Restore(inst.Dir, prev.Snapshot); err != nil {
		x.finish("failed", err.Error())
		return
	}
	if err := s.db.SetVersionState(ctx, failed.ID, "failed", "did not boot: "+cause.Error()); err != nil {
		x.finish("failed", err.Error())
		return
	}
	back, err := s.db.AddVersion(ctx, store.Version{
		Instance: inst.Name, Label: prev.Label, Source: "revert",
		Artifact: prev.Artifact, ArtifactName: prev.ArtifactName,
		Snapshot: prev.Snapshot, SnapshotBytes: prev.SnapshotBytes,
		WorldBackup: prev.WorldBackup, State: "active", RevertOf: prev.ID,
		Note: "put back automatically after " + failed.Label + " failed to boot",
	})
	if err != nil {
		x.finish("failed", err.Error())
		return
	}
	inst.Version = prev.Label
	s.db.PutInstance(ctx, inst)
	x.finish("done", "back on "+prev.Label)
	_ = back

	// Starting again is best effort. The files are what matter; if the start
	// fails too, the instance screen has a start button.
	x.begin("start " + prev.Label)
	if err := s.startInstance(ctx, inst); err != nil {
		x.finish("failed", err.Error())
		return
	}
	x.finish("done", "started")
}

// --- revert ---

// startRevert goes back to an earlier version on purpose, rather than because
// a boot failed.
func (s *Server) startRevert(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	inst, err := s.db.GetInstance(ctx, name)
	if err != nil {
		return err
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		fail(w, 400, "bad_request", err)
		return nil
	}
	target, err := s.db.GetVersion(ctx, name, id)
	if err != nil {
		return err
	}
	if !target.Revertible() {
		fail(w, 409, "no_snapshot", errors.New("the archive for that version was pruned, so it cannot be put back"))
		return nil
	}
	if _, err := os.Stat(target.Snapshot); err != nil {
		fail(w, 409, "no_snapshot", fmt.Errorf("the archive for that version is gone from disk: %w", err))
		return nil
	}
	if target.State == "active" {
		fail(w, 409, "conflict", errors.New("that version is already the one running"))
		return nil
	}
	var body struct {
		// RestoreWorld also puts back the world as it was when that version
		// was last running. Without it the current world is kept, which is
		// what you want when the upgrade itself was the problem and nothing
		// in the world has moved on.
		RestoreWorld bool `json:"restore_world"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.RestoreWorld && target.WorldBackup == "" {
		fail(w, 409, "no_world_backup", errors.New("no world backup was taken for that version"))
		return nil
	}

	x, err := s.startRun(name, "revert", target.Label)
	if err != nil {
		fail(w, http.StatusConflict, "busy", err)
		return nil
	}
	go s.runRevert(inst, target, body.RestoreWorld, x)
	writeJSON(w, http.StatusAccepted, x.snapshot())
	return nil
}

func (s *Server) runRevert(inst store.Instance, target store.Version, restoreWorld bool, x *run) {
	defer s.release(inst.Name)
	ctx, cancel := context.WithTimeout(context.Background(), runTimeout)
	defer cancel()

	id, err := s.revertSteps(ctx, inst, target, restoreWorld, x)
	if err != nil {
		x.fail(err)
	}
	x.end(id)
}

func (s *Server) revertSteps(ctx context.Context, inst store.Instance, target store.Version, restoreWorld bool, x *run) (int64, error) {
	cur, err := s.baseline(ctx, inst)
	if err != nil {
		return 0, err
	}

	x.begin("stop the server")
	if _, err := s.stopIfOnline(ctx, inst.Name); err != nil {
		x.finish("failed", err.Error())
		return 0, err
	}
	x.finish("done", "")

	// Going back is itself undoable: the world and the files being left behind
	// are both saved before anything is overwritten.
	x.begin("back up the world")
	b, err := backups.Create(inst.Dir, cur.Label)
	switch {
	case errors.Is(err, backups.ErrNotFound):
		x.finish("skipped", "no world on disk")
	case err != nil:
		x.finish("failed", err.Error())
		return 0, fmt.Errorf("back up the world: %w", err)
	default:
		s.db.SetVersionWorldBackup(ctx, cur.ID, b.File)
		x.finish("done", fmt.Sprintf("%s, %s", b.File, human(b.Size)))
	}

	if cur.Snapshot == "" {
		x.begin("archive " + cur.Label)
		path := snapshotPath(inst.Name, cur.ID)
		size, err := upgrade.Snapshot(inst.Dir, path)
		if err != nil {
			x.finish("failed", err.Error())
			return 0, err
		}
		if err := s.db.SetVersionSnapshot(ctx, cur.ID, path, size); err != nil {
			x.finish("failed", err.Error())
			return 0, err
		}
		x.finish("done", human(size))
	}

	x.begin("put " + target.Label + " back")
	if err := upgrade.Restore(inst.Dir, target.Snapshot); err != nil {
		x.finish("failed", err.Error())
		return 0, err
	}
	x.finish("done", "")

	if restoreWorld {
		x.begin("restore the world from " + target.WorldBackup)
		movedTo, err := backups.Restore(inst.Dir, target.WorldBackup)
		if err != nil {
			x.finish("failed", err.Error())
			return 0, err
		}
		x.finish("done", "the world in place is kept as "+filepath.Base(movedTo))
	}

	x.begin("record the version")
	if err := s.db.SetVersionState(ctx, cur.ID, "rolled_back", "went back to "+target.Label); err != nil {
		x.finish("failed", err.Error())
		return 0, err
	}
	next, err := s.db.AddVersion(ctx, store.Version{
		Instance: inst.Name, Label: target.Label, Source: "revert",
		Artifact: target.Artifact, ArtifactName: target.ArtifactName,
		// The archive is shared with the row it was taken from, so going back
		// twice costs nothing. Pruning only deletes a file no row points at.
		Snapshot: target.Snapshot, SnapshotBytes: target.SnapshotBytes,
		WorldBackup: target.WorldBackup, State: "active", RevertOf: target.ID,
	})
	if err != nil {
		x.finish("failed", err.Error())
		return 0, err
	}
	inst.Version = target.Label
	s.db.PutInstance(ctx, inst)
	x.finish("done", "back on "+target.Label)

	x.begin("start and wait for the world to load")
	if err := s.bootAndWait(ctx, inst); err != nil {
		x.finish("failed", err.Error())
		return next.ID, err
	}
	x.finish("done", "the server is up on "+target.Label)
	return next.ID, nil
}

// --- shared machinery ---

func (s *Server) stopIfOnline(ctx context.Context, name string) (bool, error) {
	apps, err := s.client().List(ctx)
	if err != nil {
		return false, err
	}
	if a, ok := apps[name]; !ok || a.Status != "online" {
		return false, nil
	}
	return true, s.stopApp(ctx, name)
}

// startInstance is the start rule from the lifecycle handlers: everything else
// on the box shares port 25565, so whatever is up goes down first.
func (s *Server) startInstance(ctx context.Context, inst store.Instance) error {
	apps, err := s.client().List(ctx)
	if err != nil {
		return err
	}
	for other, a := range apps {
		if other != inst.Name && a.Status == "online" {
			if err := s.stopApp(ctx, other); err != nil {
				return fmt.Errorf("stopping %s first: %w", other, err)
			}
		}
	}
	if _, ok := apps[inst.Name]; ok {
		if err := s.client().Delete(ctx, inst.Name); err != nil {
			return err
		}
	}
	return s.client().Start(ctx, inst.Name, inst.Dir, inst.Script)
}

// bootAndWait starts the server and waits for the line Minecraft prints when
// the world is loaded. Without the wait, an upgrade that boots straight into a
// missing-mod crash would be reported as a success.
func (s *Server) bootAndWait(ctx context.Context, inst store.Instance) error {
	if err := s.startInstance(ctx, inst); err != nil {
		return err
	}
	return s.waitForBoot(ctx, inst, bootTimeout)
}

// doneLine is what vanilla prints once the world is loaded and the server is
// accepting logins. Every pack on the box keeps it.
const doneLine = `)! For help, type "help"`

func (s *Server) waitForBoot(ctx context.Context, inst store.Instance, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	logPath := filepath.Join(inst.Dir, "logs", "latest.log")
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}

		if b, err := os.ReadFile(logPath); err == nil {
			text := string(b)
			if strings.Contains(text, doneLine) || strings.Contains(text, "Done (") {
				return nil
			}
		}

		// pm2 runs these with --no-autorestart, so a process that is gone is a
		// crash, not a restart in progress. Reporting it now beats waiting out
		// the full fifteen minutes on a crash that happened in ten seconds.
		apps, err := s.client().List(ctx)
		if err == nil {
			a, ok := apps[inst.Name]
			if !ok || (a.Status != "online" && a.Status != "launching") {
				return fmt.Errorf("the server exited before the world loaded, check the log")
			}
		}

		if time.Now().After(deadline) {
			return fmt.Errorf("the world did not finish loading within %s", timeout)
		}
	}
}

func keptList(names []string) string {
	if len(names) == 0 {
		return "nothing to keep"
	}
	return strings.Join(names, ", ")
}

func human(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
