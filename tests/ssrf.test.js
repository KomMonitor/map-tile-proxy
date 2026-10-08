import { describe, it, expect } from 'vitest';
import { buildRuntimeConfig } from '../src/config.js';
import { createSsrfValidator, isForbiddenAddress, hostMatchesAllowlist } from '../src/security/ssrf.js';

const fakeLookup = (map) => async (hostname) => {
  if (!(hostname in map)) throw new Error(`no fake DNS entry for ${hostname}`);
  return map[hostname].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('isForbiddenAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.5', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata endpoint
    ['0.0.0.0', true],
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['203.0.113.10', false],
    ['8.8.8.8', false],
  ])('%s -> forbidden=%s', (ip, expected) => {
    expect(isForbiddenAddress(ip)).toBe(expected);
  });
});

describe('hostMatchesAllowlist', () => {
  it('matches exact hosts and wildcard subdomains', () => {
    expect(hostMatchesAllowlist('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostMatchesAllowlist('tiles.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatchesAllowlist('evil.com', ['*.example.com'])).toBe(false);
  });
});

describe('createSsrfValidator', () => {
  it('rejects a configured upstream host by literal name', async () => {
    const assertAllowed = createSsrfValidator({ lookup: fakeLookup({}) });
    await expect(assertAllowed('localhost', {})).rejects.toThrow(/not allowed/);
  });

  it('rejects a hostname that resolves to a private IP', async () => {
    const assertAllowed = createSsrfValidator({ lookup: fakeLookup({ 'internal.tiles.corp': ['10.0.0.5'] }) });
    await expect(assertAllowed('internal.tiles.corp', {})).rejects.toThrow(/forbidden address/);
  });

  it('rejects a hostname that resolves to the cloud metadata address', async () => {
    const assertAllowed = createSsrfValidator({ lookup: fakeLookup({ 'sneaky.example.com': ['169.254.169.254'] }) });
    await expect(assertAllowed('sneaky.example.com', {})).rejects.toThrow(/forbidden address/);
  });

  it('allows a hostname that resolves only to public addresses', async () => {
    const assertAllowed = createSsrfValidator({ lookup: fakeLookup({ 'tiles.example.com': ['203.0.113.10'] }) });
    await expect(assertAllowed('tiles.example.com', {})).resolves.toBeUndefined();
  });

  it('enforces an explicit allowlist when configured', async () => {
    const assertAllowed = createSsrfValidator({ lookup: fakeLookup({ 'tiles.example.com': ['203.0.113.10'] }) });
    await expect(
      assertAllowed('tiles.example.com', { allowedUpstreamHosts: ['*.other-domain.com'] })
    ).rejects.toThrow(/allowlist/);
    await expect(
      assertAllowed('tiles.example.com', { allowedUpstreamHosts: ['*.example.com'] })
    ).resolves.toBeUndefined();
  });
});

describe('buildRuntimeConfig SSRF integration', () => {
  it('refuses to build a config whose service points at a private address', async () => {
    const ssrfValidator = createSsrfValidator({ lookup: fakeLookup({ 'internal.corp': ['10.0.0.5'] }) });
    const rawConfig = {
      services: {
        evil: {
          upstreamUrlTemplate: 'https://internal.corp/{z}/{x}/{y}.png',
          allowedExtensions: ['png'],
        },
      },
    };
    await expect(buildRuntimeConfig(rawConfig, {}, { ssrfValidator })).rejects.toThrow(/forbidden address/);
  });

  it('refuses a non-http(s) protocol', async () => {
    const ssrfValidator = createSsrfValidator({ lookup: fakeLookup({}) });
    const rawConfig = {
      services: {
        bad: {
          upstreamUrlTemplate: 'file:///etc/passwd',
          allowedExtensions: ['png'],
        },
      },
    };
    await expect(buildRuntimeConfig(rawConfig, {}, { ssrfValidator })).rejects.toThrow(/unsupported protocol/);
  });

  it('builds successfully for a safe, public service', async () => {
    const ssrfValidator = createSsrfValidator({ lookup: fakeLookup({ 'tiles.example.com': ['203.0.113.10'] }) });
    const rawConfig = {
      services: {
        good: {
          upstreamUrlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
          allowedExtensions: ['png'],
        },
      },
    };
    const runtimeConfig = await buildRuntimeConfig(rawConfig, {}, { ssrfValidator });
    expect(runtimeConfig.services.good.upstreamUrlTemplate).toBe('https://tiles.example.com/{z}/{x}/{y}.png');
  });
});
