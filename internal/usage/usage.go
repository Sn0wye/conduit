// Package usage measures disk. Walking a modded instance directory costs real
// time (project-infinity is 1.4G across tens of thousands of files), so every
// answer is cached and the dashboard polls freely.
package usage

import (
	"io/fs"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type Disk struct {
	InstanceBytes int64 `json:"instance_bytes"`
	WorldBytes    int64 `json:"world_bytes"`
	BackupBytes   int64 `json:"backup_bytes"`
	FreeBytes     int64 `json:"free_bytes"`
	TotalBytes    int64 `json:"total_bytes"`
	// MeasuredAt lets the UI admit the number is a little stale rather than
	// pretending it is live.
	MeasuredAt time.Time `json:"measured_at"`
}

type entry struct {
	d   Disk
	err error
}

var (
	mu       sync.Mutex
	cache    = map[string]entry{}
	inFlight = map[string]bool{}
)

const ttl = 60 * time.Second

// Of returns the sizes for one instance directory. The first call walks the
// tree; later calls inside the TTL return the cached figure, and a refresh
// happens in the background so no request ever waits on a second walk.
func Of(dir string) (Disk, error) {
	mu.Lock()
	e, ok := cache[dir]
	fresh := ok && time.Since(e.d.MeasuredAt) < ttl
	if fresh {
		mu.Unlock()
		return e.d, e.err
	}
	if ok && !inFlight[dir] {
		inFlight[dir] = true
		mu.Unlock()
		go func() {
			d, err := measure(dir)
			mu.Lock()
			cache[dir] = entry{d, err}
			inFlight[dir] = false
			mu.Unlock()
		}()
		return e.d, e.err
	}
	if ok {
		mu.Unlock()
		return e.d, e.err
	}
	mu.Unlock()

	d, err := measure(dir)
	mu.Lock()
	cache[dir] = entry{d, err}
	mu.Unlock()
	return d, err
}

func measure(dir string) (Disk, error) {
	d := Disk{MeasuredAt: time.Now()}
	world := filepath.Join(dir, "world")
	backups := filepath.Join(dir, "backups")

	err := filepath.WalkDir(dir, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable corner must not fail the whole number
		}
		if e.IsDir() {
			return nil
		}
		info, err := e.Info()
		if err != nil {
			return nil
		}
		size := info.Size()
		d.InstanceBytes += size
		switch {
		case within(path, world):
			d.WorldBytes += size
		case within(path, backups):
			d.BackupBytes += size
		}
		return nil
	})
	if err != nil {
		return d, err
	}

	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err == nil {
		d.FreeBytes = int64(st.Bavail) * int64(st.Bsize)
		d.TotalBytes = int64(st.Blocks) * int64(st.Bsize)
	}
	return d, nil
}

func within(path, dir string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && !filepath.IsAbs(rel) && rel != ".." && !hasDotDotPrefix(rel)
}

func hasDotDotPrefix(rel string) bool {
	return len(rel) >= 3 && rel[0] == '.' && rel[1] == '.' && rel[2] == filepath.Separator
}
