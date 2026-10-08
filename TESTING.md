# Testing Guide

## Running the suite

```bash
npm install
npm test            # single run (vitest run)
npm run test:watch  # watch mode while developing
npm run coverage     # single run with a v8 coverage report (text + html in coverage/)
```

All tests run fully offline: no test makes a real network call. Upstream tile providers are
mocked with `undici`'s `MockAgent`; a fake DNS lookup is injected wherever SSRF validation runs.
There is no test server listening on a real port — `fastify.inject()` drives requests directly
against the in-process Fastify instance.

## Mock strategy

### Upstream HTTP calls — `undici.MockAgent`

`tests/helpers/testApp.js` exports `installMockAgent()`, which creates a fresh `MockAgent`,
disables real network access (`mockAgent.disableNetConnect()`), and installs it as the process
dispatcher via `setGlobalDispatcher()`. Because production code (`src/proxy/tileClient.js`) calls
plain `undici.request(url, opts)` with no explicit `dispatcher`, it automatically goes through
whatever dispatcher is currently installed — the `MockAgent` in tests, a pooled `Agent` in
production (`src/index.js`). No test-only conditional exists in the request path.

```js
mockAgent
  .get('https://tiles.example.com')
  .intercept({ path: '/1/2/3.png?api_key=secret123', method: 'GET' })
  .reply(200, pngBytes, { headers: { 'content-type': 'image/png' } });
```

Each test installs a fresh `MockAgent` in `beforeEach`, so interceptors never leak between tests.
`mockAgent.assertNoPendingInterceptors()` is used where a test needs to prove a specific upstream
call shape (headers, query string) actually happened.

### DNS resolution — fake `lookup` function

`src/security/ssrf.js`'s `createSsrfValidator({ lookup })` takes an injectable DNS lookup
function (defaulting to `dns.promises.lookup`). Tests pass a synchronous fake that maps hostnames
to fixed IP addresses, so SSRF tests are deterministic and don't depend on real DNS or network
access in CI:

```js
const fakeLookup = async (hostname) => [{ address: '203.0.113.10', family: 4 }];
```

### Upstream timeouts — injectable `requestFn`

`fetchTile(service, coords, { requestFn })` accepts an injectable request function (defaulting to
`undici.request`). This is used exactly once, in `tests/fallback.test.js`, to simulate a hung
upstream connection that only rejects when the `AbortSignal` fires — `MockAgent` in the installed
`undici` version has no built-in reply-delay primitive, so this is the most direct way to prove
the `AbortController`/timeout wiring actually works without making the whole suite depend on real
wall-clock delays.

## Coverage scope by file

| Test file | Covers |
|---|---|
| `tests/tiles.test.js` | Happy-path tile streaming, response header pass-through/stripping (`Set-Cookie` dropped), API-key-as-query-param injection, custom-header injection, client `Cookie`/`Authorization` headers never forwarded upstream, unknown `serviceId` → 404, non-numeric coordinates → 400, disallowed extension → 400 |
| `tests/fallback.test.js` | Fallback 1×1 PNG served on upstream 404/5xx/network error, fallback disabled propagates the real upstream status, request timeout/abort wiring |
| `tests/ssrf.test.js` | IP-range classification (loopback/private/link-local/cloud-metadata/IPv6), wildcard host allow-list matching, config-time SSRF validator (literal denylist, resolved-private-IP rejection, cloud metadata rejection, explicit allow-list enforcement), end-to-end `buildRuntimeConfig` rejecting an unsafe service |
| `tests/config.test.js` | Config validation errors (no services, missing `upstreamUrlTemplate`, unsupported extension), environment variable overrides, per-service defaults |
| `tests/cors.test.js` | No-`Origin` requests allowed, wildcard-subdomain and wildcard-port origin matching, disallowed origin → 403 on both a plain route and the tile route |
| `tests/logging.test.js` | Log level resolution (default, config, env override, empty env, invalid value), URL redaction (masked key, credential-looking params, reveal opt-in), and captured log lines: masked debug URL, no secrets anywhere in the output, info summary per tile, warnings for upstream errors and rejected origins, silent health checks |
| `tests/health-metrics.test.js` | `/healthz` payload/status, `/metrics` exposes the three custom metric families, `tile_proxy_requests_total` gets the right labels after a real (mocked) tile fetch |

## Adding a new test

Reuse `installMockAgent()` + `buildTestApp(rawConfig, env)` from `tests/helpers/testApp.js` — the
latter builds a runtime config (with the fake DNS lookup wired in) and a fresh Fastify instance
with its own `prom-client` registry, so metrics assertions in one test file never see counters
incremented by another.
