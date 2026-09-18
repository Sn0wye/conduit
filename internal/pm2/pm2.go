// Package pm2 wraps the pm2 CLI. It is deliberately concrete: there is no
// ProcessBackend interface until a second backend (Docker) actually exists.
package pm2

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

type Client struct {
	bin        string
	nodeBinDir string
}

func New(bin, nodeBinDir string) *Client {
	return &Client{bin: bin, nodeBinDir: nodeBinDir}
}

// Status mirrors the subset of `pm2 jlist` we care about.
type Status struct {
	Name     string  `json:"name"`
	PID      int     `json:"pid"`
	Status   string  `json:"status"` // online, stopped, errored, stopping
	Dir      string  `json:"dir"`
	Restarts int     `json:"restarts"`
	UptimeMS int64   `json:"uptime_ms"`
	MemoryMB int64   `json:"memory_mb"`
	CPUPct   float64 `json:"cpu_pct"`
	ExitCode int     `json:"exit_code"`
}

type rawApp struct {
	Name  string `json:"name"`
	PID   int    `json:"pid"`
	Monit struct {
		Memory int64   `json:"memory"`
		CPU    float64 `json:"cpu"`
	} `json:"monit"`
	Env struct {
		Status      string `json:"status"`
		Cwd         string `json:"pm_cwd"`
		RestartTime int    `json:"restart_time"`
		PMUptime    int64  `json:"pm_uptime"`
		ExitCode    int    `json:"exit_code"`
	} `json:"pm2_env"`
}

func (c *Client) cmd(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, c.bin, args...)
	env := os.Environ()
	if c.nodeBinDir != "" {
		env = append(env, "PATH="+c.nodeBinDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	cmd.Env = env
	return cmd
}

func (c *Client) run(ctx context.Context, args ...string) ([]byte, error) {
	var out, errb bytes.Buffer
	cmd := c.cmd(ctx, args...)
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = strings.TrimSpace(out.String())
		}
		return nil, fmt.Errorf("pm2 %s: %w: %s", strings.Join(args, " "), err, msg)
	}
	return out.Bytes(), nil
}

// Version confirms pm2 and node are both reachable. Call it at startup so a
// broken PATH surfaces immediately instead of on the first start request.
func (c *Client) Version(ctx context.Context) (string, error) {
	out, err := c.run(ctx, "-v")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// List returns every app pm2 knows about, keyed by name.
func (c *Client) List(ctx context.Context) (map[string]Status, error) {
	out, err := c.run(ctx, "jlist")
	if err != nil {
		return nil, err
	}
	// pm2 sometimes prefixes jlist with update notices, so start at the array.
	if i := bytes.IndexByte(out, '['); i > 0 {
		out = out[i:]
	}
	var raw []rawApp
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse pm2 jlist: %w", err)
	}
	res := make(map[string]Status, len(raw))
	for _, a := range raw {
		s := Status{
			Name:     a.Name,
			PID:      a.PID,
			Status:   a.Env.Status,
			Dir:      a.Env.Cwd,
			Restarts: a.Env.RestartTime,
			MemoryMB: a.Monit.Memory / (1024 * 1024),
			CPUPct:   a.Monit.CPU,
			ExitCode: a.Env.ExitCode,
		}
		if a.Env.Status == "online" && a.Env.PMUptime > 0 {
			s.UptimeMS = time.Now().UnixMilli() - a.Env.PMUptime
		}
		res[a.Name] = s
	}
	return res, nil
}

// Start launches script inside dir under the given pm2 app name.
//
// --no-autorestart is not optional. With autorestart on, a deliberate shutdown
// looks like a crash to pm2 and it relaunches the server immediately; the `co`
// app on the Oracle box reached 15795 restarts that way. Conduit supervises
// instead.
func (c *Client) Start(ctx context.Context, name, dir, script string) error {
	_, err := c.run(ctx, "start", script,
		"--name", name,
		"--cwd", dir,
		"--interpreter", "/bin/sh",
		"--no-autorestart",
		"--kill-timeout", "120000",
		"--time",
	)
	return err
}

func (c *Client) Stop(ctx context.Context, name string) error {
	_, err := c.run(ctx, "stop", name)
	return err
}

func (c *Client) Delete(ctx context.Context, name string) error {
	_, err := c.run(ctx, "delete", name)
	return err
}

// WaitStopped polls until the app leaves the online state or the context ends.
func (c *Client) WaitStopped(ctx context.Context, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		apps, err := c.List(ctx)
		if err != nil {
			return err
		}
		if s, ok := apps[name]; !ok || s.Status != "online" {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s still online after %s", name, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
