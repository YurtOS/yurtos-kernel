/**
 * NetworkBridge: sync-async bridge for WASI socket calls.
 *
 * Uses SharedArrayBuffer + Atomics to allow synchronous WASM code to
 * make network requests fulfilled asynchronously by a Worker.
 *
 * Protocol (over SharedArrayBuffer):
 *   Int32[0] = status: 0=idle, 1=request_ready, 2=response_ready, 3=error
 *   Int32[1] = data length (bytes)
 *   Bytes 8+ = JSON request or response payload
 */

import type { Worker } from "node:worker_threads";
import type { NetworkGateway } from "./gateway.js";
import { HOST_MATCH_SOURCE } from "./host-match.js";

const SAB_SIZE = 16 * 1024 * 1024; // 16MB
const STATUS_IDLE = 0;
const STATUS_REQUEST_READY = 1;
const STATUS_RESPONSE_READY = 2;
const STATUS_ERROR = 3;

export interface SyncFetchResult {
  status: number;
  body: string;
  /** Base64-encoded response body for lossless binary transfer (wheels, WASM). */
  body_base64?: string;
  headers: Record<string, string>;
  error?: string;
}

export type FetchRedirectMode = "follow" | "manual";
export type FetchRequestBody = string | Uint8Array | null;

/** Generic sync request/response for any bridge operation. */
export interface SyncRequestResult {
  ok: boolean;
  [key: string]: unknown;
}

/** Minimal interface for network access from WASM host imports.
 *
 * Both methods return Promises even though the legacy naming (`fetchSync`,
 * `requestSync`) hints at synchronous calls. The names are kept to avoid a
 * sprawling rename across host imports; semantically these are async after
 * the bridge moved from `Atomics.wait` to `Atomics.waitAsync` (the
 * second-layer fix for the worker-host dispatcher deadlock pinned by
 * `libzmq-reactor-spawn_reproducer_test.ts`). The async transport lets
 * main's event loop drain `host-call` postMessages from spawned workers
 * while the bridge worker fulfils the request.
 */
export interface NetworkBridgeLike {
  fetchSync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: FetchRequestBody,
    redirect?: FetchRedirectMode,
  ): Promise<SyncFetchResult>;
  /** Async fetch — used in the browser where Atomics.wait() isn't available on the main thread. */
  fetchAsync?(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: FetchRequestBody,
    redirect?: FetchRedirectMode,
  ): Promise<SyncFetchResult>;
  /** Send a generic operation (connect/send/recv/close) through the bridge. */
  requestSync(op: Record<string, unknown>): Promise<SyncRequestResult>;
}

export class NetworkBridge implements NetworkBridgeLike {
  private sab: SharedArrayBuffer;
  private int32: Int32Array;
  private uint8: Uint8Array;
  private worker: Worker | null = null;
  private gateway: NetworkGateway;

  constructor(gateway: NetworkGateway) {
    this.gateway = gateway;
    this.sab = new SharedArrayBuffer(SAB_SIZE);
    this.int32 = new Int32Array(this.sab);
    this.uint8 = new Uint8Array(this.sab);
  }

  /** Return the underlying SharedArrayBuffer for use in Worker threads. */
  getSab(): SharedArrayBuffer {
    return this.sab;
  }

