/**
 * NetworkGateway: policy enforcement layer for all sandbox network access.
 *
 * Checks requests against allowedHosts/blockedHosts lists and an optional
 * async callback before delegating to the host fetch() API. Used by shell
 * builtins (curl, wget) and the WASI socket bridge.
 */

import { matchesHostList } from './host-match.js';

export interface NetworkPolicy {
  /** Whitelist mode: only these hosts allowed. Supports wildcards (*.example.com). */
  allowedHosts?: string[];
  /** Blacklist mode: these hosts blocked. Ignored if allowedHosts is set. */
  blockedHosts?: string[];
  /** Async callback for dynamic allow/deny. Called after static checks pass. */
  onRequest?: (request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  }) => Promise<boolean>;
  /**
   * Network mode:
   * - `"restricted"` (default): HTTP/HTTPS only via fetch(). Works in browser + Deno.
   * - `"full"`: Real TCP/TLS sockets via host. Any protocol. Deno/Node only.
   */
  mode?: 'restricted' | 'full';
  /** Whether to allow listening on ports. Default: false. */
  allowListen?: boolean;
}

export class NetworkAccessDenied extends Error {
  constructor(url: string, reason: string) {
    super(`Network access denied for ${url}: ${reason}`);
    this.name = 'NetworkAccessDenied';
  }
}

/** Maximum number of HTTP redirects to follow before aborting. */
const MAX_REDIRECTS = 5;

/** HTTP status codes that indicate a redirect. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class NetworkGateway {
  private policy: NetworkPolicy;

  constructor(policy: NetworkPolicy) {
    this.policy = policy;
  }

  /** Return the allowed hosts list (for passing to worker threads). */
  getAllowedHosts(): string[] | undefined {
    return this.policy.allowedHosts;
  }

  /** Return the blocked hosts list (for passing to worker threads). */
  getBlockedHosts(): string[] | undefined {
    return this.policy.blockedHosts;
  }

  /** Return the network mode. */
  getMode(): 'restricted' | 'full' {
    return this.policy.mode ?? 'restricted';
  }

  /** Check whether raw socket operations are allowed to the given host. */
  checkSocketAccess(host: string): { allowed: boolean; reason?: string } {
    if (this.getMode() !== 'full') {
      return { allowed: false, reason: 'raw sockets not available in restricted mode' };
    }
    return this.checkHostAccess(host);
  }

  /** Synchronous host check against allow/block lists. */
  private checkHostAccess(host: string): { allowed: boolean; reason?: string } {
    const { allowedHosts, blockedHosts } = this.policy;
    if (allowedHosts !== undefined) {
      if (matchesHostList(host, allowedHosts)) return { allowed: true };
      return { allowed: false, reason: `host ${host} not in allowedHosts` };
    }
    if (blockedHosts !== undefined) {
      if (matchesHostList(host, blockedHosts)) return { allowed: false, reason: `host ${host} is in blockedHosts` };
      return { allowed: true };
    }
    return { allowed: false, reason: 'no network policy configured (default deny)' };
  }

  /** Synchronous check against allow/block lists. */
  checkAccess(url: string, _method: string): { allowed: boolean; reason?: string } {
    const host = this.extractHost(url);
    if (host === null) {
      return { allowed: false, reason: 'invalid URL' };
    }
    return this.checkHostAccess(host);
  }

  /** Fetch with policy enforcement. Throws NetworkAccessDenied on denial. */
  async fetch(url: string, options?: RequestInit): Promise<Response> {
    let currentUrl = url;
    let currentMethod = options?.method ?? 'GET';
    let currentBody: BodyInit | null | undefined = options?.body;

    let redirectCount = 0;

    for (;;) {
      const headers: Record<string, string> = {};
      if (options?.headers) {
        const h = options.headers;
        if (h instanceof Headers) {
          h.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) { headers[k] = v; }
        } else {
          Object.assign(headers, h);
        }
      }

      // Static check
      const access = this.checkAccess(currentUrl, currentMethod);
      if (!access.allowed) {
        throw new NetworkAccessDenied(currentUrl, access.reason!);
      }

      // Dynamic callback check
      if (this.policy.onRequest) {
        const allowed = await this.policy.onRequest({ url: currentUrl, method: currentMethod, headers });
        if (!allowed) {
          throw new NetworkAccessDenied(currentUrl, 'denied by onRequest callback');
        }
      }

      const resp = await globalThis.fetch(currentUrl, {
        ...options,
        method: currentMethod,
        body: currentBody,
        redirect: 'manual',
      });

      if (!REDIRECT_STATUSES.has(resp.status)) {
        return resp;
      }

      const location = resp.headers.get('Location');
      if (!location) {
        return resp; // No Location header — return as-is
      }

      // Resolve relative redirects against current URL
      currentUrl = new URL(location, currentUrl).href;

      // 303: change method to GET and drop body (RFC 7231)
      if (resp.status === 303) {
        currentMethod = 'GET';
        currentBody = undefined;
      }

      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        throw new NetworkAccessDenied(currentUrl, 'too many redirects');
      }
    }
  }

  /**
   * Read response body as text with a size limit.
   * Streams the body and truncates at maxBytes (default 10MB).
   */
  static async readResponseBody(response: Response, maxBytes = 10 * 1024 * 1024): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      return '';
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - totalBytes;
        if (remaining <= 0) break;
        if (value.byteLength <= remaining) {
          chunks.push(value);
          totalBytes += value.byteLength;
        } else {
          chunks.push(value.subarray(0, remaining));
          totalBytes += remaining;
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Concatenate and decode
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(result);
  }

  /**
   * Read response body as ArrayBuffer with a size limit.
   * Returns null if the body exceeds maxBytes.
   */
  static async readResponseArrayBuffer(response: Response, maxBytes = 10 * 1024 * 1024): Promise<ArrayBuffer | null> {
    const reader = response.body?.getReader();
    if (!reader) {
      return new ArrayBuffer(0);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          return null; // exceeded limit
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result.buffer;
  }

  private extractHost(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

}
