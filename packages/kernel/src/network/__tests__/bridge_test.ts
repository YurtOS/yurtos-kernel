import { afterAll, afterEach, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NetworkBridge } from "../bridge.ts";
import { NetworkGateway } from "../gateway.ts";
import { createNetworkBridgeSocketBackend } from "../socket-backend.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * These tests spin up an HTTP server in a CHILD PROCESS so that
 * the Worker's real fetch() can hit a controlled endpoint without
 * deadlocking.
 *
 * The deadlock occurs when the HTTP server runs on the main thread:
 * fetchSync() calls Atomics.wait() which blocks the main thread event
 * loop, preventing the same-process HTTP server from responding.
 * Running the server in a child process avoids this.
 */

describe(
  "NetworkBridge",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    let serverProcess: ChildProcess;
    let baseUrl: string;
    let bridge: NetworkBridge;

    beforeAll(async () => {
      const serverScript = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/data') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('bridge response');
        return;
      }

      if (url.pathname === '/redirect') {
        res.writeHead(302, { Location: '/data' });
        res.end('redirect body');
        return;
      }

      if (url.pathname === '/echo-headers') {
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(headers));
        return;
      }

      if (url.pathname === '/binary') {
        // Return known binary data (bytes 0-255) that would be corrupted by UTF-8 lossy
        const buf = Buffer.alloc(256);
        for (let i = 0; i < 256; i++) buf[i] = i;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(buf);
        return;
      }

      if (url.pathname === '/echo-body') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(body);
        });
        return;
      }

      if (url.pathname === '/error') {
        req.socket.destroy();
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      process.stdout.write(JSON.stringify({ port: addr.port }) + '\\n');
    });
  `;

      serverProcess = spawn(process.execPath, ["-e", serverScript], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Wait for the server to print its port
      const port = await new Promise<number>((resolve, reject) => {
        let output = "";
        serverProcess.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const lines = output.split("\n");
          for (const line of lines) {
            if (line.trim()) {
              try {
                const info = JSON.parse(line.trim());
                if (info.port) {
                  resolve(info.port);
                  return;
                }
              } catch {
                // not yet complete JSON
              }
            }
          }
        });
        serverProcess.on("error", reject);
        serverProcess.on("exit", (code) => {
          reject(new Error(`Server process exited with code ${code}`));
        });
        setTimeout(() => reject(new Error("Timeout waiting for server")), 5000);
      });

      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(() => {
      if (serverProcess) {
        serverProcess.kill();
      }
    });

    afterEach(() => {
      bridge?.dispose();
    });

    it("performs a synchronous fetch via the bridge", async () => {
      const gateway = new NetworkGateway({ allowedHosts: ["127.0.0.1"] });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const result = await bridge.fetchSync(`${baseUrl}/data`, "GET", {});
      expect(result.status).toBe(200);
      expect(result.body).toBe("bridge response");
    });

    it("returns body_base64 for lossless binary transfer", async () => {
      const gateway = new NetworkGateway({ allowedHosts: ["127.0.0.1"] });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const result = await bridge.fetchSync(`${baseUrl}/binary`, "GET", {});
      expect(result.status).toBe(200);
      expect(result.body_base64).toBeTruthy();

      // Decode base64 and verify all 256 bytes survived
      const binary = atob(result.body_base64!);
      expect(binary.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(binary.charCodeAt(i)).toBe(i);
      }
    });

    it("sends Uint8Array request bodies without UTF-8 decoding", async () => {
      const gateway = new NetworkGateway({ allowedHosts: ["127.0.0.1"] });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const body = new Uint8Array([0xff, 0xfe, 0x00, 0x61]);
      const result = await bridge.fetchSync(
        `${baseUrl}/echo-body`,
        "POST",
        {},
        body,
      );

      expect(result.status).toBe(200);
      expect(result.body_base64).toBe("//4AYQ==");
    });

    it("text body still works for UTF-8 content", async () => {
      const gateway = new NetworkGateway({ allowedHosts: ["127.0.0.1"] });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const result = await bridge.fetchSync(`${baseUrl}/data`, "GET", {});
      expect(result.status).toBe(200);
      expect(result.body).toBe("bridge response");
      // body_base64 should also be present and decode to the same text
      expect(result.body_base64).toBeTruthy();
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(result.body_base64!), (c) => c.charCodeAt(0)),
      );
      expect(decoded).toBe("bridge response");
    });

    it("can return manual redirects without following them", async () => {
      const gateway = new NetworkGateway({ allowedHosts: ["127.0.0.1"] });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const result = await bridge.fetchSync(
        `${baseUrl}/redirect`,
        "GET",
        {},
        undefined,
        "manual",
      );
      expect(result.status).toBe(302);
      expect(result.headers.location).toBe("/data");
      expect(result.body).toBe("redirect body");
    });

    it("returns error for blocked hosts", async () => {
      const gateway = new NetworkGateway({ blockedHosts: ["evil.com"] });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const result = await bridge.fetchSync("https://evil.com", "GET", {});
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.error).toBeTruthy();
    });

    it("disposes worker cleanly", async () => {
      const gateway = new NetworkGateway({ allowedHosts: ["127.0.0.1"] });
      bridge = new NetworkBridge(gateway);
      await bridge.start();
      bridge.dispose();
      bridge.dispose(); // double dispose should not throw
    });

    it("routes sandbox loopback connect to a backend listener", async () => {
      const gateway = new NetworkGateway({
        allowedHosts: ["127.0.0.1", "localhost"],
      });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const backend = createNetworkBridgeSocketBackend(bridge);
      const listen = await backend.listen!({
        host: "127.0.0.1",
        port: 18081,
        backlog: 8,
      });
      expect(listen.ok).toBe(true);
      if (!listen.ok) throw new Error(listen.error);

      const emptyAccept = await backend.accept!(listen.listener);
      expect(emptyAccept).toEqual({
        ok: false,
        wouldBlock: true,
        error: "accept would block",
      });

      const client = await backend.connect({
        host: "127.0.0.1",
        port: 18081,
        tls: false,
      });
      expect(client.ok).toBe(true);
      if (!client.ok) throw new Error(client.error);
      const accepted = await backend.accept!(listen.listener);
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) throw new Error(accepted.error);

      expect(bridge.requestSync({
        op: "send",
        socket_id: client.socket,
        data: "ping",
      })).toEqual({
        ok: false,
        error: "send: data must be an array of bytes",
      });

      expect(await backend.send(client.socket, encode("ping"))).toEqual({
        ok: true,
        bytes_sent: 4,
      });
      expect(await backend.recv(accepted.socket, 4)).toEqual({
        ok: true,
        data: encode("ping"),
      });
      expect(await backend.send(accepted.socket, encode("pong"))).toEqual({
        ok: true,
        bytes_sent: 4,
      });
      expect(await backend.recv(client.socket, 4)).toEqual({
        ok: true,
        data: encode("pong"),
      });

      backend.close(client.socket);
      backend.close(accepted.socket);
      backend.closeListener!(listen.listener);
    });

    it("blocking acceptAsync resolves and the connecting client is unblocked", async () => {
      // Regression: separate acceptWaiters and connectWaiters queues.
      // Previously a blocking accept queued onto connectWaiters and stole
      // the wakeup that handleConnect uses to finish a routed loopback
      // connect, so the client's connect timed out.
      const gateway = new NetworkGateway({
        allowedHosts: ["127.0.0.1", "localhost"],
      });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const backend = createNetworkBridgeSocketBackend(bridge);
      const listen = await backend.listen!({
        host: "127.0.0.1",
        port: 18091,
        backlog: 8,
      });
      expect(listen.ok).toBe(true);
      if (!listen.ok) throw new Error(listen.error);

      // Park a blocking accept BEFORE any connect arrives.
      const acceptPromise = backend.acceptAsync!(listen.listener);

      // Connect from the same backend; this routes via loopbackRoutes and
      // the bridge worker's handleConnect awaits its own connectWaiters
      // entry — the accept waiter must not steal that wakeup.
      const client = await backend.connect({
        host: "127.0.0.1",
        port: 18091,
        tls: false,
      });
      expect(client.ok).toBe(true);
      if (!client.ok) throw new Error(client.error);

      const accepted = await acceptPromise;
      expect(accepted.ok).toBe(true);

      backend.close(client.socket);
      if (accepted.ok) backend.close(accepted.socket);
      backend.closeListener!(listen.listener);
    });

    it("acceptAsync polling exits when the listener is closed mid-poll", async () => {
      // Issue 2 from the second review: the polling loop has no other
      // termination path beyond the bridge response. Closing the listener
      // while a poll is parked must surface a non-wouldBlock result so
      // the loop returns instead of leaking.
      const gateway = new NetworkGateway({
        allowedHosts: ["127.0.0.1", "localhost"],
      });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const backend = createNetworkBridgeSocketBackend(bridge);
      const listen = await backend.listen!({
        host: "127.0.0.1",
        port: 18093,
        backlog: 8,
      });
      expect(listen.ok).toBe(true);
      if (!listen.ok) throw new Error(listen.error);

      const acceptPromise = backend.acceptAsync!(listen.listener);
      // Yield to let the first poll run and observe wouldBlock.
      await new Promise((resolve) => setTimeout(resolve, 10));

      backend.closeListener!(listen.listener);
      const r = await acceptPromise;
      expect(r.ok).toBe(false);
    });

    it("binds mapped 0.0.0.0 sandbox listeners to configured host port", async () => {
      const gateway = new NetworkGateway({
        allowedHosts: ["127.0.0.1", "localhost"],
      });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const backend = createNetworkBridgeSocketBackend(bridge);
      const listen = await backend.listen!({
        host: "0.0.0.0",
        port: 8080,
        backlog: 8,
        mapping: { sandboxHost: "0.0.0.0", sandboxPort: 8080, hostPort: 0 },
      });

      expect(listen.ok).toBe(true);
      if (!listen.ok) throw new Error(listen.error);
      expect(listen.port).toBe(8080);
      backend.closeListener!(listen.listener);
    });
  },
);
