// Package memo keeps the result of a slow load (an outbound call, a large query) in memory.
//
// One load runs at a time and its result is shared by every waiting caller. The load runs on
// its own context with its own timeout, so a cancelled request never cancels it. A fresh value
// is served without waiting; an expired one is still served while a single background load
// replaces it; and when a load fails, the last good value stays in use (stale on error) and
// the next attempt waits for RetryAfter, so a failing source is not called on every request.
package memo

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// Options configure a Value.
type Options struct {
	// TTL is how long a loaded value is fresh. After it, the value is refreshed in the background.
	TTL time.Duration
	// Timeout bounds one load.
	Timeout time.Duration
	// RetryAfter is the pause after a failed load before the next attempt.
	RetryAfter time.Duration
	// Now replaces time.Now in tests.
	Now func() time.Time
}

// LoadFunc loads a new value. previous is the current value (ok false before the first load),
// which lets a load keep it when nothing changed upstream.
type LoadFunc[T any] func(ctx context.Context, previous T, ok bool) (T, error)

// Value is a lazily loaded, shared, self-refreshing value. The zero value is not usable: use New.
type Value[T any] struct {
	load    LoadFunc[T]
	options Options

	state atomic.Pointer[state[T]]

	mu       sync.Mutex
	inflight chan struct{}
}

type state[T any] struct {
	value    T
	ok       bool
	loadedAt time.Time
	err      error
	failedAt time.Time
}

// New returns a Value that loads with load.
func New[T any](load LoadFunc[T], options Options) *Value[T] {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Timeout <= 0 {
		options.Timeout = time.Minute
	}
	if options.RetryAfter <= 0 {
		options.RetryAfter = 30 * time.Second
	}
	value := &Value[T]{load: load, options: options}
	value.state.Store(&state[T]{})
	return value
}

// Get returns the current value. Only the very first load (or a load after failures with no good
// value yet) makes the caller wait, and the caller stops waiting when ctx ends.
func (v *Value[T]) Get(ctx context.Context) (T, error) {
	current := v.state.Load()
	now := v.options.Now()
	if current.ok {
		if v.options.TTL > 0 && now.Sub(current.loadedAt) >= v.options.TTL && v.mayRetry(current, now) {
			v.start()
		}
		return current.value, nil
	}
	if current.err != nil && !v.mayRetry(current, now) {
		var zero T
		return zero, current.err
	}
	done := v.start()
	select {
	case <-done:
		current = v.state.Load()
		if current.ok {
			return current.value, nil
		}
		var zero T
		return zero, current.err
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	}
}

// Warm loads the value now (if no load is running) and waits for it, up to ctx.
func (v *Value[T]) Warm(ctx context.Context) error {
	select {
	case <-v.start():
		return v.state.Load().err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (v *Value[T]) mayRetry(current *state[T], now time.Time) bool {
	return current.err == nil || now.Sub(current.failedAt) >= v.options.RetryAfter
}

// start begins a load unless one is running, and returns a channel closed when it ends.
func (v *Value[T]) start() <-chan struct{} {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.inflight != nil {
		return v.inflight
	}
	done := make(chan struct{})
	v.inflight = done
	go func() {
		defer func() {
			v.mu.Lock()
			v.inflight = nil
			v.mu.Unlock()
			close(done)
		}()
		v.run()
	}()
	return done
}

func (v *Value[T]) run() {
	ctx, cancel := context.WithTimeout(context.Background(), v.options.Timeout)
	defer cancel()
	previous := v.state.Load()
	value, err := v.safeLoad(ctx, previous)
	now := v.options.Now()
	if err != nil {
		next := *previous // keep the last good value
		next.err, next.failedAt = err, now
		v.state.Store(&next)
		return
	}
	v.state.Store(&state[T]{value: value, ok: true, loadedAt: now})
}

// safeLoad turns a panicking load into an error: it runs on its own goroutine, where a panic
// would otherwise stop the whole process.
func (v *Value[T]) safeLoad(ctx context.Context, previous *state[T]) (value T, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("load panicked: %v", recovered)
		}
	}()
	return v.load(ctx, previous.value, previous.ok)
}
