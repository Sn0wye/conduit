package rcon

import (
	"sync"
	"time"
)

// Session holds one connection open instead of dialling per command.
//
// Dialling per command is what Once does, and at a five second poll it made the
// server log a connect and a disconnect line every five seconds, which buried
// the lines a person opened the console to read. A session is opened when the
// console tab is opened and closed when it goes away, so a machine nobody is
// looking at holds no connection at all.
type Session struct {
	addr, pass string

	mu   sync.Mutex
	conn *Conn
	last time.Time
}

func NewSession(addr, pass string) *Session {
	return &Session{addr: addr, pass: pass, last: time.Now()}
}

// Exec runs one command, dialling if this is the first one. A dead connection
// is redialled once and the command retried: the server restarting underneath
// us is the normal case, not an error worth showing.
func (s *Session) Exec(cmd string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.last = time.Now()

	if s.conn == nil {
		if err := s.dial(); err != nil {
			return "", err
		}
	}
	out, err := s.conn.Exec(cmd, 10*time.Second)
	if err == nil {
		return out, nil
	}
	s.drop()
	if err := s.dial(); err != nil {
		return "", err
	}
	return s.conn.Exec(cmd, 10*time.Second)
}

// Open dials now rather than on the first command, so the console tab can say
// straight away that RCON is not answering.
func (s *Session) Open() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.last = time.Now()
	if s.conn != nil {
		return nil
	}
	return s.dial()
}

func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.drop()
}

func (s *Session) Idle() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Since(s.last)
}

// dial and drop assume the caller holds the lock.
func (s *Session) dial() error {
	c, err := Dial(s.addr, s.pass, 5*time.Second)
	if err != nil {
		return err
	}
	s.conn = c
	return nil
}

func (s *Session) drop() {
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
	}
}
