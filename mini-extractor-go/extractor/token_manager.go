package extractor

import (
	"bytes"
	"context"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/common"

	"github.com/ChefBingbong/mini-extractor-go/lib"

	erc20bytes32 "github.com/ChefBingbong/mini-extractor-go/_contracts_typed/contract_templates/erc20bytes32"
	viemabi "github.com/ChefBingbong/viem-go/abi"
	"github.com/ChefBingbong/viem-go/actions/public"
	"github.com/ChefBingbong/viem-go/client"
	"github.com/ChefBingbong/viem-go/contracts/erc20"
)

// Cached parsed ERC20 ABI
var (
	erc20ABI     *viemabi.ABI
	erc20ABIOnce sync.Once
	erc20ABIErr  error
)

func getERC20ABI() (*viemabi.ABI, error) {
	erc20ABIOnce.Do(func() {
		erc20ABI, erc20ABIErr = viemabi.Parse([]byte(erc20.ContractABI))
	})
	return erc20ABI, erc20ABIErr
}

// TokenCacheRecord is what gets persisted to the JSONL token cache.
type TokenCacheRecord struct {
	Address  string `json:"address"`
	Name     string `json:"name"`
	Symbol   string `json:"symbol"`
	Decimals int    `json:"decimals"`
}

// TokenManager manages ERC20 token metadata with caching.
type TokenManager struct {
	client             *client.PublicClient
	chainID            int
	tokens             sync.Map // map[string]*lib.Token (lowercase address -> *Token)
	tokenPermanentCache *PermanentCache[TokenCacheRecord]

	// singleflight-style dedup for concurrent findToken calls
	inflight   map[string]*tokenFlight
	inflightMu sync.Mutex
}

type tokenFlight struct {
	done  chan struct{}
	token *lib.Token
	err   error
}

// NewTokenManager creates a new TokenManager.
func NewTokenManager(c *client.PublicClient, chainID int, paths ...string) *TokenManager {
	return &TokenManager{
		client:              c,
		chainID:             chainID,
		tokenPermanentCache: NewPermanentCache[TokenCacheRecord](paths...),
		inflight:            make(map[string]*tokenFlight),
	}
}

// AddCachedTokens loads all tokens from the persistent cache into memory.
func (tm *TokenManager) AddCachedTokens() error {
	records, err := tm.tokenPermanentCache.GetAllRecords()
	if err != nil {
		return err
	}
	for _, r := range records {
		tm.addToken(&lib.Token{
			ChainID:  tm.chainID,
			Address:  common.HexToAddress(r.Address),
			Decimals: r.Decimals,
			Name:     r.Name,
			Symbol:   r.Symbol,
		}, false)
	}
	lib.Info("Loaded cached tokens", "count", len(records))
	return nil
}

// addToken adds a token to the in-memory map and optionally to the cache.
func (tm *TokenManager) addToken(token *lib.Token, addToCache bool) {
	addr := strings.ToLower(token.Address.Hex())
	if _, loaded := tm.tokens.LoadOrStore(addr, token); loaded {
		return // already present
	}
	if addToCache {
		tm.tokenPermanentCache.Add(TokenCacheRecord{
			Address:  token.Address.Hex(),
			Name:     token.Name,
			Symbol:   token.Symbol,
			Decimals: token.Decimals,
		})
	}
}

// GetKnownToken returns a token if already known, else nil.
func (tm *TokenManager) GetKnownToken(addr common.Address) *lib.Token {
	key := strings.ToLower(addr.Hex())
	if v, ok := tm.tokens.Load(key); ok {
		return v.(*lib.Token)
	}
	return nil
}

// TokenCount returns the number of known tokens.
func (tm *TokenManager) TokenCount() int {
	count := 0
	tm.tokens.Range(func(_, _ any) bool {
		count++
		return true
	})
	return count
}

