package memo

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func TestConcurrentCallersShareOneLoad(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	value := New(func(context.Context, int, bool) (int, error) {
		calls.Add(1)
		<-release
		return 42, nil
	}, Options{TTL: time.Hour})
	var wg sync.WaitGroup
	results := make([]int, 20)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], _ = value.Get(context.Background())
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("loads=%d, want 1", calls.Load())
	}
	for _, result := range results {
		if result != 42 {
			t.Fatalf("results=%v", results)
		}
	}
}

func TestCancelledCallerDoesNotCancelTheLoad(t *testing.T) {
	release := make(chan struct{})
	var sawCancellation atomic.Bool
	value := New(func(ctx context.Context, _ int, _ bool) (int, error) {
		<-release
		sawCancellation.Store(ctx.Err() != nil)
		return 7, nil
	}, Options{TTL: time.Hour})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := value.Get(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Get(cancelled)=%v", err)
	}
	close(release)
	got, err := value.Get(context.Background())
	if err != nil || got != 7 {
		t.Fatalf("Get()=%d,%v", got, err)
	}
	if sawCancellation.Load() {
		t.Fatal("the load saw the caller's cancellation")
	}
}

func TestExpiredValueIsServedWhileRefreshingAndKeptOnError(t *testing.T) {
	now := &clock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	var calls atomic.Int32
	fail := atomic.Bool{}
	value := New(func(context.Context, int, bool) (int, error) {
		call := calls.Add(1)
		if fail.Load() {
			return 0, errors.New("source down")
		}
		return int(call), nil
	}, Options{TTL: time.Minute, RetryAfter: 10 * time.Second, Now: now.Now})
	if got, err := value.Get(context.Background()); err != nil || got != 1 {
		t.Fatalf("first=%d,%v", got, err)
	}
	fail.Store(true)
	now.advance(2 * time.Minute)
	if got, err := value.Get(context.Background()); err != nil || got != 1 {
		t.Fatalf("expired=%d,%v; want the stale value", got, err)
	}
	waitFor(t, func() bool { return calls.Load() == 2 && value.state.Load().err != nil })
	// The failed refresh keeps the old value and is not retried before RetryAfter.
	if got, err := value.Get(context.Background()); err != nil || got != 1 {
		t.Fatalf("after failure=%d,%v", got, err)
	}
	time.Sleep(10 * time.Millisecond)
	if calls.Load() != 2 {
		t.Fatalf("retried too early: loads=%d", calls.Load())
	}
	fail.Store(false)
	now.advance(11 * time.Second)
	_, _ = value.Get(context.Background())
	waitFor(t, func() bool { got, _ := value.Get(context.Background()); return got == 3 })
}

