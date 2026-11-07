package api

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"slices"
	"strings"

	"github.com/snowye/conduit/internal/settings"
)

type ctxKey int

const userKey ctxKey = 0

func userFrom(ctx context.Context) string {
	u, _ := ctx.Value(userKey).(string)
	return u
}

// Identify resolves the tailnet login behind a request. On the tailnet this is
// backed by WhoIs; in dev mode it returns a fixed local user.
type Identify func(ctx context.Context, remoteAddr string) (string, error)

// Owner stores which tailnet login claimed this machine.
type Owner interface {
	Setting(ctx context.Context, key string) (string, error)
	SetSetting(ctx context.Context, key, value string) error
}

// Auth is the only access control in Conduit. The agent listens on a tailnet
// address alone, so the tailnet ACL is the real boundary. On top of that the
// first login to call the machine claims it, and everyone else gets 403 unless
// the owner has named them as a guest.
//
// Pass a nil Owner to skip the claim check entirely, which is what dev mode
// does so a local run never writes "dev" into the database.
func Auth(id Identify, owner Owner) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := id(r.Context(), r.RemoteAddr)
			if err != nil {
				// Refusals are the one thing worth logging: a denied caller
				// sees a bare 403 and cannot tell the operator why, and the
				// operator has no other record that the attempt happened.
				log.Printf("denied %s: whois failed: %v", r.RemoteAddr, err)
				fail(w, http.StatusForbidden, "whois_failed", err)
				return
			}
			if owner != nil {
				claimed, err := owner.Setting(r.Context(), settings.KeyOwner)
				if err != nil {
					fail(w, http.StatusInternalServerError, "internal", err)
					return
				}
				switch claimed {
				case "":
					if err := owner.SetSetting(r.Context(), settings.KeyOwner, user); err != nil {
						fail(w, http.StatusInternalServerError, "internal", err)
						return
					}
				case user:
				default:
					guests, err := owner.Setting(r.Context(), settings.KeyGuests)
					if err != nil {
						fail(w, http.StatusInternalServerError, "internal", err)
						return
					}
					if !slices.Contains(settings.ParseGuests(guests), user) {
						log.Printf("denied %s from %s: machine belongs to %s, guests are %q",
							user, r.RemoteAddr, claimed, guests)
						fail(w, http.StatusForbidden, "not_owner",
							errors.New("this machine belongs to "+claimed))
						return
					}
				}
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
		})
	}
}

// DevCORS exists for `bun run dev`, where the PWA is served by Vite on
// localhost and the API by conduitd on another port. In tailnet mode the PWA
// and the API share an origin, so no CORS headers are sent at all.
func DevCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); strings.HasPrefix(origin, "http://localhost:") ||
			strings.HasPrefix(origin, "http://127.0.0.1:") {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Guard sits in front of everything served on the tailnet and closes the two
// ways a web page the owner happens to visit could act as the owner. The
// tailnet IP is the only credential, and a browser attaches it to any request
// it sends, wherever the page that sent it came from.
//
//   - Cross-site requests: a form post or a no-cors fetch with a text/plain
//     body needs no preflight, so CORS alone does not stop it. Unsafe methods
//     from another origin are refused, by Sec-Fetch-Site or by Origin.
//   - DNS rebinding: a hostile name that resolves to this node's address
//     would make the page same-origin. Only the node's own names and
//     addresses are accepted in Host.
func Guard(hosts []string, next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, h := range hosts {
		if h = normHost(h); h != "" {
			allowed[h] = true
		}
	}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[normHost(r.Host)] {
			log.Printf("denied %s: unexpected host %q", r.RemoteAddr, r.Host)
			fail(w, http.StatusMisdirectedRequest, "bad_host", errors.New("this address does not belong to conduit"))
			return
		}
		next.ServeHTTP(w, r)
	})
	return http.NewCrossOriginProtection().Handler(inner)
}

func normHost(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	return strings.ToLower(strings.TrimSuffix(strings.Trim(h, "[]"), "."))
}

// Names lists every way the node can legitimately be addressed: its MagicDNS
// name, the short name MagicDNS also answers to, and its tailnet addresses.
func Names(fqdn string, ips ...string) []string {
	out := append([]string{fqdn}, ips...)
	if short, _, ok := strings.Cut(fqdn, "."); ok {
		out = append(out, short)
	}
	return out
}
