package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
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

// Auth is the only access control in Conduit. The agent listens on the tsnet
// interface alone, so the tailnet ACL is the real boundary; this just narrows
// it to one login.
func Auth(id Identify, allow []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := id(r.Context(), r.RemoteAddr)
			if err != nil {
				fail(w, http.StatusForbidden, "whois_failed", err)
				return
			}
			if len(allow) > 0 && !slices.Contains(allow, user) {
				fail(w, http.StatusForbidden, "not_allowed", errors.New(user+" is not in allow_users"))
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
		})
	}
}

// CORS lets a PWA served by one agent call the others. Auth is network level,
// so no credentials ride along and the check stays simple.
func CORS(tailnet string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			ok := origin == "" ||
				strings.HasPrefix(origin, "http://localhost:") ||
				(tailnet != "" && strings.HasSuffix(origin, "."+tailnet))
			if ok && origin != "" {
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
}
