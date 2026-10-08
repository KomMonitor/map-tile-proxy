import { Writable } from 'node:stream';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { buildRuntimeConfig } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { createMetrics } from '../../src/metrics/registry.js';

/**
 * Installs a fresh undici MockAgent as the global dispatcher so tileClient's
 * plain `undici.request()` calls are intercepted without any test-only
 * indirection in production code.
 */
export function installMockAgent() {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  return mockAgent;
}

const fakeLookup = async (hostname) => {
  // Deterministic, always-public resolution for tests - no real DNS/network.
  if (hostname.includes('private') || hostname.includes('internal')) {
    return [{ address: '10.0.0.5', family: 4 }];
  }
  return [{ address: '203.0.113.10', family: 4 }];
};

/** A pino-compatible destination that collects parsed log lines for assertions. */
export function createLogCapture() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, stream };
}

export async function buildTestApp(rawConfig, env = {}, { logger = false } = {}) {
  const runtimeConfig = await buildRuntimeConfig(rawConfig, env, {
    ssrfValidator: (await import('../../src/security/ssrf.js')).createSsrfValidator({ lookup: fakeLookup }),
  });
  const metrics = createMetrics();
  const app = await buildApp(runtimeConfig, { logger, metrics });
  return { app, runtimeConfig, metrics };
}
