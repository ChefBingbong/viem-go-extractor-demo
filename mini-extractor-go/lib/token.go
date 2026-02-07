package lib

import (
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

// Token represents a minimal ERC20 token.
type Token struct {
	ChainID  int
	Decimals int
	Symbol   string
	Name     string
	Address  common.Address
}

// SortsBefore returns true if this token's address is lower (lexicographic) than other.
func (t *Token) SortsBefore(other *Token) bool {
	return strings.ToLower(t.Address.Hex()) < strings.ToLower(other.Address.Hex())
}
