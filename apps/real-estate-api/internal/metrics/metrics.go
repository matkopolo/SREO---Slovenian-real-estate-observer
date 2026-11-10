// Package metrics is a small Prometheus registry: counters, gauges and histograms with labels,
// plus collectors that read a value when scraped (connection-pool and cache statistics). It
// writes the Prometheus text exposition format (version 0.0.4), which every Prometheus-compatible
// scraper reads. It covers only what this API exports, so the module needs no client library.
package metrics

import (
	"bufio"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// Kind is a Prometheus metric type.
type Kind string

const (
	Counter Kind = "counter"
	Gauge   Kind = "gauge"
)

// Registry holds the metrics and serves them. The zero value is not usable: use NewRegistry.
type Registry struct {
	mu       sync.Mutex
	families []family
	names    map[string]bool
}

type family interface {
	write(*bufio.Writer)
}

func NewRegistry() *Registry {
	return &Registry{names: map[string]bool{}}
}

func (r *Registry) register(name string, metric family) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.names[name] {
		panic("metrics: duplicate metric " + name)
	}
	r.names[name] = true
	r.families = append(r.families, metric)
}

// ServeHTTP writes every metric in the text exposition format.
func (r *Registry) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	r.mu.Lock()
	families := slices.Clone(r.families)
	r.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	buffer := bufio.NewWriter(w)
	for _, metric := range families {
		metric.write(buffer)
	}
	_ = buffer.Flush()
}

// series is the per-label-set state shared by vectors.
type series[T any] struct {
	mu     sync.RWMutex
	values map[string]*T // key: label values joined by \xff
	labels map[string][]string
}

func newSeries[T any]() series[T] {
	return series[T]{values: map[string]*T{}, labels: map[string][]string{}}
}

func (s *series[T]) get(labelValues []string, make func() *T) *T {
	key := strings.Join(labelValues, "\xff")
	s.mu.RLock()
	value, ok := s.values[key]
	s.mu.RUnlock()
	if ok {
		return value
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if value, ok = s.values[key]; ok {
		return value
	}
	value = make()
	s.values[key] = value
	s.labels[key] = slices.Clone(labelValues)
	return value
}

// sorted returns the label sets in a stable order.
func (s *series[T]) sorted() (keys []string, labels map[string][]string, values map[string]*T) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	labels = make(map[string][]string, len(s.labels))
	values = make(map[string]*T, len(s.values))
	for key := range s.values {
		keys = append(keys, key)
		labels[key] = s.labels[key]
		values[key] = s.values[key]
	}
	slices.Sort(keys)
	return keys, labels, values
}

// atomicFloat is a float64 updated without locks.
type atomicFloat struct{ bits atomic.Uint64 }

func (f *atomicFloat) add(delta float64) {
	for {
		old := f.bits.Load()
		if f.bits.CompareAndSwap(old, math.Float64bits(math.Float64frombits(old)+delta)) {
			return
		}
	}
}

func (f *atomicFloat) load() float64 { return math.Float64frombits(f.bits.Load()) }

// CounterVec is a counter per label set.
type CounterVec struct {
	name, help string
	labelNames []string
	series     series[atomicFloat]
}

// NewCounterVec registers a counter with the given label names.
func (r *Registry) NewCounterVec(name, help string, labelNames ...string) *CounterVec {
	counter := &CounterVec{name: name, help: help, labelNames: labelNames, series: newSeries[atomicFloat]()}
	r.register(name, counter)
	return counter
}

// Add increases the counter of the label values (in label-name order) by delta (>= 0).
func (c *CounterVec) Add(delta float64, labelValues ...string) {
	c.series.get(checkLabels(c.name, c.labelNames, labelValues), func() *atomicFloat { return &atomicFloat{} }).add(delta)
}

// Inc increases the counter of the label values by one.
func (c *CounterVec) Inc(labelValues ...string) { c.Add(1, labelValues...) }

func (c *CounterVec) write(w *bufio.Writer) {
	writeHeader(w, c.name, c.help, Counter)
	keys, labels, values := c.series.sorted()
	for _, key := range keys {
		writeSample(w, c.name, c.labelNames, labels[key], "", "", values[key].load())
	}
}

// GaugeValue is a single gauge without labels.
type GaugeValue struct {
	name, help string
	value      atomicFloat
}

// NewGauge registers a gauge without labels.
func (r *Registry) NewGauge(name, help string) *GaugeValue {
	gauge := &GaugeValue{name: name, help: help}
	r.register(name, gauge)
	return gauge
}

// Add changes the gauge by delta (which may be negative).
func (g *GaugeValue) Add(delta float64) { g.value.add(delta) }

