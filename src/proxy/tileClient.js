import { request as undiciRequest } from 'undici';
import { PassThrough } from 'node:stream';
import { buildUpstreamHeaders } from '../security/headers.js';
import { redactUrl } from '../logging.js';

export function buildUpstreamUrl(service, { z, x, y, ext }) {
  const path = service.upstreamUrlTemplate
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y);
  const url = new URL(path);
  // Extension is not part of most upstream templates (they hardcode the
  // format); only append it if the template doesn't already carry one.
  if (!/\.[a-z]+$/i.test(url.pathname)) {
    url.pathname = `${url.pathname}.${ext}`;
  }
  if (service.apiKeyParamName && service.apiKeyValue) {
    url.searchParams.set(service.apiKeyParamName, service.apiKeyValue);
  }
  return url;
}

/**
 * Fetches a single tile from upstream via the process-wide undici dispatcher
 * (a pooled keep-alive Agent in production, a MockAgent in tests). Returns
 * the raw streaming body - callers are responsible for piping or draining it.
 */
export async function fetchTile(
  service,
  { z, x, y, ext },
  { requestFn = undiciRequest, log, revealApiKeys = false } = {}
) {
  const url = buildUpstreamUrl(service, { z, x, y, ext });
  const headers = buildUpstreamHeaders(service);
  const timeoutMs = service.timeoutMs;

  log?.debug(
    {
      serviceId: service.id,
      url: redactUrl(url, { secretParams: [service.apiKeyParamName].filter(Boolean), reveal: revealApiKeys }),
      headerNames: Object.keys(headers),
      timeoutMs,
    },
    'requesting tile from upstream'
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const { statusCode, headers: responseHeaders, body } = await requestFn(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    return { statusCode, headers: responseHeaders, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps a tile body stream in a byte-counting PassThrough so bandwidth can be
 * recorded without buffering the tile in memory - bytes are counted as they
 * flow through, not accumulated.
 */
export function countBytes(sourceStream, onBytes) {
  let total = 0;
  const counter = new PassThrough();
  counter.on('data', (chunk) => {
    total += chunk.length;
  });
  counter.on('end', () => onBytes(total));
  sourceStream.on('error', (err) => counter.destroy(err));
  return sourceStream.pipe(counter);
}
