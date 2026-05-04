import { assertEquals } from 'jsr:@std/assert@^1.0.19';
import { createKernelImports } from '../kernel-imports.ts';
import type { FetchRedirectMode, NetworkBridgeLike, SyncFetchResult, SyncRequestResult } from '../../network/bridge.ts';

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
      headers: { location: '/next' },
      body: 'moved',
      body_base64: 'bW92ZWQ=',
    };
  }

  requestSync(_op: Record<string, unknown>): SyncRequestResult {
    return { ok: false, error: 'not used' };
  }
}

function readCString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  return decoder.decode(new Uint8Array(memory.buffer, ptr, len));
}

Deno.test('host_network_fetch passes manual redirect and preserves HTTP status', async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bridge = new RecordingBridge();
  const imports = createKernelImports({ memory, networkBridge: bridge });
  const req = encoder.encode(JSON.stringify({
    url: 'https://example.test/start',
    method: 'GET',
    headers: {},
    redirect: 'manual',
  }));
  new Uint8Array(memory.buffer, 32, req.length).set(req);

  const hostNetworkFetch = imports.host_network_fetch as HostNetworkFetch;
  const written = await hostNetworkFetch(32, req.length, 1024, 4096);
  const json = JSON.parse(readCString(memory, 1024, written));

  assertEquals(bridge.redirect, 'manual');
  assertEquals(json.status, 302);
  assertEquals(json.error, null);
  assertEquals(json.body_base64, 'bW92ZWQ=');
});

Deno.test("host_network_fetch error responses include body_base64", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports = createKernelImports({ memory });
  const req = encoder.encode(JSON.stringify({
    url: "https://example.test/start",
    method: "GET",
    headers: {},
    redirect: "manual",
  }));
  new Uint8Array(memory.buffer, 32, req.length).set(req);

  const hostNetworkFetch = imports.host_network_fetch as HostNetworkFetch;
  const written = await hostNetworkFetch(32, req.length, 1024, 4096);
  const json = JSON.parse(readCString(memory, 1024, written));

  assertEquals(json.ok, false);
  assertEquals(json.status, 0);
  assertEquals(json.body, "");
  assertEquals(json.body_base64, null);
  assertEquals(json.error, "networking not configured");
});
