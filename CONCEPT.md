# map-tile-proxy — Technical Concept

## 1. Purpose and scope

`map-tile-proxy` is a small Fastify service with exactly one job: sit between a browser-based
map client (Leaflet, MapLibre, etc.) and one or more third-party XYZ raster tile providers, so
that the provider's API key/token never appears in client-side code, network tabs, or logs
outside this service.

Route pattern:

```
GET /proxy/raster/{serviceId}/{z}/{x}/{y}.{ext}     ext ∈ {png, jpg, jpeg}
```

`{serviceId}` is looked up in the server's own configuration (`config.json`); it never contains
a raw upstream URL. This is the single most important security property of the design: **the
set of reachable upstream hosts is fixed at process start by the operator, not influenced by
any request input.**

## 2. Request lifecycle / stream pipeline design

```
client ──GET /proxy/raster/:serviceId/:z/:x/:y.:ext──▶ Fastify route handler
                                                              │
                                              1. look up serviceId in config
                                              2. validate z/x/y are integers, ext is allowed
                                              3. build upstream URL (template + key injection)
                                              4. build a minimal, explicit header set
                                                              │
                                                undici.request() over a pooled Agent
                                                              │
                                          upstream tile provider (PNG/JPEG over HTTPS)
                                                              │
                                     undici streaming response body (Node Readable)
                                                              │
                                 byte-counting PassThrough (for the bandwidth metric)
                                                              │
                                         reply.send(stream) → Fastify → client socket
```

No tile is ever buffered into a `Buffer` in application code and no tile touches disk. The
upstream response body is a Node `Readable` the moment `undici.request()` resolves; it is piped
through a small `PassThrough` (purely to count bytes for the `tile_proxy_bytes_streamed_total`
metric) and handed directly to `reply.send()`. Fastify pipes a `Readable` reply payload to the
HTTP response using the same pump/pipeline semantics as `stream.pipeline` — errors on either side
tear down both ends of the pipe instead of leaking a socket or a dangling stream.

Memory/RAM footprint per in-flight tile request is therefore O(chunk size), not O(tile size).

### Why raw `undici.request()` instead of `@fastify/reply-from`

`@fastify/reply-from` is a good fit when you want Fastify to reverse-proxy *all* of a request
(method, body, most headers) to a single, mostly-static upstream. Here we need something
narrower and stricter:

- **Per-service URL templating and key injection** (`{z}/{x}/{y}` substitution, then appending
  an API key as a query parameter *or* as custom headers) is easiest to reason about — and to
  unit test — as an explicit small function (`buildUpstreamUrl`, `buildUpstreamHeaders`) rather
  than a header-rewrite callback bolted onto a generic proxy.
- **Header sanitization must be allow-list, not rewrite-based** (see §4) — we build the upstream
  request's headers from scratch rather than starting from the client's headers and stripping.
- **Testability**: the test suite intercepts upstream calls with `undici`'s `MockAgent`, which
  works by being installed as the process-wide dispatcher. Calling `undici.request()` directly
  (no explicit `dispatcher` option) means it automatically honors whatever dispatcher is
  currently installed — a pooled `Agent` in production (`src/index.js`), a `MockAgent` in tests
  (`tests/helpers/testApp.js`) — with zero test-only branches in the production code path.

## 3. Connection pooling / Keep-Alive

`src/index.js` installs a single process-wide `undici.Agent` as the **global dispatcher** before
the server starts accepting traffic:

```js
setGlobalDispatcher(new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 128 }));
```

Every `undici.request()` call in `src/proxy/tileClient.js` goes through this Agent. `undici`
pools TCP/TLS connections per origin automatically, so rapid map panning (many tile requests to
the same tile provider host in a short window) reuses warm, already-negotiated TLS connections
instead of paying a full handshake per tile.

## 4. Header sanitization (both directions)

