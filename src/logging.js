export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

const SECRET_PARAM_PATTERN = /key|token|secret|auth|sig|password|pwd/i;

export function maskSecret(value) {
  if (value.length <= 6) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/**
 * Returns the URL as a string that is safe to log: the value of the configured
 * API key parameter (and any parameter whose name looks like a credential,
 * e.g. one embedded directly in upstreamUrlTemplate) is masked unless
 * `reveal` is set.
 */
export function redactUrl(url, { secretParams = [], reveal = false } = {}) {
  if (reveal) return url.href;
  const redacted = new URL(url);
  const explicit = new Set(secretParams.map((name) => name.toLowerCase()));
  for (const name of new Set(redacted.searchParams.keys())) {
    if (explicit.has(name.toLowerCase()) || SECRET_PARAM_PATTERN.test(name)) {
      redacted.searchParams.set(name, maskSecret(redacted.searchParams.get(name)));
    }
  }
  return redacted.href;
}

export function describeAuth(service) {
  const modes = [];
  if (service.apiKeyParamName && service.apiKeyValue) modes.push(`query-param:${service.apiKeyParamName}`);
  if (service.headers && Object.keys(service.headers).length > 0) modes.push('headers');
  return modes.length > 0 ? modes.join('+') : 'none';
}
