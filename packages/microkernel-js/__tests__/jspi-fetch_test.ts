/**
 * JSPI end-to-end: kh_fetch_blocking suspends the calling wasm
 * via WebAssembly.Suspending; kernel_dispatch returns Promise via
 * WebAssembly.promising; sys_fetch round-trips real bytes from a
 * fake async backend.
 *
 * Skipped automatically on hosts without JSPI.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defaultHostState, METHOD, Microkernel } from "../mod.ts";

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

function fetchRequestRecord(url: string, method: string): Uint8Array {
  const urlBytes = enc.encode(url);
  const methodBytes = enc.encode(method);
  const headerSize = 44;
  const urlOffset = headerSize;
  const methodOffset = urlOffset + urlBytes.byteLength;
  const size = methodOffset + methodBytes.byteLength;
  const record = new Uint8Array(size);
  const view = new DataView(record.buffer);
  view.setUint32(0, size, true);
  view.setUint16(4, 1, true);
  view.setUint32(8, urlOffset, true);
  view.setUint32(12, urlBytes.byteLength, true);
  view.setUint32(16, methodOffset, true);
  view.setUint32(20, methodBytes.byteLength, true);
  view.setUint32(24, headerSize, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, size, true);
  view.setUint32(36, 0, true);
  record.set(urlBytes, urlOffset);
  record.set(methodBytes, methodOffset);
  return record;
}

function fetchRequestUrl(record: Uint8Array): string {
  const view = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  );
  return dec.decode(
    record.subarray(
      view.getUint32(8, true),
      view.getUint32(8, true) + view.getUint32(12, true),
    ),
  );
}

function fetchResponseRecord(status: number, body: Uint8Array): Uint8Array {
  const headerSize = 36;
  const bodyOffset = headerSize;
  const size = bodyOffset + body.byteLength;
  const record = new Uint8Array(size);
  const view = new DataView(record.buffer);
  view.setUint32(0, size, true);
  view.setUint16(4, 1, true);
  view.setUint32(8, status, true);
  view.setUint32(12, headerSize, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, bodyOffset, true);
  view.setUint32(24, body.byteLength, true);
  view.setUint32(28, size, true);
  view.setUint32(32, 0, true);
  record.set(body, bodyOffset);
  return record;
}

function fetchResponseBody(record: Uint8Array): Uint8Array {
  const view = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  );
  const offset = view.getUint32(20, true);
  return record.subarray(offset, offset + view.getUint32(24, true));
}

describe("JSPI / kh_fetch_blocking", () => {
  it("syscallAsync(SYS_FETCH) round-trips real bytes via Suspending", async () => {
    if (!HAS_JSPI) {
      console.log("(no JSPI on this host — skipping)");
      return;
    }
    const bytes = await Deno.readFile(KERNEL_WASM);
    const host = defaultHostState();
    host.fetch = async (req: Uint8Array): Promise<Uint8Array> => {
      // Yield to confirm the wasm stack actually suspends.
      await new Promise<void>((r) => queueMicrotask(r));
      return fetchResponseRecord(
        200,
        enc.encode(`echoed:${fetchRequestUrl(req)}`),
      );
    };
    const mk = await Microkernel.load(bytes, host);

    const reqBytes = fetchRequestRecord("https://example.invalid/test", "GET");
    const out = await mk.syscallAsync(
      METHOD.SYS_FETCH,
      reqBytes,
      8 * 1024,
    );
    expect(Number(out.rc)).toBeGreaterThan(0);
    const used = Number(out.rc);
    const resp = out.response.subarray(0, used);
    expect(dec.decode(fetchResponseBody(resp))).toEqual(
      "echoed:https://example.invalid/test",
    );
  });

  it("fetch denied by mayFetch policy returns -EACCES", async () => {
    if (!HAS_JSPI) return;
    const bytes = await Deno.readFile(KERNEL_WASM);
    const host = defaultHostState();
    host.fetch = (_req: Uint8Array): Promise<Uint8Array> => {
      throw new Error("fetch should not be reached on deny");
    };
    host.policy = { mayFetch: () => "deny" };
    const mk = await Microkernel.load(bytes, host);
    const reqBytes = fetchRequestRecord("https://x", "GET");
    const out = await mk.syscallAsync(METHOD.SYS_FETCH, reqBytes, 1024);
    expect(Number(out.rc)).toEqual(-13);
  });
});
