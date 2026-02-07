package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	univ2factory "github.com/ChefBingbong/mini-extractor-go/_contracts_typed/contract_templates/univ2factory"
	univ2pair "github.com/ChefBingbong/mini-extractor-go/_contracts_typed/contract_templates/univ2pair"
	"github.com/ChefBingbong/mini-extractor-go/extractor"
	"github.com/ChefBingbong/viem-go/actions/public"
	"github.com/ChefBingbong/viem-go/chain/definitions"
	"github.com/ChefBingbong/viem-go/client"
	"github.com/ChefBingbong/viem-go/client/transport"
	"github.com/ChefBingbong/viem-go/utils/formatters"
)

// ─── Shared state (initialized once via TestMain, like TS beforeAll) ─────────

var (
	uniV2Factory = common.HexToAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f")
	knownPair    = common.HexToAddress("0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc") // USDC-WETH

	sharedClient  *client.PublicClient
	pairAddresses []common.Address
	pairABI       = univ2pair.MustParsedABI()
	factoryABI    = univ2factory.MustParsedABI()
)

func boolPtr(v bool) *bool { return &v }

func TestMain(m *testing.M) {
	rpcURL := os.Getenv("RPC_URL")
	if rpcURL == "" {
		fmt.Fprintln(os.Stderr, "RPC_URL not set — skipping benchmarks")
		os.Exit(0)
	}

	c, err := client.CreatePublicClient(client.PublicClientConfig{
		Chain:     &definitions.Mainnet,
		Transport: transport.HTTP(rpcURL),
		Batch: &client.BatchOptions{
			Multicall: &client.MulticallBatchOptions{
				BatchSize: 8196,
				Wait:      16 * time.Millisecond,
			},
		},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create client: %v\n", err)
		os.Exit(1)
	}
	sharedClient = c

	ctx := context.Background()
	contracts := make([]public.MulticallContract, 200)
	for i := 0; i < 200; i++ {
		contracts[i] = public.MulticallContract{
			Address:      uniV2Factory,
			ABI:          factoryABI,
			FunctionName: "allPairs",
			Args:         []any{big.NewInt(int64(i))},
		}
	}
	results, err := public.Multicall(ctx, c, public.MulticallParameters{
		Contracts:    contracts,
		AllowFailure: boolPtr(true),
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to fetch pair addresses: %v\n", err)
		os.Exit(1)
	}
	for _, r := range results {
		if r.Status == "success" {
			if addr, ok := r.Result.(common.Address); ok {
				pairAddresses = append(pairAddresses, addr)
			}
		}
	}
	fmt.Fprintf(os.Stderr, "Setup: client created, %d pair addresses fetched\n", len(pairAddresses))

	os.Exit(m.Run())
}

func memStatsMB() float64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.HeapAlloc) / 1024 / 1024
}

// ─── 1. Multicall Benchmarks ────────────────────────────────────────────────

func BenchmarkMulticallSingle(b *testing.B) {
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := public.Multicall(ctx, sharedClient, public.MulticallParameters{
			Contracts: []public.MulticallContract{
				{Address: knownPair, ABI: pairABI, FunctionName: "getReserves"},
			},
			AllowFailure: boolPtr(true),
		})
		if err != nil {
			b.Fatal(err)
		}
	}
}

