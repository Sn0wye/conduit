package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/snowye/conduit/internal/config"
	"github.com/snowye/conduit/internal/pm2"
	"github.com/snowye/conduit/internal/store"
)

type Server struct {
	cfg config.Config
	db  *store.DB
	pm  *pm2.Client
}

func New(cfg config.Config, db *store.DB, pm *pm2.Client) *Server {
	return &Server{cfg: cfg, db: db, pm: pm}
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code string, err error) {
	writeJSON(w, status, map[string]apiError{"error": {Code: code, Message: err.Error()}})
}

func handle(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			switch {
			case errors.Is(err, store.ErrNotFound):
				fail(w, http.StatusNotFound, "not_found", err)
			default:
				fail(w, http.StatusInternalServerError, "internal", err)
			}
		}
	}
}

func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/info", handle(s.info))
	mux.HandleFunc("GET /v1/instances", handle(s.listInstances))
	mux.HandleFunc("POST /v1/instances", handle(s.putInstance))
	mux.HandleFunc("GET /v1/instances/scan", handle(s.scan))
	mux.HandleFunc("GET /v1/instances/{name}", handle(s.getInstance))
	mux.HandleFunc("DELETE /v1/instances/{name}", handle(s.deleteInstance))
	mux.HandleFunc("POST /v1/instances/{name}/start", handle(s.start))
	mux.HandleFunc("POST /v1/instances/{name}/stop", handle(s.stop))
	mux.HandleFunc("POST /v1/instances/{name}/restart", handle(s.restart))
	mux.HandleFunc("GET /v1/instances/{name}/logs", handle(s.logs))
	return mux
}

// --- info ---

func (s *Server) info(w http.ResponseWriter, r *http.Request) error {
	host, _ := os.Hostname()
	ver, pmErr := s.pm.Version(r.Context())
	out := map[string]any{
		"node":     s.cfg.NodeName,
		"hostname": host,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
		"pm2":      ver,
		"user":     userFrom(r.Context()),
	}
	if pmErr != nil {
		out["pm2_error"] = pmErr.Error()
	}
	writeJSON(w, 200, out)
	return nil
}

// --- instances ---

// view is an instance plus its live pm2 status. Status is never persisted.
type view struct {
	store.Instance
	Status   string  `json:"status"`
	PID      int     `json:"pid"`
	MemoryMB int64   `json:"memory_mb"`
	CPUPct   float64 `json:"cpu_pct"`
	UptimeMS int64   `json:"uptime_ms"`
	Restarts int     `json:"restarts"`
	Known    bool    `json:"known_to_pm2"`
}

func (s *Server) views(ctx context.Context) ([]view, error) {
	insts, err := s.db.ListInstances(ctx)
	if err != nil {
		return nil, err
	}
	apps, err := s.pm.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]view, 0, len(insts))
	for _, i := range insts {
		v := view{Instance: i, Status: "unregistered"}
		if a, ok := apps[i.Name]; ok {
			v.Known, v.Status, v.PID = true, a.Status, a.PID
			v.MemoryMB, v.CPUPct, v.UptimeMS, v.Restarts = a.MemoryMB, a.CPUPct, a.UptimeMS, a.Restarts
		}
		out = append(out, v)
	}
	return out, nil
}

func (s *Server) listInstances(w http.ResponseWriter, r *http.Request) error {
	v, err := s.views(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, 200, v)
	return nil
}

func (s *Server) getInstance(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	i, err := s.db.GetInstance(r.Context(), name)
	if err != nil {
		return err
	}
	v := view{Instance: i, Status: "unregistered"}
	if apps, err := s.pm.List(r.Context()); err == nil {
		if a, ok := apps[name]; ok {
			v.Known, v.Status, v.PID = true, a.Status, a.PID
			v.MemoryMB, v.CPUPct, v.UptimeMS, v.Restarts = a.MemoryMB, a.CPUPct, a.UptimeMS, a.Restarts
		}
	}
	writeJSON(w, 200, v)
	return nil
}

func (s *Server) putInstance(w http.ResponseWriter, r *http.Request) error {
	var i store.Instance
	if err := json.NewDecoder(r.Body).Decode(&i); err != nil {
		fail(w, 400, "bad_request", err)
		return nil
	}
	if i.Name == "" || i.Dir == "" {
		fail(w, 400, "bad_request", errors.New("name and dir are required"))
		return nil
	}
	if err := s.db.PutInstance(r.Context(), i); err != nil {
		return err
	}
	writeJSON(w, 200, i)
	return nil
}

