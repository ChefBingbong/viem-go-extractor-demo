package extractor

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/ChefBingbong/mini-extractor-go/lib"

	univ2factory "github.com/ChefBingbong/mini-extractor-go/_contracts_typed/contract_templates/univ2factory"
	univ2pair "github.com/ChefBingbong/mini-extractor-go/_contracts_typed/contract_templates/univ2pair"
	"github.com/ChefBingbong/viem-go/actions/public"
	"github.com/ChefBingbong/viem-go/client"
	"github.com/ChefBingbong/viem-go/utils/formatters"
)

const multicallBatchSize = 1048

// ---- Sync state persistence ----

type SyncState map[string]int

func readSyncState(filePath string) SyncState {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return make(SyncState)
	}
	var state SyncState
	if err := json.Unmarshal(data, &state); err != nil {
		return make(SyncState)
	}
	return state
}

func writeSyncState(filePath string, state SyncState) {
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		lib.Error("Failed to create sync state directory", "error", err)
		return
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		lib.Error("Failed to marshal sync state", "error", err)
		return
	}
	if err := os.WriteFile(filePath, data, 0644); err != nil {
		lib.Error("Failed to write sync state", "path", filePath, "error", err)
	}
}

// ---- UniV2Extractor ----

// UniV2Extractor indexes UniswapV2 pool state.
type UniV2Extractor struct {
	client       *client.PublicClient
	tokenManager *TokenManager

	factories  []FactoryV2
	factoryMap map[string]FactoryV2 // lowercase address -> FactoryV2

	poolMu  sync.RWMutex
	poolMap map[string]*PoolState // lowercase address -> PoolState

	pendingLogDiscovery sync.Map // set of lowercase addresses

	logFilter          *LogFilter2
	poolPermanentCache *PermanentCache[PoolCacheRecord]
	syncStatePath      string

	started bool
	syncing bool
}

// NewUniV2Extractor creates a new UniV2Extractor.
func NewUniV2Extractor(
	c *client.PublicClient,
	factories []FactoryV2,
	cacheDir string,
	logFilter *LogFilter2,
	tokenManager *TokenManager,
	chainID int,
) *UniV2Extractor {
	factoryMap := make(map[string]FactoryV2, len(factories))
	for _, f := range factories {
		factoryMap[strings.ToLower(f.Address.Hex())] = f
	}

	ext := &UniV2Extractor{
		client:             c,
		tokenManager:       tokenManager,
		factories:          factories,
		factoryMap:         factoryMap,
		poolMap:            make(map[string]*PoolState),
		logFilter:          logFilter,
		poolPermanentCache: NewPermanentCache[PoolCacheRecord](cacheDir, fmt.Sprintf("uniV2Pools-%d", chainID)),
		syncStatePath:      filepath.Join(cacheDir, fmt.Sprintf("uniV2SyncState-%d.json", chainID)),
	}

	// Register log filter for Sync events
	syncTopic := SyncEventTopic.Hex()
	logFilter.AddFilter([]string{syncTopic}, func(logs []formatters.Log) {
		if logs == nil {
			lib.ExtractorError("UniV2: Log collecting failed")
			return
		}

		eventKnown := 0
		eventUnknown := 0

		for _, l := range logs {
			reserve0, reserve1, err := DecodeSyncEvent(l)
			if err != nil {
				continue
			}

			addrL := strings.ToLower(l.Address)
			ext.poolMu.RLock()
			pool, exists := ext.poolMap[addrL]
			ext.poolMu.RUnlock()

			if exists {
				if reserve0 != nil && reserve1 != nil && !l.Removed {
					ext.poolMu.Lock()
					pool.Reserve0 = reserve0
					pool.Reserve1 = reserve1
					ext.poolMu.Unlock()
				}
				eventKnown++
			} else {
				eventUnknown++
				if reserve0 != nil && reserve1 != nil {
					go ext.addPoolByLog(common.HexToAddress(l.Address), reserve0, reserve1)
				}
			}
		}

		blockNumber := "<undefined>"
		if len(logs) > 0 {
			last := logs[len(logs)-1]
			if last.BlockNumber != nil {
				blockNumber = last.BlockNumber.String()
			}
		}
		ext.poolMu.RLock()
		poolCount := len(ext.poolMap)
		ext.poolMu.RUnlock()
		ext.consoleLog(fmt.Sprintf("Block %s %d logs (%d known, %d unknown), pools: %d",
			blockNumber, len(logs), eventKnown, eventUnknown, poolCount))
	})

	return ext
}

