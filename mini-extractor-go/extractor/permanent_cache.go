package extractor

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/ChefBingbong/mini-extractor-go/lib"
)

// PermanentCache is a JSONL-based append-only file cache with in-memory deduplication.
type PermanentCache[T any] struct {
	filePath     string
	mu           sync.Mutex
	knownEntries map[string]struct{}
}

// NewPermanentCache creates a new PermanentCache at the given path components.
func NewPermanentCache[T any](paths ...string) *PermanentCache[T] {
	fp := ""
	if len(paths) > 0 && paths[0] != "" {
		fp = filepath.Join(paths...)
	}
	return &PermanentCache[T]{
		filePath:     fp,
		knownEntries: make(map[string]struct{}),
	}
}

// GetAllRecords reads all records from the cache file.
func (c *PermanentCache[T]) GetAllRecords() ([]T, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.filePath == "" {
		return nil, nil
	}

	file, err := os.Open(c.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer file.Close()

	var records []T
	scanner := bufio.NewScanner(file)
	// Increase max token size for large lines
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var record T
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			return nil, err
		}
		records = append(records, record)
		c.knownEntries[line] = struct{}{}
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return records, nil
}

// Add appends a record to the cache file if it hasn't been seen before.
func (c *PermanentCache[T]) Add(record T) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.filePath == "" {
		return
	}

	data, err := json.Marshal(record)
	if err != nil {
		lib.Error("Error marshaling cache record", "error", err)
		return
	}

	line := string(data)
	if _, exists := c.knownEntries[line]; exists {
		return
	}
	c.knownEntries[line] = struct{}{}

	// Ensure directory exists
	dir := filepath.Dir(c.filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		lib.Error("Error creating cache directory", "error", err)
		return
	}

	f, err := os.OpenFile(c.filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		lib.Error("Error opening cache file", "error", err)
		return
	}
	defer f.Close()

	if _, err := f.WriteString(line + "\n"); err != nil {
		lib.Error("Error writing cache record", "error", err)
	}
}
