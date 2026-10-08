# KomMonitor map-tile-proxy

A lightweight HTTP proxy for **XYZ raster map tiles** that keeps upstream API keys on the server.
Your web map (Leaflet, OpenLayers, ...) requests tiles from the proxy; the proxy adds the API key
(query parameter and/or request headers) and streams the tile back. The key never reaches the
browser.

- Streams tiles straight through: nothing is cached or buffered on the proxy (browser caching headers are passed through)
- Pooled keep-alive connections to the tile provider
- SSRF protection: upstream hosts are validated at startup (no loopback, private or cloud-metadata addresses, optional host allow-list)
- Optional transparent 1x1 PNG instead of broken-image icons when the provider fails
- `/healthz` health check and Prometheus `/metrics`
- Structured JSON logs, with a `debug` level that shows the proxied URL (API key masked)

Source, full documentation and issue tracker: <https://github.com/KomMonitor/map-tile-proxy>

## Image

```
kommonitor/map-tile-proxy
```

| Tag | Content |
|---|---|
| `latest` | Latest build of the `master` branch |
| `X.Y.Z`, `X.Y` | Released versions (e.g. `1.0.0`, `1.0`). Pin one of these in production |

Platform: `linux/amd64`. Based on `node:22-alpine`, runs as the unprivileged `node` user, listens
on port `8080`, and includes a Docker `HEALTHCHECK` on `/healthz`.

## Quick start