// ---- Batched multicall helpers ----

func (ext *UniV2Extractor) batchGetReserves(ctx context.Context, addresses []common.Address) map[string][2]*big.Int {
	pairABI := univ2pair.MustParsedABI()
	results := make(map[string][2]*big.Int)

	for i := 0; i < len(addresses); i += multicallBatchSize {
		end := i + multicallBatchSize
		if end > len(addresses) {
			end = len(addresses)
		}
		chunk := addresses[i:end]

		contracts := make([]public.MulticallContract, len(chunk))
		for j, addr := range chunk {
			contracts[j] = public.MulticallContract{
				Address:      addr,
				ABI:          pairABI,
				FunctionName: "getReserves",
			}
		}

		mcResults, err := public.Multicall(ctx, ext.client, public.MulticallParameters{
			Contracts:    contracts,
			AllowFailure: boolPtr(true),
		})
		if err != nil {
			lib.ExtractorError("batchGetReserves multicall error", "error", err)
			continue
		}

		for j, r := range mcResults {
			addrL := strings.ToLower(chunk[j].Hex())
			if r.Status == "success" {
				if vals, ok := r.Result.([]any); ok && len(vals) >= 2 {
					r0, _ := vals[0].(*big.Int)
					r1, _ := vals[1].(*big.Int)
					if r0 != nil && r1 != nil {
						results[addrL] = [2]*big.Int{r0, r1}
					}
				}
			}
		}
	}
	return results
}

// ---- Token -> TokenInfo helper ----

func tokenToInfo(t *lib.Token) TokenInfo {
	sym := ""
	name := ""
	if t.Symbol != "" {
		sym = t.Symbol
	}
	if t.Name != "" {
		name = t.Name
	}
	return TokenInfo{
		Address:  t.Address.Hex(),
		Symbol:   sym,
		Name:     name,
		Decimals: t.Decimals,
	}
}

// ---- Core pool add ----

func (ext *UniV2Extractor) addPool(
	address common.Address,
	token0, token1 *lib.Token,
	reserve0, reserve1 *big.Int,
	factory FactoryV2,
	log bool,
) *PoolState {
	t0, t1 := token0, token1
	if !token0.SortsBefore(token1) {
		t0, t1 = token1, token0
	}

	state := &PoolState{
		Address:  address.Hex(),
		Token0:   tokenToInfo(t0),
		Token1:   tokenToInfo(t1),
		Reserve0: reserve0,
		Reserve1: reserve1,
		Fee:      factory.Fee,
		Provider: factory.Provider,
	}

	ext.poolMu.Lock()
	ext.poolMap[strings.ToLower(address.Hex())] = state
	poolCount := len(ext.poolMap)
	ext.poolMu.Unlock()

	if log {
		ext.consoleLog(fmt.Sprintf("add pool %s %s-%s, total: %d", address.Hex(), t0.Symbol, t1.Symbol, poolCount))
	}
	return state
}

// ---- Start ----

