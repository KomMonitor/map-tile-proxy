import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import { isOriginAllowed } from './security/origins.js';
import { createMetrics } from './metrics/registry.js';
import healthRoutes from './routes/health.js';
import metricsRoutes from './routes/metrics.js';
import tileRoutes from './routes/tiles.js';

/**
 * Builds a Fastify instance from a runtime config. Kept separate from
 * process bootstrap (src/index.js) so tests can build and exercise the app
 * in-process via fastify.inject() without opening a real socket.
 */
export async function buildApp(
  runtimeConfig,
  { logger = { level: runtimeConfig.logLevel }, metrics = createMetrics() } = {}
) {
  // Per-request logging is done by the tile route (one structured line per tile);
  // Fastify's default incoming/completed pair would also log every health check.
  const app = Fastify({ logger, logController: new LogController({ disableRequestLogging: true }) });

  await app.register(cors, {
    origin(origin, cb) {
      if (!origin) return cb(null, true); // non-browser clients (e.g. <img> tags) send no Origin header
      cb(null, isOriginAllowed(origin, runtimeConfig.allowedOrigins));
    },
  });

  // @fastify/cors only omits CORS headers for a disallowed origin; the browser
  // then blocks the response client-side but the server still serves it. The
  // spec requires an explicit 403, so reject disallowed browser origins here.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, runtimeConfig.allowedOrigins)) {
      req.log.warn({ origin, url: req.url }, 'request rejected: origin not allowed');
      reply.code(403).send({ error: 'Forbidden', message: 'Origin not allowed' });
    }
  });

  await app.register(healthRoutes);
  await app.register(metricsRoutes, { metrics });
  await app.register(tileRoutes, {
    services: runtimeConfig.services,
    metrics,
    logRevealApiKeys: runtimeConfig.logRevealApiKeys,
  });

  return app;
}
