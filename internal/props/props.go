// Package props edits server.properties in place, keeping comments, blank
// lines and key order. A rewrite from a map would silently drop every comment
// in the file, which is not an acceptable trade for a three-key edit.
package props

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Read returns the key/value pairs, ignoring comments.
func Read(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out, sc.Err()
}

// Write applies set to the file, appending any key that was not already
// present. The original is copied next to it first, because this edits a live
// server's configuration.
func Write(path string, set map[string]string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	backup := filepath.Join(filepath.Dir(path),
		fmt.Sprintf("server.properties.conduit-%s.bak", time.Now().Format("20060102-150405")))
	if err := os.WriteFile(backup, b, 0o644); err != nil {
		return fmt.Errorf("back up server.properties: %w", err)
	}

	seen := map[string]bool{}
	lines := strings.Split(string(b), "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		k, _, ok := strings.Cut(trimmed, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		if v, want := set[k]; want {
			lines[i] = k + "=" + v
			seen[k] = true
		}
	}
	for k, v := range set {
		if !seen[k] {
			lines = append(lines, k+"="+v)
		}
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644)
}
