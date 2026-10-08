import net from 'node:net';
import dns from 'node:dns';

const FORBIDDEN_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

/**
 * Ranges an SSRF-hardened proxy must never be allowed to reach, regardless of
 * any explicit allowlist: loopback, private, link-local (incl. cloud metadata
 * endpoints at 169.254.169.254 / fd00:ec2::254), and unspecified addresses.
 */
function isForbiddenIpv4(ip) {
  const parts = ip.split('.').map(Number);
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 0) return true; // "this network"
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isForbiddenIpv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) return isForbiddenIpv4(mapped);
  }
  if (normalized.startsWith('fe80:')) return true; // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
  return false;
}

export function isForbiddenAddress(ip) {
  if (net.isIPv4(ip)) return isForbiddenIpv4(ip);
  if (net.isIPv6(ip)) return isForbiddenIpv6(ip);
  return true; // unrecognized shape, fail closed
}

function wildcardHostToRegex(pattern) {
  const escaped = pattern
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

export function hostMatchesAllowlist(hostname, allowlist) {
  const lower = hostname.toLowerCase();
  return allowlist.some((pattern) => wildcardHostToRegex(pattern).test(lower));
}

export class SsrfValidationError extends Error {}

/**
 * Validates that a configured upstream hostname is safe to connect to.
 * Runs once at config-load time per service (not per-request), since the set
 * of reachable upstreams is fixed by the operator's config rather than by
 * end-user input.
 */
export function createSsrfValidator({ lookup = dns.promises.lookup } = {}) {
  return async function assertUpstreamHostAllowed(hostname, { allowedUpstreamHosts } = {}) {
    const lower = hostname.toLowerCase();

    if (FORBIDDEN_HOSTNAMES.has(lower)) {
      throw new SsrfValidationError(`Upstream host "${hostname}" is not allowed`);
    }

    if (allowedUpstreamHosts && allowedUpstreamHosts.length > 0) {
      if (!hostMatchesAllowlist(lower, allowedUpstreamHosts)) {
        throw new SsrfValidationError(
          `Upstream host "${hostname}" is not in the configured allowlist`
        );
      }
    }

    if (net.isIP(hostname)) {
      if (isForbiddenAddress(hostname)) {
        throw new SsrfValidationError(`Upstream host "${hostname}" resolves to a forbidden address`);
      }
      return;
    }

    let addresses;
    try {
      addresses = await lookup(hostname, { all: true });
    } catch (err) {
      throw new SsrfValidationError(`Could not resolve upstream host "${hostname}": ${err.message}`);
    }

    for (const { address } of addresses) {
      if (isForbiddenAddress(address)) {
        throw new SsrfValidationError(
          `Upstream host "${hostname}" resolves to forbidden address ${address}`
        );
      }
    }
  };
}
