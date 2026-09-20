// Package rcon speaks Minecraft's remote console protocol. It is the only way
// to send a command to a running server from outside: pm2 cannot write to a
// process's stdin.
//
// The protocol is Valve's, little endian, and trivially small:
//
//	int32 length | int32 request id | int32 type | body NUL | NUL
//
// Type 3 authenticates, type 2 runs a command. A failed auth answers with
// request id -1.
package rcon

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

const (
	typeResponse = 0
	typeCommand  = 2
	typeAuth     = 3

	maxBody = 4096
)

var ErrAuth = errors.New("rcon authentication failed")

type Conn struct {
	c    net.Conn
	r    *bufio.Reader
	next int32
}

// Dial connects and authenticates. Callers must Close.
func Dial(addr, password string, timeout time.Duration) (*Conn, error) {
	c, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	conn := &Conn{c: c, r: bufio.NewReader(c), next: 1}
	c.SetDeadline(time.Now().Add(timeout))

	id, err := conn.send(typeAuth, password)
	if err != nil {
		c.Close()
		return nil, err
	}
	// Some servers answer auth with an empty type 0 packet first.
	for {
		gotID, typ, _, err := conn.read()
		if err != nil {
			c.Close()
			return nil, err
		}
		if gotID == -1 {
			c.Close()
			return nil, ErrAuth
		}
		if typ != typeResponse || gotID == id {
			return conn, nil
		}
	}
}

func (c *Conn) Close() error { return c.c.Close() }

// Exec runs one command and returns whatever the server printed. An empty
// reply is normal: plenty of commands answer only in the server log.
func (c *Conn) Exec(cmd string, timeout time.Duration) (string, error) {
	c.c.SetDeadline(time.Now().Add(timeout))
	id, err := c.send(typeCommand, cmd)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	for {
		gotID, _, body, err := c.read()
		if err != nil {
			// A long reply arrives split across packets with no count, so a
			// read timeout after some output means the reply simply ended.
			if out.Len() > 0 && isTimeout(err) {
				return out.String(), nil
			}
			return out.String(), err
		}
		if gotID != id {
			continue
		}
		out.WriteString(body)
		// Replies under the limit are never continued.
		if len(body) < maxBody {
			return out.String(), nil
		}
		c.c.SetDeadline(time.Now().Add(300 * time.Millisecond))
	}
}

func (c *Conn) send(typ int32, body string) (int32, error) {
	id := c.next
	c.next++
	payload := make([]byte, 0, len(body)+10)
	payload = binary.LittleEndian.AppendUint32(payload, uint32(id))
	payload = binary.LittleEndian.AppendUint32(payload, uint32(typ))
	payload = append(payload, body...)
	payload = append(payload, 0, 0)

	buf := binary.LittleEndian.AppendUint32(nil, uint32(len(payload)))
	if _, err := c.c.Write(append(buf, payload...)); err != nil {
		return 0, err
	}
	return id, nil
}

func (c *Conn) read() (id, typ int32, body string, err error) {
	var length uint32
	if err = binary.Read(c.r, binary.LittleEndian, &length); err != nil {
		return
	}
	if length < 10 || length > 8192 {
		return 0, 0, "", fmt.Errorf("rcon: implausible packet length %d", length)
	}
	buf := make([]byte, length)
	if _, err = io.ReadFull(c.r, buf); err != nil {
		return
	}
	id = int32(binary.LittleEndian.Uint32(buf[0:4]))
	typ = int32(binary.LittleEndian.Uint32(buf[4:8]))
	body = strings.TrimRight(string(buf[8:]), "\x00")
	return
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// Once opens a connection, runs one command and closes. Conduit sends a handful
// of commands a minute, so a pooled connection would be complexity for nothing.
func Once(addr, password, cmd string) (string, error) {
	c, err := Dial(addr, password, 5*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	return c.Exec(cmd, 10*time.Second)
}