The container needs a `config.json` that defines your tile services (including the API keys).
Create it first (see [Configuration](#configuration)), then:

```bash
docker run -d --name map-tile-proxy \
  -p 8080:8080 \
  -v "$(pwd)/config.json:/app/config/config.json:ro" \
  -e ALLOWED_ORIGINS="https://*.kommonitor.de,http://localhost:*" \
  kommonitor/map-tile-proxy:latest
```

Check it:

```bash
curl http://localhost:8080/healthz
# {"status":"ok"}

curl -o tile.png http://localhost:8080/proxy/raster/my-service/5/16/10.png
```

> Git Bash on Windows rewrites the `-v` path; prefix the command with `MSYS_NO_PATHCONV=1` or use PowerShell.

## Docker Compose

### Standalone

```yaml
services:
  map-tile-proxy:
    image: kommonitor/map-tile-proxy:latest   # pin a version tag in production, e.g. 1.0.0
    container_name: kommonitor-map-tile-proxy
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      ALLOWED_ORIGINS: "https://*.kommonitor.de,http://localhost:*"
      LOG_LEVEL: ${LOG_LEVEL:-}               # empty = use "logLevel" from config.json, else "info"
    volumes:
      - ./config/config.json:/app/config/config.json:ro
```

```bash
mkdir -p config && cp config.json config/config.json    # your real config, never commit it
docker compose up -d
LOG_LEVEL=debug docker compose up -d                    # temporarily more verbose
```

The image already defines a health check, so you don't need one in the compose file.

### Inside the KomMonitor Data Infrastructure

KomMonitor stacks share a Docker network named `kommonitor`. Join it and drop the published port
so the proxy is only reachable from other containers (for example the nginx gateway) under
`http://kommonitor-map-tile-proxy:8080`:

```yaml
services:
  kommonitor-map-tile-proxy:
    image: kommonitor/map-tile-proxy:latest
    container_name: kommonitor-map-tile-proxy
    restart: unless-stopped
    environment:
      KOMMONITOR_NAME: map-tile-proxy
      ALLOWED_ORIGINS: "https://*.kommonitor.de"
      LOG_LEVEL: ${LOG_LEVEL:-}
    volumes:
      - ./config/config.json:/app/config/config.json:ro
    networks:
      - kommonitor

networks:
  kommonitor:
    name: kommonitor
    external: true      # created by the main KomMonitor stack (docker network create kommonitor if standalone)
```

To expose it through the KomMonitor nginx gateway, add a location to the gateway's template, for
example:

```nginx
location /kommonitor/api/maptiles/ {
    proxy_pass http://kommonitor-map-tile-proxy:8080/;
}
```

Your map then loads `https://<your-host>/kommonitor/api/maptiles/proxy/raster/<serviceId>/{z}/{x}/{y}.png`.

## Configuration

The service reads a JSON file from `/app/config/config.json` (override the path with `CONFIG_PATH`).
**Mount it read-only at runtime; never bake keys into an image.** The container runs as the
`node` user, so the file must be readable by it (for example mode `644`).

```json
{
  "logLevel": "info",
  "allowedOrigins": ["https://*.kommonitor.de", "http://localhost:*"],
  "services": {
    "carto-light": {
      "upstreamUrlTemplate": "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      "apiKeyParamName": "key",
      "apiKeyValue": "REPLACE_WITH_YOUR_API_KEY",
      "allowedExtensions": ["png"],
      "timeoutMs": 5000
    },
    "satellite": {
      "upstreamUrlTemplate": "https://api.example-satellite.com/tiles/{z}/{x}/{y}.jpg",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_YOUR_TOKEN",
        "X-Api-Key": "REPLACE_WITH_YOUR_API_KEY"
      },
      "allowedExtensions": ["jpg", "jpeg"]
    }
  }
}
```

The key of each entry under `services` is the `serviceId` used in the proxy URL:

```
/proxy/raster/{serviceId}/{z}/{x}/{y}.{png|jpg|jpeg}
```

| Service field | Meaning |
|---|---|
| `upstreamUrlTemplate` | Required. `http(s)` URL with `{z}`, `{x}`, `{y}` placeholders |
| `apiKeyParamName` / `apiKeyValue` | Optional. Appended to the upstream URL as a query parameter |
| `headers` | Optional. Headers sent to the upstream only (e.g. `Authorization`) |
| `allowedExtensions` | Optional. Default `["png","jpg","jpeg"]` |
| `timeoutMs` | Optional. Upstream timeout, default `5000` |
| `fallbackOnError` | Optional. Serve a transparent 1x1 PNG when the upstream fails, default `true` |

### Environment variables

Environment variables override the matching value in `config.json`.

| Variable | Default | Meaning |
|---|---|---|
| `CONFIG_PATH` | `/app/config/config.json` | Location of the config file inside the container |
| `PORT` | `8080` | Listen port |
| `ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to use the proxy, `*` wildcards allowed (`https://*.kommonitor.de,http://localhost:*`). Requests with any other `Origin` get `403` |
| `ALLOWED_UPSTREAM_HOSTS` | none | Optional allow-list of upstream hostnames, e.g. `*.example.com`. Private, loopback and metadata addresses are always refused |
| `REQUEST_TIMEOUT_MS` | `5000` | Default upstream timeout |
| `FALLBACK_ON_ERROR` | `true` | Serve a transparent tile instead of an error when the upstream fails |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `LOG_REVEAL_API_KEYS` | `false` | Print API keys unmasked in `debug` logs (troubleshooting only) |

Notes:

- With no `ALLOWED_ORIGINS`, every request that carries an `Origin` header is rejected. Plain `<img>`
  tile loads (what Leaflet uses) send no `Origin` header and are not affected; cross-origin `fetch()` calls are.
- The container **refuses to start** on an invalid config, an unsupported URL scheme, or an upstream
  host that resolves to a private or loopback address. The container needs working DNS at startup.
- Quote values that contain `*` in YAML (`"https://*.kommonitor.de"`).

## Logging

JSON logs, one object per line, on stdout: read them with `docker logs -f <container>`.
Level precedence: `LOG_LEVEL` environment variable, then `logLevel` in `config.json`, then `info`.

| Level | What you see |
|---|---|
| `info` | Loaded configuration, one line per registered service, `ready`, and one `tile served` line per tile (status, bytes, duration) |
| `warn` | Upstream error statuses and timeouts (and whether the fallback tile was used), requests rejected for a disallowed `Origin` |
| `debug` | The exact upstream URL for every tile request |

```json
{"level":20,"serviceId":"carto-light","url":"https://c.basemaps.cartocdn.com/light_all/5/16/10.png?key=ab***yz","headerNames":["accept","user-agent"],"msg":"requesting tile from upstream"}
```

API keys in these URLs and all header values are masked (`ab***yz`) so `debug` is safe to enable
while troubleshooting. That is still enough to notice a placeholder or truncated key. Health checks
and `/metrics` scrapes are not logged.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /proxy/raster/{serviceId}/{z}/{x}/{y}.{png\|jpg\|jpeg}` | Proxied tile |
| `GET /healthz` | `200 {"status":"ok"}`, used by the Docker health check |
| `GET /metrics` | Prometheus metrics: `tile_proxy_requests_total{service_id,status_code}`, `tile_proxy_upstream_request_duration_seconds{service_id}`, `tile_proxy_bytes_streamed_total{service_id}` plus Node.js process metrics |

`/metrics` is not authenticated. Keep it on an internal network and don't expose it publicly.

Prometheus scrape example:

```yaml
scrape_configs:
  - job_name: map-tile-proxy
    static_configs:
      - targets: ["kommonitor-map-tile-proxy:8080"]
```

## Leaflet

```js
L.tileLayer('https://your-host/proxy/raster/carto-light/{z}/{x}/{y}.png', {
  maxZoom: 19,
}).addTo(map);
```

No API key appears anywhere on the client.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Container exits right after start | Read `docker logs`: missing or unreadable `/app/config/config.json` (wrong mount path, file not readable by the `node` user), invalid JSON, invalid `LOG_LEVEL`, or an upstream host rejected by the SSRF check |
| Map shows empty tiles, requests return `200` | The upstream failed and the transparent fallback tile was served (response header `X-Tile-Proxy-Fallback: 1`). Look for `upstream returned an error status` in the logs, or set `fallbackOnError` to `false` for that service to see the real status |
| Tiles are returned but watermarked | The provider treats the API key as invalid. Run with `LOG_LEVEL=debug` and check the masked key in the logged URL, make sure the config you mounted is the one you edited, and restart the container after changing it: **the config is only read at startup** |
| Still watermarked after fixing the key | Your browser cached the old tiles: the provider's `Cache-Control` (often 30 days, `immutable`) is passed through. Hard-reload or disable the cache in DevTools |
| `403 Forbidden` | The request's `Origin` header is not matched by `ALLOWED_ORIGINS` |
| `404` | Unknown `serviceId` (it is the key under `services` in `config.json`) |
| `400` | Non-numeric tile coordinates, or an extension not listed in the service's `allowedExtensions` |
| `LOG_LEVEL` set in `docker-compose` seems ignored | Compose also reads a `.env` file next to the compose file for `${LOG_LEVEL}`; check it, and note that an environment value always beats `logLevel` in `config.json` |

## License

See the [LICENSE](https://github.com/KomMonitor/map-tile-proxy/blob/master/LICENSE) in the GitHub repository.
