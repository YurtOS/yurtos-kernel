/**
 * Shared host pattern matching for network policy enforcement.
 *
 * Used by both NetworkGateway (main thread) and the bridge worker (inline).
 * The worker uses `HOST_MATCH_SOURCE` (a plain JS string) since it runs
 * inside an eval'd Worker and cannot import modules.
 */

/** Check if a hostname matches any pattern in the list. */
export function matchesHostList(host: string, list: string[]): boolean {
  for (const pattern of list) {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      if (
        host.endsWith(suffix) &&
        host.length > suffix.length &&
        host[host.length - suffix.length - 1] === '.'
      ) {
        return true;
      }
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Plain JS source for matchesHostList, for embedding in Worker eval code.
 * Must be kept in sync with the function above.
 */
export const HOST_MATCH_SOURCE = `\
function matchesHostList(host, list) {
  for (const pattern of list) {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      if (
        host.endsWith(suffix) &&
        host.length > suffix.length &&
        host[host.length - suffix.length - 1] === '.'
      ) return true;
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}`;
