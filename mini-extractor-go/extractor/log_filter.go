package extractor

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/ChefBingbong/mini-extractor-go/lib"
	"github.com/ChefBingbong/viem-go/actions/public"
	"github.com/ChefBingbong/viem-go/client"
	"github.com/ChefBingbong/viem-go/utils/formatters"
)

// LogFilterType determines how logs are fetched.
type LogFilterType int

const (
	LogFilterNative    LogFilterType = iota // getFilterChanges (not widely supported)
	LogFilterOneCall                        // one eth_getLogs call for all topics
	LogFilterMultiCall                      // separate eth_getLogs call for each topic
	LogFilterSelfFilter                     // fetch all logs, filter client-side
)

// FilterCallback is called when new logs arrive for a registered filter.
type FilterCallback func(logs []formatters.Log)

// FilterMy is a registered filter with its topics and callback.
type FilterMy struct {
	Topics    []string
	OnNewLogs FilterCallback
}

// BlockParams holds essential block info for the reorg chain.
type BlockParams struct {
	Hash       common.Hash
	Number     *uint64
	ParentHash common.Hash
	Timestamp  uint64
}

// BlockFrame tracks a sliding window of block hashes for reorg detection.
type BlockFrame struct {
	firstNumber *uint64
	lastNumber  *uint64
	hashNumMap  map[uint64][]common.Hash
}

func NewBlockFrame() *BlockFrame {
	return &BlockFrame{
		hashNumMap: make(map[uint64][]common.Hash),
	}
}

// SetFrame sets the frame [from, to) and returns deleted block hashes.
func (bf *BlockFrame) SetFrame(from, to uint64) []common.Hash {
	var deleted []common.Hash
	if bf.firstNumber != nil && bf.lastNumber != nil {
		for i := *bf.firstNumber; i < from; i++ {
			if hashes, ok := bf.hashNumMap[i]; ok {
				deleted = append(deleted, hashes...)
				delete(bf.hashNumMap, i)
			}
		}
		for i := to; i < *bf.lastNumber; i++ {
			if hashes, ok := bf.hashNumMap[i]; ok {
				deleted = append(deleted, hashes...)
				delete(bf.hashNumMap, i)
			}
		}
	}
	bf.firstNumber = &from
	bf.lastNumber = &to
	return deleted
}

// Add adds a block hash at the given number. Returns false if out of frame.
func (bf *BlockFrame) Add(blockNumber uint64, blockHash common.Hash) bool {
	if bf.firstNumber == nil || bf.lastNumber == nil {
		return false
	}
	if blockNumber < *bf.firstNumber || blockNumber >= *bf.lastNumber {
		return false
	}
	bf.hashNumMap[blockNumber] = append(bf.hashNumMap[blockNumber], blockHash)
	return true
}

// DeleteFrame clears the frame.
func (bf *BlockFrame) DeleteFrame() {
	bf.firstNumber = nil
	bf.lastNumber = nil
}

// LogFilter2 is a reorg-aware log filter that watches blocks and dispatches
// filtered logs to registered callbacks.
type LogFilter2 struct {
	client  *client.PublicClient
	depth   int
	logType LogFilterType
	debug   bool

	mu sync.Mutex

	topicsAll []string
	filters   []FilterMy

	blockProcessing bool
	cancelWatch     context.CancelFunc

	lastProcessedBlock *BlockParams
	processedBlockHash map[common.Hash]struct{}
	nextGoalBlock      *BlockParams

	blockHashMap map[common.Hash]*BlockParams
	logHashMap   map[common.Hash][]formatters.Log
	blockFrame   *BlockFrame

	// Channel to notify subscribers of new blocks
	blockCh chan uint64
}

// NewLogFilter2 creates a new LogFilter2.
func NewLogFilter2(c *client.PublicClient, depth int, logType LogFilterType, debug bool) *LogFilter2 {
	return &LogFilter2{
		client:             c,
		depth:              depth,
		logType:            logType,
		debug:              debug,
		processedBlockHash: make(map[common.Hash]struct{}),
		blockHashMap:       make(map[common.Hash]*BlockParams),
		logHashMap:         make(map[common.Hash][]formatters.Log),
		blockFrame:         NewBlockFrame(),
		blockCh:            make(chan uint64, 64),
	}
}

// BlockCh returns the channel that emits new block numbers.
func (lf *LogFilter2) BlockCh() <-chan uint64 {
	return lf.blockCh
}

// LastProcessedBlock returns the last processed block params.
func (lf *LogFilter2) LastProcessedBlock() *BlockParams {
	lf.mu.Lock()
	defer lf.mu.Unlock()
	return lf.lastProcessedBlock
}

