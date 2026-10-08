import { fetchTile, countBytes } from '../proxy/tileClient.js';
import { forwardSafeResponseHeaders } from '../security/headers.js';
import { sendFallbackTile } from '../proxy/fallbackTile.js';

const COORD_PATTERN = /^\d+$/;

export default async function tileRoutes(app, { services, metrics, logRevealApiKeys = false }) {
  app.get('/proxy/raster/:serviceId/:z/:x/:y.:ext', async (req, reply) => {
    const { serviceId, z, x, y, ext } = req.params;
    const tile = `${z}/${x}/${y}`;
    const startedAt = performance.now();
    const elapsedMs = () => Math.round(performance.now() - startedAt);

    const service = services[serviceId];
    if (!service) {
      req.log.info({ serviceId, tile }, 'tile request rejected: unknown serviceId');
      return reply.code(404).send({ error: 'Unknown serviceId', serviceId });
    }

    if (!COORD_PATTERN.test(z) || !COORD_PATTERN.test(x) || !COORD_PATTERN.test(y)) {
      req.log.info({ serviceId, tile }, 'tile request rejected: coordinates must be non-negative integers');
      return reply.code(400).send({ error: 'Tile coordinates must be non-negative integers' });
    }

    const extension = ext.toLowerCase();
    if (!service.allowedExtensions.includes(extension)) {
      req.log.info({ serviceId, tile, ext }, 'tile request rejected: extension not allowed for service');
      return reply.code(400).send({ error: `Unsupported extension "${ext}" for service "${serviceId}"` });
    }

    const stopTimer = metrics.upstreamRequestDuration.startTimer({ service_id: serviceId });

    let upstream;
    try {
      upstream = await fetchTile(
        service,
        { z, x, y, ext: extension },
        { log: req.log, revealApiKeys: logRevealApiKeys }
      );
    } catch (err) {
      stopTimer();
      metrics.requestsTotal.inc({ service_id: serviceId, status_code: 'error' });
      req.log.warn(
        { serviceId, tile, durationMs: elapsedMs(), fallback: service.fallbackOnError, err },
        'upstream tile request failed (timeout or connection error)'
      );
      return handleFailure(reply, service, 502);
    }

    stopTimer();
    metrics.requestsTotal.inc({ service_id: serviceId, status_code: String(upstream.statusCode) });

    if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      reply.code(upstream.statusCode);
      forwardSafeResponseHeaders(reply, upstream.headers);
      const counted = countBytes(upstream.body, (bytes) => {
        metrics.bytesStreamedTotal.inc({ service_id: serviceId }, bytes);
        req.log.info(
          { serviceId, tile, upstreamStatus: upstream.statusCode, bytes, durationMs: elapsedMs() },
          'tile served'
        );
      });
      return reply.send(counted);
    }

    // Drain the upstream body so the connection can be reused/closed cleanly.
    upstream.body.resume();
    req.log.warn(
      {
        serviceId,
        tile,
        upstreamStatus: upstream.statusCode,
        durationMs: elapsedMs(),
        fallback: service.fallbackOnError,
      },
      'upstream returned an error status'
    );
    return handleFailure(reply, service, upstream.statusCode);
  });
}

function handleFailure(reply, service, upstreamStatusCode) {
  if (service.fallbackOnError) {
    return sendFallbackTile(reply);
  }
  return reply.code(upstreamStatusCode >= 400 && upstreamStatusCode < 600 ? upstreamStatusCode : 502).send({
    error: 'Upstream tile request failed',
  });
}
