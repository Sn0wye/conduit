// Command conduitd manages the Minecraft servers on the machine it runs on and
// serves the PWA that drives them. One binary per machine, reached over the
// tailnet at its own hostname. There is no control plane, no peer list and no
// config file: paths are detected, and the settings screen overrides them.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/snowye/conduit/internal/api"
	"github.com/snowye/conduit/internal/settings"
	"github.com/snowye/conduit/internal/store"
	"github.com/snowye/conduit/internal/tsnetsrv"
	webui "github.com/snowye/conduit/web"
)

func main() {
	var (
		authKey = flag.String("authkey", os.Getenv("TS_AUTHKEY"), "tailscale auth key, optional; without it the first run prints a login URL")
		claim   = flag.String("claim", "", "reset the owning tailnet login and exit")
		allow   = flag.String("allow", "", "let this tailnet login use the machine alongside the owner, and exit")
		revoke  = flag.String("revoke", "", "take back the access granted by --allow, and exit")
		dev     = flag.Bool("dev", false, "serve plain http on localhost and skip tailnet identity")
		devAddr = flag.String("dev-addr", "127.0.0.1:8420", "listen address in dev mode")
		host    = flag.String("host-port", "", "serve on this port of the machine's own tailnet address, using the tailscaled already running here instead of joining as a second node")
	)
	flag.Parse()

	if err := run(*authKey, *claim, *allow, *revoke, *dev, *devAddr, *host); err != nil {
		log.Fatalf("conduitd: %v", err)
	}
}

func run(authKey, claim, allow, revoke string, dev bool, devAddr, hostPort string) error {
	if err := settings.EnsureDirs(); err != nil {
		return err
	}
	db, err := store.Open(settings.DBPath())
	if err != nil {
		return err
	}
	defer db.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if claim != "" {
		if err := db.SetSetting(ctx, settings.KeyOwner, claim); err != nil {
			return err
		}
		log.Printf("this machine now belongs to %s", claim)
		return nil
	}

	if allow != "" || revoke != "" {
		stored, err := db.Setting(ctx, settings.KeyGuests)
		if err != nil {
			return err
		}
		login, changed := allow, false
		if allow != "" {
			stored, changed = settings.AddGuest(stored, allow)
		} else {
			login = revoke
			stored, changed = settings.RemoveGuest(stored, revoke)
		}
		if !changed {
			log.Printf("nothing to do for %s", login)
			return nil
		}
		if err := db.SetSetting(ctx, settings.KeyGuests, stored); err != nil {
			return err
		}
		if allow != "" {
			log.Printf("%s may now use this machine", login)
		} else {
			log.Printf("%s may no longer use this machine", login)
		}
		return nil
	}

	set, err := settings.Load(ctx, db)
	if err != nil {
		return err
	}
	apiSrv := api.New(db, set)
	apiSrv.WarmDisk(ctx)
	go apiSrv.ReapRCON(ctx)

	// Fail loudly at startup rather than on the first start request. pm2 is a
	// node script, so a missing node_bin_dir breaks it even when the pm2 path
	// itself is correct.
	if set.PM2Bin == "" {
		log.Printf("warning: pm2 not found, set its path in the settings screen")
	} else {
		log.Printf("pm2 at %s", set.PM2Bin)
	}
	log.Printf("servers root %s", set.ServersRoot)

	mux := http.NewServeMux()
	mux.Handle("/", webui.Handler())

	if dev {
		id := func(context.Context, string) (string, error) { return "dev", nil }
		mux.Handle("/v1/", api.DevCORS(api.Auth(id, nil)(apiSrv.Routes())))
		log.Printf("dev mode on http://%s", devAddr)
		return serve(ctx, &http.Server{Addr: devAddr, Handler: mux}, nil)
	}

	// Host mode: no node of its own, no cert, no login URL. The panel answers
	// on the address the machine already has, and the tailnet ACL is the
	// boundary exactly as it is in tsnet mode.
	if hostPort != "" {
		hn, err := tsnetsrv.DialHost(ctx)
		if err != nil {
			return err
		}
		mux.Handle("/v1/", api.Auth(hn.WhoIs, db)(apiSrv.Routes()))

		ln, err := hn.ListenTailnet(ctx, hostPort)
		if err != nil {
			return err
		}
		addr := ln.Addr().String()
		if fqdn, err := hn.FQDN(ctx); err == nil {
			log.Printf("serving http://%s:%s", fqdn, hostPort)
		}
		log.Printf("serving http://%s", addr)
		return serve(ctx, &http.Server{Handler: mux}, ln)
	}

	ts, err := tsnetsrv.Start(ctx, settings.NodeName(), settings.TsnetDir(), authKey)
	if err != nil {
		return err
	}
	defer ts.Close()

	fqdn, err := ts.FQDN(ctx)
	if err != nil {
		return err
	}
	// The PWA and the API share this origin, so no CORS middleware is needed.
	mux.Handle("/v1/", api.Auth(ts.WhoIs, db)(apiSrv.Routes()))

	ln, err := ts.ListenTLS(":443")
	if err != nil {
		// A tailnet with HTTPS Certificates switched off cannot issue the cert,
		// and that is an admin-console setting no binary can flip for itself.
		// Fall back to plain http on the same node rather than refusing to
		// start: the hop is still WireGuard-encrypted and WhoIs still names the
		// caller, so the auth story is unchanged. What is lost is the secure
		// context, and with it the service worker, so the PWA will not install
		// until certificates are turned on and conduitd is restarted.
		log.Printf("no https (%v)", err)
		log.Printf("falling back to plain http; enable HTTPS Certificates in the tailnet admin, then restart, to install the PWA")

		plain, plainErr := ts.Listen(":80")
		if plainErr != nil {
			return fmt.Errorf("listen tls: %w (and plain http: %v)", err, plainErr)
		}
		log.Printf("serving http://%s", fqdn)
		return serve(ctx, &http.Server{Handler: mux}, plain)
	}
	if redir, err := ts.Listen(":80"); err == nil {
		go http.Serve(redir, tsnetsrv.RedirectToHTTPS())
	}

	log.Printf("serving https://%s", fqdn)
	return serve(ctx, &http.Server{Handler: mux}, ln)
}

func serve(ctx context.Context, srv *http.Server, ln net.Listener) error {
	errc := make(chan error, 1)
	go func() {
		if ln != nil {
			errc <- srv.Serve(ln)
			return
		}
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdown)
	}
}