**Request direction (client → upstream):** the proxy never forwards the client's own request
headers upstream. `buildUpstreamHeaders()` constructs a brand-new header object containing only
`accept`, a fixed `user-agent`, and whatever headers the *service definition* in `config.json`
specifies (e.g. `Authorization: Bearer ...`, `X-Api-Key: ...`). This is an allow-list by
construction — there is no `Cookie`, `Authorization`, or `Host` header from the inbound request
that could ever leak to a third party, because nothing from the inbound request is copied in the
first place.

**Response direction (upstream → client):** `forwardSafeResponseHeaders()` copies only a fixed
allow-list of response headers back to the client: `content-type`, `content-length`,
`cache-control`, `etag`, `last-modified`, `expires`, `content-encoding`. Everything else —
including any `Set-Cookie` the upstream provider might send — is dropped.

## 5. SSRF mitigation (`src/security/ssrf.js`)

Because `{serviceId}` maps to a fixed, operator-configured URL template rather than an
arbitrary user-supplied URL, the primary SSRF surface is **configuration-time**, not
per-request: an operator (or an attacker who can influence `config.json`) could point a service
at an internal address. `assertUpstreamHostAllowed()` runs once per service, at config-load time
(`buildRuntimeConfig()` in `src/config.js`), and the process **refuses to start** if any check
fails:

1. **Scheme allow-list**: only `http:`/`https:` upstream URLs are accepted.
2. **Literal denylist**: `localhost`, `metadata.google.internal`, `metadata`, `instance-data`.
3. **Optional explicit domain allow-list** (`allowedUpstreamHosts` / `ALLOWED_UPSTREAM_HOSTS`,
   wildcard subdomains supported, e.g. `*.example-provider.com`). When set, only matching hosts
   are permitted at all.
4. **DNS resolution + IP range check**: the hostname is resolved (`dns.lookup(..., {all:true})`)
   and *every* returned address is checked against a denylist of loopback (`127.0.0.0/8`, `::1`),
   private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local/cloud-metadata
   (`169.254.0.0/16`, `fe80::/10` — this range covers the `169.254.169.254` metadata endpoint
   used by AWS/GCP/Azure), unique-local IPv6 (`fc00::/7`), and unspecified (`0.0.0.0`, `::`)
   ranges. Literal IP addresses in the config are checked directly without a DNS step.

At request time, `z`/`x`/`y` path parameters are validated against `^\d+$` and the extension
against the service's `allowedExtensions` allow-list before they are interpolated into the
upstream URL template, so no per-request input can smuggle a different host, scheme, or path
into the upstream call.

**Known residual risk (documented, not silently ignored):** this design validates DNS at
config-load time, not on every connection, so it does not defend against DNS rebinding attacks
where an upstream hostname's DNS record changes *after* startup to point at an internal address.
Given that upstream hosts are operator-configured (not attacker-supplied per request), this is an
acceptable trade-off for a lightweight proxy; a future hardening step would be a custom `connect`
function on the production `Agent` that re-validates the resolved IP on every new TCP connection.

## 6. Resilience: timeouts and fallback tiles

Every upstream request carries an `AbortController` wired to a per-service `timeoutMs` (default
5000 ms, configurable globally via `requestTimeoutMs`/`REQUEST_TIMEOUT_MS` and per-service via
`timeoutMs`). If the upstream socket doesn't respond in time, the controller aborts the request.