func (s *Server) deleteInstance(w http.ResponseWriter, r *http.Request) error {
	// Files on disk are never touched. This only forgets the instance.
	if err := s.db.DeleteInstance(r.Context(), r.PathValue("name")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// scan proposes instances found in pm2 and on disk that are not registered
// yet. The two sources overlap: pm2 knows "co" and the disk knows
// "contained-opolis", and they are the same server. Directories are matched
// after resolving symlinks, and the pm2 name wins because that is what the
// server is already registered as.
func (s *Server) scan(w http.ResponseWriter, r *http.Request) error {
	insts, err := s.db.ListInstances(r.Context())
	if err != nil {
		return err
	}
	knownName := map[string]bool{}
	claimed := map[string]bool{}
	for _, i := range insts {
		knownName[i.Name] = true
		claimed[realpath(i.Dir)] = true
	}

	out := []store.Instance{}
	add := func(name, dir string) {
		real := realpath(dir)
		if knownName[name] || claimed[real] {
			return
		}
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			return // pm2 remembers directories that have since moved
		}
		claimed[real] = true
		out = append(out, store.Instance{Name: name, Dir: dir, Script: "./run.sh",
			Port: 25565, RCONPort: 25575})
	}

	if apps, err := s.pm.List(r.Context()); err == nil {
		names := make([]string, 0, len(apps))
		for n := range apps {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			add(n, apps[n].Dir)
		}
	}
	if s.cfg.ServersRoot != "" {
		entries, _ := os.ReadDir(s.cfg.ServersRoot)
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			dir := filepath.Join(s.cfg.ServersRoot, e.Name())
			if _, err := os.Stat(filepath.Join(dir, "run.sh")); err != nil {
				continue // not a Forge or NeoForge server directory
			}
			add(e.Name(), dir)
		}
	}
	writeJSON(w, 200, out)
	return nil
}

// realpath resolves symlinks so two names for one directory collapse into one.
func realpath(dir string) string {
	if r, err := filepath.EvalSymlinks(dir); err == nil {
		return r
	}
	return filepath.Clean(dir)
}

// --- lifecycle ---

// start stops whatever else is online first. Every instance on this box shares
// port 25565, so exactly one can run. Conduit decides which, rather than
// leaving it to whichever process binds the port first.
func (s *Server) start(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	inst, err := s.db.GetInstance(ctx, name)
	if err != nil {
		return err
	}
	apps, err := s.pm.List(ctx)
	if err != nil {
		return err
	}
	stopped := []string{}
	for other, a := range apps {
		if other != name && a.Status == "online" {
			if err := s.stopApp(ctx, other); err != nil {
				return fmt.Errorf("stopping %s first: %w", other, err)
			}
			stopped = append(stopped, other)
		}
	}
	if a, ok := apps[name]; ok && a.Status == "online" {
		writeJSON(w, 200, map[string]any{"name": name, "already_running": true})
		return nil
	}
	if _, ok := apps[name]; ok {
		// pm2 already has the app registered from a previous run, so reuse it
		// rather than creating a duplicate entry with different flags.
		if err := s.pm.Delete(ctx, name); err != nil {
			return err
		}
	}
	if err := s.pm.Start(ctx, name, inst.Dir, inst.Script); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"name": name, "started": true, "stopped_first": stopped})
	return nil
}

// stopApp shuts a server down. Phase 1 has no RCON, so this is pm2 sending
// SIGINT and Minecraft's own shutdown handler saving the world. Once RCON is
// enabled per instance this sends "stop" first and waits for a clean exit.
func (s *Server) stopApp(ctx context.Context, name string) error {
	if err := s.pm.Stop(ctx, name); err != nil {
		return err
	}
	return s.pm.WaitStopped(ctx, name, 130*time.Second)
}

func (s *Server) stop(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	if _, err := s.db.GetInstance(r.Context(), name); err != nil {
		return err
	}
	if err := s.stopApp(r.Context(), name); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"name": name, "stopped": true})
	return nil
}

func (s *Server) restart(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	name := r.PathValue("name")
	inst, err := s.db.GetInstance(ctx, name)
	if err != nil {
		return err
	}
	if err := s.stopApp(ctx, name); err != nil {
		return err
	}
	if err := s.pm.Delete(ctx, name); err != nil {
		return err
	}
	if err := s.pm.Start(ctx, name, inst.Dir, inst.Script); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"name": name, "restarted": true})
	return nil
}

func (s *Server) logs(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	inst, err := s.db.GetInstance(r.Context(), name)
	if err != nil {
		return err
	}
	n := 200
	if v := r.URL.Query().Get("tail"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 && parsed <= 5000 {
			n = parsed
		}
	}
	body, err := tailFile(filepath.Join(inst.Dir, "logs", "latest.log"), n)
	if err != nil {
		home, _ := os.UserHomeDir()
		body, err = tailFile(filepath.Join(home, ".pm2", "logs", name+"-out.log"), n)
		if err != nil {
			return err
		}
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(body))
	return nil
}

func tailFile(path string, n int) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n"), nil
}