func (ext *UniV2Extractor) Start(ctx context.Context) error {
	startTime := time.Now()

	if ext.tokenManager.TokenCount() == 0 {
		if err := ext.tokenManager.AddCachedTokens(); err != nil {
			return fmt.Errorf("failed to load cached tokens: %w", err)
		}
	}

	syncState := readSyncState(ext.syncStatePath)
	needsBackgroundSync := false

	factoryABI := univ2factory.MustParsedABI()

	for _, factory := range ext.factories {
		factoryKey := strings.ToLower(factory.Address.Hex())

		mcResults, err := public.Multicall(ctx, ext.client, public.MulticallParameters{
			Contracts: []public.MulticallContract{
				{Address: factory.Address, ABI: factoryABI, FunctionName: "allPairsLength"},
			},
			AllowFailure: boolPtr(true),
		})
		if err != nil || len(mcResults) == 0 || mcResults[0].Status == "failure" {
			continue
		}

		onChainCount := 0
		if val, ok := mcResults[0].Result.(*big.Int); ok {
			onChainCount = int(val.Int64())
		}
		lastSynced := syncState[factoryKey]
		ext.consoleLog(fmt.Sprintf("%s: on-chain=%d, synced=%d", factory.Provider, onChainCount, lastSynced))

		if lastSynced < onChainCount {
			needsBackgroundSync = true
		}
	}

	if err := ext.loadCachedPools(ctx, startTime); err != nil {
		lib.ExtractorError("Failed to load cached pools", "error", err)
	}

	ext.poolMu.RLock()
	poolCount := len(ext.poolMap)
	ext.poolMu.RUnlock()
	ext.consoleLog(fmt.Sprintf("ExtractorV2 ready (%dms), %d pools from cache",
		time.Since(startTime).Milliseconds(), poolCount))
	ext.started = true

	if needsBackgroundSync {
		ext.syncing = true
		go func() {
			if err := ext.backgroundSync(ctx, syncState); err != nil {
				lib.ExtractorError("Background sync failed", "error", err)
			}
			ext.syncing = false
		}()
	}

	return nil
}

func (ext *UniV2Extractor) backgroundSync(ctx context.Context, syncState SyncState) error {
	writeSyncState(ext.syncStatePath, syncState)

	for _, factory := range ext.factories {
		if err := ext.syncFactoryStreaming(ctx, factory, syncState); err != nil {
			return err
		}
	}
	writeSyncState(ext.syncStatePath, syncState)

	ext.poolMu.RLock()
	poolCount := len(ext.poolMap)
	ext.poolMu.RUnlock()
	ext.consoleLog(fmt.Sprintf("Background sync complete. %d total pools.", poolCount))
	return nil
}

