package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/snowye/conduit/internal/backups"
	"github.com/snowye/conduit/internal/props"
	"github.com/snowye/conduit/internal/rcon"
	"github.com/snowye/conduit/internal/store"
	"github.com/snowye/conduit/internal/usage"
)

// --- stats ---

// stats is everything the detail screen polls: process counters from pm2, disk
// from a cached walk, and the player list from RCON when it is on.
func (s *Server) stats(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	inst, err := s.db.GetInstance(ctx, name)
	if err != nil {
		return err
	}

	out := map[string]any{"name": name, "status": "unknown"}
	if apps, err := s.client().List(ctx); err == nil {
		if a, ok := apps[name]; ok {
			out["status"] = a.Status
			out["pid"] = a.PID
			out["cpu_pct"] = a.CPUPct
			out["memory_mb"] = a.MemoryMB
			out["uptime_ms"] = a.UptimeMS
			out["restarts"] = a.Restarts
		} else {
			out["status"] = "not_started"
		}
	}

	if d, err := usage.Of(inst.Dir); err == nil {
		out["disk"] = d
	}

	if inst.RCONReady && out["status"] == "online" {
		if reply, err := rcon.Once(rconAddr(inst), inst.RCONPass, "list"); err == nil {
			out["players"] = strings.TrimSpace(reply)
		}
	}
	writeJSON(w, 200, out)
	return nil
}

func rconAddr(i store.Instance) string {
	port := i.RCONPort
	if port == 0 {
		port = 25575
	}
	// The agent runs on the same box, so RCON never leaves the loopback
	// interface and the password never crosses the network.
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
}

// --- console ---

// console runs one command through RCON and returns whatever the server said.
func (s *Server) console(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	inst, err := s.db.GetInstance(ctx, name)
	if err != nil {
		return err
	}
	var body struct {
		Command string `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, 400, "bad_request", err)
		return nil
	}
	cmd := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(body.Command), "/"))
	if cmd == "" {
		fail(w, 400, "bad_request", errors.New("empty command"))
		return nil
	}
	if !inst.RCONReady {
		fail(w, 409, "rcon_off", errors.New("turn RCON on for this instance first"))
		return nil
	}
	reply, err := rcon.Once(rconAddr(inst), inst.RCONPass, cmd)
	if err != nil {
		fail(w, 502, "rcon_failed", err)
		return nil
	}
	writeJSON(w, 200, map[string]any{"command": cmd, "reply": reply})
	return nil
}

// enableRCON writes the three properties that turn the remote console on. This
// edits a live server's configuration, so server.properties is copied next to
// itself first and the change only takes effect on the next restart.
//
// The password is generated and never shown. Nothing off the tailnet can reach
// the port, but Minecraft refuses to start RCON when the field is blank.
func (s *Server) enableRCON(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	inst, err := s.db.GetInstance(ctx, name)
	if err != nil {
		return err
	}
	path := filepath.Join(inst.Dir, "server.properties")
	cur, err := props.Read(path)
	if err != nil {
		return err
	}

	port := inst.RCONPort
	if port == 0 {
		port = 25575
	}
	if p, err := strconv.Atoi(cur["rcon.port"]); err == nil && p > 0 {
		port = p
	}

	pass := cur["rcon.password"]
	adopted := pass != "" && cur["enable-rcon"] == "true"
	if pass == "" {
		buf := make([]byte, 16)
		if _, err := rand.Read(buf); err != nil {
			return err
		}
		pass = hex.EncodeToString(buf)
	}

	if !adopted {
		if err := props.Write(path, map[string]string{
			"enable-rcon":   "true",
			"rcon.port":     strconv.Itoa(port),
			"rcon.password": pass,
		}); err != nil {
			return err
		}
	}

	inst.RCONPort, inst.RCONPass, inst.RCONReady = port, pass, true
	if err := s.db.PutInstance(ctx, inst); err != nil {
		return err
	}

	// If it is already listening, the running server was started with RCON on
	// and no restart is needed.
	live := false
	if _, err := rcon.Once(rconAddr(inst), pass, "list"); err == nil {
		live = true
	}
	writeJSON(w, 200, map[string]any{
		"name":             name,
		"rcon_port":        port,
		"already_enabled":  adopted,
		"connected":        live,
		"restart_required": !live,
	})
	return nil
}

// --- backups ---

func (s *Server) listBackups(w http.ResponseWriter, r *http.Request) error {
	inst, err := s.db.GetInstance(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	list, err := backups.List(inst.Dir)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, 200, []backups.Backup{})
			return nil
		}
		return err
	}
	writeJSON(w, 200, list)
	return nil
}

// createBackup asks the server's own backup mod to take one. Conduit does not
// zip the world itself: the mod flushes and pauses saving first, and a zip
// taken behind its back is a torn world.
func (s *Server) createBackup(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	inst, err := s.db.GetInstance(ctx, r.PathValue("name"))
	if err != nil {
		return err
	}
	if !inst.RCONReady {
		fail(w, 409, "rcon_off", errors.New("taking a backup needs RCON, turn it on first"))
		return nil
	}
	apps, err := s.client().List(ctx)
	if err != nil {
		return err
	}
	if a, ok := apps[inst.Name]; !ok || a.Status != "online" {
		fail(w, 409, "not_running", errors.New("the server must be running to back it up"))
		return nil
	}
	cmd := inst.BackupCmd
	if cmd == "" {
		cmd = "backup start"
	}
	reply, err := rcon.Once(rconAddr(inst), inst.RCONPass, cmd)
	if err != nil {
		fail(w, 502, "rcon_failed", err)
		return nil
	}
	// The mod zips in the background, so the new file shows up in the list a
	// moment later rather than in this reply.
	writeJSON(w, 200, map[string]any{"command": cmd, "reply": strings.TrimSpace(reply), "started": true})
	return nil
}

// restoreBackup stops the server, swaps the world and starts it again if it was
// running. The old world is moved aside, never deleted.
func (s *Server) restoreBackup(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	file := r.PathValue("file")
	inst, err := s.db.GetInstance(ctx, name)
	if err != nil {
		return err
	}

	apps, err := s.client().List(ctx)
	if err != nil {
		return err
	}
	wasOnline := false
	if a, ok := apps[name]; ok && a.Status == "online" {
		wasOnline = true
		if err := s.stopApp(ctx, name); err != nil {
			return fmt.Errorf("stop before restoring: %w", err)
		}
	}

	movedTo, err := backups.Restore(inst.Dir, file)
	if err != nil {
		return err
	}

	started := false
	if wasOnline {
		if err := s.client().Delete(ctx, name); err != nil {
			return err
		}
		if err := s.client().Start(ctx, name, inst.Dir, inst.Script); err != nil {
			return fmt.Errorf("world restored from %s, but starting again failed: %w", file, err)
		}
		started = true
	}
	writeJSON(w, 200, map[string]any{
		"name": name, "restored": file,
		"previous_world": filepath.Base(movedTo), "restarted": started,
	})
	return nil
}

// WarmDisk measures every instance in the background at startup, so the first
// dashboard load is not the one that pays for the walk.
func (s *Server) WarmDisk(ctx context.Context) {
	insts, err := s.db.ListInstances(ctx)
	if err != nil {
		return
	}
	for _, i := range insts {
		go usage.Of(i.Dir)
	}
}
