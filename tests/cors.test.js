import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installMockAgent, buildTestApp } from './helpers/testApp.js';

const rawConfig = {
  allowedOrigins: ['https://*.kommonitor.de', 'http://localhost:*'],
  services: {
    demo: {
      upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
      allowedExtensions: ['png'],
      timeoutMs: 2000,
    },
  },
};

describe('CORS origin filtering', () => {
  let app;

  beforeEach(async () => {
    installMockAgent();
    ({ app } = await buildTestApp(rawConfig));
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows requests with no Origin header (e.g. <img> tag loads)', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('allows an exact-match wildcard subdomain origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://app.kommonitor.de' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.kommonitor.de');
  });

  it('allows a wildcard-port localhost origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'http://localhost:5173' } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a disallowed origin with 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example.com' } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a disallowed origin on the tile route too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/proxy/raster/demo/1/2/3.png',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });
});
