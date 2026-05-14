/**
 * Universal browser-friendly impls — exercise the parts that run
 * cleanly under Deno. globalFetch wraps globalThis.fetch
 * (browsers, Deno, Bun, Node 18+); IndexedDbKv is browser-only
 * and the test confirms it throws cleanly when indexedDB is
 * absent. WebSocketTcp lands in this same module but its full
 * round-trip is exercised in real browser environments — Deno's
 * WebSocket / Deno.upgradeWebSocket teardown pipeline is too
 * brittle to test here without flakes.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  globalFetch,
  IndexedDbKv,
  KernelHostInterface,
  METHOD,
} from "../mod.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

const enc = new TextEncoder();
const dec = new TextDecoder();

function fetchRequestRecord(
  url: string,
  method: string,
  headers: Record<string, string> = {},
  body = new Uint8Array(),
): Uint8Array {
  const headerSize = 44;
  const pairSize = 16;
  const pairsOffset = headerSize;
  let cursor = pairsOffset + Object.keys(headers).length * pairSize;
  const urlBytes = enc.encode(url);
  const methodBytes = enc.encode(method);
  const pairs: Array<[number, number, number, number]> = [];
  const strings: Uint8Array[] = [];
  const urlOffset = cursor;
  cursor += urlBytes.byteLength;
  const methodOffset = cursor;
  cursor += methodBytes.byteLength;
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    const nameOffset = cursor;
    cursor += nameBytes.byteLength;
    const valueOffset = cursor;
    cursor += valueBytes.byteLength;
    pairs.push([
      nameOffset,
      nameBytes.byteLength,
      valueOffset,
      valueBytes.byteLength,
    ]);
    strings.push(nameBytes, valueBytes);
  }
  const bodyOffset = cursor;
  cursor += body.byteLength;
  const record = new Uint8Array(cursor);
  const view = new DataView(record.buffer);
  view.setUint32(0, cursor, true);
  view.setUint16(4, 1, true);
  view.setUint32(8, urlOffset, true);
  view.setUint32(12, urlBytes.byteLength, true);
  view.setUint32(16, methodOffset, true);
  view.setUint32(20, methodBytes.byteLength, true);
  view.setUint32(24, pairsOffset, true);
  view.setUint32(28, pairs.length, true);
  view.setUint32(32, bodyOffset, true);
  view.setUint32(36, body.byteLength, true);
  record.set(urlBytes, urlOffset);
  record.set(methodBytes, methodOffset);
  let writeCursor = pairsOffset;
  for (const [nameOffset, nameLen, valueOffset, valueLen] of pairs) {
    view.setUint32(writeCursor, nameOffset, true);
    view.setUint32(writeCursor + 4, nameLen, true);
    view.setUint32(writeCursor + 8, valueOffset, true);
    view.setUint32(writeCursor + 12, valueLen, true);
    writeCursor += pairSize;
  }
  let stringCursor = methodOffset + methodBytes.byteLength;
  for (const bytes of strings) {
    record.set(bytes, stringCursor);
    stringCursor += bytes.byteLength;
  }
  record.set(body, bodyOffset);
  return record;
}

function readSpan(record: Uint8Array, offset: number, len: number): Uint8Array {
  return record.subarray(offset, offset + len);
}

function decodeFetchResponse(record: Uint8Array): {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  error: string;
} {
  const view = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  );
  const size = view.getUint32(0, true);
  expect(size).toEqual(record.byteLength);
  expect(view.getUint16(4, true)).toEqual(1);
  const status = view.getUint32(8, true);
  const headersOffset = view.getUint32(12, true);
  const headersCount = view.getUint32(16, true);
  const bodyOffset = view.getUint32(20, true);
  const bodyLen = view.getUint32(24, true);
  const errorOffset = view.getUint32(28, true);
  const errorLen = view.getUint32(32, true);
  const headers: Record<string, string> = {};
  for (let idx = 0; idx < headersCount; idx++) {
    const at = headersOffset + idx * 16;
    const key = dec.decode(
      readSpan(record, view.getUint32(at, true), view.getUint32(at + 4, true)),
    );
    const value = dec.decode(
      readSpan(
        record,
        view.getUint32(at + 8, true),
        view.getUint32(at + 12, true),
      ),
    );
    headers[key] = value;
  }
  return {
    status,
    headers,
    body: readSpan(record, bodyOffset, bodyLen),
    error: dec.decode(readSpan(record, errorOffset, errorLen)),
  };
}

describe("browser-friendly impls", () => {
  it("globalFetch consumes and returns native fetch records", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const requestInit = init as globalThis.RequestInit | undefined;
      expect(String(input)).toEqual("https://example.invalid/");
      expect(requestInit?.method).toEqual("POST");
      expect(requestInit?.headers).toEqual({ "X-Test": "1" });
      expect(requestInit?.body).toEqual(enc.encode("ping"));
      return Promise.resolve(
        new Response(enc.encode("pong"), {
          status: 201,
          headers: { "X-Reply": "2" },
        }),
      );
    };
    try {
      const response = await globalFetch(
        fetchRequestRecord(
          "https://example.invalid/",
          "POST",
          { "X-Test": "1" },
          enc.encode("ping"),
        ),
      );
      const decoded = decodeFetchResponse(response);
      expect(decoded.status).toEqual(201);
      expect(decoded.headers["x-reply"]).toEqual("2");
      expect(dec.decode(decoded.body)).toEqual("pong");
      expect(decoded.error).toEqual("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("globalFetch reaches kernel fetch through JSPI", async () => {
    if (!HAS_JSPI) return;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      expect(String(input)).toEqual("https://example.invalid/");
      return Promise.resolve(
        new Response("hello globalFetch", { status: 200 }),
      );
    };
    try {
      const host = defaultHostState();
      host.fetch = globalFetch;
      const mk = await KernelHostInterface.load(
        await Deno.readFile(KERNEL_WASM),
        host,
      );
      const out = await mk.syscallAsync(
        METHOD.SYS_FETCH,
        fetchRequestRecord("https://example.invalid/", "GET"),
        4096,
      );
      const used = Number(out.rc);
      expect(used).toBeGreaterThan(0);
      const resp = decodeFetchResponse(
        out.response.subarray(0, used),
      );
      expect(dec.decode(resp.body)).toEqual("hello globalFetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("IndexedDbKv refuses to construct without globalThis.indexedDB", () => {
    // On Deno, globalThis.indexedDB is undefined — confirms the
    // explicit error rather than a silent runtime trap. In a real
    // browser the constructor succeeds and put/get/delete/list
    // work via getAsync/putAsync/etc.
    expect(() => new IndexedDbKv()).toThrow(
      /globalThis\.indexedDB is not available/,
    );
  });

  it("OpfsHostFs refuses to construct without navigator.storage.getDirectory", async () => {
    const { OpfsHostFs } = await import("../mod.ts");
    expect(() => new OpfsHostFs()).toThrow(
      /navigator\.storage\.getDirectory/,
    );
  });
});
