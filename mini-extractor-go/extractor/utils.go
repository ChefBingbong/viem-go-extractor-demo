package extractor

import (
	"time"

	"github.com/ChefBingbong/mini-extractor-go/lib"
)

// Delay sleeps for the given duration.
func Delay(ms int) {
	time.Sleep(time.Duration(ms) * time.Millisecond)
}

// RepeatAsync retries an async action up to `times` with a delay between attempts.
// On final failure it calls the `failed` callback.
func RepeatAsync[T any](times int, delayBetween int, action func() (T, error), failed func(error)) (T, bool) {
	var lastErr error
	for i := 0; i < times; i++ {
		result, err := action()
		if err == nil {
			if i > 0 {
				lib.Info("retry succeeded", "attempt", i+1)
			}
			return result, true
		}
		lastErr = err
		if delayBetween > 0 {
			Delay(delayBetween)
		}
	}
	failed(lastErr)
	var zero T
	return zero, false
}

// Repeat retries an action up to `times`, returning the result on success.
// On the final attempt, any error is returned.
func Repeat[T any](times int, action func() (T, error)) (T, error) {
	for i := 0; i < times-1; i++ {
		result, err := action()
		if err == nil {
			return result, nil
		}
	}
	return action()
}
