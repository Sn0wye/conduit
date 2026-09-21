package api

import (
	"context"
	"time"

	"github.com/snowye/conduit/internal/rcon"
	"github.com/snowye/conduit/internal/store"
)

// idleRCON is how long a session outlives its last command. The browser closes
// its session when the console tab goes away, but a closed laptop never gets
// the chance, so the agent drops it on its own.
const idleRCON = 5 * time.Minute

// openSession dials and keeps the connection. Called only when someone opens
// the console: nothing else in Conduit brings RCON up.
func (s *Server) openSession(inst store.Instance) (*rcon.Session, error) {
	s.rconMu.Lock()
	sess, ok := s.rcons[inst.Name]
	if !ok {
		sess = rcon.NewSession(rconAddr(inst), inst.RCONPass)
		s.rcons[inst.Name] = sess
	}
	s.rconMu.Unlock()

	if err := sess.Open(); err != nil {
		s.closeSession(inst.Name)
		return nil, err
	}
	return sess, nil
}

// session returns the live connection or nil. Callers that only want a number
// to display use this, so polling never opens a connection by itself.
func (s *Server) session(name string) *rcon.Session {
	s.rconMu.Lock()
	defer s.rconMu.Unlock()
	return s.rcons[name]
}

func (s *Server) closeSession(name string) {
	s.rconMu.Lock()
	sess := s.rcons[name]
	delete(s.rcons, name)
	s.rconMu.Unlock()
	if sess != nil {
		sess.Close()
	}
}

// ReapRCON closes sessions nobody has used in a while.
func (s *Server) ReapRCON(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.rconMu.Lock()
			var stale []string
			for name, sess := range s.rcons {
				if sess.Idle() > idleRCON {
					stale = append(stale, name)
				}
			}
			s.rconMu.Unlock()
			for _, name := range stale {
				s.closeSession(name)
			}
		}
	}
}
