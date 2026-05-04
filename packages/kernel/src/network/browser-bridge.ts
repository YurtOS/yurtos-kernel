/**
 * BrowserNetworkBridge: async network bridge for browser environments.
 *
 * Uses the browser's native fetch() API directly. Since WASM runs on the main
 * thread in browsers (where Atomics.wait() is not allowed), this bridge relies
 * on JSPI to suspend the WASM stack while the fetch completes asynchronously.
 *
 * Provides fetchAsync() for the kernel import's async path. fetchSync() throws
 * since it cannot block in a browser main thread.
 */

import type { FetchRedirectMode, NetworkBridgeLike, SyncFetchResult, SyncRequestResult } from './bridge.js';
import { NetworkGateway } from './gateway.js';
import type { NetworkPolicy } from './gateway.js';

export class BrowserNetworkBridge implements NetworkBridgeLike {
  private gateway: NetworkGateway;

  constructor(policy: NetworkPolicy) {
    this.gateway = new NetworkGateway(policy);
  }

  fetchSync(): SyncFetchResult {
    return { status: 0, body: '', headers: {}, error: 'fetchSync not available in browser — use fetchAsync via JSPI' };
  }

  async fetchAsync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    redirect: FetchRedirectMode = 'follow',
  ): Promise<SyncFetchResult> {
    // Check gateway policy
    const access = this.gateway.checkAccess(url, method);
    if (!access.allowed) {
      return { status: 403, body: '', headers: {}, error: access.reason };
    }

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body || undefined,
        redirect,
      });

      const bytes = new Uint8Array(await resp.arrayBuffer());
      const respBody = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const body_base64 = btoa(binary);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });

      return {
        status: resp.status,
        body: respBody,
        body_base64,
        headers: respHeaders,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Browser fetch() throws "Failed to fetch" for CORS / network errors
      if (msg === 'Failed to fetch') {
        return { status: 0, body: '', headers: {}, error: `network error (likely CORS: ${url} does not allow cross-origin requests)` };
      }
      return { status: 0, body: '', headers: {}, error: msg };
    }
  }

  requestSync(): SyncRequestResult {
    return { ok: false, error: 'requestSync not available in browser' };
  }

  async start(): Promise<void> {
    // No worker to start in browser mode
  }

  stop(): void {
    // No worker to stop
  }
}
