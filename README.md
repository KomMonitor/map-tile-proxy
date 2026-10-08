# map-tile-proxy

A lightweight HTTP proxy for XYZ raster map tiles that keeps upstream provider API keys server-side.
Built for the [KomMonitor](https://kommonitor.de) Data Infrastructure, but has no KomMonitor-specific
dependency and can be run standalone.

- Fastify + `undici` (pooled, keep-alive connections to upstream tile providers)
- Pure streaming — no tile is ever buffered fully in memory or written to disk
- Per-service API key injection (query parameter *or* request headers), configured once, never
  exposed to the browser
- SSRF-hardened: upstream hosts are validated (scheme, DNS-resolved IP ranges, optional explicit
  allow-list) at startup
- Prometheus metrics at `/metrics`, health check at `/healthz`
- Transparent 1×1 PNG fallback on upstream errors/timeouts so map canvases never show a broken
  image icon

See [`CONCEPT.md`](./CONCEPT.md) for the full architecture write-up and [`TESTING.md`](./TESTING.md)
for the test suite's mocking strategy.

## Quick start

```bash
npm install
cp config.example.json config.json   # then fill in your real upstream API keys
cp env.example .env                  # optional — or just export the same vars
npm start
```

The service listens on `PORT` (default `8080`). Try it:

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/proxy/raster/osm-bright/2/1/1.png -o tile.png
```

## Configuration

Configuration is a JSON file (`config.example.json` is a fully-worked example) loaded from the
path in `CONFIG_PATH` (default `./config.json`). Every top-level and per-service field can be
overridden by an environment variable, so the same `config.json` can be shipped across
environments with only env vars changing.

| `config.json` field | Env var override | Default | Meaning |
|---|---|---|---|
| `port` | `PORT` | `8080` | HTTP port to listen on |
| `requestTimeoutMs` | `REQUEST_TIMEOUT_MS` | `5000` | Default per-request upstream timeout (ms) |
| `fallbackOnError` | `FALLBACK_ON_ERROR` | `true` | Serve the transparent fallback tile on upstream failure |
| `logLevel` | `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. See [Logging](#logging) |
| `logRevealApiKeys` | `LOG_REVEAL_API_KEYS` | `false` | Print API keys unmasked in `debug` logs (troubleshooting only) |
| `allowedOrigins` | `ALLOWED_ORIGINS` | `[]` (deny all cross-origin) | Comma-separated (env) or array (JSON) list of allowed browser `Origin` values. Wildcards (`*`) allowed per segment, e.g. `https://*.kommonitor.de`, `http://localhost:*` |
| `allowedUpstreamHosts` | `ALLOWED_UPSTREAM_HOSTS` | unset (denylist-only) | Optional explicit allow-list of upstream hostnames (wildcards allowed, e.g. `*.example.com`). When set, only matching hosts may be configured as upstreams |

Each entry under `services` describes one upstream tile provider:

```jsonc
"my-service-id": {
  "upstreamUrlTemplate": "https://tiles.example.com/{z}/{x}/{y}.png", // required, must be http(s)
  "apiKeyParamName": "api_key",       // optional — query param name for key auth
  "apiKeyValue": "...",               // optional — the actual key
  "headers": {                        // optional — extra headers sent upstream only
    "Authorization": "Bearer ...",
    "X-Api-Key": "..."
  },
  "allowedExtensions": ["png"],       // optional, default ["png","jpg","jpeg"]
  "timeoutMs": 5000,                  // optional, defaults to requestTimeoutMs
  "fallbackOnError": true             // optional, defaults to top-level fallbackOnError
}
```

`serviceId` is what appears in the proxy route (`/proxy/raster/{serviceId}/...`) — it never
exposes the real upstream host or credentials to the client.

Config is validated at startup, including an SSRF check that resolves every configured upstream
host and rejects it if it (or any of its resolved IPs) is loopback, private, link-local, or a
known cloud metadata address. **The process refuses to start on an invalid or unsafe config** —
see [`CONCEPT.md` §5](./CONCEPT.md#5-ssrf-mitigation-srcsecurityssrfjs) for the exact ranges
checked.

## Logging

Logs are one JSON object per line on stdout (Pino). The level is resolved in this order: the
`LOG_LEVEL` environment variable, then `logLevel` in `config.json`, then `info`. An unknown level
makes the service refuse to start.

```bash
LOG_LEVEL=debug npm start                       # local
docker run -e LOG_LEVEL=debug ...               # plain Docker
LOG_LEVEL=debug docker compose up               # docker compose (passed through, see docker-compose.yml)
```

| Level | What you get |
|---|---|
| `info` (default) | Startup: loaded configuration, connection pool settings, one line per registered service (upstream host, auth mode, timeout), `ready`. Runtime: one `tile served` line per tile (`serviceId`, `tile`, `upstreamStatus`, `bytes`, `durationMs`). Shutdown. |
| `warn` | Also shown at `info`: upstream error statuses and timeouts (with whether the fallback tile was used), requests rejected for a disallowed `Origin`. |
| `debug` | Adds `requesting tile from upstream` for every tile: the exact upstream URL, the names (never values) of the headers sent, and the timeout. |

Example `debug` line:

```json
{"level":20,"serviceId":"carto_light_all","url":"https://c.basemaps.cartocdn.com/light_all/5/16/10.png?key=ab***yz","headerNames":["accept","user-agent"],"timeoutMs":5000,"msg":"requesting tile from upstream"}
```

The API key in that URL is **masked by default** (`ab***yz`, or `***` for short values), as are
header values, so enabling `debug` in production does not leak credentials into log storage. That
is still enough to spot a placeholder or truncated key. To see the full URL while troubleshooting,
set `LOG_REVEAL_API_KEYS=true` (the service logs a warning at startup while it is enabled).
Health checks and `/metrics` scrapes are not logged.

## Running tests

```bash
npm test            # vitest run — full suite, no network access required
npm run test:watch  # watch mode
npm run coverage     # coverage report (text + html under coverage/)
```

See [`TESTING.md`](./TESTING.md) for what each test file covers and how upstream calls/DNS are
mocked.

## Docker

```bash
mkdir -p config
cp config.example.json config/config.json   # fill in real API keys
cp map-tile-proxy.env.example map-tile-proxy.env

docker compose up --build
```

`docker-compose.yml` follows the same conventions as the rest of the KomMonitor Data
Infrastructure: container name `kommonitor-map-tile-proxy`, joins the shared external `kommonitor`
bridge network (so it's reachable by name from `kommonitor-data-management`, the KomMonitor nginx
gateway, etc.), config mounted read-only from `./config/config.json`, and environment sourced from
an `.env`-style file. To route it through the KomMonitor nginx gateway, add a
`location /kommonitor/api/maptiles/ { proxy_pass http://kommonitor-map-tile-proxy:8080/; }` block
(with a matching upstream env var) to the gateway's `default.conf.template`, mirroring the other
backend services there.

The `Dockerfile` builds a `node:22-alpine` image with `npm ci --omit=dev`, runs as the unprivileged
`node` user, and defines a `HEALTHCHECK` that hits `/healthz`.

## Releasing

Releases are cut with [release-it](https://github.com/release-it/release-it) (configured in
[`.release-it.json`](./.release-it.json)), the same way as the other KomMonitor repositories.
It needs Node.js 22.22 or newer, a clean working tree, the `master` branch checked out and push
access to `origin`.

```bash
npm run release            # interactive: pick the bump (patch/minor/major/pre-release)
npm run release -- 1.2.0   # or name the version explicitly
npm run release -- --dry-run   # show what would happen, change nothing
```

What it does, in order:

1. runs `npm test` and aborts if anything fails
2. bumps `version` in `package.json` and `package-lock.json`
3. regenerates `CHANGELOG.md` from the git history with `auto-changelog`
4. creates the commit `Release X.Y.Z` and the tag `X.Y.Z` (no `v` prefix), and pushes both

Pushing triggers the GitHub workflows: the push to `master` rebuilds `kommonitor/map-tile-proxy:latest`
and syncs `README_DOCKERHUB.md` to Docker Hub, and the `X.Y.Z` tag builds the versioned images
`kommonitor/map-tile-proxy:X.Y.Z` and `:X.Y`.

Notes:

- `package.json` is `private`, and npm publishing and GitHub Releases are disabled; a release is
  the git tag plus the Docker images.
- The very first release can be `1.0.0` (the current `package.json` version); this is why
  same-version bumps are allowed.
- `CHANGELOG.md` must stay tracked in git, otherwise release-it will not include it in the release commit.
- Commit subjects become changelog entries, so write them as short sentences.

## Client integration

### Leaflet

```js
L.tileLayer('https://map-tile-proxy.example.org/proxy/raster/osm-bright/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; your tile provider',
}).addTo(map);
```

No API key, token, or `Authorization` header appears anywhere in this snippet — Leaflet just
loads plain `<img>` tiles from the proxy, which injects the real credentials server-side.

### Fetching a single tile (e.g. for a thumbnail)

```js
const res = await fetch('https://map-tile-proxy.example.org/proxy/raster/osm-bright/10/551/335.png');
const blob = await res.blob();
```

Cross-origin `fetch()` calls are subject to the `ALLOWED_ORIGINS` check (§ Configuration) — make
sure the page's origin is included, or the proxy responds `403 Forbidden`. Plain `<img>` tag loads
(what Leaflet uses) are not affected by this check, since browsers don't send an `Origin` header
or enforce CORS for image loads.

## Security notes

- Zero hardcoded credentials — all API keys/tokens live only in `config.json` (or wherever
  `CONFIG_PATH` points), which should be kept out of version control and mounted at runtime.
- See [`CONCEPT.md`](./CONCEPT.md) for the full threat-model write-up: SSRF mitigations, header
  sanitization in both directions, and the documented DNS-rebinding residual risk.
