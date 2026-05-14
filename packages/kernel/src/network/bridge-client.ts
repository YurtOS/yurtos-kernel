/**
 * BridgeClient: Worker-side network bridge using the same SAB protocol as NetworkBridge.
 *
 * Runs inside a Worker thread using the SharedArrayBuffer created by the
 * main-thread NetworkBridge. Encodes requests, signals the bridge worker,
 * and waits synchronously for the response.
 */

import type {
  FetchRedirectMode,
  FetchRequestBody,
  NetworkBridgeLike,
  SyncFetchResult,
  SyncRequestResult,
} from "./bridge.js";
import type { NetworkGateway } from "./gateway.js";

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

  // BridgeClient runs in the execution-worker. That worker is ALSO the
  // worker-host dispatcher for any pthreads cpython spawns (libzmq's
  // I/O reactor, etc.). A blocking `Atomics.wait` here would freeze the
  // execution-worker's event loop and prevent it from draining
  // "host-call" postMessages from those nested workers — the same
  // dispatcher deadlock the SabMutex.lockAsync fix (dc58e1c) addressed
  // at the main thread. Use `Atomics.waitAsync` so the event loop stays
  // drained while we wait for the bridge worker's response.
  async fetchSync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: FetchRequestBody,
    redirect?: FetchRedirectMode,
  ): Promise<SyncFetchResult> {
    // Check gateway policy synchronously first
    if (this.gateway) {
      const access = this.gateway.checkAccess(url, method);
      if (!access.allowed) {
        return { status: 403, body: "", headers: {}, error: access.reason };
      }
    }

    const reqJson = JSON.stringify({
      url,
      method,
      headers,
      body: body instanceof Uint8Array ? undefined : body,
      body_base64: body instanceof Uint8Array ? bytesToBase64(body) : undefined,
      redirect,
    });
    const reqEncoded = this.encoder.encode(reqJson);
    if (reqEncoded.byteLength > this.uint8.byteLength - 8) {
      return { status: 413, body: "", headers: {}, error: "request too large" };
    }
    this.uint8.set(reqEncoded, 8);
    Atomics.store(this.int32, 1, reqEncoded.byteLength);
    Atomics.store(this.int32, 0, STATUS_REQUEST_READY);
    Atomics.notify(this.int32, 0);

    const wait = Atomics.waitAsync(
      this.int32,
      0,
      STATUS_REQUEST_READY,
      30_000,
    );
    const waitResult = wait.async ? await wait.value : "not-equal";
    if (waitResult === "timed-out") {
      Atomics.store(this.int32, 0, STATUS_IDLE);
      return {
        status: 0,
        body: "",
        headers: {},
        error: "network request timed out",
      };
    }

    const status = Atomics.load(this.int32, 0);
    const len = Atomics.load(this.int32, 1);
    const respJson = this.decoder.decode(this.uint8.slice(8, 8 + len));

    // Reset to idle
    Atomics.store(this.int32, 0, STATUS_IDLE);

    const result = JSON.parse(respJson) as SyncFetchResult;
    if (status === STATUS_ERROR) {
      result.error = result.error || "unknown error";
    }
    return result;
  }

  async requestSync(op: Record<string, unknown>): Promise<SyncRequestResult> {
    const reqJson = JSON.stringify(op);
    const reqEncoded = this.encoder.encode(reqJson);
    if (reqEncoded.byteLength > this.uint8.byteLength - 8) {
      return { ok: false, error: "request too large" };
    }
    this.uint8.set(reqEncoded, 8);
    Atomics.store(this.int32, 1, reqEncoded.byteLength);
    Atomics.store(this.int32, 0, STATUS_REQUEST_READY);
    Atomics.notify(this.int32, 0);

    const wait = Atomics.waitAsync(
      this.int32,
      0,
      STATUS_REQUEST_READY,
      30_000,
    );
    const waitResult = wait.async ? await wait.value : "not-equal";
    if (waitResult === "timed-out") {
      Atomics.store(this.int32, 0, STATUS_IDLE);
      return { ok: false, error: "request timed out" };
    }

    const len = Atomics.load(this.int32, 1);
    const respJson = this.decoder.decode(this.uint8.slice(8, 8 + len));
    Atomics.store(this.int32, 0, STATUS_IDLE);
    return JSON.parse(respJson) as SyncRequestResult;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
