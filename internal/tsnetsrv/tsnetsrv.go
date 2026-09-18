// Package tsnetsrv joins the tailnet as its own node. No tailscaled is needed
// on the host.
package tsnetsrv

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"strings"

	"tailscale.com/tsnet"
)

type Server struct {
	ts *tsnet.Server
}

func Start(ctx context.Context, nodeName, stateDir, authKey string) (*Server, error) {
	ts := &tsnet.Server{
		Hostname: nodeName,
		Dir:      filepath.Join(stateDir, "tsnet"),
		AuthKey:  authKey,
	}
	if _, err := ts.Up(ctx); err != nil {
		return nil, fmt.Errorf("tailscale up: %w", err)
	}
	return &Server{ts: ts}, nil
}

func (s *Server) Close() error { return s.ts.Close() }

// WhoIs maps a connection back to the tailnet user that opened it.
func (s *Server) WhoIs(ctx context.Context, remoteAddr string) (string, error) {
	lc, err := s.ts.LocalClient()
	if err != nil {
		return "", err
	}
	who, err := lc.WhoIs(ctx, remoteAddr)
	if err != nil {
		return "", err
	}
	if who.UserProfile == nil {
		return "", fmt.Errorf("no user profile for %s", remoteAddr)
	}
	return who.UserProfile.LoginName, nil
}

// FQDN is this node's MagicDNS name, for example conduit.tailbcc11b.ts.net.
func (s *Server) FQDN(ctx context.Context) (string, error) {
	lc, err := s.ts.LocalClient()
	if err != nil {
		return "", err
	}
	st, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		return "", err
	}
	if st.Self == nil {
		return "", fmt.Errorf("no self status")
	}
	return strings.TrimSuffix(st.Self.DNSName, "."), nil
}

// Tailnet returns the domain suffix, for example tailbcc11b.ts.net.
func (s *Server) Tailnet(ctx context.Context) string {
	fqdn, err := s.FQDN(ctx)
	if err != nil {
		return ""
	}
	if i := strings.Index(fqdn, "."); i >= 0 {
		return fqdn[i+1:]
	}
	return ""
}

// ListenTLS serves HTTPS with a Let's Encrypt certificate that Tailscale
// issues and renews. This is required, not a nicety: a service worker only
// runs in a secure context, and plain http on a ts.net name is not one, so the
// PWA cannot be installed without it.
//
// MagicDNS and HTTPS Certificates must both be enabled in the tailnet admin.
func (s *Server) ListenTLS(addr string) (net.Listener, error) {
	return s.ts.ListenTLS("tcp", addr)
}

func (s *Server) Listen(addr string) (net.Listener, error) {
	return s.ts.Listen("tcp", addr)
}

// RedirectToHTTPS is served on port 80 so typing the bare hostname works.
func RedirectToHTTPS() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://"+r.Host+r.URL.RequestURI(), http.StatusMovedPermanently)
	})
}
