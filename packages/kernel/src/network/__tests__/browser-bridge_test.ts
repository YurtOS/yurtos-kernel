import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { BrowserNetworkBridge } from "../browser-bridge.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(bytes: Uint8Array, init: ResponseInit): Response {
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, init);
}

describe("BrowserNetworkBridge", () => {
  it("uses manual redirects when requested", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return Promise.resolve(response(new TextEncoder().encode("moved"), {
        status: 302,
        headers: { location: "/next" },
      }));
    }) as typeof fetch;

    const bridge = new BrowserNetworkBridge({ allowedHosts: ["example.test"] });
    const result = await bridge.fetchAsync(
      "https://example.test/start",
      "GET",
      {},
      undefined,
      "manual",
    );

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe("/next");
    expect(result.body).toBe("moved");
    expect(calls[0].redirect).toBe("manual");
  });

  it("returns body_base64 for binary responses", async () => {
    globalThis.fetch = (() => {
      return Promise.resolve(
        response(new Uint8Array([0, 1, 2, 253, 254, 255]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    }) as typeof fetch;

    const bridge = new BrowserNetworkBridge({ allowedHosts: ["example.test"] });
    const result = await bridge.fetchAsync(
      "https://example.test/binary",
      "GET",
      {},
    );

    expect(result.status).toBe(200);
    expect(result.body_base64).toBe("AAEC/f7/");
  });

  it("sends Uint8Array request bodies without UTF-8 decoding", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return Promise.resolve(response(new TextEncoder().encode("ok"), {
        status: 200,
      }));
    }) as typeof fetch;

    const bridge = new BrowserNetworkBridge({ allowedHosts: ["example.test"] });
    const body = new Uint8Array([0xff, 0xfe, 0x00, 0x61]);
    await bridge.fetchAsync("https://example.test/upload", "POST", {}, body);

    expect(calls[0].body).toBe(body);
  });
});
