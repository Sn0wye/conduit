// Package settings replaces the config file. Nothing is configured on the
// machine: paths are detected at startup, and the PWA can override any of them
// into SQLite when a guess is wrong.
package settings

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Settings struct {
	// PM2Bin is the absolute path to pm2. It is rarely on a non-login PATH
	// because n, nvm, fnm and volta all install it under the home directory.
	PM2Bin string `json:"pm2_bin"`
	// NodeBinDir is prepended to PATH for pm2 calls. pm2 is a node script, so
	// finding the pm2 path alone is not enough.
	NodeBinDir string `json:"node_bin_dir"`
	// ServersRoot is scanned for unregistered instance directories, on top of
	// whatever pm2 already reports.
	ServersRoot string `json:"servers_root"`
	// CurseForgeKey is used server side only and is never sent to the browser.
	CurseForgeKey string `json:"-"`
	// HasCurseForgeKey tells the PWA whether a key is stored without leaking it.
	HasCurseForgeKey bool `json:"has_curseforge_key"`
	// Detected reports which fields came from detection rather than an override.
	Detected map[string]bool `json:"detected"`
}

// Keys stored in the settings table. Anything absent falls back to detection.
const (
	KeyPM2Bin        = "pm2_bin"
	KeyNodeBinDir    = "node_bin_dir"
	KeyServersRoot   = "servers_root"
	KeyCurseForgeKey = "curseforge_key"
	KeyOwner         = "owner"
	// KeyGuests is a comma separated list of tailnet logins that may use the
	// machine alongside the owner. Conduit stays single-operator: guests are
	// named one by one, never a whole tailnet.
	KeyGuests = "guests"
)

// ParseGuests splits a stored guest list. Blank entries are dropped so an
// empty setting cannot accidentally admit the empty login.
func ParseGuests(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// AddGuest returns the list with login added, and reports whether it was new.
func AddGuest(v, login string) (string, bool) {
	guests := ParseGuests(v)
	for _, g := range guests {
		if g == login {
			return strings.Join(guests, ","), false
		}
	}
	return strings.Join(append(guests, login), ","), true
}

// RemoveGuest returns the list with login dropped, and reports whether it was
// there to begin with.
func RemoveGuest(v, login string) (string, bool) {
	var out []string
	found := false
	for _, g := range ParseGuests(v) {
		if g == login {
			found = true
			continue
		}
		out = append(out, g)
	}
	return strings.Join(out, ","), found
}

type Reader interface {
	Settings(ctx context.Context) (map[string]string, error)
}

// Load detects what it can, then lets stored overrides win.
func Load(ctx context.Context, r Reader) (Settings, error) {
	stored, err := r.Settings(ctx)
	if err != nil {
		return Settings{}, err
	}
	s := Detect(ctx)
	s.Detected = map[string]bool{}
	pick := func(key string, field *string) {
		if v := stored[key]; v != "" {
			*field = v
			return
		}
		s.Detected[key] = *field != ""
	}
	pick(KeyPM2Bin, &s.PM2Bin)
	pick(KeyNodeBinDir, &s.NodeBinDir)
	pick(KeyServersRoot, &s.ServersRoot)
	s.CurseForgeKey = stored[KeyCurseForgeKey]
	s.HasCurseForgeKey = s.CurseForgeKey != ""
	return s, nil
}

// Detect guesses every path. It never returns an error: a miss just leaves the
// field empty and the settings screen shows an input for it.
func Detect(ctx context.Context) Settings {
	var s Settings
	s.PM2Bin = findPM2(ctx)
	if s.PM2Bin != "" {
		s.NodeBinDir = filepath.Dir(s.PM2Bin)
	}
	s.ServersRoot = findServersRoot()
	return s
}

// findPM2 asks a login shell first, then falls back to globbing the known
// install layouts. The fallback is not decoration: on the Oracle box n exports
// its PATH from ~/.bashrc, and a non-interactive `bash -lc` bails out of that
// file before reaching the line, so the login shell finds nothing and only the
// ~/n/bin glob does.
func findPM2(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if out, err := exec.CommandContext(ctx, "bash", "-lc", "command -v pm2").Output(); err == nil {
		if p := strings.TrimSpace(string(out)); p != "" && usable(p) {
			return p
		}
	}
	home, _ := os.UserHomeDir()
	globs := []string{
		filepath.Join(home, "n/bin/pm2"),
		filepath.Join(home, ".nvm/versions/node/*/bin/pm2"),
		filepath.Join(home, ".volta/bin/pm2"),
		filepath.Join(home, ".local/share/fnm/node-versions/*/installation/bin/pm2"),
		"/usr/local/bin/pm2",
		"/opt/homebrew/bin/pm2",
	}
	for _, g := range globs {
		matches, _ := filepath.Glob(g)
		for _, m := range matches {
			if usable(m) {
				return m
			}
		}
	}
	if p, err := exec.LookPath("pm2"); err == nil {
		return p
	}
	return ""
}

func usable(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0
}

// findServersRoot prefers ~/mine_servers, the layout already on the box.
func findServersRoot() string {
	home, _ := os.UserHomeDir()
	for _, c := range []string{"mine_servers", "servers", "minecraft"} {
		d := filepath.Join(home, c)
		if fi, err := os.Stat(d); err == nil && fi.IsDir() {
			return d
		}
	}
	return home
}

// StateDir holds the database, the tsnet node key, job logs and downloaded
// packs. It is not configurable: one fixed place beats a flag nobody sets.
func StateDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".conduit")
}

func DBPath() string      { return filepath.Join(StateDir(), "conduit.db") }
func TsnetDir() string    { return filepath.Join(StateDir(), "tsnet") }
func ArtifactDir() string { return filepath.Join(StateDir(), "artifacts") }
func JobLogDir() string   { return filepath.Join(StateDir(), "jobs") }

// VersionDir holds the snapshot of each version's server files. It lives here
// rather than inside the instance so an upgrade never grows the directory it
// is about to archive, and so a snapshot survives a purge of the instance.
func VersionDir() string { return filepath.Join(StateDir(), "versions") }

func EnsureDirs() error {
	for _, d := range []string{StateDir(), ArtifactDir(), JobLogDir(), VersionDir()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// NodeName is what this agent calls itself on the tailnet, so the URL reads
// conduit-<hostname>.<tailnet>.ts.net.
func NodeName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "conduit"
	}
	host = strings.ToLower(strings.Split(host, ".")[0])
	clean := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			return r
		}
		return '-'
	}, host)
	return "conduit-" + strings.Trim(clean, "-")
}
