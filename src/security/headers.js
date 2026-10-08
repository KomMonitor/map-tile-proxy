/**
 * We never forward the client's own headers upstream. Building a minimal,
 * explicit header set (rather than stripping a denylist from the incoming
 * request) means there is no sensitive client header - Cookie, Authorization,
 * Host, or anything else - that could ever leak to the upstream provider.
 */
export function buildUpstreamHeaders(service, { accept } = {}) {
  const headers = {
    accept: accept || 'image/*,*/*;q=0.8',
    'user-agent': 'kommonitor-map-tile-proxy',
  };
  if (service.headers) {
    for (const [key, value] of Object.entries(service.headers)) {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

// Response headers we allow to pass through to the browser. Anything else
// (including Set-Cookie and any upstream-identifying headers) is dropped.
const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'content-encoding',
]);

export function forwardSafeResponseHeaders(reply, upstreamHeaders) {
  for (const [key, value] of Object.entries(upstreamHeaders || {})) {
    if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      reply.header(key, value);
    }
  }
}