func (ext *UniV2Extractor) syncFactoryStreaming(ctx context.Context, factory FactoryV2, syncState SyncState) error {
	factoryKey := strings.ToLower(factory.Address.Hex())
	factoryABI := univ2factory.MustParsedABI()
	pairABI := univ2pair.MustParsedABI()

	mcResults, err := public.Multicall(ctx, ext.client, public.MulticallParameters{
		Contracts: []public.MulticallContract{
			{Address: factory.Address, ABI: factoryABI, FunctionName: "allPairsLength"},
		},
		AllowFailure: boolPtr(true),
	})
	if err != nil || len(mcResults) == 0 || mcResults[0].Status == "failure" {
		lib.ExtractorError("Failed to get allPairsLength", "provider", factory.Provider)
		return nil
	}

	onChainCount := 0
	if val, ok := mcResults[0].Result.(*big.Int); ok {
		onChainCount = int(val.Int64())
	}
	lastSynced := syncState[factoryKey]
	if lastSynced >= onChainCount {
		return nil
	}

	total := onChainCount - lastSynced
	ext.consoleLog(fmt.Sprintf("%s: syncing %d new pools in background (%d->%d)...",
		factory.Provider, total, lastSynced, onChainCount))

	synced := 0
	lastSyncWrite := time.Now()
	const syncWriteInterval = 10 * time.Second

	for i := lastSynced; i < onChainCount; i += multicallBatchSize {
		end := i + multicallBatchSize
		if end > onChainCount {
			end = onChainCount
		}
		chunkSize := end - i

		// 1. Fetch addresses
		addrContracts := make([]public.MulticallContract, 0, chunkSize)
		for j := i; j < end; j++ {
			addrContracts = append(addrContracts, public.MulticallContract{
				Address:      factory.Address,
				ABI:          factoryABI,
				FunctionName: "allPairs",
				Args:         []any{big.NewInt(int64(j))},
			})
		}

		addrResults, err := public.Multicall(ctx, ext.client, public.MulticallParameters{
			Contracts:    addrContracts,
			AllowFailure: boolPtr(true),
		})
		if err != nil {
			lib.ExtractorError("syncFactory allPairs multicall error", "error", err)
			continue
		}

		var addresses []common.Address
		for _, r := range addrResults {
			if r.Status == "success" {
				if addr, ok := r.Result.(common.Address); ok {
					addresses = append(addresses, addr)
				}
			}
		}

		// Filter out already-known pools
		var newAddresses []common.Address
		ext.poolMu.RLock()
		for _, a := range addresses {
			if _, exists := ext.poolMap[strings.ToLower(a.Hex())]; !exists {
				newAddresses = append(newAddresses, a)
			}
		}
		ext.poolMu.RUnlock()

		if len(newAddresses) == 0 {
			synced += chunkSize
			syncState[factoryKey] = end
			if time.Since(lastSyncWrite) >= syncWriteInterval {
				writeSyncState(ext.syncStatePath, syncState)
				lastSyncWrite = time.Now()
			}
			continue
		}

		// 2. Fetch token0 + token1 + reserves
		infoContracts := make([]public.MulticallContract, 0, len(newAddresses)*3)
		for _, addr := range newAddresses {
			infoContracts = append(infoContracts,
				public.MulticallContract{Address: addr, ABI: pairABI, FunctionName: "token0"},
				public.MulticallContract{Address: addr, ABI: pairABI, FunctionName: "token1"},
				public.MulticallContract{Address: addr, ABI: pairABI, FunctionName: "getReserves"},
			)
		}

		infoResults, err := public.Multicall(ctx, ext.client, public.MulticallParameters{
			Contracts:    infoContracts,
			AllowFailure: boolPtr(true),
		})
		if err != nil {
			lib.ExtractorError("syncFactory info multicall error", "error", err)
			continue
		}

		// 3. Parse + resolve tokens
		type poolInfo struct {
			address   common.Address
			token0Addr common.Address
			token1Addr common.Address
			reserve0   *big.Int
			reserve1   *big.Int
		}
		var pools []poolInfo
		tokenAddrs := make(map[common.Address]struct{})

		for j := 0; j < len(newAddresses); j++ {
			t0R := infoResults[j*3]
			t1R := infoResults[j*3+1]
			resR := infoResults[j*3+2]

			if t0R.Status != "success" || t1R.Status != "success" || resR.Status != "success" {
				continue
			}

			t0, _ := t0R.Result.(common.Address)
			t1, _ := t1R.Result.(common.Address)

			var r0, r1 *big.Int
			if vals, ok := resR.Result.([]any); ok && len(vals) >= 2 {
				r0, _ = vals[0].(*big.Int)
				r1, _ = vals[1].(*big.Int)
			}
			if r0 == nil {
				r0 = big.NewInt(0)
			}
			if r1 == nil {
				r1 = big.NewInt(0)
			}

			tokenAddrs[t0] = struct{}{}
			tokenAddrs[t1] = struct{}{}
			pools = append(pools, poolInfo{
				address:    newAddresses[j],
				token0Addr: t0,
				token1Addr: t1,
				reserve0:   r0,
				reserve1:   r1,
			})
		}

		// Resolve unknown tokens concurrently — the multicall batcher
		// automatically aggregates these into fewer RPC calls.
		var unknownTokens []common.Address
		for addr := range tokenAddrs {
			if ext.tokenManager.GetKnownToken(addr) == nil {
				unknownTokens = append(unknownTokens, addr)
			}
		}

		if len(unknownTokens) > 0 {
			var tokenWg sync.WaitGroup
			for _, addr := range unknownTokens {
				tokenWg.Add(1)
				go func(a common.Address) {
					defer tokenWg.Done()
					_, _ = ext.tokenManager.FindToken(ctx, a)
				}(addr)
			}
			tokenWg.Wait()
		}

		// 4. Add pools
		chunkAdded := 0
		for _, p := range pools {
			ext.poolMu.RLock()
			_, exists := ext.poolMap[strings.ToLower(p.address.Hex())]
			ext.poolMu.RUnlock()
			if exists {
				continue
			}

			token0 := ext.tokenManager.GetKnownToken(p.token0Addr)
			token1 := ext.tokenManager.GetKnownToken(p.token1Addr)
			if token0 == nil {
				t, _ := ext.tokenManager.FindToken(ctx, p.token0Addr)
				token0 = t
			}
			if token1 == nil {
				t, _ := ext.tokenManager.FindToken(ctx, p.token1Addr)
				token1 = t
			}
			if token0 == nil || token1 == nil {
				continue
			}

			ext.addPool(p.address, token0, token1, p.reserve0, p.reserve1, factory, false)
			ext.poolPermanentCache.Add(PoolCacheRecord{
				Address: p.address.Hex(),
				Token0:  p.token0Addr.Hex(),
				Token1:  p.token1Addr.Hex(),
				Factory: factory.Address.Hex(),
			})
			chunkAdded++
		}

		synced += chunkSize
		syncState[factoryKey] = end
		ext.poolMu.RLock()
		poolCount := len(ext.poolMap)
		ext.poolMu.RUnlock()
		ext.consoleLog(fmt.Sprintf("  %s: %d/%d (+%d pools), total map: %d",
			factory.Provider, synced, total, chunkAdded, poolCount))

		if time.Since(lastSyncWrite) >= syncWriteInterval {
			writeSyncState(ext.syncStatePath, syncState)
			lastSyncWrite = time.Now()
		}
	}

	syncState[factoryKey] = onChainCount
	writeSyncState(ext.syncStatePath, syncState)
	ext.consoleLog(fmt.Sprintf("  %s: sync complete (index=%d)", factory.Provider, onChainCount))
	return nil
}

