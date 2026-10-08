import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installMockAgent, buildTestApp } from './helpers/testApp.js';

const baseRawConfig = {
  allowedOrigins: ['http://localhost:*'],
  services: {
    'key-param': {
      upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
      apiKeyParamName: 'api_key',
      apiKeyValue: 'secret123',
      allowedExtensions: ['png'],
      timeoutMs: 2000,
    },
    'header-auth': {
      upstreamUrlTemplate: 'https://tiles.example.com/hdr/{z}/{x}/{y}.jpg',
      headers: { 'X-Api-Key': 'headersecret', Authorization: 'Bearer topsecret' },
      allowedExtensions: ['jpg', 'jpeg'],
      timeoutMs: 2000,
    },
  },
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe('tile proxy routing', () => {
  let mockAgent;
  let app;

  beforeEach(async () => {
    mockAgent = installMockAgent();
    ({ app } = await buildTestApp(baseRawConfig));
  });

  afterEach(async () => {
    await app.close();
  });

  it('streams a successful tile and forwards safe caching headers', async () => {
    mockAgent
      .get('https://tiles.example.com')
      .intercept({ path: '/1/2/3.png?api_key=secret123', method: 'GET' })
      .reply(200, PNG_BYTES, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400',
          etag: '"abc123"',
          'set-cookie': 'session=leaked; HttpOnly',
        },
      });

    const res = await app.inject({ method: 'GET', url: '/proxy/raster/key-param/1/2/3.png' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.headers.etag).toBe('"abc123"');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(Buffer.compare(res.rawPayload, PNG_BYTES)).toBe(0);
  });

  it('injects the configured API key as a query parameter', async () => {
    mockAgent
      .get('https://tiles.example.com')
      .intercept({ path: '/1/2/3.png?api_key=secret123', method: 'GET' })
      .reply(200, PNG_BYTES, { headers: { 'content-type': 'image/png' } });

    const res = await app.inject({ method: 'GET', url: '/proxy/raster/key-param/1/2/3.png' });

    expect(res.statusCode).toBe(200);
    mockAgent.assertNoPendingInterceptors();
  });

  it('injects configured custom headers instead of a query key', async () => {
    mockAgent
      .get('https://tiles.example.com')
      .intercept({
        path: '/hdr/5/6/7.jpg',
        method: 'GET',
        headers: (headers) => headers['x-api-key'] === 'headersecret' && headers['authorization'] === 'Bearer topsecret',
      })
      .reply(200, PNG_BYTES, { headers: { 'content-type': 'image/jpeg' } });

    const res = await app.inject({ method: 'GET', url: '/proxy/raster/header-auth/5/6/7.jpg' });

    expect(res.statusCode).toBe(200);
    mockAgent.assertNoPendingInterceptors();
  });

  it('never forwards the client Cookie/Authorization headers upstream', async () => {
    mockAgent
      .get('https://tiles.example.com')
      .intercept({
        path: '/1/2/3.png?api_key=secret123',
        method: 'GET',
        headers: (headers) => headers['cookie'] === undefined && headers['authorization'] === undefined,
      })
      .reply(200, PNG_BYTES, { headers: { 'content-type': 'image/png' } });

    const res = await app.inject({
      method: 'GET',
      url: '/proxy/raster/key-param/1/2/3.png',
      headers: { cookie: 'secret=client-cookie', authorization: 'Bearer client-token' },
    });

    expect(res.statusCode).toBe(200);
    mockAgent.assertNoPendingInterceptors();
  });

  it('returns 404 for an unknown serviceId', async () => {
    const res = await app.inject({ method: 'GET', url: '/proxy/raster/does-not-exist/1/2/3.png' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for non-numeric tile coordinates', async () => {
    const res = await app.inject({ method: 'GET', url: '/proxy/raster/key-param/abc/2/3.png' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an extension the service does not allow', async () => {
    const res = await app.inject({ method: 'GET', url: '/proxy/raster/key-param/1/2/3.jpg' });
    expect(res.statusCode).toBe(400);
  });
});
