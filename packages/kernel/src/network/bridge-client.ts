/**
 * BridgeClient: Worker-side network bridge using the same SAB protocol as NetworkBridge.
 *
 * Runs inside a Worker thread using the SharedArrayBuffer created by the
 * main-thread NetworkBridge. Encodes requests, signals the bridge worker,
 * and waits synchronously for the response.
 */

import type { FetchRedirectMode, NetworkBridgeLike, SyncFetchResult, SyncRequestResult } from './bridge.js';
import type { NetworkGateway } from './gateway.js';

const STATUS_IDLE = 0;
const STATUS_REQUEST_READY = 1;
const STATUS_ERROR = 3;

export class BridgeClient implements NetworkBridgeLike {
  private int32: Int32Array;
  private uint8: Uint8Array;
  private gateway: NetworkGateway | null;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(sab: SharedArrayBuffer, gateway?: NetworkGateway) {
    this.int32 = new Int32Array(sab);
    this.uint8 = new Uint8Array(sab);
    this.gateway = gateway ?? null;
  }

  fetchSync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    redirect?: FetchRedirectMode,
  ): SyncFetchResult {
    // Check gateway policy synchronously first
    if (this.gateway) {
      const access = this.gateway.checkAccess(url, method);
      if (!access.allowed) {
        return { status: 403, body: '', headers: {}, error: access.reason };
      }
    }

    const reqJson = JSON.stringify({ url, method, headers, body, redirect });
    const reqEncoded = this.encoder.encode(reqJson);
    if (reqEncoded.byteLength > this.uint8.byteLength - 8) {
      return { status: 413, body: '', headers: {}, error: 'request too large' };
    }
    this.uint8.set(reqEncoded, 8);
    Atomics.store(this.int32, 1, reqEncoded.byteLength);
    Atomics.store(this.int32, 0, STATUS_REQUEST_READY);
    Atomics.notify(this.int32, 0);

    // Block until response (30-second timeout)
    const waitResult = Atomics.wait(this.int32, 0, STATUS_REQUEST_READY, 30_000);
    if (waitResult === 'timed-out') {
      Atomics.store(this.int32, 0, STATUS_IDLE);
      return { status: 0, body: '', headers: {}, error: 'network request timed out' };
    }

    const status = Atomics.load(this.int32, 0);
    const len = Atomics.load(this.int32, 1);
    const respJson = this.decoder.decode(this.uint8.slice(8, 8 + len));

    // Reset to idle
    Atomics.store(this.int32, 0, STATUS_IDLE);

    const result = JSON.parse(respJson) as SyncFetchResult;
    if (status === STATUS_ERROR) {
      result.error = result.error || 'unknown error';
    }
    return result;
  }

  requestSync(op: Record<string, unknown>): SyncRequestResult {
    const reqJson = JSON.stringify(op);
    const reqEncoded = this.encoder.encode(reqJson);
    if (reqEncoded.byteLength > this.uint8.byteLength - 8) {
      return { ok: false, error: 'request too large' };
    }
    this.uint8.set(reqEncoded, 8);
    Atomics.store(this.int32, 1, reqEncoded.byteLength);
    Atomics.store(this.int32, 0, STATUS_REQUEST_READY);
    Atomics.notify(this.int32, 0);

    const waitResult = Atomics.wait(this.int32, 0, STATUS_REQUEST_READY, 30_000);
    if (waitResult === 'timed-out') {
      Atomics.store(this.int32, 0, STATUS_IDLE);
      return { ok: false, error: 'request timed out' };
    }

    const len = Atomics.load(this.int32, 1);
    const respJson = this.decoder.decode(this.uint8.slice(8, 8 + len));
    Atomics.store(this.int32, 0, STATUS_IDLE);
    return JSON.parse(respJson) as SyncRequestResult;
  }
}
