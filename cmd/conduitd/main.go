// Command conduitd manages the Minecraft servers on one machine and serves the
// PWA that drives them. Every machine runs an identical copy; there is no
// central control plane.
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
	"path/filepath"
	"syscall"
	"time"

	"github.com/snowye/conduit/internal/api"
	"github.com/snowye/conduit/internal/config"
	"github.com/snowye/conduit/internal/pm2"
	"github.com/snowye/conduit/internal/store"
	"github.com/snowye/conduit/internal/tsnetsrv"
	webui "github.com/snowye/conduit/web"
)

func main() {
	home, _ := os.UserHomeDir()
	var (
		cfgPath = flag.String("config", filepath.Join(home, ".conduit", "config.json"), "config file")
		authKey = flag.String("authkey", os.Getenv("TS_AUTHKEY"), "tailscale auth key, first run only")
		dev     = flag.Bool("dev", false, "serve plain http on localhost and skip tailnet identity")
		devAddr = flag.String("dev-addr", "127.0.0.1:8420", "listen address in dev mode")
	)
	flag.Parse()

	if err := run(*cfgPath, *authKey, *dev, *devAddr); err != nil {
		log.Fatalf("conduitd: %v", err)
	}
}

func run(cfgPath, authKey string, dev bool, devAddr string) error {
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	if err := cfg.EnsureDirs(); err != nil {
		return err
	}

	db, err := store.Open(cfg.DBPath())
	if err != nil {
		return err
	}
	defer db.Close()

	pm := pm2.New(cfg.PM2Bin, cfg.NodeBinDir)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Fail loudly at startup rather than on the first start request. pm2 is a
	// node script, so a missing node_bin_dir breaks it even when pm2_bin is a
	// correct absolute path.
	if v, err := pm.Version(ctx); err != nil {
		log.Printf("warning: pm2 is not usable: %v", err)
	} else {
		log.Printf("pm2 %s at %s", v, cfg.PM2Bin)
	}

	apiSrv := api.New(cfg, db, pm)

	mux := http.NewServeMux()
	mux.Handle("/", webui.Handler())

	if dev {
		id := func(context.Context, string) (string, error) { return "dev", nil }
		mux.Handle("/v1/", api.CORS("")(api.Auth(id, nil)(apiSrv.Routes())))
		log.Printf("dev mode on http://%s", devAddr)
		return serve(ctx, &http.Server{Addr: devAddr, Handler: mux}, nil)
	}

	ts, err := tsnetsrv.Start(ctx, cfg.NodeName, cfg.StateDir, authKey)
	if err != nil {
		return err
	}
	defer ts.Close()

	fqdn, err := ts.FQDN(ctx)
	if err != nil {
		return err
	}
	mux.Handle("/v1/", api.CORS(ts.Tailnet(ctx))(api.Auth(ts.WhoIs, cfg.AllowUsers)(apiSrv.Routes())))

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