  async start(): Promise<void> {
    const { Worker } = await import("node:worker_threads");
    const workerCode = `
      const { workerData, parentPort } = require('node:worker_threads');
      const sab = workerData.sab;
      const allowedHosts = workerData.allowedHosts;
      const blockedHosts = workerData.blockedHosts;
      const int32 = new Int32Array(sab);
      const uint8 = new Uint8Array(sab);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      ${HOST_MATCH_SOURCE}

      function checkAccess(url) {
        let host;
        try { host = new URL(url).hostname; }
        catch { return { allowed: false, reason: 'invalid URL' }; }

        if (allowedHosts !== undefined) {
          if (matchesHostList(host, allowedHosts)) return { allowed: true };
          return { allowed: false, reason: 'host ' + host + ' not in allowedHosts' };
        }
        if (blockedHosts !== undefined) {
          if (matchesHostList(host, blockedHosts)) return { allowed: false, reason: 'host ' + host + ' is in blockedHosts' };
          return { allowed: true };
        }
        return { allowed: false, reason: 'no network policy configured (default deny)' };
      }

      // Socket state for full mode
      const sockets = new Map();
      const listeners = new Map();
      const loopbackRoutes = new Map();
      let nextSocketId = 1;
      let nextListenerId = 1;
      let net = null;
      let tls = null;
      try { net = require('node:net'); tls = require('node:tls'); } catch {}

      function routeKey(host, port) {
        const normalized = host === 'localhost' ? '127.0.0.1' : host;
        return normalized + ':' + port;
      }

      function writeResponse(json, status) {
        const encoded = encoder.encode(json);
        uint8.set(encoded, 8);
        Atomics.store(int32, 1, encoded.byteLength);
        Atomics.store(int32, 0, status);
        Atomics.notify(int32, 0);
      }

      function writeOk(obj) {
        writeResponse(JSON.stringify(obj), ${STATUS_RESPONSE_READY});
      }

      function writeErr(msg) {
        writeResponse(JSON.stringify({ ok: false, error: msg }), ${STATUS_ERROR});
      }

      function checkHostAccess(host) {
        if (allowedHosts !== undefined) {
          if (matchesHostList(host, allowedHosts)) return { allowed: true };
          return { allowed: false, reason: 'host ' + host + ' not in allowedHosts' };
        }
        if (blockedHosts !== undefined) {
          if (matchesHostList(host, blockedHosts)) return { allowed: false, reason: 'host ' + host + ' is in blockedHosts' };
          return { allowed: true };
        }
        return { allowed: false, reason: 'no network policy configured (default deny)' };
      }

      async function handleFetch(req) {
        const access = checkAccess(req.url);
        if (!access.allowed) {
          writeResponse(JSON.stringify({ status: 403, body: '', headers: {}, error: access.reason }), ${STATUS_ERROR});
          return;
        }
        const manualRedirect = req.redirect === 'manual';
        const MAX_REDIRECTS = 5;
        const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
        let currentUrl = req.url;
        let currentMethod = req.method;
        let currentBody = req.body_base64
          ? Uint8Array.from(atob(req.body_base64), (c) => c.charCodeAt(0))
          : (req.body || undefined);
        let resp;
        let redirectCount = 0;

        for (;;) {
          if (redirectCount > 0) {
            const hopAccess = checkAccess(currentUrl);
            if (!hopAccess.allowed) {
              writeResponse(JSON.stringify({ status: 403, body: '', headers: {}, error: hopAccess.reason }), ${STATUS_ERROR});
              return;
            }
          }
          // Strip sensitive headers on cross-origin redirects.
          // Case-insensitive: HTTP header names are case-insensitive, and a
          // caller may legitimately pass 'AUTHORIZATION', 'set-cookie', etc.
          // Kept in sync with NetworkGateway.fetch in gateway.ts.
          let reqHeaders = req.headers;
          if (redirectCount > 0) {
            try {
              const origHost = new URL(req.url).hostname;
              const curHost = new URL(currentUrl).hostname;
              if (origHost !== curHost) {
                reqHeaders = Object.assign({}, req.headers);
                for (const key of Object.keys(reqHeaders)) {
                  const lower = key.toLowerCase();
                  if (lower === 'authorization' || lower === 'cookie') {
                    delete reqHeaders[key];
                  }
                }
              }
            } catch {}
          }
          resp = await fetch(currentUrl, {
            method: currentMethod,
            headers: reqHeaders,
            body: currentBody,
            redirect: 'manual',
          });
          if (manualRedirect) break;
          if (!REDIRECT_STATUSES.has(resp.status)) break;
          const location = resp.headers.get('location');
          if (!location) break;
          currentUrl = new URL(location, currentUrl).href;
          if (resp.status === 303) { currentMethod = 'GET'; currentBody = undefined; }
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            writeResponse(JSON.stringify({ status: 0, body: '', headers: {}, error: 'too many redirects' }), ${STATUS_ERROR});
            return;
          }
        }
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        // body: UTF-8 text (lossy, for backwards compat with curl/wget)
        const body = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        // body_base64: lossless binary encoding for wheels, WASM, images
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const body_base64 = btoa(binary);
        const headers = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        writeOk({ status: resp.status, body, headers, body_base64 });
      }

      async function handleConnect(req) {
        if (!net) { writeErr('sockets not available (no net module)'); return; }
        const access = checkHostAccess(req.host);
        if (!access.allowed) { writeErr(access.reason); return; }
        const requestedKey = routeKey(req.host, req.port);
        const routed = loopbackRoutes.get(requestedKey);
        const host = routed ? routed.host : req.host;
        const port = routed ? routed.port : req.port;
        const routedListener = routed ? listeners.get(routed.listenerId) : null;
        const acceptedReady = routedListener
          ? new Promise((resolve) => { routedListener.connectWaiters.push(resolve); })
          : Promise.resolve();
        const id = nextSocketId++;
        return new Promise((resolve) => {
          const connectFn = req.tls ? tls.connect : net.connect;
          const opts = { host, port };
          if (req.tls) opts.servername = req.host;
          const sock = connectFn(opts, async () => {
            sockets.set(id, sock);
            await acceptedReady;
            writeOk({ ok: true, socket_id: id });
            resolve();
          });
          sock.on('error', (err) => {
            sockets.delete(id);
            writeErr('connect: ' + err.message);
            resolve();
          });
          setTimeout(() => {
            if (!sockets.has(id)) {
              sock.destroy();
              writeErr('connect: timed out');
              resolve();
            }
          }, 30000);
        });
      }

      async function handleListen(req) {
        if (!net) { writeErr('sockets not available (no net module)'); return; }
        const listenerId = nextListenerId++;
        const server = net.createServer();
        const pending = [];
        const connectWaiters = [];
        server.on('connection', (sock) => {
          const socketId = nextSocketId++;
          sockets.set(socketId, sock);
          const item = {
            socket_id: socketId,
            peer_host: sock.remoteAddress || '127.0.0.1',
            peer_port: sock.remotePort || 0,
            local_host: req.host === '0.0.0.0' ? '10.0.2.15' : '127.0.0.1',
            local_port: req.port,
          };
          pending.push(item);
          // Unblock a routed-loopback connecting client whose
          // handleConnect is awaiting acceptedReady on this listener.
          const waiter = connectWaiters.shift();
          if (waiter) waiter();
        });
        const hostPort = req.mapping && req.host === '0.0.0.0' ? req.mapping.hostPort : 0;
        const bindHost = '127.0.0.1';
        return new Promise((resolve) => {
          let settled = false;
          function finishOk() {
            if (settled) return;
            settled = true;
            server.off('error', finishErr);
            const address = server.address();
            const actualPort = typeof address === 'object' && address ? address.port : hostPort;
            listeners.set(listenerId, { server, pending, connectWaiters, actualPort });
            loopbackRoutes.set(routeKey(req.host, req.port), { host: bindHost, port: actualPort, listenerId });
            if (req.host === 'localhost') loopbackRoutes.set(routeKey('127.0.0.1', req.port), { host: bindHost, port: actualPort, listenerId });
            writeOk({ ok: true, listener_id: listenerId, host: req.host, port: req.port });
            resolve();
          }
          function finishErr(err) {
            if (settled) return;
            settled = true;
            writeErr('listen: ' + err.message);
            resolve();
          }
          server.once('error', finishErr);
          server.listen({ host: bindHost, port: hostPort, backlog: req.backlog || 128 }, () => {
            finishOk();
          });
        });
      }

      function handleAccept(req) {
        const listener = listeners.get(req.listener_id);
        if (!listener) { writeErr('accept: invalid listener_id'); return; }
        if (listener.pending.length > 0) {
          const item = listener.pending.shift();
          writeOk({ ok: true, ...item });
          return;
        }
        // Bridge requests are serialized over the SAB, so a long-running
        // accept here would block any connect that's about to feed it.
        // Always reply immediately; the kernel-side adapter polls.
        writeOk({ ok: false, would_block: true, error: 'accept would block' });
      }

      function handleCloseListener(req) {
        const listener = listeners.get(req.listener_id);
        if (!listener) { writeErr('close_listener: invalid listener_id'); return; }
        listener.server.close();
        listeners.delete(req.listener_id);
        for (const [key, route] of loopbackRoutes.entries()) {
          if (route.listenerId === req.listener_id) loopbackRoutes.delete(key);
        }
        writeOk({ ok: true });
      }

      async function handleSend(req) {
        const sock = sockets.get(req.socket_id);
        if (!sock) { writeErr('send: invalid socket_id'); return; }
        if (!Array.isArray(req.data)) {
          writeErr('send: data must be an array of bytes');
          return;
        }
        const data = Buffer.from(req.data);
        return new Promise((resolve) => {
          sock.write(data, (err) => {
            if (err) { writeErr('send: ' + err.message); }
            else { writeOk({ ok: true, bytes_sent: data.length }); }
            resolve();
          });
        });
      }

      async function handleRecv(req) {
        const sock = sockets.get(req.socket_id);
        if (!sock) { writeErr('recv: invalid socket_id'); return; }
        const maxBytes = req.max_bytes || 65536;
        return new Promise((resolve) => {
          const chunk = sock.read(maxBytes);
          if (chunk) {
            writeOk({ ok: true, data: Array.from(chunk) });
            resolve();
            return;
          }
          if (req.nonblocking) {
            // After peer FIN with no buffered bytes, readableEnded
            // becomes true once the 'end' event has fired. Return EOF
            // (ok with empty bytes) so polling callers don't spin
            // forever after the peer closes.
            if (sock.readableEnded || sock.destroyed) {
              writeOk({ ok: true, data: [] });
            } else {
              writeErr('EAGAIN');
            }
            resolve();
            return;
          }
          // No data available yet — wait for readable or end
          let settled = false;
          const onReadable = () => {
            if (settled) return;
            settled = true;
            cleanup();
            const c = sock.read(maxBytes);
            writeOk({ ok: true, data: c ? Array.from(c) : [] });
            resolve();
          };
          const onEnd = () => {
            if (settled) return;
            settled = true;
            cleanup();
            writeOk({ ok: true, data: [] });
            resolve();
          };
          const onError = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            writeErr('recv: ' + err.message);
            resolve();
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            writeErr('recv: timed out');
            resolve();
          }, 30000);
          function cleanup() {
            clearTimeout(timer);
            sock.removeListener('readable', onReadable);
            sock.removeListener('end', onEnd);
            sock.removeListener('error', onError);
          }
          sock.on('readable', onReadable);
          sock.on('end', onEnd);
          sock.on('error', onError);
        });
      }

      function handleSetNoDelay(req) {
        const sock = sockets.get(req.socket_id);
        if (!sock) { writeErr('set_no_delay: invalid socket_id'); return; }
        if (typeof sock.setNoDelay !== 'function') {
          writeErr('set_no_delay: socket does not support TCP_NODELAY');
          return;
        }
        sock.setNoDelay(!!req.enabled);
        writeOk({ ok: true });
      }

      function handleClose(req) {
        const sock = sockets.get(req.socket_id);
        if (!sock) { writeErr('close: invalid socket_id'); return; }
        sock.destroy();
        sockets.delete(req.socket_id);
        writeOk({ ok: true });
      }

      parentPort.postMessage('ready');

      async function loop() {
        while (true) {
          Atomics.wait(int32, 0, ${STATUS_IDLE});
          if (Atomics.load(int32, 0) !== ${STATUS_REQUEST_READY}) continue;

          const len = Atomics.load(int32, 1);
          const reqJson = decoder.decode(uint8.slice(8, 8 + len));
          const req = JSON.parse(reqJson);

          try {
            const op = req.op || 'fetch';
            switch (op) {
              case 'fetch': await handleFetch(req); break;
              case 'connect': await handleConnect(req); break;
              case 'listen': await handleListen(req); break;
              case 'accept': handleAccept(req); break;
              case 'send': await handleSend(req); break;
              case 'recv': await handleRecv(req); break;
              case 'set_no_delay': handleSetNoDelay(req); break;
              case 'close_listener': handleCloseListener(req); break;
              case 'close': handleClose(req); break;
              default: writeErr('unknown op: ' + op); break;
            }
          } catch (err) {
            writeErr(err.message);
          }
        }
      }
      loop();
    `;

    this.worker = new Worker(workerCode, {
      eval: true,
      workerData: {
        sab: this.sab,
        allowedHosts: this.gateway.getAllowedHosts(),
        blockedHosts: this.gateway.getBlockedHosts(),
      },
    });

    // Attach error handler that unblocks any waiting thread
    this.worker.on("error", () => {
      Atomics.store(this.int32, 0, STATUS_ERROR);
      Atomics.notify(this.int32, 0);
    });

    // Wait for the worker to signal it's ready (with a fallback timeout)
    await new Promise<void>((resolve, reject) => {
      const worker = this.worker!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const fail = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onMessage = (msg: string) => {
        if (msg === "ready") finish();
      };
      const onError = (err: Error) => fail(err);
      worker.on("message", onMessage);
      worker.on("error", onError);
      timer = setTimeout(finish, 2000); // fallback timeout
    });
  }