func benchMulticallBatch(b *testing.B, size int) {
	ctx := context.Background()
	chunk := pairAddresses[:size]
	contracts := make([]public.MulticallContract, len(chunk))
	for j, addr := range chunk {
		contracts[j] = public.MulticallContract{
			Address:      addr,
			ABI:          pairABI,
			FunctionName: "getReserves",
		}
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := public.Multicall(ctx, sharedClient, public.MulticallParameters{
			Contracts:    contracts,
			AllowFailure: boolPtr(true),
		})
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkMulticallBatch_10(b *testing.B)  { benchMulticallBatch(b, 10) }
func BenchmarkMulticallBatch_50(b *testing.B)  { benchMulticallBatch(b, 50) }
func BenchmarkMulticallBatch_100(b *testing.B) { benchMulticallBatch(b, 100) }
func BenchmarkMulticallBatch_200(b *testing.B) { benchMulticallBatch(b, 200) }

// ─── 2. Event Decoding Benchmarks ───────────────────────────────────────────

func BenchmarkDecodeSyncEvent(b *testing.B) {
	rawLog := formatters.Log{
		Address: "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc",
		Topics:  []string{extractor.SyncEventTopic.Hex()},
		Data:    "0x00000000000000000000000000000000000000000000000000005af3107a400000000000000000000000000000000000000000000000000000000000003b9aca00",
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, err := extractor.DecodeSyncEvent(rawLog)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkDecodeSyncEventBatch(b *testing.B) {
	logs := make([]formatters.Log, 1000)
	for i := range logs {
		logs[i] = formatters.Log{
			Address: fmt.Sprintf("0x%040x", i),
			Topics:  []string{extractor.SyncEventTopic.Hex()},
			Data:    "0x00000000000000000000000000000000000000000000000000005af3107a400000000000000000000000000000000000000000000000000000000000003b9aca00",
		}
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, l := range logs {
			extractor.DecodeSyncEvent(l)
		}
	}
}

// ─── 3. Factory Sync Throughput ─────────────────────────────────────────────

func benchFactorySyncChunk(b *testing.B, chunkSize int) {
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		addrContracts := make([]public.MulticallContract, chunkSize)
		for j := 0; j < chunkSize; j++ {
			addrContracts[j] = public.MulticallContract{
				Address:      uniV2Factory,
				ABI:          factoryABI,
				FunctionName: "allPairs",
				Args:         []any{big.NewInt(int64(j))},
			}
		}
		addrResults, err := public.Multicall(ctx, sharedClient, public.MulticallParameters{
			Contracts:    addrContracts,
			AllowFailure: boolPtr(true),
		})
		if err != nil {
			b.Fatal(err)
		}

		var addrs []common.Address
		for _, r := range addrResults {
			if r.Status == "success" {
				if addr, ok := r.Result.(common.Address); ok {
					addrs = append(addrs, addr)
				}
			}
		}

		infoContracts := make([]public.MulticallContract, 0, len(addrs)*3)
		for _, addr := range addrs {
			infoContracts = append(infoContracts,
				public.MulticallContract{Address: addr, ABI: pairABI, FunctionName: "token0"},
				public.MulticallContract{Address: addr, ABI: pairABI, FunctionName: "token1"},
				public.MulticallContract{Address: addr, ABI: pairABI, FunctionName: "getReserves"},
			)
		}
		_, err = public.Multicall(ctx, sharedClient, public.MulticallParameters{
			Contracts:    infoContracts,
			AllowFailure: boolPtr(true),
		})
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkFactorySyncChunk_50(b *testing.B)  { benchFactorySyncChunk(b, 50) }
func BenchmarkFactorySyncChunk_100(b *testing.B) { benchFactorySyncChunk(b, 100) }
func BenchmarkFactorySyncChunk_500(b *testing.B) { benchFactorySyncChunk(b, 500) }

// ─── 4. JSON Serialization Benchmarks ───────────────────────────────────────

func benchPoolSerializationJSON(b *testing.B, poolCount int) {
	pools := make([]extractor.PoolStateJSON, poolCount)
	for i := 0; i < poolCount; i++ {
		pools[i] = extractor.PoolStateJSON{
			Address: fmt.Sprintf("0x%040x", i),
			Token0: extractor.TokenInfo{
				Address: fmt.Sprintf("0x%040x", i*2), Symbol: "TK0", Name: "Token0", Decimals: 18,
			},
			Token1: extractor.TokenInfo{
				Address: fmt.Sprintf("0x%040x", i*2+1), Symbol: "TK1", Name: "Token1", Decimals: 18,
			},
			Reserve0: "1000000000000000000",
			Reserve1: "2000000000000000000",
			Fee:      0.003,
			Provider: "UniswapV2",
		}
	}
	resp := map[string]any{
		"blockNumber": 12345678,
		"totalPools":  poolCount,
		"syncing":     false,
		"pools":       pools,
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, err := json.Marshal(resp)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPoolSerializationJSON_100(b *testing.B)   { benchPoolSerializationJSON(b, 100) }
func BenchmarkPoolSerializationJSON_1000(b *testing.B)  { benchPoolSerializationJSON(b, 1000) }
func BenchmarkPoolSerializationJSON_5000(b *testing.B)  { benchPoolSerializationJSON(b, 5000) }
func BenchmarkPoolSerializationJSON_10000(b *testing.B) { benchPoolSerializationJSON(b, 10000) }

// ─── 5. Memory Profiling ────────────────────────────────────────────────────

func TestPoolMapMemoryProfile(t *testing.T) {
	runtime.GC()
	beforeMB := memStatsMB()

	poolMap := make(map[string]*extractor.PoolState, 10000)
	for i := 0; i < 10000; i++ {
		poolMap[fmt.Sprintf("0x%040x", i)] = &extractor.PoolState{
			Address: fmt.Sprintf("0x%040x", i),
			Token0: extractor.TokenInfo{
				Address: fmt.Sprintf("0x%040x", i*2), Symbol: "TK0", Name: "Token0", Decimals: 18,
			},
			Token1: extractor.TokenInfo{
				Address: fmt.Sprintf("0x%040x", i*2+1), Symbol: "TK1", Name: "Token1", Decimals: 18,
			},
			Reserve0: big.NewInt(1e18),
			Reserve1: big.NewInt(2e18),
			Fee:      0.003,
			Provider: "UniswapV2",
		}
	}

	runtime.GC()
	afterMB := memStatsMB()
	t.Logf("Memory for 10,000 pools: %.2f MB (before=%.2f, after=%.2f)",
		afterMB-beforeMB, beforeMB, afterMB)
	t.Logf("~%.2f KB per pool", (afterMB-beforeMB)*1024/10000)
}
