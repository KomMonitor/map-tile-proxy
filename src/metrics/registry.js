import client from 'prom-client';

export function createMetrics() {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register });

  const upstreamRequestDuration = new client.Histogram({
    name: 'tile_proxy_upstream_request_duration_seconds',
    help: 'Latency of upstream tile requests in seconds, labeled by service_id',
    labelNames: ['service_id'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  const requestsTotal = new client.Counter({
    name: 'tile_proxy_requests_total',
    help: 'Total number of tile requests handled, labeled by service_id and status_code',
    labelNames: ['service_id', 'status_code'],
    registers: [register],
  });

  const bytesStreamedTotal = new client.Counter({
    name: 'tile_proxy_bytes_streamed_total',
    help: 'Total bytes streamed to clients from upstream tile responses, labeled by service_id',
    labelNames: ['service_id'],
    registers: [register],
  });

  return { register, upstreamRequestDuration, requestsTotal, bytesStreamedTotal };
}
