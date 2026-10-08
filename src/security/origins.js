function wildcardOriginToRegex(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

export function parseAllowedOrigins(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(',');
  return list.map((s) => s.trim()).filter(Boolean);
}

export function isOriginAllowed(origin, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.length === 0) return false;
  return allowedOrigins.some((pattern) => wildcardOriginToRegex(pattern).test(origin));
}
