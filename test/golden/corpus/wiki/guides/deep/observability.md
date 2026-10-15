# Observability

## Tracing

Every inbound request starts a span; downstream calls propagate the `traceparent` header.

## Metrics

Latency histograms use exponential buckets from 1ms to 10s.

```yaml
metrics:
  histogram:
    buckets: exponential
    start_ms: 1
    factor: 2
```