  /**
   * Fetch through the bridge worker — async on the main JS thread so the
   * event loop stays drained for `host-call` postMessages while the
   * worker fulfils the request. Safe to call from WASI host functions
   * because all host imports already flow through JSPI/Asyncify. Name
   * is `fetchSync` for historical reasons (callers used to be sync); the
   * return is a Promise.
   */
  async fetchSync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: FetchRequestBody,
    redirect?: FetchRedirectMode,
  ): Promise<SyncFetchResult> {
    if (!this.worker) {
      return { status: 0, body: "", headers: {}, error: "bridge not started" };
    }

    // Check gateway policy synchronously first
    const access = this.gateway.checkAccess(url, method);
    if (!access.allowed) {
      return { status: 403, body: "", headers: {}, error: access.reason };
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const reqJson = JSON.stringify({
      url,
      method,
      headers,
      body: body instanceof Uint8Array ? undefined : body,
      body_base64: body instanceof Uint8Array ? bytesToBase64(body) : undefined,
      redirect,
    });
    const reqEncoded = encoder.encode(reqJson);
    if (reqEncoded.byteLength > SAB_SIZE - 8) {
      return { status: 413, body: "", headers: {}, error: "request too large" };
    }
    this.uint8.set(reqEncoded, 8);
    Atomics.store(this.int32, 1, reqEncoded.byteLength);
    Atomics.store(this.int32, 0, STATUS_REQUEST_READY);
    Atomics.notify(this.int32, 0);

    // Non-blocking wait so the main event loop keeps draining
    // worker-host postMessages. Mirrors SabMutex.lockAsync (dc58e1c).
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
    const respJson = decoder.decode(this.uint8.slice(8, 8 + len));

    // Reset to idle
    Atomics.store(this.int32, 0, STATUS_IDLE);

    const result = JSON.parse(respJson) as SyncFetchResult;
    if (status === STATUS_ERROR) {
      result.error = result.error || "unknown error";
    }
    return result;
  }

  /**
   * Generic request through the bridge — async on the main JS thread.
   * Used for socket operations (connect, send, recv, close, listen,
   * accept, …). See `fetchSync` for the rationale; the name keeps the
   * `Sync` suffix for callsite continuity but the return is a Promise.
   */
  async requestSync(op: Record<string, unknown>): Promise<SyncRequestResult> {
    if (!this.worker) {
      return { ok: false, error: "bridge not started" };
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const reqJson = JSON.stringify(op);
    const reqEncoded = encoder.encode(reqJson);
    if (reqEncoded.byteLength > SAB_SIZE - 8) {
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
    const respJson = decoder.decode(this.uint8.slice(8, 8 + len));
    Atomics.store(this.int32, 0, STATUS_IDLE);
    return JSON.parse(respJson) as SyncRequestResult;
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
