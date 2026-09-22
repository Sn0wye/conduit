package tsnetsrv

import (
	"context"
	"fmt"
	"net"
	"strings"

	"tailscale.com/client/local"
)

// HostNode serves on the tailscaled that is already running on this machine
// instead of joining the tailnet as a node of its own. The machine keeps
// whatever account it is registered under, there is no second node to log in,
// and the URL is the plain host address that everyone already uses.
//
// Identity is unchanged: tailscaled answers WhoIs for connections arriving on
// its own address, so callers are still named by their tailnet login and the
// owner claim still applies. The socket is world-writable on a default Linux
// install, so this needs no root and no operator flag.
type HostNode struct {
	lc *local.Client
}

// DialHost connects to the local tailscaled and confirms it is up. It fails
// here rather than on the first request so a misconfigured box is obvious at
// startup.
func DialHost(ctx context.Context) (*HostNode, error) {
	lc := &local.Client{}
	st, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		return nil, fmt.Errorf("local tailscaled (is tailscale up on this machine?): %w", err)
	}
	if st.Self == nil {
		return nil, fmt.Errorf("local tailscaled has no self status")
	}
	return &HostNode{lc: lc}, nil
}

// WhoIs maps a connection back to the tailnet user that opened it.
func (h *HostNode) WhoIs(ctx context.Context, remoteAddr string) (string, error) {
	who, err := h.lc.WhoIs(ctx, remoteAddr)
	if err != nil {
		return "", err
	}
	if who.UserProfile == nil {
		return "", fmt.Errorf("no user profile for %s", remoteAddr)
	}
	return who.UserProfile.LoginName, nil
}

// FQDN is the host machine's own MagicDNS name.
func (h *HostNode) FQDN(ctx context.Context) (string, error) {
	st, err := h.lc.StatusWithoutPeers(ctx)
	if err != nil {
		return "", err
	}
	if st.Self == nil {
		return "", fmt.Errorf("no self status")
	}
	return strings.TrimSuffix(st.Self.DNSName, "."), nil
}

// TailnetAddr is the machine's tailnet IP. Binding to it rather than to
// 0.0.0.0 is what keeps the panel off the LAN and the public internet, so the
// tailnet ACL stays the only way in.
func (h *HostNode) TailnetAddr(ctx context.Context) (string, error) {
	st, err := h.lc.StatusWithoutPeers(ctx)
	if err != nil {
		return "", err
	}
	if st.Self == nil || len(st.Self.TailscaleIPs) == 0 {
		return "", fmt.Errorf("this machine has no tailnet address")
	}
	for _, ip := range st.Self.TailscaleIPs {
		if ip.Is4() {
			return ip.String(), nil
		}
	}
	return st.Self.TailscaleIPs[0].String(), nil
}

// ListenTailnet binds port on the tailnet address alone.
func (h *HostNode) ListenTailnet(ctx context.Context, port string) (net.Listener, error) {
	addr, err := h.TailnetAddr(ctx)
	if err != nil {
		return nil, err
	}
	return net.Listen("tcp", net.JoinHostPort(addr, port))
}