func (ext *UniV2Extractor) loadCachedPools(ctx context.Context, startTime time.Time) error {
	cachedRecords, err := ext.poolPermanentCache.GetAllRecords()
	if err != nil {
		return err
	}

	seen := make(map[string]struct{})
	type rawEntry struct {
		address    common.Address
		token0Addr common.Address
		token1Addr common.Address
		factoryKey string
	}
	var rawEntries []rawEntry

	ext.poolMu.RLock()
	for _, r := range cachedRecords {
		addrL := strings.ToLower(r.Address)
		if _, ok := seen[addrL]; ok {
			continue
		}
		if _, ok := ext.poolMap[addrL]; ok {
			continue
		}
		if _, ok := ext.factoryMap[strings.ToLower(r.Factory)]; !ok {
			continue
		}
		seen[addrL] = struct{}{}
		rawEntries = append(rawEntries, rawEntry{
			address:    common.HexToAddress(r.Address),
			token0Addr: common.HexToAddress(r.Token0),
			token1Addr: common.HexToAddress(r.Token1),
			factoryKey: r.Factory,
		})
	}
	ext.poolMu.RUnlock()

	if len(rawEntries) == 0 {
		ext.consoleLog("No cached pools to load")
		return nil
	}

	// Collect unique token addresses
	allTokenAddrs := make(map[common.Address]struct{})
	for _, r := range rawEntries {
		allTokenAddrs[r.token0Addr] = struct{}{}
		allTokenAddrs[r.token1Addr] = struct{}{}
	}
	var missingTokens []common.Address
	for addr := range allTokenAddrs {
		if ext.tokenManager.GetKnownToken(addr) == nil {
			missingTokens = append(missingTokens, addr)
		}
	}

	if len(missingTokens) > 0 {
		ext.consoleLog(fmt.Sprintf("Resolving %d missing tokens...", len(missingTokens)))
		var wg sync.WaitGroup
		for _, addr := range missingTokens {
			wg.Add(1)
			go func(a common.Address) {
				defer wg.Done()
				_, _ = ext.tokenManager.FindToken(ctx, a)
			}(addr)
		}
		wg.Wait()
	}

	type entry struct {
		address common.Address
		token0  *lib.Token
		token1  *lib.Token
		factory FactoryV2
	}
	var entries []entry
	skipped := 0
	for _, r := range rawEntries {
		token0 := ext.tokenManager.GetKnownToken(r.token0Addr)
		token1 := ext.tokenManager.GetKnownToken(r.token1Addr)
		factory := ext.factoryMap[strings.ToLower(r.factoryKey)]
		if token0 != nil && token1 != nil {
			entries = append(entries, entry{address: r.address, token0: token0, token1: token1, factory: factory})
		} else {
			skipped++
		}
	}

	if skipped > 0 {
		ext.consoleLog(fmt.Sprintf("Skipped %d pools (unresolvable tokens)", skipped))
	}
	if len(entries) == 0 {
		return nil
	}

	ext.consoleLog(fmt.Sprintf("Loading %d pools from cache...", len(entries)))

	addrs := make([]common.Address, len(entries))
	for i, e := range entries {
		addrs[i] = e.address
	}
	reservesMap := ext.batchGetReserves(ctx, addrs)

	loaded := 0
	for _, e := range entries {
		reserves, ok := reservesMap[strings.ToLower(e.address.Hex())]
		r0 := big.NewInt(0)
		r1 := big.NewInt(0)
		if ok {
			r0 = reserves[0]
			r1 = reserves[1]
		}
		ext.addPool(e.address, e.token0, e.token1, r0, r1, e.factory, false)
		loaded++
	}

	ext.consoleLog(fmt.Sprintf("Loaded %d pools from cache", loaded))
	return nil
}

