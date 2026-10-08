import { readFileSync } from 'node:fs';
import { createSsrfValidator, SsrfValidationError } from './security/ssrf.js';
import { parseAllowedOrigins } from './security/origins.js';
import { LOG_LEVELS } from './logging.js';

const DEFAULT_TIMEOUT_MS = 5000;
const VALID_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

const nonEmpty = (value) => (value === '' ? undefined : value);

function extractTemplateHostname(urlTemplate) {
  const literal = urlTemplate.replace(/\{z\}/g, '0').replace(/\{x\}/g, '0').replace(/\{y\}/g, '0');
  let parsed;
  try {
    parsed = new URL(literal);
  } catch {
    throw new Error(`upstreamUrlTemplate "${urlTemplate}" is not a valid URL`);
  }
  return parsed;
}

export function loadConfigFile(path) {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Validates and normalizes the raw config object, applying environment
 * variable overrides, and runs SSRF validation against every configured
 * upstream host. Throws on any invalid or unsafe configuration - the service
 * refuses to start rather than run with a bad config.
 */
export async function buildRuntimeConfig(rawConfig, env = process.env, { ssrfValidator } = {}) {
  const assertUpstreamHostAllowed = ssrfValidator ?? createSsrfValidator();

  const port = Number(env.PORT ?? rawConfig.port ?? 8080);
  const requestTimeoutMs = Number(env.REQUEST_TIMEOUT_MS ?? rawConfig.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fallbackOnError = String(env.FALLBACK_ON_ERROR ?? rawConfig.fallbackOnError ?? true) !== 'false';

  const logLevel = String(nonEmpty(env.LOG_LEVEL) ?? rawConfig.logLevel ?? 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`invalid log level "${logLevel}", expected one of: ${LOG_LEVELS.join(', ')}`);
  }
  const logRevealApiKeys = String(nonEmpty(env.LOG_REVEAL_API_KEYS) ?? rawConfig.logRevealApiKeys ?? false) === 'true';

  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS ?? rawConfig.allowedOrigins ?? []);
  const allowedUpstreamHosts = parseAllowedOrigins(
    env.ALLOWED_UPSTREAM_HOSTS ?? rawConfig.allowedUpstreamHosts ?? []
  );

  if (!rawConfig.services || typeof rawConfig.services !== 'object' || Object.keys(rawConfig.services).length === 0) {
    throw new Error('config must define at least one entry under "services"');
  }

  const services = {};
  for (const [serviceId, def] of Object.entries(rawConfig.services)) {
    if (!def.upstreamUrlTemplate) {
      throw new Error(`service "${serviceId}" is missing "upstreamUrlTemplate"`);
    }
    const parsedUrl = extractTemplateHostname(def.upstreamUrlTemplate);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`service "${serviceId}" has unsupported protocol "${parsedUrl.protocol}"`);
    }

    await assertUpstreamHostAllowed(parsedUrl.hostname, { allowedUpstreamHosts }).catch((err) => {
      if (err instanceof SsrfValidationError) {
        throw new Error(`service "${serviceId}": ${err.message}`);
      }
      throw err;
    });

    const allowedExtensions = (def.allowedExtensions ?? ['png', 'jpg', 'jpeg']).map((e) => e.toLowerCase());
    for (const ext of allowedExtensions) {
      if (!VALID_EXTENSIONS.has(ext)) {
        throw new Error(`service "${serviceId}" declares unsupported extension "${ext}"`);
      }
    }

    services[serviceId] = {
      id: serviceId,
      upstreamUrlTemplate: def.upstreamUrlTemplate,
      apiKeyParamName: def.apiKeyParamName ?? null,
      apiKeyValue: def.apiKeyValue ?? null,
      headers: def.headers ?? {},
      allowedExtensions,
      timeoutMs: Number(def.timeoutMs ?? requestTimeoutMs),
      fallbackOnError: def.fallbackOnError ?? fallbackOnError,
    };
  }

  return {
    port,
    requestTimeoutMs,
    fallbackOnError,
    logLevel,
    logRevealApiKeys,
    allowedOrigins,
    allowedUpstreamHosts,
    services,
  };
}

export async function loadRuntimeConfig(path, env = process.env, opts = {}) {
  const raw = loadConfigFile(path);
  return buildRuntimeConfig(raw, env, opts);
}