// AddFilter registers a set of event topics and a callback.
func (lf *LogFilter2) AddFilter(topics []string, onNewLogs FilterCallback) {
	lf.topicsAll = append(lf.topicsAll, topics...)
	lf.filters = append(lf.filters, FilterMy{Topics: topics, OnNewLogs: onNewLogs})
}

// Start begins watching blocks and fetching logs.
func (lf *LogFilter2) Start() {
	if lf.cancelWatch != nil {
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	lf.cancelWatch = cancel

	if lf.logType == LogFilterNative {
		// Not widely supported — use OneCall as fallback
		lf.logType = LogFilterOneCall
	}

	// Watch block numbers via viem-go
	events := lf.client.WatchBlockNumber(ctx, public.WatchBlockNumberParameters{})

	go func() {
		for event := range events {
			if event.Error != nil {
				lib.ExtractorError("watchBlockNumber error", "error", event.Error)
				lf.Restart()
				return
			}

			blockNum := event.BlockNumber
			block, err := lf.client.GetBlockByNumber(ctx, blockNum, false)
			if err != nil {
				lib.ExtractorError("getBlock error", "blockNumber", blockNum, "error", err)
				continue
			}
			if block == nil {
				continue
			}

			bp := &BlockParams{
				Hash:       block.Hash,
				Number:     &block.Number,
				ParentHash: block.ParentHash,
				Timestamp:  block.Timestamp,
			}

			lf.addBlock(ctx, bp, block, true)

			// Notify subscribers
			select {
			case lf.blockCh <- block.Number:
			default:
			}
		}
	}()
}

// Stop stops watching.
func (lf *LogFilter2) Stop(signalStopping bool) {
	if lf.cancelWatch != nil {
		lf.cancelWatch()
		lf.cancelWatch = nil
	}

	lf.mu.Lock()
	lf.lastProcessedBlock = nil
	lf.processedBlockHash = make(map[common.Hash]struct{})
	lf.nextGoalBlock = nil
	lf.blockHashMap = make(map[common.Hash]*BlockParams)
	lf.logHashMap = make(map[common.Hash][]formatters.Log)
	lf.blockFrame.DeleteFrame()
	lf.mu.Unlock()

	if signalStopping {
		for _, f := range lf.filters {
			f.OnNewLogs(nil)
		}
	}
}

// Restart restarts the log filter with a backoff delay to avoid
// hammering a rate-limited RPC in a tight restart loop.
func (lf *LogFilter2) Restart() {
	lf.Stop(true)
	lib.Info("LogFilter restarting in 5s...")
	time.Sleep(5 * time.Second)
	lf.Start()
}

// setNewGoal sets the new goal block and trims the frame. Returns false if a restart was triggered.
func (lf *LogFilter2) setNewGoal(block *BlockParams) bool {
	if block.Number == nil {
		return true
	}
	blockNumber := *block.Number

	deletedHashes := lf.blockFrame.SetFrame(
		blockNumber-uint64(lf.depth),
		blockNumber+uint64(lf.depth),
	)

	initProcessed := len(lf.processedBlockHash)
	for _, hash := range deletedHashes {
		delete(lf.blockHashMap, hash)
		delete(lf.logHashMap, hash)
		delete(lf.processedBlockHash, hash)
	}

	if initProcessed > 0 && len(lf.processedBlockHash) == 0 {
		go lf.Restart()
		return false
	}

	lf.nextGoalBlock = block
	return true
}

// addBlock processes a new block: fetches logs and resolves the chain.
func (lf *LogFilter2) addBlock(ctx context.Context, bp *BlockParams, block interface{}, isGoal bool) {
	start := time.Now()

	if bp.Number == nil || bp.Hash == (common.Hash{}) {
		lib.ExtractorError("Incorrect block", "number", bp.Number, "hash", bp.Hash)
		return
	}

	lf.mu.Lock()

	if isGoal {
		if !lf.setNewGoal(bp) {
			lf.mu.Unlock()
			return
		}
	}

	if _, exists := lf.blockHashMap[bp.Hash]; exists {
		lf.mu.Unlock()
		return
	}

	if !lf.blockFrame.Add(*bp.Number, bp.Hash) {
		lf.mu.Unlock()
		return
	}
	lf.blockHashMap[bp.Hash] = bp

	needsSyncUp := lf.lastProcessedBlock != nil && lf.blockHashMap[bp.ParentHash] == nil
	lf.mu.Unlock()

	// Fetch logs
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		lf.fetchLogsForBlock(ctx, bp, start)
	}()

	// Sync up (fetch parent blocks if missing)
	if needsSyncUp {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lf.syncUpParent(ctx, bp)
		}()
	}

	wg.Wait()
}

