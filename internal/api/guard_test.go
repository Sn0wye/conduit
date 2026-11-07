package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/snowye/conduit/internal/store"
)

func TestGuard(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	h := Guard(Names("snowye.tail1234.ts.net", "100.83.147.40", "fd7a:115c::1"), ok)

	cases := []struct {
		name, method, host, site, origin string
		want                             int
	}{
		{"own name", "GET", "snowye.tail1234.ts.net", "", "", 204},
		{"own name with port", "POST", "snowye.tail1234.ts.net:8420", "same-origin", "", 204},
		{"short name", "GET", "snowye:8420", "", "", 204},
		{"tailnet ip", "GET", "100.83.147.40:8420", "", "", 204},
		{"tailnet ipv6", "GET", "[fd7a:115c::1]:8420", "", "", 204},
		{"rebound name", "GET", "evil.example.com", "", "", http.StatusMisdirectedRequest},
		{"cross-site post", "POST", "snowye.tail1234.ts.net", "cross-site", "", http.StatusForbidden},
		{"cross-origin post, old browser", "POST", "snowye.tail1234.ts.net", "", "https://evil.example.com", http.StatusForbidden},
		{"cross-site get is harmless", "GET", "snowye.tail1234.ts.net", "cross-site", "", 204},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(c.method, "/v1/instances", strings.NewReader("{}"))
			r.Host = c.host
			if c.site != "" {
				r.Header.Set("Sec-Fetch-Site", c.site)
			}
			if c.origin != "" {
				r.Header.Set("Origin", c.origin)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != c.want {
				t.Fatalf("got %d, want %d", w.Code, c.want)
			}
		})
	}
}

func TestValidInstance(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "run.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()

	good := store.Instance{Name: "atm-10_lite.2", Dir: dir}
	if err := validInstance(&good); err != nil || good.Script != "./run.sh" {
		t.Fatalf("valid instance refused: %v (script %q)", err, good.Script)
	}
	bad := []store.Instance{
		{Name: "-rf", Dir: dir},
		{Name: "a/b", Dir: dir},
		{Name: "", Dir: dir},
		{Name: "ok", Dir: "relative"},
		{Name: "ok", Dir: home},
		{Name: "ok", Dir: "/"},
		{Name: "ok", Dir: dir, Script: "/bin/sh"},
		{Name: "ok", Dir: dir, Script: "../run.sh"},
		{Name: "ok", Dir: dir, Script: "./start.sh"},
	}
	for _, i := range bad {
		if err := validInstance(&i); err == nil {
			t.Errorf("accepted %+v", i)
		}
	}
}
