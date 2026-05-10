/**
 * JSPI end-to-end for kh_idb_*: a fake async KV implements only
 * the *Async variants; userland's syscall actually awaits the
 * Promise via WebAssembly.Suspending. Confirms the same pattern
 * generalizes to the persistence surface.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  type KvBackend,
  METHOD,
  Microkernel,
} from "../mod.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

function bkey(s: Uint8Array, k: Uint8Array): string {
  return Array.from(s).join(",") + "|" + Array.from(k).join(",");
}

class FakeAsyncKv implements KvBackend {
  private store = new Map<string, Uint8Array>();

  // Sync stubs.
  get(): Uint8Array | number { return -38; }
  put(): number { return -38; }
  delete(): number { return -38; }
  list(): Uint8Array[] { return []; }

  async getAsync(s: Uint8Array, k: Uint8Array): Promise<Uint8Array | number> {
    await new Promise<void>((r) => queueMicrotask(r));
    const v = this.store.get(bkey(s, k));
    return v ?? -2; // -ENOENT
  }
  async putAsync(s: Uint8Array, k: Uint8Array, v: Uint8Array): Promise<number> {
    await new Promise<void>((r) => queueMicrotask(r));
    this.store.set(bkey(s, k), v);
    return 0;
  }
  async deleteAsync(s: Uint8Array, k: Uint8Array): Promise<number> {
    await new Promise<void>((r) => queueMicrotask(r));
    this.store.delete(bkey(s, k));
    return 0;
  }
  async listAsync(_s: Uint8Array, _p: Uint8Array): Promise<Uint8Array[]> {
    await new Promise<void>((r) => queueMicrotask(r));
    return [];
  }
}

describe("JSPI / kh_idb_*", () => {
  it("syscallAsync(SYS_IDB_PUT/GET) round-trips through async KV", async () => {
    if (!HAS_JSPI) return;
    const host = defaultHostState();
    host.kv = new FakeAsyncKv();
    const mk = await Microkernel.load(await Deno.readFile(KERNEL_WASM), host);

    // sys_idb_put request: u8 store_len + store + u32 key_len LE + key + value
    const store = new TextEncoder().encode("sessions");
    const key = new TextEncoder().encode("alice");
    const value = new TextEncoder().encode("AAA");
    const putReq = new Uint8Array(1 + store.byteLength + 4 + key.byteLength + value.byteLength);
    putReq[0] = store.byteLength;
    putReq.set(store, 1);
    new DataView(putReq.buffer).setUint32(1 + store.byteLength, key.byteLength, true);
    putReq.set(key, 1 + store.byteLength + 4);
    putReq.set(value, 1 + store.byteLength + 4 + key.byteLength);
    const putOut = await mk.syscallAsync(METHOD.SYS_IDB_PUT, putReq, 0);
    expect(Number(putOut.rc)).toEqual(0);

    // sys_idb_get request: u8 store_len + store + key
    const getReq = new Uint8Array(1 + store.byteLength + key.byteLength);
    getReq[0] = store.byteLength;
    getReq.set(store, 1);
    getReq.set(key, 1 + store.byteLength);
    const getOut = await mk.syscallAsync(METHOD.SYS_IDB_GET, getReq, 64);
    const used = Number(getOut.rc);
    expect(used).toEqual(3);
    expect(new TextDecoder().decode(getOut.response.subarray(0, used)))
      .toEqual("AAA");
  });
});