// fetchLogsForBlock fetches logs for a specific block hash.
func (lf *LogFilter2) fetchLogsForBlock(ctx context.Context, bp *BlockParams, start time.Time) {
	backupPlan := func(err error) {
		lib.Warn("getLog failed for block, restarting", "hash", bp.Hash.Hex(), "error", err)
		lf.Restart()
	}

	switch lf.logType {
	case LogFilterOneCall:
		_, ok := RepeatAsync(10, 1000, func() ([]formatters.Log, error) {
			blockHash := bp.Hash.Hex()
			// Use raw transport request for eth_getLogs with blockHash + topics filter
			resp, err := lf.client.Request(ctx, "eth_getLogs", map[string]interface{}{
				"blockHash": blockHash,
				"topics":    []interface{}{lf.topicsAll},
			})
			if err != nil {
				if lf.debug {
					lib.Debug("logs transport fetch issues", "error", err)
				}
				return nil, err
			}

			var rpcLogs []formatters.RpcLog
			if err := json.Unmarshal(resp.Result, &rpcLogs); err != nil {
				return nil, fmt.Errorf("failed to unmarshal logs: %w", err)
			}

			logs := formatters.FormatLogs(rpcLogs)
			lf.sortAndProcessLogs(bp.Hash, logs)
			lib.Info(fmt.Sprintf("Processed block [%d] (%dms)", *bp.Number, time.Since(start).Milliseconds()))
			return logs, nil
		}, backupPlan)
		if !ok {
			return
		}

	case LogFilterMultiCall:
		// Fetch logs per topic, then merge
		var allLogs []formatters.Log
		var logsMu sync.Mutex
		var fetchWg sync.WaitGroup
		blockHash := bp.Hash

		for _, topic := range lf.topicsAll {
			fetchWg.Add(1)
			go func(t string) {
				defer fetchWg.Done()
				logs, err := public.GetLogs(ctx, lf.client, public.GetLogsParameters{
					BlockHash: &blockHash,
					Topics:    []any{t},
				})
				if err != nil {
					lib.Warn("MultiCall getLogs error", "topic", t, "error", err)
					return
				}
				logsMu.Lock()
				allLogs = append(allLogs, logs...)
				logsMu.Unlock()
			}(topic)
		}
		fetchWg.Wait()
		lf.sortAndProcessLogs(bp.Hash, allLogs)

	case LogFilterSelfFilter:
		blockHash := bp.Hash
		logs, err := public.GetLogs(ctx, lf.client, public.GetLogsParameters{
			BlockHash: &blockHash,
		})
		if err != nil {
			backupPlan(err)
			return
		}
		// Filter client-side
		topicSet := make(map[string]struct{}, len(lf.topicsAll))
		for _, t := range lf.topicsAll {
			topicSet[t] = struct{}{}
		}
		var filtered []formatters.Log
		for _, l := range logs {
			if len(l.Topics) > 0 {
				if _, ok := topicSet[l.Topics[0]]; ok {
					filtered = append(filtered, l)
				}
			}
		}
		lf.sortAndProcessLogs(bp.Hash, filtered)
	}
}

// syncUpParent fetches missing parent blocks backwards.
func (lf *LogFilter2) syncUpParent(ctx context.Context, bp *BlockParams) {
	RepeatAsync(10, 1000, func() (struct{}, error) {
		lib.Info("Adding blocks backwards", "number", bp.Number, "parentHash", bp.ParentHash.Hex())
		parentBlock, err := lf.client.GetBlockByHash(ctx, bp.ParentHash, false)
		if err != nil {
			return struct{}{}, err
		}
		if parentBlock == nil {
			return struct{}{}, fmt.Errorf("parent block not found: %s", bp.ParentHash.Hex())
		}
		parentBP := &BlockParams{
			Hash:       parentBlock.Hash,
			Number:     &parentBlock.Number,
			ParentHash: parentBlock.ParentHash,
			Timestamp:  parentBlock.Timestamp,
		}
		lf.addBlock(ctx, parentBP, parentBlock, false)
		return struct{}{}, nil
	}, func(err error) {
		lib.ExtractorError("getBlock failed for parent", "error", err)
	})
}

// sortAndProcessLogs sorts logs by index and stores them, then processes the chain.
func (lf *LogFilter2) sortAndProcessLogs(blockHash common.Hash, logs []formatters.Log) {
	sort.Slice(logs, func(i, j int) bool {
		li := 0
		lj := 0
		if logs[i].LogIndex != nil {
			li = *logs[i].LogIndex
		}
		if logs[j].LogIndex != nil {
			lj = *logs[j].LogIndex
		}
		return li < lj
	})

	lf.mu.Lock()
	lf.logHashMap[blockHash] = logs
	lf.mu.Unlock()

	lf.processNewLogs()
}

