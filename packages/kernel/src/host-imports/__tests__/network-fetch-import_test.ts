import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { createKernelImports } from "../kernel-imports.ts";
import type {
  FetchRedirectMode,
  NetworkBridgeLike,
  SyncFetchResult,
  SyncRequestResult,
} from "../../network/bridge.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type HostNetworkFetch = (
  reqPtr: number,
  reqLen: number,
  outPtr: number,
  outCap: number,
) => Promise<number>;

class RecordingBridge implements NetworkBridgeLike {
  redirect: FetchRedirectMode | undefined;

  fetchSync(
    _url: string,
    _method: string,
    _headers: Record<string, string>,
    _body?: string,
    redirect?: FetchRedirectMode,
  ): SyncFetchResult {
    this.redirect = redirect;
    return {
      status: 302,
      headers: { location: "/next" },
      body: "moved",
      body_base64: "bW92ZWQ=",
    };
  }

  requestSync(_op: Record<string, unknown>): SyncRequestResult {
    return { ok: false, error: "not used" };
  }
}

function buildFetchRequest(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: FetchRedirectMode;
}): Uint8Array {
  const headerSize = 44;
  const pairSize = 16;
  const headers = Object.entries(opts.headers ?? {});
  const pairsOffset = headerSize;
  let cursor = pairsOffset + headers.length * pairSize;
  const method = opts.method ?? "GET";
  const urlBytes = encoder.encode(opts.url);
  const methodBytes = encoder.encode(method);
  const bodyBytes = opts.body ? encoder.encode(opts.body) : new Uint8Array();
  const stringBytes: Uint8Array[] = [];
  const pairs: Array<[number, number, number, number]> = [];
  const urlOffset = cursor;
  cursor += urlBytes.byteLength;
  const methodOffset = cursor;
  cursor += methodBytes.byteLength;
  for (const [key, value] of headers) {
    const keyBytes = encoder.encode(key);
    const valueBytes = encoder.encode(value);
    const keyOffset = cursor;
    cursor += keyBytes.byteLength;
    const valueOffset = cursor;
    cursor += valueBytes.byteLength;
    stringBytes.push(keyBytes, valueBytes);
    pairs.push([
      keyOffset,
      keyBytes.byteLength,
      valueOffset,
      valueBytes.byteLength,
    ]);
  }
  const bodyOffset = cursor;
  cursor += bodyBytes.byteLength;

  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  view.setUint32(0, cursor, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, urlOffset, true);
  view.setUint32(12, urlBytes.byteLength, true);
  view.setUint32(16, methodOffset, true);
  view.setUint32(20, methodBytes.byteLength, true);
  view.setUint32(24, pairsOffset, true);
  view.setUint32(28, headers.length, true);
  view.setUint32(32, bodyOffset, true);
  view.setUint32(36, bodyBytes.byteLength, true);
  view.setUint32(40, opts.redirect === "manual" ? 1 : 0, true);
  for (let i = 0; i < pairs.length; i++) {
    const at = pairsOffset + i * pairSize;
    const [keyOffset, keyLength, valueOffset, valueLength] = pairs[i];
    view.setUint32(at, keyOffset, true);
    view.setUint32(at + 4, keyLength, true);
    view.setUint32(at + 8, valueOffset, true);
    view.setUint32(at + 12, valueLength, true);
  }
  cursor = pairsOffset + headers.length * pairSize;
  out.set(urlBytes, cursor);
  cursor += urlBytes.byteLength;
  out.set(methodBytes, cursor);
  cursor += methodBytes.byteLength;
  for (const bytes of stringBytes) {
    out.set(bytes, cursor);
    cursor += bytes.byteLength;
  }
  out.set(bodyBytes, bodyOffset);
  return out;
}

function readFetchResponse(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
) {
  const view = new DataView(memory.buffer, ptr, len);
  const bodyOffset = view.getUint32(20, true);
  const bodyLength = view.getUint32(24, true);
  const errorOffset = view.getUint32(28, true);
  const errorLength = view.getUint32(32, true);
  return {
    size: view.getUint32(0, true),
    version: view.getUint16(4, true),
    status: view.getUint32(8, true),
    headersOffset: view.getUint32(12, true),
    headersCount: view.getUint32(16, true),
    body: decoder.decode(
      new Uint8Array(memory.buffer, ptr + bodyOffset, bodyLength),
    ),
    error: decoder.decode(
      new Uint8Array(memory.buffer, ptr + errorOffset, errorLength),
    ),
  };
}

Deno.test("host_network_fetch passes manual redirect and preserves HTTP status", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bridge = new RecordingBridge();
  const imports = createKernelImports({ memory, networkBridge: bridge });
  const req = buildFetchRequest({
    url: "https://example.test/start",
    method: "GET",
    headers: { accept: "text/plain" },
    redirect: "manual",
  });
  new Uint8Array(memory.buffer, 32, req.length).set(req);

  const hostNetworkFetch = imports.host_network_fetch as HostNetworkFetch;
  const written = await hostNetworkFetch(32, req.length, 1024, 4096);
  const response = readFetchResponse(memory, 1024, written);

  assertEquals(bridge.redirect, "manual");
  assertEquals(response.version, 1);
  assertEquals(response.status, 302);
  assertEquals(response.headersCount, 1);
  assertEquals(response.error, "");
  assertEquals(response.body, "moved");
});

Deno.test("host_network_fetch error responses include body_base64", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports = createKernelImports({ memory });
  const req = buildFetchRequest({
    url: "https://example.test/start",
    method: "GET",
    headers: {},
    redirect: "manual",
  });
  new Uint8Array(memory.buffer, 32, req.length).set(req);

  const hostNetworkFetch = imports.host_network_fetch as HostNetworkFetch;
  const written = await hostNetworkFetch(32, req.length, 1024, 4096);
  const response = readFetchResponse(memory, 1024, written);

  assertEquals(response.status, 0);
  assertEquals(response.body, "");
  assertEquals(response.error, "networking not configured");
});