When a service has `fallbackOnError: true` (the default) and the upstream call returns a
non-2xx status, throws, or times out, the proxy responds `200 OK` with a hardcoded, in-memory
1×1 fully-transparent PNG (`src/proxy/fallbackTile.js`) and a `Cache-Control: no-store` header (so
browsers don't cache what may be a transient failure) plus a diagnostic
`X-Tile-Proxy-Fallback: 1` header. This keeps map canvases free of broken-image icons during
provider outages or rate-limiting. Setting `fallbackOnError: false` on a service instead
propagates the upstream status code (or `502` for a network-level failure) to the client.

## 7. Client-side caching pass-through

Because the proxy itself never caches (§1 — RAM/disk footprint stays flat regardless of traffic),
client-side (browser) caching is the only caching layer, and it is enabled by forwarding
`Cache-Control`, `ETag`, and `Last-Modified` unchanged from the upstream response (§4).

## 8. CORS / origin restriction

`ALLOWED_ORIGINS` (env var, comma-separated, wildcard segments allowed — e.g.
`https://*.kommonitor.de,http://localhost:*`) or `config.json`'s `allowedOrigins` array define
which browser `Origin` values may use the proxy. This is enforced twice, deliberately:

- `@fastify/cors` is configured with a custom `origin` callback that reflects
  `Access-Control-Allow-Origin` only for allowed origins, so genuine cross-origin `fetch()`-based
  map clients get correct CORS headers and preflight (`OPTIONS`) handling.
- A dedicated `onRequest` hook explicitly returns **`403 Forbidden`** for any request carrying a
  disallowed `Origin` header. This matters because `@fastify/cors` alone only *omits* CORS
  headers for a disallowed origin — the server would still process and return the response, and
  only the browser's own same-origin policy would block script access to it. The explicit hook
  gives a hard server-side reject, as required.

Requests with **no** `Origin` header (typical for `<img src="...">` tile loads, which are not
subject to CORS at all) are always allowed through — CORS is a browser-enforced, `fetch`/`XHR`
concept, not a general request-authentication mechanism, so an explicit domain allow-list only
makes sense when an `Origin` is actually present.

## 9. Observability

- `GET /healthz` → `200 { "status": "ok" }`, used by the Docker `HEALTHCHECK` and orchestrators.
- `GET /metrics` → Prometheus exposition format via `prom-client`:
  - `tile_proxy_upstream_request_duration_seconds` (Histogram, label `service_id`) — wraps every
    upstream call from dispatch to response headers received (or failure).
  - `tile_proxy_requests_total` (Counter, labels `service_id`, `status_code`) — incremented once
    per request, `status_code` is the upstream's numeric status or the literal `"error"` for a
    network-level failure.
  - `tile_proxy_bytes_streamed_total` (Counter, label `service_id`) — incremented by the
    byte-counting `PassThrough` once the response stream ends, giving a true bandwidth figure
    without ever buffering a tile.
  - Default Node.js process metrics (`prom-client`'s `collectDefaultMetrics`) for baseline
    CPU/memory/event-loop visibility.

### Logging

Structured JSON logs via Fastify's Pino logger. Fastify's default "incoming request" / "request
completed" pair is disabled (`LogController`) because it would log every health check and scrape;
instead the tile route emits one line per tile with the outcome, upstream status, byte count and
duration, and the CORS hook warns on rejected origins. At `debug`, `tileClient.fetchTile` logs the
upstream URL it is about to call. Because that URL carries the API key, `src/logging.js#redactUrl`
masks the configured key parameter and any parameter whose name looks like a credential (so a key
embedded directly in `upstreamUrlTemplate` is covered too); header values are never logged, only
their names. `LOG_REVEAL_API_KEYS=true` is an explicit, startup-warned opt-out for troubleshooting.

Level resolution: `LOG_LEVEL` env, then `logLevel` in `config.json`, then `info`; empty env values
count as unset so docker-compose can always pass `LOG_LEVEL` through.

## 10. Configuration model

A single `config.json` (path via `CONFIG_PATH`, default `./config.json`) defines global defaults
and a `services` map keyed by `serviceId`. Every value can be overridden by an environment
variable (`PORT`, `ALLOWED_ORIGINS`, `ALLOWED_UPSTREAM_HOSTS`, `REQUEST_TIMEOUT_MS`,
`FALLBACK_ON_ERROR`, `LOG_LEVEL`, `LOG_REVEAL_API_KEYS`) so the same config file can be reused across environments with only env vars
changing — no secrets need to live in an env var *or* the config file exclusively; either works.
See `config.example.json` for the full shape and `README.md` for field-by-field documentation.

Config is loaded and validated (including the SSRF checks in §5) once at process start; an
invalid or unsafe config causes the process to exit non-zero rather than serve traffic with a
partially-broken configuration.
