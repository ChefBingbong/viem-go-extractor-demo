package extractor

import (
	"github.com/ethereum/go-ethereum/common"
	"golang.org/x/crypto/sha3"
)

// SyncEventTopic is the keccak256 hash of "Sync(uint112,uint112)".
var SyncEventTopic common.Hash

func init() {
	h := sha3.NewLegacyKeccak256()
	h.Write([]byte("Sync(uint112,uint112)"))
	copy(SyncEventTopic[:], h.Sum(nil))
}
