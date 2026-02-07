package extractor

import (
	"context"
	"fmt"

	"github.com/ChefBingbong/mini-extractor-go/lib"
	"github.com/ChefBingbong/viem-go/client"
)

// Config holds the configuration for the Extractor.
type Config struct {
	Client      *client.PublicClient
	FactoriesV2 []FactoryV2
	CacheDir    string
	LogType     LogFilterType
	LogDepth    int
	Debug       bool
}

// Extractor is the top-level orchestrator that ties together the
// LogFilter, TokenManager, and UniV2Extractor.
type Extractor struct {
	Client       *client.PublicClient
	ExtractorV2  *UniV2Extractor
	TokenManager *TokenManager
	LogFilter    *LogFilter2
	Config       Config
}

// NewExtractor creates a new Extractor from the given config.
func NewExtractor(cfg Config) *Extractor {
	chainID := 0
	if cfg.Client.Chain() != nil {
		chainID = int(cfg.Client.Chain().ID)
	}

	tokenManager := NewTokenManager(
		cfg.Client,
		chainID,
		cfg.CacheDir,
		fmt.Sprintf("tokens-%d", chainID),
	)

	logFilter := NewLogFilter2(
		cfg.Client,
		cfg.LogDepth,
		cfg.LogType,
		cfg.Debug,
	)

	extractorV2 := NewUniV2Extractor(
		cfg.Client,
		cfg.FactoriesV2,
		cfg.CacheDir,
		logFilter,
		tokenManager,
		chainID,
	)

	return &Extractor{
		Client:       cfg.Client,
		ExtractorV2:  extractorV2,
		TokenManager: tokenManager,
		LogFilter:    logFilter,
		Config:       cfg,
	}
}

// Start initializes the log filter and starts the V2 extractor.
func (e *Extractor) Start(ctx context.Context) error {
	e.LogFilter.Start()
	if err := e.ExtractorV2.Start(ctx); err != nil {
		return err
	}
	lib.Info("Extractor started successfully")
	return nil
}

// GetPools returns all known pool states.
func (e *Extractor) GetPools() []PoolState {
	return e.ExtractorV2.GetPools()
}

// GetPoolMap returns the pool map.
func (e *Extractor) GetPoolMap() map[string]*PoolState {
	return e.ExtractorV2.GetPoolMap()
}

// IsStarted returns true if the extractor has completed initial startup.
func (e *Extractor) IsStarted() bool {
	return e.ExtractorV2.IsStarted()
}

// IsSyncing returns true if background factory sync is in progress.
func (e *Extractor) IsSyncing() bool {
	return e.ExtractorV2.IsSyncing()
}