func (g *GaugeValue) write(w *bufio.Writer) {
	writeHeader(w, g.name, g.help, Gauge)
	writeSample(w, g.name, nil, nil, "", "", g.value.load())
}

// HistogramVec is a histogram per label set.
type HistogramVec struct {
	name, help string
	labelNames []string
	buckets    []float64
	series     series[histogram]
}

type histogram struct {
	counts []atomic.Uint64 // one per bucket upper bound, not cumulative
	count  atomic.Uint64
	sum    atomicFloat
}

// DefaultDurationBuckets suit HTTP handlers that answer in milliseconds to tens of seconds.
var DefaultDurationBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30}

// NewHistogramVec registers a histogram with ascending bucket upper bounds.
func (r *Registry) NewHistogramVec(name, help string, buckets []float64, labelNames ...string) *HistogramVec {
	if !slices.IsSorted(buckets) {
		panic("metrics: histogram buckets must ascend")
	}
	histogram := &HistogramVec{name: name, help: help, labelNames: labelNames, buckets: slices.Clone(buckets), series: newSeries[histogram]()}
	r.register(name, histogram)
	return histogram
}

// Observe records value for the label values.
func (h *HistogramVec) Observe(value float64, labelValues ...string) {
	state := h.series.get(checkLabels(h.name, h.labelNames, labelValues), func() *histogram {
		return &histogram{counts: make([]atomic.Uint64, len(h.buckets))}
	})
	if index, _ := slices.BinarySearch(h.buckets, value); index < len(h.buckets) {
		state.counts[index].Add(1)
	}
	state.count.Add(1)
	state.sum.add(value)
}

func (h *HistogramVec) write(w *bufio.Writer) {
	writeHeader(w, h.name, h.help, "histogram")
	keys, labels, values := h.series.sorted()
	for _, key := range keys {
		state := values[key]
		var cumulative uint64
		for index, bound := range h.buckets {
			cumulative += state.counts[index].Load()
			writeSample(w, h.name+"_bucket", h.labelNames, labels[key], "le", formatFloat(bound), float64(cumulative))
		}
		count := state.count.Load()
		writeSample(w, h.name+"_bucket", h.labelNames, labels[key], "le", "+Inf", float64(count))
		writeSample(w, h.name+"_sum", h.labelNames, labels[key], "", "", state.sum.load())
		writeSample(w, h.name+"_count", h.labelNames, labels[key], "", "", float64(count))
	}
}

// Sample is one value read by a collector, with its label values in label-name order.
type Sample struct {
	LabelValues []string
	Value       float64
}

type funcFamily struct {
	name, help string
	kind       Kind
	labelNames []string
	collect    func() []Sample
}

// NewFunc registers a counter or gauge whose samples collect reads at scrape time; use it for
// values another component already counts (pool statistics, cache counters).
func (r *Registry) NewFunc(name, help string, kind Kind, labelNames []string, collect func() []Sample) {
	r.register(name, &funcFamily{name: name, help: help, kind: kind, labelNames: labelNames, collect: collect})
}

func (f *funcFamily) write(w *bufio.Writer) {
	writeHeader(w, f.name, f.help, f.kind)
	for _, sample := range f.collect() {
		writeSample(w, f.name, f.labelNames, checkLabels(f.name, f.labelNames, sample.LabelValues), "", "", sample.Value)
	}
}

func checkLabels(name string, names, values []string) []string {
	if len(names) != len(values) {
		panic(fmt.Sprintf("metrics: %s wants %d label values, got %d", name, len(names), len(values)))
	}
	return values
}

func writeHeader(w *bufio.Writer, name, help string, kind Kind) {
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", name, strings.NewReplacer(`\`, `\\`, "\n", `\n`).Replace(help), name, kind)
}

var labelEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)

// writeSample writes one line; extraName/extraValue add a trailing label such as le.
func writeSample(w *bufio.Writer, name string, labelNames, labelValues []string, extraName, extraValue string, value float64) {
	w.WriteString(name)
	if len(labelNames) > 0 || extraName != "" {
		w.WriteByte('{')
		for index, label := range labelNames {
			if index > 0 {
				w.WriteByte(',')
			}
			fmt.Fprintf(w, `%s="%s"`, label, labelEscaper.Replace(labelValues[index]))
		}
		if extraName != "" {
			if len(labelNames) > 0 {
				w.WriteByte(',')
			}
			fmt.Fprintf(w, `%s="%s"`, extraName, extraValue)
		}
		w.WriteByte('}')
	}
	w.WriteByte(' ')
	w.WriteString(formatFloat(value))
	w.WriteByte('\n')
}

func formatFloat(value float64) string {
	switch {
	case math.IsInf(value, 1):
		return "+Inf"
	case math.IsInf(value, -1):
		return "-Inf"
	case math.IsNaN(value):
		return "NaN"
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}
