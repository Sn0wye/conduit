package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config is read once at startup from ~/.conduit/config.json.
type Config struct {
	// NodeName is the name this agent takes on the tailnet.
	NodeName string `json:"node_name"`
	// StateDir holds the database, job logs and downloaded pack artifacts.
	StateDir string `json:"state_dir"`
	// PM2Bin is the absolute path to the pm2 executable. It is not on the
	// default non-login PATH when pm2 was installed through n or nvm.
	PM2Bin string `json:"pm2_bin"`
	// NodeBinDir is prepended to PATH for every pm2 call. The pm2 executable is
	// a node script, so it fails with "env: node: No such file or directory"
	// when node is missing from the environment, even if pm2 itself was found.
	NodeBinDir string `json:"node_bin_dir"`
	// ServersRoot is scanned for unregistered instance directories.
	ServersRoot string `json:"servers_root"`
	// AllowUsers lists the tailnet logins permitted to call the API.
	AllowUsers []string `json:"allow_users"`
	// CurseForgeKey is used server side only and is never sent to the browser.
	CurseForgeKey string `json:"curseforge_key"`
}

func Default() Config {
	home, _ := os.UserHomeDir()
	return Config{
		NodeName:    "conduit",
		StateDir:    filepath.Join(home, ".conduit"),
		PM2Bin:      "pm2",
		ServersRoot: filepath.Join(home, "mine_servers"),
	}
}

func Load(path string) (Config, error) {
	c := Default()
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.StateDir == "" {
		c.StateDir = Default().StateDir
	}
	return c, nil
}

func (c Config) DBPath() string       { return filepath.Join(c.StateDir, "conduit.db") }
func (c Config) ArtifactDir() string  { return filepath.Join(c.StateDir, "artifacts") }
func (c Config) JobLogDir() string    { return filepath.Join(c.StateDir, "jobs") }

func (c Config) EnsureDirs() error {
	for _, d := range []string{c.StateDir, c.ArtifactDir(), c.JobLogDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}