func TestFirstLoadFailureIsReturnedAndThrottled(t *testing.T) {
	now := &clock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	var calls atomic.Int32
	value := New(func(context.Context, int, bool) (int, error) {
		calls.Add(1)
		return 0, errors.New("source down")
	}, Options{TTL: time.Minute, RetryAfter: time.Minute, Now: now.Now})
	for range 3 {
		if _, err := value.Get(context.Background()); err == nil {
			t.Fatal("expected the load error")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("loads=%d, want 1 within RetryAfter", calls.Load())
	}
}

func TestPanickingLoadBecomesAnError(t *testing.T) {
	value := New(func(context.Context, int, bool) (int, error) { panic("boom") }, Options{})
	if _, err := value.Get(context.Background()); err == nil {
		t.Fatal("expected an error from a panicking load")
	}
}

func TestLoadReceivesThePreviousValue(t *testing.T) {
	now := &clock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	var seen []bool
	var mu sync.Mutex
	value := New(func(_ context.Context, previous int, ok bool) (int, error) {
		mu.Lock()
		seen = append(seen, ok)
		mu.Unlock()
		return previous + 1, nil
	}, Options{TTL: time.Minute, Now: now.Now})
	if err := value.Warm(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := value.Warm(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _ := value.Get(context.Background())
	mu.Lock()
	defer mu.Unlock()
	if got != 2 || len(seen) != 2 || seen[0] || !seen[1] {
		t.Fatalf("value=%d seen=%v", got, seen)
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestStatsCountHitsMissesAndLoads(t *testing.T) {
	fail := true
	value := New(func(context.Context, int, bool) (int, error) {
		if fail {
			return 0, errors.New("source down")
		}
		return 7, nil
	}, Options{TTL: time.Hour, RetryAfter: time.Nanosecond})
	if _, err := value.Get(context.Background()); err == nil {
		t.Fatal("first load should fail")
	}
	time.Sleep(time.Millisecond)
	fail = false
	for range 3 {
		if got, err := value.Get(context.Background()); err != nil || got != 7 {
			t.Fatalf("Get=%d,%v", got, err)
		}
	}
	stats := value.Stats()
	if stats != (Stats{Hits: 2, Misses: 2, Loads: 1, Failures: 1}) {
		t.Fatalf("stats=%+v", stats)
	}
}

// TestConcurrentGetsAcrossExpiryShareLoadsAndNeverReturnZero hammers Get while the clock
// crosses the TTL and the loader alternates between success and failure (run under -race): at
// most one load runs at a time, every caller gets a loaded value, and a failure keeps the last
// good one.
func TestConcurrentGetsAcrossExpiryShareLoadsAndNeverReturnZero(t *testing.T) {
	now := &clock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	var calls, inflight, maxInflight atomic.Int32
	value := New(func(context.Context, int, bool) (int, error) {
		running := inflight.Add(1)
		defer inflight.Add(-1)
		for {
			seen := maxInflight.Load()
			if running <= seen || maxInflight.CompareAndSwap(seen, running) {
				break
			}
		}
		time.Sleep(time.Millisecond)
		call := calls.Add(1)
		if call%2 == 0 {
			return 0, errors.New("source down")
		}
		return int(call), nil
	}, Options{TTL: time.Minute, RetryAfter: time.Second, Now: now.Now})
	if _, err := value.Get(context.Background()); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var zeros atomic.Int32
	for worker := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 200 {
				if worker == 0 && i%20 == 0 {
					now.advance(2 * time.Minute)
				}
				got, err := value.Get(context.Background())
				if err != nil || got == 0 {
					zeros.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	if zeros.Load() != 0 {
		t.Fatalf("%d calls returned no value although one was loaded", zeros.Load())
	}
	if maxInflight.Load() != 1 {
		t.Fatalf("loads ran %d at a time, want 1", maxInflight.Load())
	}
	// Background refreshes finish on their own schedule: drive the clock past the TTL and wait for
	// each load, so the counters below do not depend on how the goroutines above interleaved.
	for attempt := 0; attempt < 20 && (value.Stats().Failures == 0 || value.Stats().Loads < 2); attempt++ {
		now.advance(2 * time.Minute)
		if _, err := value.Get(context.Background()); err != nil {
			t.Fatal(err)
		}
		_ = value.Warm(context.Background())
	}
	if value.Stats().Failures == 0 || value.Stats().Loads < 2 {
		t.Fatalf("stats=%+v, want refreshes and failures", value.Stats())
	}
}

// TestParentContextCancelsLoads: cancelling Options.Context (process shutdown) ends a load in
// progress, so the connection it holds returns instead of outliving the server.
func TestParentContextCancelsLoads(t *testing.T) {
	parent, stop := context.WithCancel(context.Background())
	started := make(chan struct{})
	value := New(func(ctx context.Context, _ int, _ bool) (int, error) {
		close(started)
		<-ctx.Done()
		return 0, ctx.Err()
	}, Options{TTL: time.Hour, Timeout: time.Minute, Context: parent})
	done := make(chan error, 1)
	go func() {
		_, err := value.Get(context.Background())
		done <- err
	}()
	<-started
	stop()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Get()=%v, want the cancelled load's error", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the load did not end when the parent context was cancelled")
	}
}
