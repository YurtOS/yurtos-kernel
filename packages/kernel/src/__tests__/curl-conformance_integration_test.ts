import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "node:path";
import { Sandbox } from "../sandbox.js";
import { NodeAdapter } from "../platform/node-adapter.js";
import type {
  NetworkBridgeLike,
  SyncFetchResult,
  SyncRequestResult,
} from "../network/bridge.ts";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);

class StaticFetchBridge implements NetworkBridgeLike {
  requests: Array<
    { url: string; method: string; redirect?: string; body?: string | null }
  > = [];

  fetchSync(
    url: string,
    method: string,
    _headers: Record<string, string>,
    body?: string | null,
    redirect?: "follow" | "manual",
  ): SyncFetchResult {
    this.requests.push({ url, method, redirect, body });
    if (url.endsWith("/denied")) {
      return {
        status: 0,
        headers: {},
        body: "",
        error: "blocked by test policy",
      };
    }
    if (url.endsWith("/redirect")) {
      return {
        status: 302,
        headers: { location: "http://example.test/final" },
        body: "",
        body_base64: "",
      };
    }
    if (url.endsWith("/binary")) {
      return {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: "\u0000\u0001\u0002",
        body_base64: "AAEC",
      };
    }

    const text = method === "POST" ? `posted:${body ?? ""}` : "hello curl";
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: text,
      body_base64: btoa(text),
    };
  }

  requestSync(_op: Record<string, unknown>): SyncRequestResult {
    return { ok: false, error: "socket path not used in this test" };
  }
}

