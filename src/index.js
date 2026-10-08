import { Agent, setGlobalDispatcher } from 'undici';
import { loadRuntimeConfig } from './config.js';
import { buildApp } from './app.js';
import { describeAuth } from './logging.js';

const CONFIG_PATH = process.env.CONFIG_PATH ?? './config.json';

const POOL_OPTIONS = {
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 128,
};

// A single pooled, keep-alive Agent shared by every upstream request avoids
// repeating the TLS handshake on every tile fetch during rapid map panning.
setGlobalDispatcher(new Agent(POOL_OPTIONS));

async function main() {
  const runtimeConfig = await loadRuntimeConfig(CONFIG_PATH);
  const app = await buildApp(runtimeConfig);
  const log = app.log;

  log.info(
    {
      configPath: CONFIG_PATH,
      port: runtimeConfig.port,
      logLevel: runtimeConfig.logLevel,
      requestTimeoutMs: runtimeConfig.requestTimeoutMs,
      fallbackOnError: runtimeConfig.fallbackOnError,
      allowedOrigins: runtimeConfig.allowedOrigins,
      allowedUpstreamHosts: runtimeConfig.allowedUpstreamHosts,
    },
    'configuration loaded'
  );
  if (runtimeConfig.allowedOrigins.length === 0) {
    log.warn('no allowedOrigins configured: all requests carrying an Origin header will be rejected with 403');
  }
  if (runtimeConfig.logRevealApiKeys) {
    log.warn('LOG_REVEAL_API_KEYS is enabled: API keys will appear in debug logs');
  }
  log.info(POOL_OPTIONS, 'upstream connection pool configured');

  for (const service of Object.values(runtimeConfig.services)) {
    log.info(
      {
        serviceId: service.id,
        upstreamHost: new URL(service.upstreamUrlTemplate.replace(/\{[xyz]\}/g, '0')).host,
        auth: describeAuth(service),
        allowedExtensions: service.allowedExtensions,
        timeoutMs: service.timeoutMs,
        fallbackOnError: service.fallbackOnError,
      },
      'service registered (upstream host passed SSRF validation)'
    );
  }

  await app.listen({ port: runtimeConfig.port, host: '0.0.0.0' });
  log.info(
    { endpoints: ['/proxy/raster/{serviceId}/{z}/{x}/{y}.{png|jpg|jpeg}', '/healthz', '/metrics'] },
    'map-tile-proxy ready'
  );

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      log.info({ signal }, 'shutting down');
      await app.close();
      log.info('server stopped');
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('Failed to start map-tile-proxy:', err);
  process.exit(1);
});
