import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installMockAgent, buildTestApp } from './helpers/testApp.js';
import { fetchTile } from '../src/proxy/tileClient.js';
import { TRANSPARENT_PNG_BUFFER } from '../src/proxy/fallbackTile.js';

const rawConfig = {
  services: {
    'with-fallback': {
      upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
      allowedExtensions: ['png'],
      timeoutMs: 2000,
      fallbackOnError: true,
    },
    'no-fallback': {
      upstreamUrlTemplate: 'https://tiles.example.com/nf/{z}/{x}/{y}.png',
      allowedExtensions: ['png'],
      timeoutMs: 2000,
      fallbackOnError: false,
    },
  },
};

describe('error fallback handling', () => {
  let mockAgent;
  let app;

  beforeEach(async () => {
    mockAgent = installMockAgent();
    ({ app } = await buildTestApp(rawConfig));
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the transparent fallback tile on upstream 404', async () => {
    mockAgent
      .get('https://tiles.example.com')
      .intercept({ path: '/1/2/3.png', method: 'GET' })
      .reply(404, 'not found');

    const res = await app.inject({ method: 'GET', url: '/proxy/raster/with-fallback/1/2/3.png' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-tile-proxy-fallback']).toBe('1');
    expect(Buffer.compare(res.rawPayload, TRANSPARENT_PNG_BUFFER)).toBe(0);
  });

  it('serves the transparent fallback tile on upstream 5xx', async () => {
    mockAgent
      .get('https://tiles.example.com')
      .intercept({ path: '/1/2/3.png', method: 'GET' })
      .reply(503, 'service unavailable');

    const res = await app.inject({ method: 'GET', url: '/proxy/raster/with-fallback/1/2/3.png' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-tile-proxy-fallback']).toBe('1');
  });

  it('serves the transparent fallback tile when the upstream request errors', async () => {
    mockAgent
      .get('https://tiles.example.com')
      .intercept({ path: '/1/2/3.png', method: 'GET' })
      .replyWithError(new Error('connection reset'));

    const res = await app.inject({ method: 'GET', url: '/proxy/raster/with-fallback/1/2/3.png' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-tile-proxy-fallback']).toBe('1');
  });

  it('propagates the upstream status code when fallback is disabled', async () => {
    mockAgent
      .get('https://tiles.example.com')
      .intercept({ path: '/nf/1/2/3.png', method: 'GET' })
      .reply(404, 'not found');

    const res = await app.inject({ method: 'GET', url: '/proxy/raster/no-fallback/1/2/3.png' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['x-tile-proxy-fallback']).toBeUndefined();
  });

  it('aborts and falls back when the upstream request exceeds the configured timeout', async () => {
    const service = {
      upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
      allowedExtensions: ['png'],
      timeoutMs: 20,
      headers: {},
    };

    const hangingRequestFn = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });

    await expect(
      fetchTile(service, { z: '1', x: '2', y: '3', ext: 'png' }, { requestFn: hangingRequestFn })
    ).rejects.toThrow();
  });
});
