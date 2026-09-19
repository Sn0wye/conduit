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
		dev     = flag.Bool("dev", false, "serve plain http on localhost and skip tailnet identity")
		devAddr = flag.String("dev-addr", "127.0.0.1:8420", "listen address in dev mode")
	)
	flag.Parse()

	if err := run(*authKey, *claim, *dev, *devAddr); err != nil {
		log.Fatalf("conduitd: %v", err)
	}
}

func run(authKey, claim string, dev bool, devAddr string) error {
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

	set, err := settings.Load(ctx, db)
	if err != nil {
		return err
	}
	apiSrv := api.New(db, set)

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
		return fmt.Errorf("listen tls (enable MagicDNS and HTTPS Certificates in the tailnet admin): %w", err)
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