// ---- Event-driven pool discovery ----

func (ext *UniV2Extractor) addPoolByLog(addr common.Address, reserve0, reserve1 *big.Int) {
	addrL := strings.ToLower(addr.Hex())

	ext.poolMu.RLock()
	_, exists := ext.poolMap[addrL]
	ext.poolMu.RUnlock()
	if exists {
		return
	}

	if _, loaded := ext.pendingLogDiscovery.LoadOrStore(addrL, struct{}{}); loaded {
		return
	}
	defer ext.pendingLogDiscovery.Delete(addrL)

	ctx := context.Background()
	pairABI := univ2pair.MustParsedABI()

	results, err := Repeat(2, func() ([]public.MulticallResult, error) {
		return public.Multicall(ctx, ext.client, public.MulticallParameters{
			Contracts: []public.MulticallContract{
				{Address: addr, ABI: pairABI, FunctionName: "factory"},
				{Address: addr, ABI: pairABI, FunctionName: "token0"},
				{Address: addr, ABI: pairABI, FunctionName: "token1"},
			},
			AllowFailure: boolPtr(true),
		})
	})
	if err != nil {
		lib.ExtractorError("addPoolByLog multicall failed", "address", addr.Hex(), "error", err)
		return
	}

	factoryR := results[0]
	token0R := results[1]
	token1R := results[2]

	if factoryR.Status == "failure" || token0R.Status == "failure" || token1R.Status == "failure" {
		return
	}

	factoryAddr, _ := factoryR.Result.(common.Address)
	factory, ok := ext.factoryMap[strings.ToLower(factoryAddr.Hex())]
	if !ok {
		return
	}

	t0Addr, _ := token0R.Result.(common.Address)
	t1Addr, _ := token1R.Result.(common.Address)

	// Resolve tokens concurrently
	var token0, token1 *lib.Token
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		token0, _ = ext.tokenManager.FindToken(ctx, t0Addr)
	}()
	go func() {
		defer wg.Done()
		token1, _ = ext.tokenManager.FindToken(ctx, t1Addr)
	}()
	wg.Wait()

	if token0 == nil || token1 == nil {
		return
	}

	ext.poolMu.RLock()
	_, exists = ext.poolMap[addrL]
	ext.poolMu.RUnlock()
	if exists {
		return
	}

	ext.addPool(addr, token0, token1, reserve0, reserve1, factory, true)
	ext.poolPermanentCache.Add(PoolCacheRecord{
		Address: addr.Hex(),
		Token0:  t0Addr.Hex(),
		Token1:  t1Addr.Hex(),
		Factory: factory.Address.Hex(),
	})
}

// ---- Getters ----

func (ext *UniV2Extractor) GetPools() []PoolState {
	ext.poolMu.RLock()
	defer ext.poolMu.RUnlock()
	pools := make([]PoolState, 0, len(ext.poolMap))
	for _, p := range ext.poolMap {
		pools = append(pools, *p)
	}
	return pools
}

func (ext *UniV2Extractor) GetPoolMap() map[string]*PoolState {
	ext.poolMu.RLock()
	defer ext.poolMu.RUnlock()
	// return a copy
	result := make(map[string]*PoolState, len(ext.poolMap))
	for k, v := range ext.poolMap {
		result[k] = v
	}
	return result
}

func (ext *UniV2Extractor) consoleLog(msg string) {
	lib.ExtractorInfo(fmt.Sprintf("V2 %s", msg))
}

func (ext *UniV2Extractor) IsStarted() bool { return ext.started }
func (ext *UniV2Extractor) IsSyncing() bool { return ext.syncing }
