package lib

import (
	"log/slog"
	"os"
)

// Logger provides structured logging for the extractor.
var Logger *slog.Logger

func init() {
	Logger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
}

// Info logs at info level.
func Info(msg string, args ...any) {
	Logger.Info(msg, args...)
}

// Error logs at error level.
func Error(msg string, args ...any) {
	Logger.Error(msg, args...)
}

// Warn logs at warn level.
func Warn(msg string, args ...any) {
	Logger.Warn(msg, args...)
}

// Debug logs at debug level.
func Debug(msg string, args ...any) {
	Logger.Debug(msg, args...)
}

// ExtractorInfo logs extractor info messages.
func ExtractorInfo(msg string, args ...any) {
	Logger.Info(msg, args...)
}

// ExtractorError logs extractor error messages.
func ExtractorError(msg string, args ...any) {
	Logger.Error(msg, args...)
}
