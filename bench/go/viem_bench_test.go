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

	"github.com/ChefBingbong/mini-extractor-go/extractor"
	univ2factory "github.com/ChefBingbong/mini-extractor-go/_contracts_typed/contract_templates/univ2factory"
	univ2pair "github.com/ChefBingbong/mini-extractor-go/_contracts_typed/contract_templates/univ2pair"
	"github.com/ChefBingbong/viem-go/actions/public"
	"github.com/ChefBingbong/viem-go/chain/definitions"
	"github.com/ChefBingbong/viem-go/client"
	"github.com/ChefBingbong/viem-go/client/transport"
	"github.com/ChefBingbong/viem-go/utils/formatters"
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

var (
	uniV2Factory = common.HexToAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f")
	knownPair    = common.HexToAddress("0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc") // USDC-WETH
)

func boolPtr(v bool) *bool { return &v }

func rpcURL(t testing.TB) string {
	t.Helper()
	url := os.Getenv("RPC_URL")
	if url == "" {
		t.Skip("RPC_URL not set — skipping RPC benchmark")
	}
	return url
}

func setupClient(t testing.TB) *client.PublicClient {
	t.Helper()
	c, err := client.CreatePublicClient(client.PublicClientConfig{
		Chain:     &definitions.Mainnet,
		Transport: transport.HTTP(rpcURL(t)),
		Batch: &client.BatchOptions{
			Multicall: &client.MulticallBatchOptions{
				BatchSize: 2048,
				Wait:      16 * time.Millisecond,
			},
		},
		PollingInterval: 200 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func fetchPairAddresses(t testing.TB, c *client.PublicClient, count int) []common.Address {
	t.Helper()
	ctx := context.Background()
	factoryABI := univ2factory.MustParsedABI()

	contracts := make([]public.MulticallContract, count)
	for i := 0; i < count; i++ {
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
		t.Fatal(err)
	}

	var addrs []common.Address
	for _, r := range results {
		if r.Status == "success" {
			if addr, ok := r.Result.(common.Address); ok {
				addrs = append(addrs, addr)
			}
		}
	}
	return addrs
}

func memStatsMB() float64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.HeapAlloc) / 1024 / 1024
}

// ─── 1. Multicall Benchmarks ────────────────────────────────────────────────

func BenchmarkMulticallSingle(b *testing.B) {
	c := setupClient(b)
	ctx := context.Background()
	pairABI := univ2pair.MustParsedABI()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := public.Multicall(ctx, c, public.MulticallParameters{
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

func BenchmarkMulticallBatch(b *testing.B) {
	c := setupClient(b)
	ctx := context.Background()
	pairABI := univ2pair.MustParsedABI()
	pairs := fetchPairAddresses(b, c, 200)

	for _, size := range []int{10, 50, 100, 200} {
		if size > len(pairs) {
			continue
		}
		b.Run(fmt.Sprintf("batch_%d", size), func(b *testing.B) {
			chunk := pairs[:size]
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
				_, err := public.Multicall(ctx, c, public.MulticallParameters{
					Contracts:    contracts,
					AllowFailure: boolPtr(true),
				})
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// ─── 2. Event Decoding Benchmark ────────────────────────────────────────────

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

func BenchmarkFactorySyncChunks(b *testing.B) {
	c := setupClient(b)
	ctx := context.Background()
	factoryABI := univ2factory.MustParsedABI()
	pairABI := univ2pair.MustParsedABI()

	for _, chunkSize := range []int{50, 100, 500} {
		b.Run(fmt.Sprintf("chunk_%d", chunkSize), func(b *testing.B) {
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				// 1. Fetch pair addresses
				addrContracts := make([]public.MulticallContract, chunkSize)
				for j := 0; j < chunkSize; j++ {
					addrContracts[j] = public.MulticallContract{
						Address:      uniV2Factory,
						ABI:          factoryABI,
						FunctionName: "allPairs",
						Args:         []any{big.NewInt(int64(j))},
					}
				}
				addrResults, err := public.Multicall(ctx, c, public.MulticallParameters{
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

				// 2. Fetch token0 + token1 + getReserves for all
				infoContracts := make([]public.MulticallContract, 0, len(addrs)*3)
				for _, addr := range addrs {
					infoContracts = append(infoContracts,
						public.MulticallContract{Address: addr, ABI: pairABI, FunctionName: "token0"},
						public.MulticallContract{Address: addr, ABI: pairABI, FunctionName: "token1"},
						public.MulticallContract{Address: addr, ABI: pairABI, FunctionName: "getReserves"},
					)
				}
				_, err = public.Multicall(ctx, c, public.MulticallParameters{
					Contracts:    infoContracts,
					AllowFailure: boolPtr(true),
				})
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// ─── 4. JSON Serialization Benchmark ────────────────────────────────────────

func BenchmarkPoolSerializationJSON(b *testing.B) {
	for _, poolCount := range []int{100, 1000, 5000, 10000} {
		b.Run(fmt.Sprintf("pools_%d", poolCount), func(b *testing.B) {
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
		})
	}
}

// ─── 5. Memory Profiling for Pool Map ───────────────────────────────────────

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
