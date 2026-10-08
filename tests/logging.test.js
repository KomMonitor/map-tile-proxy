import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installMockAgent, buildTestApp, createLogCapture } from './helpers/testApp.js';
import { buildRuntimeConfig } from '../src/config.js';
import { createSsrfValidator } from '../src/security/ssrf.js';
import { redactUrl, maskSecret, describeAuth } from '../src/logging.js';

const ssrfValidator = createSsrfValidator({ lookup: async () => [{ address: '203.0.113.10', family: 4 }] });
const minimalServices = {
  demo: { upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png', allowedExtensions: ['png'] },
};
const levelOf = async (raw, env = {}) => (await buildRuntimeConfig(raw, env, { ssrfValidator })).logLevel;

describe('log level configuration', () => {
  it('defaults to info', async () => {
    expect(await levelOf({ services: minimalServices })).toBe('info');
  });

  it('reads logLevel from config.json', async () => {
    expect(await levelOf({ logLevel: 'warn', services: minimalServices })).toBe('warn');
  });

  it('lets LOG_LEVEL override config.json, case-insensitively', async () => {
    expect(await levelOf({ logLevel: 'warn', services: minimalServices }, { LOG_LEVEL: 'DEBUG' })).toBe('debug');
  });

  it('treats an empty LOG_LEVEL (e.g. from docker compose) as unset', async () => {
    expect(await levelOf({ logLevel: 'error', services: minimalServices }, { LOG_LEVEL: '' })).toBe('error');
  });

  it('refuses to start with an unknown level', async () => {
    await expect(levelOf({ services: minimalServices }, { LOG_LEVEL: 'verbose' })).rejects.toThrow(/invalid log level/);
  });
});

describe('redactUrl', () => {
  const url = new URL('https://tiles.example.com/1/2/3.png?key=abcdef123456&style=light');

  it('masks the configured key parameter but keeps other parameters', () => {
    const out = redactUrl(url, { secretParams: ['key'] });
    expect(out).toContain('key=ab***56');
    expect(out).toContain('style=light');
    expect(out).not.toContain('abcdef123456');
  });

  it('masks credential-looking parameters even when not configured (key embedded in the template)', () => {
    expect(redactUrl(url)).not.toContain('abcdef123456');
  });

  it('fully hides very short secrets', () => {
    expect(maskSecret('abc')).toBe('***');
  });

  it('prints the full URL only when reveal is set', () => {
    expect(redactUrl(url, { reveal: true })).toBe(url.href);
  });

  it('describes how a service authenticates without exposing values', () => {
    expect(describeAuth({ apiKeyParamName: 'key', apiKeyValue: 'x' })).toBe('query-param:key');
    expect(describeAuth({ headers: { 'X-Api-Key': 'x' } })).toBe('headers');
    expect(describeAuth({ headers: {} })).toBe('none');
  });
});

describe('request logging', () => {
  const SECRET = 'supersecretkey99';
  const rawConfig = {
    allowedOrigins: ['http://localhost:*'],
    services: {
      demo: {
        upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
        apiKeyParamName: 'key',
        apiKeyValue: SECRET,
        headers: { 'X-Api-Key': 'headervalue123' },
        allowedExtensions: ['png'],
      },
    },
  };
  let mockAgent;
  let app;
  let capture;

  const start = async (level, env = {}) => {
    capture = createLogCapture();
    ({ app } = await buildTestApp(rawConfig, env, { logger: { level, stream: capture.stream } }));
  };
  const intercept = () =>
    mockAgent.get('https://tiles.example.com').intercept({ path: `/1/2/3.png?key=${SECRET}`, method: 'GET' });
  const tileOk = () =>
    intercept().reply(200, Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

  beforeEach(() => {
    mockAgent = installMockAgent();
  });
  afterEach(async () => {
    await app.close();
  });

  it('at debug, logs the upstream URL with the key masked and never the secrets', async () => {
    await start('debug');
    tileOk();
    await app.inject({ method: 'GET', url: '/proxy/raster/demo/1/2/3.png' });

    const line = capture.lines.find((l) => l.msg === 'requesting tile from upstream');
    expect(line.url).toBe('https://tiles.example.com/1/2/3.png?key=su***99');
    expect(line.headerNames).toContain('x-api-key');
    const everything = JSON.stringify(capture.lines);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('headervalue123');
  });

  it('at debug with LOG_REVEAL_API_KEYS=true, logs the full URL', async () => {
    await start('debug', { LOG_REVEAL_API_KEYS: 'true' });
    tileOk();
    await app.inject({ method: 'GET', url: '/proxy/raster/demo/1/2/3.png' });

    const line = capture.lines.find((l) => l.msg === 'requesting tile from upstream');
    expect(line.url).toBe(`https://tiles.example.com/1/2/3.png?key=${SECRET}`);
  });

  it('at info, omits the debug URL line but logs one summary line per served tile', async () => {
    await start('info');
    tileOk();
    await app.inject({ method: 'GET', url: '/proxy/raster/demo/1/2/3.png' });

    expect(capture.lines.some((l) => l.msg === 'requesting tile from upstream')).toBe(false);
    const served = capture.lines.filter((l) => l.msg === 'tile served');
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ serviceId: 'demo', tile: '1/2/3', upstreamStatus: 200, bytes: 3 });
    expect(typeof served[0].durationMs).toBe('number');
  });

  it('logs an upstream error status as a warning that mentions the fallback', async () => {
    await start('info');
    intercept().reply(401, 'no');
    await app.inject({ method: 'GET', url: '/proxy/raster/demo/1/2/3.png' });

    const warn = capture.lines.find((l) => l.msg === 'upstream returned an error status');
    expect(warn).toMatchObject({ level: 40, serviceId: 'demo', upstreamStatus: 401, fallback: true });
  });

  it('logs a rejected origin as a warning', async () => {
    await start('info');
    await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example.com' } });

    expect(capture.lines.find((l) => l.msg === 'request rejected: origin not allowed')).toMatchObject({
      level: 40,
      origin: 'https://evil.example.com',
    });
  });

  it('does not log health checks at info', async () => {
    await start('info');
    await app.inject({ method: 'GET', url: '/healthz' });
    expect(capture.lines).toHaveLength(0);
  });
});
