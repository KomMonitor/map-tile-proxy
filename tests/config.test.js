import { describe, it, expect } from 'vitest';
import { buildRuntimeConfig } from '../src/config.js';
import { createSsrfValidator } from '../src/security/ssrf.js';

const fakeLookup = async () => [{ address: '203.0.113.10', family: 4 }];
const ssrfValidator = createSsrfValidator({ lookup: fakeLookup });

describe('buildRuntimeConfig', () => {
  it('rejects a config with no services', async () => {
    await expect(buildRuntimeConfig({ services: {} }, {}, { ssrfValidator })).rejects.toThrow(/at least one/);
  });

  it('rejects a service missing upstreamUrlTemplate', async () => {
    const rawConfig = { services: { broken: {} } };
    await expect(buildRuntimeConfig(rawConfig, {}, { ssrfValidator })).rejects.toThrow(/upstreamUrlTemplate/);
  });

  it('rejects a service declaring an unsupported extension', async () => {
    const rawConfig = {
      services: {
        weird: {
          upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.webp',
          allowedExtensions: ['webp'],
        },
      },
    };
    await expect(buildRuntimeConfig(rawConfig, {}, { ssrfValidator })).rejects.toThrow(/unsupported extension/);
  });

  it('applies environment variable overrides over config.json values', async () => {
    const rawConfig = {
      port: 8080,
      allowedOrigins: ['https://from-config.example.com'],
      services: {
        demo: {
          upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
          allowedExtensions: ['png'],
        },
      },
    };
    const env = { PORT: '9090', ALLOWED_ORIGINS: 'https://from-env.example.com,http://localhost:*' };
    const runtimeConfig = await buildRuntimeConfig(rawConfig, env, { ssrfValidator });

    expect(runtimeConfig.port).toBe(9090);
    expect(runtimeConfig.allowedOrigins).toEqual(['https://from-env.example.com', 'http://localhost:*']);
  });

  it('defaults a service allowedExtensions and timeout when omitted', async () => {
    const rawConfig = {
      services: {
        demo: { upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png' },
      },
    };
    const runtimeConfig = await buildRuntimeConfig(rawConfig, {}, { ssrfValidator });
    expect(runtimeConfig.services.demo.allowedExtensions).toEqual(['png', 'jpg', 'jpeg']);
    expect(runtimeConfig.services.demo.timeoutMs).toBe(5000);
  });
});
