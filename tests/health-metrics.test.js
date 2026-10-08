import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installMockAgent, buildTestApp } from './helpers/testApp.js';

const rawConfig = {
  services: {
    demo: {
      upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
      allowedExtensions: ['png'],
      timeoutMs: 2000,
    },
  },
};

describe('/healthz', () => {
  let app;

  beforeEach(async () => {
    installMockAgent();
    ({ app } = await buildTestApp(rawConfig));
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with a status ok payload', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('/metrics', () => {
  let app;
  let mockAgent;

  beforeEach(async () => {
    mockAgent = installMockAgent();
    ({ app } = await buildTestApp(rawConfig));
  });

  afterEach(async () => {
    await app.close();
  });

  it('exposes prometheus-formatted metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('tile_proxy_requests_total');
    expect(res.body).toContain('tile_proxy_upstream_request_duration_seconds');
    expect(res.body).toContain('tile_proxy_bytes_streamed_total');
  });

  it('records a request count and status_code label after a tile fetch', async () => {
    mockAgent
      .get('https://tiles.example.com')
      .intercept({ path: '/1/2/3.png', method: 'GET' })
      .reply(200, Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

    await app.inject({ method: 'GET', url: '/proxy/raster/demo/1/2/3.png' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toMatch(/tile_proxy_requests_total\{service_id="demo",status_code="200"\} 1/);
  });
});
