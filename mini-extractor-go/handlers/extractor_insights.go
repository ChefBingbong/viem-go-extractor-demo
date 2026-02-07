package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/ChefBingbong/mini-extractor-go/extractor"
)

// ExtractorInsightsHandler returns an HTTP handler for /extractor-insights.
func ExtractorInsightsHandler(ext *extractor.Extractor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pools := ext.GetPools()

		// Convert pools to JSON-safe form (bigints as strings)
		poolsJSON := make([]extractor.PoolStateJSON, len(pools))
		for i, p := range pools {
			poolsJSON[i] = p.ToJSON()
		}

		var blockNumber any
		if bp := ext.LogFilter.LastProcessedBlock(); bp != nil {
			blockNumber = bp.Number
		}

		resp := map[string]any{
			"blockNumber": blockNumber,
			"totalPools":  len(pools),
			"syncing":     ext.IsSyncing(),
			"pools":       poolsJSON,
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

// HealthHandler returns an HTTP handler for /health.
func HealthHandler(ext *extractor.Extractor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !ext.IsStarted() {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte("not ready"))
			return
		}

		resp := map[string]any{
			"status":  "ok",
			"pools":   len(ext.GetPools()),
			"syncing": ext.IsSyncing(),
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}
