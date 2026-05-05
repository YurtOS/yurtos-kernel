import { describe, it, beforeEach, afterEach } from '@std/testing/bdd';
import { expect, fn as mock } from '@std/expect';
import { NetworkGateway } from '../gateway.js';

/**
 * Cross-origin redirect sensitive-header stripping.
 *
 * The Worker bridge in network/bridge.ts drops Authorization and Cookie
 * headers when a redirect crosses origins (bridge.ts:178-186). This is a
 * defense-in-depth measure: an attacker who controls a redirect target
 * within the allow-list shouldn't be able to harvest credentials meant
 * for the original origin.
 *
 * NetworkGateway.fetch() runs on the main thread and is used by host
 * code outside the Worker bridge path (e.g. browser embedding via
 * BrowserNetworkBridge). The same hardening must apply there.
 */

/** Lower-case the headers a mocked fetch was called with, regardless of
 *  whether the caller passed a Headers instance, an array of pairs, or
 *  a plain object. Returned shape is the same in all three cases so the
 *  assertions below don't have to know which carrier was used. */
function recordedHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

/** Install a mock for globalThis.fetch that issues one redirect to
 *  `redirectTo` and then 200s. Returns the captured headers per call. */
function mockRedirectChain(redirectTo: string): Array<Record<string, string>> {
  const captured: Array<Record<string, string>> = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    captured.push(recordedHeaders(init));
    if (captured.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: redirectTo },
      });
    }
    return new Response('ok');
  }) as typeof fetch;
  return captured;
}

describe('NetworkGateway.fetch — cross-origin redirect header hygiene', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('strips Authorization on redirect to a different host', async () => {
    const calls = mockRedirectChain('https://other.com/landing');

    const gw = new NetworkGateway({ allowedHosts: ['*'] });
    await gw.fetch('https://example.com/api', {
      headers: { Authorization: 'Bearer secret-token', 'X-Trace': 'keep-me' },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]['authorization']).toBe('Bearer secret-token');
    expect(calls[1]['authorization']).toBeUndefined();
    expect(calls[1]['x-trace']).toBe('keep-me');
  });

  it('strips Cookie on redirect to a different host', async () => {
    const calls = mockRedirectChain('https://other.com/');

    const gw = new NetworkGateway({ allowedHosts: ['*'] });
    await gw.fetch('https://example.com/api', {
      headers: { Cookie: 'session=abc' },
    });
    expect(calls[0]['cookie']).toBe('session=abc');
    expect(calls[1]['cookie']).toBeUndefined();
  });

  it('strips case-variant header names (AUTHORIZATION, COOKIE)', async () => {
    const calls = mockRedirectChain('https://other.com/');

    const gw = new NetworkGateway({ allowedHosts: ['*'] });
    await gw.fetch('https://example.com/api', {
      headers: { AUTHORIZATION: 'Bearer x', COOKIE: 'session=y' },
    });
    expect(calls[1]['authorization']).toBeUndefined();
    expect(calls[1]['cookie']).toBeUndefined();
  });

  it('preserves Authorization on same-host redirects', async () => {
    const calls = mockRedirectChain('https://example.com/v2/api');

    const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
    await gw.fetch('https://example.com/v1/api', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(calls[1]['authorization']).toBe('Bearer secret-token');
  });

  it('handles caller passing a Headers instance', async () => {
    const calls = mockRedirectChain('https://other.com/');

    const gw = new NetworkGateway({ allowedHosts: ['*'] });
    const headers = new Headers();
    headers.set('Authorization', 'Bearer secret');
    await gw.fetch('https://example.com/api', { headers });
    expect(calls[0]['authorization']).toBe('Bearer secret');
    expect(calls[1]['authorization']).toBeUndefined();
  });

  it('handles caller passing an array-of-pairs headers form', async () => {
    const calls = mockRedirectChain('https://other.com/');

    const gw = new NetworkGateway({ allowedHosts: ['*'] });
    await gw.fetch('https://example.com/api', {
      headers: [['Authorization', 'Bearer secret'], ['X-Trace', 'keep']],
    });
    expect(calls[0]['authorization']).toBe('Bearer secret');
    expect(calls[1]['authorization']).toBeUndefined();
    expect(calls[1]['x-trace']).toBe('keep');
  });

  // Pin the documented A→B→A behavior so it doesn't regress silently.
  // Comparison is per-hop against the original hostname, so a redirect
  // back to the original origin re-attaches credentials. See gateway.ts.
  it('re-attaches credentials when a redirect chain bounces back to origin', async () => {
    const calls: Array<Record<string, string>> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(recordedHeaders(init));
      const u = String(url);
      if (u === 'https://example.com/api') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://other.com/bounce' },
        });
      }
      if (u === 'https://other.com/bounce') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://example.com/final' },
        });
      }
      return new Response('ok');
    }) as typeof fetch;

    const gw = new NetworkGateway({ allowedHosts: ['*'] });
    await gw.fetch('https://example.com/api', {
      headers: { Authorization: 'Bearer secret' },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]['authorization']).toBe('Bearer secret'); // initial
    expect(calls[1]['authorization']).toBeUndefined();       // crossed to other.com
    // Hop 3 is back to example.com (the original origin) — comparison is
    // against the original hostname, not the previous hop, so credentials
    // re-attach. See the comment in gateway.ts for the rationale.
    expect(calls[2]['authorization']).toBe('Bearer secret');
  });
});
