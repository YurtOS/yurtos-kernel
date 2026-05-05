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
 * BrowserNetworkBridge). The same hardening should apply there.
 */
describe('NetworkGateway.fetch — cross-origin redirect header hygiene', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('strips Authorization on redirect to a different host', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        } else {
          for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
            headers[k.toLowerCase()] = v;
          }
        }
      }
      calls.push({ url: String(url), headers });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://other.com/landing' },
        });
      }
      return new Response('ok');
    }) as typeof fetch;

    const gw = new NetworkGateway({ allowedHosts: ['*'] });
    await gw.fetch('https://example.com/api', {
      headers: { Authorization: 'Bearer secret-token', 'X-Trace': 'keep-me' },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].headers['authorization']).toBe('Bearer secret-token');
    // Hop crossed origins (example.com -> other.com): credentials must not leak.
    expect(calls[1].headers['authorization']).toBeUndefined();
    // Non-sensitive headers may still propagate.
    expect(calls[1].headers['x-trace']).toBe('keep-me');
  });

  it('strips Cookie on redirect to a different host', async () => {
    const calls: Record<string, string>[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
      calls.push(headers);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://other.com/' },
        });
      }
      return new Response('ok');
    }) as typeof fetch;

    const gw = new NetworkGateway({ allowedHosts: ['*'] });
    await gw.fetch('https://example.com/api', {
      headers: { Cookie: 'session=abc' },
    });
    expect(calls[1]['cookie']).toBeUndefined();
  });

  it('preserves Authorization on same-host redirects', async () => {
    const calls: Record<string, string>[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
      calls.push(headers);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://example.com/v2/api' },
        });
      }
      return new Response('ok');
    }) as typeof fetch;

    const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
    await gw.fetch('https://example.com/v1/api', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(calls[1]['authorization']).toBe('Bearer secret-token');
  });
});