// processNewLogs builds the canonical chain from goal back to last processed,
// detects reorgs, and dispatches logs to registered filters.
func (lf *LogFilter2) processNewLogs() {
	lf.mu.Lock()
	defer lf.mu.Unlock()

	if lf.cancelWatch == nil {
		return
	}

	// Walk up from goal to find the fork point
	var upLine []*BlockParams
	cornerBlock := lf.nextGoalBlock
	for {
		if cornerBlock == nil {
			if lf.lastProcessedBlock != nil {
				return
			}
			break
		}
		if _, processed := lf.processedBlockHash[cornerBlock.Hash]; processed {
			break
		}
		upLine = append(upLine, cornerBlock)
		parent, ok := lf.blockHashMap[cornerBlock.ParentHash]
		if !ok {
			cornerBlock = nil
		} else {
			cornerBlock = parent
		}
	}

	// Walk down from last processed to the corner
	var downLine []*BlockParams
	if cornerBlock != nil {
		b := lf.lastProcessedBlock
		for {
			if b == nil {
				return
			}
			if b.Hash == cornerBlock.Hash {
				break
			}
			downLine = append(downLine, b)
			parent, ok := lf.blockHashMap[b.ParentHash]
			if !ok {
				b = nil
			} else {
				b = parent
			}
		}
	}

	// Build combined log list: reversed down logs (marked removed) + up logs
	var logs []formatters.Log

	for i := 0; i < len(downLine); i++ {
		l, ok := lf.logHashMap[downLine[i].Hash]
		if !ok {
			lib.ExtractorError("Unexpected Error in LogFilter: missing logs for down block")
			go lf.Restart()
			return
		}
		// Reverse and mark removed
		for j := len(l) - 1; j >= 0; j-- {
			entry := l[j]
			entry.Removed = true
			logs = append(logs, entry)
		}
		delete(lf.processedBlockHash, downLine[i].Hash)
	}
	lf.lastProcessedBlock = cornerBlock

	// Walk up (newest at end)
	for i := len(upLine) - 1; i >= 0; i-- {
		l, ok := lf.logHashMap[upLine[i].Hash]
		if !ok {
			break // logs not yet available
		}
		for j := range l {
			l[j].Removed = false
		}
		logs = append(logs, l...)
		lf.processedBlockHash[upLine[i].Hash] = struct{}{}
		lf.lastProcessedBlock = upLine[i]
	}

	// Dispatch to registered filters
	for _, f := range lf.filters {
		topicSet := make(map[string]struct{}, len(f.Topics))
		for _, t := range f.Topics {
			topicSet[t] = struct{}{}
		}
		var filtered []formatters.Log
		for _, l := range logs {
			if len(l.Topics) > 0 {
				if _, ok := topicSet[l.Topics[0]]; ok {
					filtered = append(filtered, l)
				}
			}
		}
		if len(filtered) > 0 {
			f.OnNewLogs(filtered)
		}
	}
}

// ConsoleLog logs a message with the chain ID prefix.
func (lf *LogFilter2) ConsoleLog(msg string) {
	chainID := int64(0)
	if lf.client.Chain() != nil {
		chainID = lf.client.Chain().ID
	}
	lib.ExtractorInfo(fmt.Sprintf("LogFilter-%d: %s", chainID, msg))
}

// GetBlockTimestamp returns the timestamp of a block by its hash.
func (lf *LogFilter2) GetBlockTimestamp(blockHash common.Hash) (uint64, bool) {
	lf.mu.Lock()
	defer lf.mu.Unlock()
	if bp, ok := lf.blockHashMap[blockHash]; ok {
		return bp.Timestamp, true
	}
	return 0, false
}

// decodeSyncEvent decodes a Sync event log into (reserve0, reserve1).
func DecodeSyncEvent(log formatters.Log) (*big.Int, *big.Int, error) {
	if len(log.Topics) == 0 {
		return nil, nil, fmt.Errorf("no topics in log")
	}
	// Sync event: data contains two uint112 values packed into 64 bytes
	data := common.FromHex(log.Data)
	if len(data) < 64 {
		return nil, nil, fmt.Errorf("data too short for Sync event: %d bytes", len(data))
	}
	reserve0 := new(big.Int).SetBytes(data[0:32])
	reserve1 := new(big.Int).SetBytes(data[32:64])
	return reserve0, reserve1, nil
}
