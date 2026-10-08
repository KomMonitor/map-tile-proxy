// A single fully-transparent 1x1 PNG, embedded so the fallback path never
// touches disk or an upstream. Kept as a base64 literal rather than a
// generated buffer so it stays a trivial, auditable constant.
const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export const TRANSPARENT_PNG_BUFFER = Buffer.from(TRANSPARENT_PNG_BASE64, 'base64');

export function sendFallbackTile(reply) {
  reply
    .code(200)
    .header('content-type', 'image/png')
    .header('cache-control', 'no-store')
    .header('x-tile-proxy-fallback', '1');
  return reply.send(TRANSPARENT_PNG_BUFFER);
}
