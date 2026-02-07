package extractor

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

// FactoryV2 describes a UniswapV2-style factory deployment.
type FactoryV2 struct {
	Address      common.Address
	Provider     string
	Fee          float64
	InitCodeHash string
}

// PoolCacheRecord is what gets persisted to the JSONL pool cache.
type PoolCacheRecord struct {
	Address string `json:"address"`
	Token0  string `json:"token0"`
	Token1  string `json:"token1"`
	Factory string `json:"factory"`
}

// TokenInfo is the token metadata stored inside PoolState.
type TokenInfo struct {
	Address  string `json:"address"`
	Symbol   string `json:"symbol"`
	Name     string `json:"name"`
	Decimals int    `json:"decimals"`
}

// PoolState represents the live state of a UniswapV2 pool.
type PoolState struct {
	Address  string    `json:"address"`
	Token0   TokenInfo `json:"token0"`
	Token1   TokenInfo `json:"token1"`
	Reserve0 *big.Int  `json:"reserve0"`
	Reserve1 *big.Int  `json:"reserve1"`
	Fee      float64   `json:"fee"`
	Provider string    `json:"provider"`
}

// PoolStateJSON is used for JSON marshaling with string reserves.
type PoolStateJSON struct {
	Address  string    `json:"address"`
	Token0   TokenInfo `json:"token0"`
	Token1   TokenInfo `json:"token1"`
	Reserve0 string    `json:"reserve0"`
	Reserve1 string    `json:"reserve1"`
	Fee      float64   `json:"fee"`
	Provider string    `json:"provider"`
}

// ToJSON converts PoolState to its JSON-friendly form.
func (p *PoolState) ToJSON() PoolStateJSON {
	r0 := "0"
	r1 := "0"
	if p.Reserve0 != nil {
		r0 = p.Reserve0.String()
	}
	if p.Reserve1 != nil {
		r1 = p.Reserve1.String()
	}
	return PoolStateJSON{
		Address:  p.Address,
		Token0:   p.Token0,
		Token1:   p.Token1,
		Reserve0: r0,
		Reserve1: r1,
		Fee:      p.Fee,
		Provider: p.Provider,
	}
}
