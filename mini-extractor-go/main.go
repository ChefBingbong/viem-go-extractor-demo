package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/ChefBingbong/mini-extractor-go/extractor"
	"github.com/ChefBingbong/mini-extractor-go/handlers"
	"github.com/ChefBingbong/mini-extractor-go/lib"
)

func main() {
	_, cfg := MustLoadConfig()
	ext := extractor.NewExtractor(cfg)

	// Start extractor (non-blocking — loads cache then syncs in background)
	go func() {
		if err := ext.Start(context.Background()); err != nil {
			lib.Error("Failed to start extractor", "error", err)
			os.Exit(1)
		}
	}()

	// Set up HTTP server
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handlers.HealthHandler(ext))
	mux.HandleFunc("/extractor-insights", handlers.ExtractorInsightsHandler(ext))

	port := Port()
	addr := fmt.Sprintf(":%d", port)
	lib.Info(fmt.Sprintf("Mini Extractor API started on port %d", port))

	// Graceful shutdown
	srv := &http.Server{Addr: addr, Handler: mux}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
		sig := <-sigCh
		lib.Info(fmt.Sprintf("About to exit with signal: %v", sig))
		srv.Close()
	}()

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		lib.Error("HTTP server error", "error", err)
		os.Exit(1)
	}
}