describe("curl/libcurl conformance", () => {
  let sandbox: Sandbox | undefined;

  afterEach(() => {
    sandbox?.destroy();
    sandbox = undefined;
  });

  async function createSandbox(bridge = new StaticFetchBridge()) {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["example.test"] },
      networkBridge: bridge,
    });
    return { sandbox, bridge };
  }

  async function createSocketSandbox() {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
    });
    return sandbox;
  }

  async function readFirstLine(
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("TLS test server exited before reporting a port");
      }
      text += decoder.decode(value, { stream: true });
      const newline = text.indexOf("\n");
      if (newline !== -1) {
        const line = text.slice(0, newline);
        await reader.cancel();
        return line;
      }
    }
  }

  async function withLocalHttpsServer(
    body: string,
    fn: (url: string) => Promise<void>,
  ) {
    const certPath = resolve(
      import.meta.dirname!,
      "fixtures/tls/server-cert.pem",
    );
    const keyPath = resolve(
      import.meta.dirname!,
      "fixtures/tls/server-key.pem",
    );
    const script = `
      import { createServer } from "node:https";
      const cert = await Deno.readTextFile(${JSON.stringify(certPath)});
      const key = await Deno.readTextFile(${JSON.stringify(keyPath)});
      const server = createServer({ key, cert }, (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(${JSON.stringify(body)});
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("expected TCP listener address");
      console.log(JSON.stringify({ port: addr.port }));
      await new Promise(() => {});
    `;
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", "--no-check", script],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const firstLine = await readFirstLine(child.stdout);
    const { port } = JSON.parse(firstLine) as { port: number };
    try {
      await fn(`https://127.0.0.1:${port}/data`);
    } finally {
      child.kill("SIGTERM");
      await child.status.catch(() => undefined);
    }
  }

  it("curl --version reports curl", async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run("curl --version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("curl");
  });

  it("fetch-forced curl GET prints response body", async () => {
    const { sandbox, bridge } = await createSandbox();
    const result = await sandbox.run(
      "curl --yurt-network=fetch http://example.test/data",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello curl");
    expect(bridge.requests[0].redirect).toBe("manual");
  });

  it("fetch-forced curl HTTPS GET prints response body", async () => {
    const { sandbox, bridge } = await createSandbox();
    const result = await sandbox.run(
      "curl --yurt-network=fetch https://example.test/data",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello curl");
    expect(bridge.requests[0]).toMatchObject({
      url: "https://example.test/data",
      method: "GET",
      redirect: "manual",
    });
  });

  it("auto curl HTTPS uses fetch when sockets are unavailable", async () => {
    const { sandbox, bridge } = await createSandbox();
    const result = await sandbox.run("curl https://example.test/data");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello curl");
    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]).toMatchObject({
      url: "https://example.test/data",
      method: "GET",
      redirect: "manual",
    });
  });

  it("fetch-forced curl POST sends request body", async () => {
    const { sandbox, bridge } = await createSandbox();
    const result = await sandbox.run(
      "curl --yurt-network=fetch -d 'a=1' http://example.test/post",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("posted:a=1");
    expect(bridge.requests[0].method).toBe("POST");
    expect(bridge.requests[0].body).toContain("a=1");
  });

  it("fetch-forced curl writes binary response to VFS", async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run(
      "curl --yurt-network=fetch -o /tmp/out.bin http://example.test/binary",
    );
    expect(result.exitCode).toBe(0);
    const bytes = sandbox.readFile("/tmp/out.bin");
    expect(Array.from(bytes)).toEqual([0, 1, 2]);
  });

  it("fetch-forced curl HTTPS writes binary response to VFS", async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run(
      "curl --yurt-network=fetch -o /tmp/https.bin https://example.test/binary",
    );
    expect(result.exitCode).toBe(0);
    expect(Array.from(sandbox.readFile("/tmp/https.bin"))).toEqual([0, 1, 2]);
  });

  it("fetch-forced curl without -L exposes redirects", async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run(
      "curl --yurt-network=fetch -I http://example.test/redirect",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("302");
    expect(result.stdout.toLowerCase()).toContain("location:");
  });

  it("fetch-forced curl HTTPS exposes manual redirects", async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run(
      "curl --yurt-network=fetch -I https://example.test/redirect",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("302");
    expect(result.stdout.toLowerCase()).toContain("location:");
  });

  it("fetch-forced curl reports transport errors as non-zero", async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run(
      "curl --yurt-network=fetch http://example.test/denied",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("blocked by test policy");
  });

  it("libcurl fetch canary runs through direct library API", async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run(
      "libcurl-fetch-canary http://example.test/data",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status=200");
    expect(result.stdout).toContain("hello curl");
  });

  it("libcurl fetch canary supports HTTPS URLs", async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run(
      "libcurl-fetch-canary https://example.test/data",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status=200");
    expect(result.stdout).toContain("hello curl");
  });

  it("mbedTLS version canary runs in the sandbox", async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run("mbedtls-version-canary");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Mbed TLS");
  });

  it.skip("socket-forced libcurl canary uses socket backend when available", () => {
    // Deferred until deterministic in-sandbox HTTP listener exists.
  });

  it("socket-forced curl completes a real local TLS transfer", async () => {
    await withLocalHttpsServer("tls socket hello", async (url) => {
      const sandbox = await createSocketSandbox();
      const result = await sandbox.run(`curl --yurt-network=socket -k ${url}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("tls socket hello");
    });
  });

  it("socket-forced curl trusts the default VFS CA bundle", async () => {
    await withLocalHttpsServer("tls trusted hello", async (url) => {
      const sandbox = await createSocketSandbox();
      const result = await sandbox.run(`curl --yurt-network=socket ${url}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("tls trusted hello");
    });
  });

  it("libcurl socket canary completes a real local TLS transfer", async () => {
    await withLocalHttpsServer("tls libcurl hello", async (url) => {
      const sandbox = await createSocketSandbox();
      const result = await sandbox.run(
        `libcurl-socket-canary --insecure ${url}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("status=200");
      expect(result.stdout).toContain("tls libcurl hello");
    });
  });

  it("socket-forced curl fails without falling back to fetch when socket backend is unavailable", async () => {
    const { sandbox, bridge } = await createSandbox();
    const result = await sandbox.run(
      "curl --yurt-network=socket http://example.test/data",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("fetch-used");
    expect(result.stderr.toLowerCase()).toContain("connect");
    expect(bridge.requests).toEqual([]);
  });
});
