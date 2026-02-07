package main

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/ChefBingbong/mini-extractor-go/extractor"
	"github.com/ChefBingbong/viem-go/chain/definitions"
	"github.com/ChefBingbong/viem-go/client"
	"github.com/ChefBingbong/viem-go/client/transport"
)

// getEnv returns the env var value or a default.
func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// getEnvInt returns the env var as int or a default.
func getEnvInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

// MustLoadConfig creates the PublicClient and ExtractorConfig from env vars.
func MustLoadConfig() (*client.PublicClient, extractor.Config) {
	rpcURL := os.Getenv("RPC_URL")
	if rpcURL == "" {
		fmt.Fprintln(os.Stderr, "RPC_URL env var is required")
		os.Exit(1)
	}

	pollingInterval := time.Duration(getEnvInt("POLLING_INTERVAL", 200)) * time.Millisecond

	c, err := client.CreatePublicClient(client.PublicClientConfig{
		Chain:     &definitions.Mainnet,
		Transport: transport.HTTP(rpcURL),
		Batch: &client.BatchOptions{
			Multicall: &client.MulticallBatchOptions{
				BatchSize: 2048,
				Wait:      16 * time.Millisecond,
			},
		},
		PollingInterval: pollingInterval,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create public client: %v\n", err)
		os.Exit(1)
	}

	uniswapV2Factory := extractor.FactoryV2{
		Address:      common.HexToAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"),
		Fee:          0.003,
		InitCodeHash: "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
		Provider:     "UniswapV2",
	}

	cfg := extractor.Config{
		Client:      c,
		FactoriesV2: []extractor.FactoryV2{uniswapV2Factory},
		CacheDir:    getEnv("CACHE_DIR", "./cache/go-cache"),
		LogDepth:    getEnvInt("LOG_DEPTH", 50),
		LogType:     extractor.LogFilterOneCall,
		MaxPools:    getEnvInt("MAX_POOLS", 1000),
	}

	return c, cfg
}

// Port returns the HTTP port from env or default.
func Port() int {
	return getEnvInt("GO_PORT", 8001)
}