// FindToken resolves a token's metadata via multicall. Uses singleflight dedup.
func (tm *TokenManager) FindToken(ctx context.Context, address common.Address) (*lib.Token, error) {
	addr := strings.ToLower(address.Hex())

	// Check cache first
	if t := tm.GetKnownToken(address); t != nil {
		return t, nil
	}

	// Singleflight: deduplicate concurrent requests for the same token
	tm.inflightMu.Lock()
	if flight, ok := tm.inflight[addr]; ok {
		tm.inflightMu.Unlock()
		<-flight.done
		return flight.token, flight.err
	}
	flight := &tokenFlight{done: make(chan struct{})}
	tm.inflight[addr] = flight
	tm.inflightMu.Unlock()

	token, err := tm.fetchToken(ctx, address)

	flight.token = token
	flight.err = err
	close(flight.done)

	tm.inflightMu.Lock()
	delete(tm.inflight, addr)
	tm.inflightMu.Unlock()

	return token, err
}

// fetchToken does the actual on-chain multicall to get token metadata.
func (tm *TokenManager) fetchToken(ctx context.Context, address common.Address) (*lib.Token, error) {
	erc20ABI, err := getERC20ABI()
	if err != nil {
		return nil, err
	}

	// Use MulticallConcurrent since token resolution is typically called from
	// fan-out goroutines — this enables the batcher to merge concurrent calls.
	results, err := public.MulticallConcurrent(ctx, tm.client, public.MulticallParameters{
		Contracts: []public.MulticallContract{
			{Address: address, ABI: erc20ABI, FunctionName: "decimals"},
			{Address: address, ABI: erc20ABI, FunctionName: "symbol"},
			{Address: address, ABI: erc20ABI, FunctionName: "name"},
		},
		AllowFailure: boolPtr(true),
	})
	if err != nil {
		lib.ExtractorError("Token multicall error", "address", address.Hex(), "error", err)
		return nil, err
	}

	decimalsR := results[0]
	symbolR := results[1]
	nameR := results[2]

	if decimalsR.Status == "failure" {
		return nil, nil
	}

	if symbolR.Status == "failure" || nameR.Status == "failure" {
		// Try bytes32 fallback
		return tm.fetchTokenBytes32(ctx, address)
	}

	decimals := toInt(decimalsR.Result)
	symbol := toString(symbolR.Result)
	name := toString(nameR.Result)

	token := &lib.Token{
		ChainID:  tm.chainID,
		Address:  address,
		Decimals: decimals,
		Symbol:   symbol,
		Name:     name,
	}
	tm.addToken(token, true)
	return token, nil
}

// fetchTokenBytes32 is the bytes32 fallback for tokens that don't return string.
func (tm *TokenManager) fetchTokenBytes32(ctx context.Context, address common.Address) (*lib.Token, error) {
	b32ABI, err := erc20bytes32.ParsedABI()
	if err != nil {
		return nil, err
	}

	results, err := public.MulticallConcurrent(ctx, tm.client, public.MulticallParameters{
		Contracts: []public.MulticallContract{
			{Address: address, ABI: b32ABI, FunctionName: "decimals"},
			{Address: address, ABI: b32ABI, FunctionName: "symbol"},
			{Address: address, ABI: b32ABI, FunctionName: "name"},
		},
		AllowFailure: boolPtr(false),
	})
	if err != nil {
		lib.ExtractorError("Token bytes32 multicall error", "address", address.Hex(), "error", err)
		return nil, err
	}

	decimals := toInt(results[0].Result)
	symbol := bytes32ToString(results[1].Result)
	name := bytes32ToString(results[2].Result)

	token := &lib.Token{
		ChainID:  tm.chainID,
		Address:  address,
		Decimals: decimals,
		Symbol:   symbol,
		Name:     name,
	}
	tm.addToken(token, true)
	return token, nil
}

// ---- helpers ----

func boolPtr(v bool) *bool { return &v }

func toInt(v any) int {
	switch val := v.(type) {
	case uint8:
		return int(val)
	case uint16:
		return int(val)
	case uint32:
		return int(val)
	case uint64:
		return int(val)
	case int:
		return val
	case *big.Int:
		return int(val.Int64())
	default:
		return 0
	}
}

func toString(v any) string {
	switch val := v.(type) {
	case string:
		return val
	case []byte:
		return string(val)
	default:
		return ""
	}
}

func bytes32ToString(v any) string {
	switch val := v.(type) {
	case [32]byte:
		// Trim right zero bytes
		trimmed := bytes.TrimRight(val[:], "\x00")
		return string(trimmed)
	case []byte:
		trimmed := bytes.TrimRight(val, "\x00")
		return string(trimmed)
	default:
		return ""
	}
}

