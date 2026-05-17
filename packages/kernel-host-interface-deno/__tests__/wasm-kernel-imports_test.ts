/**
 * Phase 7.2 macro layer — direct tests of the wrapper functions
 * buildWasmKernelImports produces. Each binding is exercised by
 * calling the generated function with the right shape of args
 * and asserting the result equals what KernelHostInterface.syscallAsync
 * would return on its own. No probe wasm needed; the wrappers
 * are JS functions.
 *
 * When the kernelImpl="wasm" Sandbox option lands, the same
 * wrappers (Suspending-wrapped on the way to user wasm) carry
 * every host_* call. This test is the contract.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  KernelHostInterface,
  type KvBackend,
  METHOD,
} from "../../kernel-host-interface-js/mod.ts";
import {
  buildWasmKernelImports,
  createWasmForkLifecycle,
  createWasmThreadHostRegistry,
  HOST_BINDINGS,
  type WasmProcessHostRegistry,
} from "../wasm-kernel-imports.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

async function freshMk(): Promise<KernelHostInterface> {
  return await KernelHostInterface.load(
    await Deno.readFile(KERNEL_WASM),
    defaultHostState(),
  );
}

interface CapturedCall {
  method: number;
  callerPid: number;
  callerTid?: number;
  request: Uint8Array;
  responseCap: number;
}

function capturingMk(rc = 0, response = new Uint8Array()): {
  mk: KernelHostInterface;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const mk = {
    kernelSyscall(
      method: number,
      callerPid: number,
      request: Uint8Array,
      responseCap: number,
    ): { rc: bigint; response: Uint8Array } {
      calls.push({ method, callerPid, request: request.slice(), responseCap });
      return { rc: BigInt(rc), response };
    },
    kernelSyscallAsync(
      method: number,
      callerPid: number,
      request: Uint8Array,
      responseCap: number,
    ): Promise<{ rc: bigint; response: Uint8Array }> {
      calls.push({ method, callerPid, request: request.slice(), responseCap });
      return Promise.resolve({ rc: BigInt(rc), response });
    },
    kernelThreadSyscall(
      method: number,
      callerPid: number,
      callerTid: number,
      request: Uint8Array,
      responseCap: number,
    ): { rc: bigint; response: Uint8Array } {
      calls.push({
        method,
        callerPid,
        callerTid,
        request: request.slice(),
        responseCap,
      });
      return { rc: BigInt(rc), response };
    },
  } as unknown as KernelHostInterface;
  return { mk, calls };
}

function kvKey(store: Uint8Array, key: Uint8Array): string {
  return `${new TextDecoder().decode(store)}\0${new TextDecoder().decode(key)}`;
}

function sockaddrIn(
  host: [number, number, number, number],
  port: number,
): Uint8Array {
  const addr = new Uint8Array(16);
  const view = new DataView(addr.buffer);
  view.setUint16(0, 2, true);
  view.setUint16(2, port & 0xffff, false);
  addr.set(host, 4);
  return addr;
}

class FakeKv implements KvBackend {
  private values = new Map<string, Uint8Array>();

  get(store: Uint8Array, key: Uint8Array): Uint8Array | number {
    return this.values.get(kvKey(store, key)) ?? -2;
  }

  put(store: Uint8Array, key: Uint8Array, value: Uint8Array): number {
    this.values.set(kvKey(store, key), value);
    return 0;
  }

  delete(store: Uint8Array, key: Uint8Array): number {
    this.values.delete(kvKey(store, key));
    return 0;
  }

  list(store: Uint8Array, prefix: Uint8Array): Uint8Array[] {
    const storeName = new TextDecoder().decode(store);
    const prefixText = new TextDecoder().decode(prefix);
    const keys: Uint8Array[] = [];
    for (const fullKey of this.values.keys()) {
      const [stored, key] = fullKey.split("\0");
      if (stored === storeName && key.startsWith(prefixText)) {
        keys.push(new TextEncoder().encode(key));
      }
    }
    return keys.sort((a, b) =>
      new TextDecoder().decode(a).localeCompare(new TextDecoder().decode(b))
    );
  }
}

describe("buildWasmKernelImports (Phase 7.2 macro)", () => {
  it("installs a pid-routed thread host with global host handles", () => {
    const state = defaultHostState();
    const exitCalls: number[][] = [];
    const mk = {
      hostStateMut() {
        return state;
      },
      recordThreadExitAuthenticated(
        pid: number,
        tid: number,
        handle: number,
        retval: number,
      ) {
        exitCalls.push([pid, tid, handle, retval]);
      },
    } as unknown as KernelHostInterface;
    const registry = createWasmThreadHostRegistry(mk);
    const spawnCalls: number[][] = [];
    const releaseCalls: number[] = [];
    const cancelCalls: number[] = [];
    registry.registerProcess(10, {
      spawn(tid, fnPtr, arg) {
        spawnCalls.push([tid, fnPtr, arg]);
        return 3;
      },
      release(handle) {
        releaseCalls.push(handle);
        return 0;
      },
      cancel(handle) {
        cancelCalls.push(handle);
        return 0;
      },
    });

    const globalHandle = state.threadHost?.spawn(10, 2, 123, 456);
    expect(globalHandle).toBe(1);
    expect(spawnCalls).toEqual([[2, 123, 456]]);
    registry.threadExited(10, 2, 3, 0x8000_0000);
    expect(exitCalls).toEqual([[10, 2, 1, 0x8000_0000]]);
    expect(state.threadHost?.release(1)).toBe(0);
    expect(releaseCalls).toEqual([3]);

    const cancelledHandle = state.threadHost?.spawn(10, 4, 777, 888);
    expect(cancelledHandle).toBe(2);
    expect(state.threadHost?.cancel(2)).toBe(0);
    expect(cancelCalls).toEqual([3]);
    expect(state.threadHost?.spawn(11, 2, 1, 2)).toBe(-3);
  });

  it("routes worker nested spawn/yield through authenticated Rust thread syscalls", () => {
    const state = defaultHostState();
    const calls: Array<{
      method: number;
      callerPid: number;
      callerTid: number;
      request: number[];
      responseCap: number;
    }> = [];
    const mk = {
      hostStateMut() {
        return state;
      },
      kernelThreadSyscall(
        method: number,
        callerPid: number,
        callerTid: number,
        request: Uint8Array,
        responseCap: number,
      ) {
        calls.push({
          method,
          callerPid,
          callerTid,
          request: Array.from(request),
          responseCap,
        });
        return {
          rc: BigInt(method === METHOD.SYS_THREAD_SPAWN ? 17 : 0),
          response: new Uint8Array(),
        };
      },
    } as unknown as KernelHostInterface;
    const registry = createWasmThreadHostRegistry(mk);

    expect(registry.threadSpawn?.(10, 2, 123, 456)).toBe(17);
    expect(registry.threadYield?.(10, 2)).toBe(0);
    expect(calls).toEqual([
      {
        method: METHOD.SYS_THREAD_SPAWN,
        callerPid: 10,
        callerTid: 2,
        request: [123, 0, 0, 0, 200, 1, 0, 0],
        responseCap: 0,
      },
      {
        method: METHOD.SYS_THREAD_YIELD,
        callerPid: 10,
        callerTid: 2,
        request: [],
        responseCap: 0,
      },
    ]);
  });

  it("covers the legacy socket host import names that have Rust syscalls", () => {
    const names = new Set(HOST_BINDINGS.map((b) => b.name));
    for (
      const name of [
        "host_socket_connect",
        "host_socket_open",
        "host_socket_bind",
        "host_socket_listen",
        "host_socket_accept",
        "host_socket_addr",
        "host_socket_send",
        "host_socket_recv",
        "host_socket_close",
        "host_socket_option",
        "host_socket_set_no_delay",
        "host_socket_bind_unix",
        "host_socket_connect_unix",
        "host_socket_listen_unix",
        "host_socket_socketpair",
        "host_socket_sendmsg",
        "host_socket_recvmsg",
      ]
    ) {
      expect(names.has(name)).toEqual(true);
    }
  });

  it("covers the legacy durable KV host import names that have Rust syscalls", () => {
    const names = new Set(HOST_BINDINGS.map((b) => b.name));
    for (
      const name of [
        "host_idb_get",
        "host_idb_put",
        "host_idb_delete",
        "host_idb_list",
      ]
    ) {
      expect(names.has(name)).toEqual(true);
    }
  });

  it("covers host_realpath through a Rust-kernel syscall", () => {
    const names = new Set(HOST_BINDINGS.map((b) => b.name));
    expect(names.has("host_realpath")).toEqual(true);
  });

  it("covers host_lstat through a Rust-kernel syscall", () => {
    const names = new Set(HOST_BINDINGS.map((b) => b.name));
    expect(names.has("host_lstat")).toEqual(true);
  });

  it("covers the pthread host import names that have Rust syscalls", () => {
    const names = new Set(HOST_BINDINGS.map((b) => b.name));
    for (
      const name of [
        "host_thread_spawn",
        "host_thread_self",
        "host_thread_join",
        "host_thread_detach",
        "host_thread_exit",
        "host_thread_yield",
      ]
    ) {
      expect(names.has(name)).toEqual(true);
    }
  });

  it("scalar-zero-arg: host_getuid → sys_getuid via factory", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const fakeBuf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => fakeBuf);
    const uid = await imports.host_getuid();
    // Default credentials UID (1000); confirms the factory's
    // zero-arg scalar-return path returns the syscall's actual
    // value, not a stub.
    expect(uid).toEqual(1000);
  });

  it("initializes the Rust-kernel caller cwd for Sandbox-hosted guests", async () => {
    const { mk, calls } = capturingMk();
    const fakeBuf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => fakeBuf, 77, "/tmp");

    await imports.host_getuid();

    expect(calls.length).toEqual(2);
    expect(calls[0].method).toEqual(METHOD.SYS_CHDIR);
    expect(calls[0].callerPid).toEqual(77);
    expect(new TextDecoder().decode(calls[0].request)).toEqual("/tmp");
    expect(calls[1].method).toEqual(METHOD.SYS_GETUID);
    expect(calls[1].callerPid).toEqual(77);
  });

  it("host_socket_peercred dispatches SYS_SOCKET_PEERCRED, not SYS_SOCKET_INFO (PR #58 [P1])", async () => {
    // Regression for the [P1] wiring bug: the binding used to dispatch
    // METHOD.SYS_SOCKET_INFO and read offsets 12/16/20, so the new
    // sys_socket_peercred syscall was never reached and accept/connect
    // peer creds were wrong. Mock kernel returns 12 (bytes written) and
    // a 12-byte response: i32 pid LE + i32 uid LE + i32 gid LE.
    const resp = new Uint8Array(12);
    const rv = new DataView(resp.buffer);
    rv.setInt32(0, 4242, true); // pid
    rv.setInt32(4, 1000, true); // uid
    rv.setInt32(8, 1007, true); // gid
    const { mk, calls } = capturingMk(12, resp);
    const mem = new ArrayBuffer(64);
    const imports = buildWasmKernelImports(mk, () => mem);

    // fd=3, pidPtr=0, uidPtr=8, gidPtr=16.
    const rc = await imports.host_socket_peercred(3, 0, 8, 16);
    expect(rc).toEqual(0);

    expect(calls.length).toEqual(1);
    expect(calls[0].method).toEqual(METHOD.SYS_SOCKET_PEERCRED);
    expect(calls[0].method).not.toEqual(METHOD.SYS_SOCKET_INFO);
    expect(calls[0].responseCap).toEqual(12);
    expect(calls[0].request.byteLength).toEqual(4);
    expect(
      new DataView(
        calls[0].request.buffer,
        calls[0].request.byteOffset,
        4,
      ).getUint32(0, true),
    ).toEqual(3);
    // pid/uid/gid copied out to the three pointers verbatim.
    const out = new DataView(mem);
    expect(out.getInt32(0, true)).toEqual(4242);
    expect(out.getInt32(8, true)).toEqual(1000);
    expect(out.getInt32(16, true)).toEqual(1007);
  });

  it("host_thread_self routes through authenticated Rust thread dispatch", async () => {
    const { mk, calls } = capturingMk(9);
    const imports = buildWasmKernelImports(
      mk,
      () => new ArrayBuffer(8),
      77,
      undefined,
      9,
    );

    const tid = await imports.host_thread_self();

    expect(tid).toEqual(9);
    expect(calls.length).toEqual(1);
    expect(calls[0].method).toEqual(METHOD.SYS_THREAD_SELF);
    expect(calls[0].callerPid).toEqual(77);
    expect(calls[0].callerTid).toEqual(9);
    expect(calls[0].request.byteLength).toEqual(0);
  });

  it("host_thread_join writes raw retval bits through the out pointer", async () => {
    const response = new Uint8Array(4);
    new DataView(response.buffer).setUint32(0, 0x8000_0000, true);
    const { mk, calls } = capturingMk(0, response);
    const memory = new ArrayBuffer(16);
    const imports = buildWasmKernelImports(mk, () => memory, 77, undefined, 1);

    const rc = await imports.host_thread_join(42, 4);

    expect(rc).toEqual(0);
    expect(calls.length).toEqual(1);
    expect(calls[0].method).toEqual(METHOD.SYS_THREAD_JOIN);
    expect(calls[0].callerTid).toEqual(1);
    expect(new DataView(calls[0].request.buffer).getUint32(0, true)).toEqual(
      42,
    );
    expect(new DataView(memory, 4, 4).getUint32(0, true)).toEqual(0x8000_0000);
  });

  it("host_thread_join waits for Rust thread-exit notification before retrying", async () => {
    const response = new Uint8Array(4);
    new DataView(response.buffer).setUint32(0, 123, true);
    const calls: CapturedCall[] = [];
    const rcs = [-11, 0];
    const mk = {
      kernelThreadSyscall(
        method: number,
        callerPid: number,
        callerTid: number,
        request: Uint8Array,
        responseCap: number,
      ): { rc: bigint; response: Uint8Array } {
        calls.push({
          method,
          callerPid,
          callerTid,
          request: request.slice(),
          responseCap,
        });
        return { rc: BigInt(rcs.shift() ?? 0), response };
      },
    } as unknown as KernelHostInterface;
    let version = 0;
    let notifyExit: (() => void) | undefined;
    const memory = new ArrayBuffer(16);
    const imports = buildWasmKernelImports(
      mk,
      () => memory,
      77,
      undefined,
      1,
      {
        threadEvents: {
          threadExitVersion: () => version,
          waitForThreadExit: (_pid, _tid, seenVersion) =>
            new Promise<void>((resolve) => {
              notifyExit = () => {
                expect(seenVersion).toEqual(0);
                version++;
                resolve();
              };
            }),
        },
      },
    );

    const join = imports.host_thread_join(42, 4);
    await Promise.resolve();
    expect(calls.length).toEqual(1);
    expect(typeof notifyExit).toEqual("function");
    notifyExit!();

    expect(await join).toEqual(0);
    expect(calls.length).toEqual(2);
    expect(new DataView(memory, 4, 4).getUint32(0, true)).toEqual(123);
  });

  it("multi-scalar-arg: host_kill with args packed inline", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const fakeBuf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => fakeBuf);
    const rc = await imports.host_kill(999_999, 0);
    expect(rc).toEqual(-3);
  });

  it("multi-scalar-arg: host_killpg with args packed inline", async () => {
    const { mk, calls } = capturingMk(0);
    const fakeBuf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => fakeBuf);
    const rc = await imports.host_killpg(7, 15);
    expect(rc).toEqual(0);
    expect(calls.length).toEqual(1);
    expect(calls[0].method).toEqual(METHOD.SYS_KILLPG);
    expect(calls[0].request).toEqual(new Uint8Array([7, 0, 0, 0, 15, 0, 0, 0]));
  });

  it("multi-scalar fd helpers pack dup_min and descriptor flags inline", async () => {
    const calls: CapturedCall[] = [];
    const rcs = [9, 0];
    const mk = {
      kernelSyscallAsync(
        method: number,
        callerPid: number,
        request: Uint8Array,
        responseCap: number,
      ): Promise<{ rc: bigint; response: Uint8Array }> {
        calls.push({
          method,
          callerPid,
          request: request.slice(),
          responseCap,
        });
        return Promise.resolve({
          rc: BigInt(rcs.shift() ?? 0),
          response: new Uint8Array(),
        });
      },
    } as unknown as KernelHostInterface;
    const fakeBuf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => fakeBuf);
    expect(await imports.host_dup_min(3, 9)).toEqual(9);
    expect(await imports.host_set_fd_descriptor_flags(9, 1)).toEqual(0);
    expect(calls.map((call) => call.method)).toEqual([
      METHOD.SYS_DUP_MIN,
      METHOD.SYS_SET_FD_DESCRIPTOR_FLAGS,
    ]);
    expect(calls[0].request).toEqual(new Uint8Array([3, 0, 0, 0, 9, 0, 0, 0]));
    expect(calls[1].request).toEqual(new Uint8Array([9, 0, 0, 0, 1, 0, 0, 0]));
  });

  it("tty helpers pack scalar requests and copy fixed responses", async () => {
    const calls: CapturedCall[] = [];
    const termios = new Uint8Array(60);
    termios[0] = 0xAA;
    const winsize = new Uint8Array([24, 0, 80, 0, 0, 0, 0, 0]);
    const responses = [
      { rc: 7, response: new Uint8Array() },
      { rc: 0, response: new Uint8Array() },
      { rc: 60, response: termios },
      { rc: 0, response: new Uint8Array() },
      { rc: 8, response: winsize },
      { rc: 0, response: new Uint8Array() },
    ];
    const mk = {
      kernelSyscallAsync(
        method: number,
        callerPid: number,
        request: Uint8Array,
        responseCap: number,
      ): Promise<{ rc: bigint; response: Uint8Array }> {
        calls.push({
          method,
          callerPid,
          request: request.slice(),
          responseCap,
        });
        const next = responses.shift() ?? { rc: 0, response: new Uint8Array() };
        return Promise.resolve({
          rc: BigInt(next.rc),
          response: next.response,
        });
      },
    } as unknown as KernelHostInterface;
    const memory = new ArrayBuffer(128);
    const imports = buildWasmKernelImports(mk, () => memory);

    expect(await imports.host_tcgetpgrp(0)).toEqual(7);
    expect(await imports.host_tcsetpgrp(0, 7)).toEqual(0);
    expect(await imports.host_tcgetattr(0, 16, 60)).toEqual(60);
    expect(await imports.host_tcsetattr(0, 0, 96)).toEqual(0);
    expect(await imports.host_winsize(0, 80, 8)).toEqual(8);
    expect(await imports.host_tiocsctty(0)).toEqual(0);

    expect(calls.map((call) => call.method)).toEqual([
      METHOD.SYS_TCGETPGRP,
      METHOD.SYS_TCSETPGRP,
      METHOD.SYS_TCGETATTR,
      METHOD.SYS_TCSETATTR,
      METHOD.SYS_WINSIZE,
      METHOD.SYS_TIOCSCTTY,
    ]);
    expect(calls[1].request).toEqual(new Uint8Array([0, 0, 0, 0, 7, 0, 0, 0]));
    expect(calls[2].request).toEqual(new Uint8Array([0, 0, 0, 0]));
    expect(calls[2].responseCap).toEqual(60);
    expect(calls[3].request).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
    expect(calls[4].responseCap).toEqual(8);
    expect(new Uint8Array(memory, 16, 1)[0]).toEqual(0xAA);
    expect(new Uint8Array(memory, 80, 4)).toEqual(
      new Uint8Array([24, 0, 80, 0]),
    );
  });

  it("scheduler affinity helpers pack pid and cpuset buffers", async () => {
    const calls: CapturedCall[] = [];
    const affinity = new Uint8Array([1, 0, 0, 0]);
    const responses = [
      { rc: 4, response: affinity },
      { rc: 0, response: new Uint8Array() },
    ];
    const mk = {
      kernelSyscallAsync(
        method: number,
        callerPid: number,
        request: Uint8Array,
        responseCap: number,
      ): Promise<{ rc: bigint; response: Uint8Array }> {
        calls.push({
          method,
          callerPid,
          request: request.slice(),
          responseCap,
        });
        const next = responses.shift() ?? { rc: 0, response: new Uint8Array() };
        return Promise.resolve({
          rc: BigInt(next.rc),
          response: next.response,
        });
      },
    } as unknown as KernelHostInterface;
    const memory = new ArrayBuffer(128);
    new Uint8Array(memory, 80, 4).set(affinity);
    const imports = buildWasmKernelImports(mk, () => memory);

    expect(await imports.host_sched_getaffinity(0, 32, 4)).toEqual(4);
    expect(await imports.host_sched_setaffinity(0, 80, 4)).toEqual(0);

    expect(calls.map((call) => call.method)).toEqual([
      METHOD.SYS_SCHED_GETAFFINITY,
      METHOD.SYS_SCHED_SETAFFINITY,
    ]);
    expect(calls[0].request).toEqual(
      new Uint8Array([0, 0, 0, 0, 4, 0, 0, 0]),
    );
    expect(calls[0].responseCap).toEqual(4);
    expect(calls[1].request).toEqual(
      new Uint8Array([0, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0]),
    );
    expect(new Uint8Array(memory, 32, 4)).toEqual(affinity);
  });

  it("ownership helpers pack path and fd chown requests", async () => {
    const { mk, calls } = capturingMk(0);
    const memory = new ArrayBuffer(128);
    const path = new TextEncoder().encode("/tmp/owned");
    new Uint8Array(memory, 16, path.byteLength).set(path);
    const imports = buildWasmKernelImports(mk, () => memory);

    expect(await imports.host_chown(16, path.byteLength, 123, 456)).toEqual(0);
    expect(await imports.host_fchown(7, 123, 456)).toEqual(0);
    expect(
      await (imports as Record<string, (...args: number[]) => Promise<number>>)
        .host_fchdir(7),
    ).toEqual(0);

    expect(calls.map((call) => call.method)).toEqual([
      METHOD.SYS_CHOWN,
      (METHOD as Record<string, number>).SYS_FCHOWN,
      (METHOD as Record<string, number>).SYS_FCHDIR,
    ]);
    expect(calls[0].request).toEqual(
      new Uint8Array([
        123,
        0,
        0,
        0,
        200,
        1,
        0,
        0,
        ...path,
      ]),
    );
    expect(calls[1].request).toEqual(
      new Uint8Array([7, 0, 0, 0, 123, 0, 0, 0, 200, 1, 0, 0]),
    );
    expect(calls[2].request).toEqual(new Uint8Array([7, 0, 0, 0]));
  });

  it("host_wait converts the kernel wait record to yurt_wait_result_v1", async () => {
    const kernelWait = new Uint8Array(8);
    const kernelView = new DataView(kernelWait.buffer);
    kernelView.setUint32(0, 42, true);
    kernelView.setInt32(4, 7, true);
    const { mk, calls } = capturingMk(8, kernelWait);
    const memory = new ArrayBuffer(64);
    const imports = buildWasmKernelImports(mk, () => memory);

    const rc = await imports.host_wait(0, 0, 16, 16);

    expect(rc).toEqual(16);
    expect(calls.length).toEqual(1);
    expect(calls[0].method).toEqual(METHOD.SYS_WAIT);
    expect(calls[0].responseCap).toEqual(8);
    const req = new DataView(calls[0].request.buffer);
    expect(req.getUint32(0, true)).toEqual(0);
    expect(req.getUint32(4, true)).toEqual(0);

    const result = new DataView(memory, 16, 16);
    expect(result.getInt32(0, true)).toEqual(42);
    expect(result.getInt32(4, true)).toEqual(7);
    expect(result.getInt32(8, true)).toEqual(0);
    expect(result.getInt32(12, true)).toEqual(0);
  });

  it("host_wait reports kernel signal deaths as wait signals", async () => {
    const kernelWait = new Uint8Array(8);
    const kernelView = new DataView(kernelWait.buffer);
    kernelView.setUint32(0, 42, true);
    kernelView.setInt32(4, 128 + 15, true);
    const { mk } = capturingMk(8, kernelWait);
    const memory = new ArrayBuffer(64);
    const imports = buildWasmKernelImports(mk, () => memory);

    const rc = await imports.host_wait(0, 0, 16, 16);

    expect(rc).toEqual(16);
    const result = new DataView(memory, 16, 16);
    expect(result.getInt32(0, true)).toEqual(42);
    expect(result.getInt32(4, true)).toEqual(0);
    expect(result.getInt32(8, true)).toEqual(15);
    expect(result.getInt32(12, true)).toEqual(0);
  });

  it("ptr_len arg: host_chdir reads bytes from user memory", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    // Stage "/" at offset 0 in a fake user-memory buffer.
    const buf = new ArrayBuffer(64);
    new Uint8Array(buf).set(new TextEncoder().encode("/"));
    const imports = buildWasmKernelImports(mk, () => buf);
    // host_chdir(pathPtr=0, pathLen=1) → 0 (root always exists).
    const rc = await imports.host_chdir(0, 1);
    expect(rc).toEqual(0);
  });

  it("ptr_len arg returns -EFAULT for out-of-bounds user memory", async () => {
    const { mk } = capturingMk(0);
    const buf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => buf);

    let rc: number | undefined;
    let threw = false;
    try {
      rc = await imports.host_chdir(16, 4);
    } catch {
      threw = true;
    }

    expect(threw).toEqual(false);
    expect(rc).toEqual(-14);
  });

  it("out_cap arg: host_getcwd writes bytes back into user memory", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    const imports = buildWasmKernelImports(mk, () => buf);
    // chdir / first so cwd is "/".
    new Uint8Array(buf).set(new TextEncoder().encode("/"));
    const cdRc = await imports.host_chdir(0, 1);
    expect(cdRc).toEqual(0);
    // Now read it back via host_getcwd. The factory's out_cap
    // path writes the response bytes into the user-memory
    // buffer at the supplied offset.
    new Uint8Array(buf).fill(0);
    const n = await imports.host_getcwd(0, 64);
    expect(n).toBeGreaterThan(0);
    // Trim any trailing NUL the kernel may include (POSIX-style
    // C-string convention).
    const raw = new Uint8Array(buf, 0, n);
    let end = raw.byteLength;
    while (end > 0 && raw[end - 1] === 0) end--;
    const got = new TextDecoder().decode(raw.subarray(0, end));
    expect(got).toEqual("/");
  });

  it("out_cap arg: host_realpath canonicalizes through the Rust kernel", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(128);
    const u = new Uint8Array(buf);
    const imports = buildWasmKernelImports(mk, () => buf);

    u.set(new TextEncoder().encode("/work"), 0);
    expect(await imports.host_mkdir(0, 5)).toEqual(0);
    expect(await imports.host_chdir(0, 5)).toEqual(0);
    u.fill(0);
    u.set(new TextEncoder().encode("/work/file.txt"), 0);
    u.set(new TextEncoder().encode("hello"), 32);
    expect(await imports.host_write_file(0, 14, 32, 5, 0)).toEqual(5);

    u.fill(0);
    u.set(new TextEncoder().encode("./file.txt"), 0);
    const n = await imports.host_realpath(0, 10, 64, 64);

    expect(n).toEqual("/work/file.txt".length + 1);
    expect(
      new TextDecoder().decode(new Uint8Array(buf, 64, n - 1)),
    ).toEqual("/work/file.txt");
    expect(new Uint8Array(buf)[64 + n - 1]).toEqual(0);
  });

  it("out_cap arg: host_pipe writes 8 bytes (read_fd + write_fd)", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(16);
    const imports = buildWasmKernelImports(mk, () => buf);
    const n = await imports.host_pipe(0, 8);
    expect(n).toEqual(8);
    const view = new DataView(buf);
    const readFd = view.getUint32(0, true);
    const writeFd = view.getUint32(4, true);
    expect(readFd).toBeGreaterThan(0);
    expect(writeFd).toBeGreaterThan(readFd);
  });

  it("argOrder: host_chmod permutes (path,len,mode) → (mode,path)", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    // Use the root path so chmod can find an extant inode. The
    // point of this test is the *wire format* — that mode arrives
    // ahead of the path on the request bytes. Returning -EINVAL
    // would mean wire mismatch; any other rc (0 or path-specific
    // errno) means the kernel decoded our bytes.
    new Uint8Array(buf).set(new TextEncoder().encode("/"));
    const imports = buildWasmKernelImports(mk, () => buf);
    const rc = await imports.host_chmod(0, 1, 0o755);
    // -EINVAL would mean our wire format was wrong. Any other
    // rc means chmod parsed (mode=0o755, path="/") successfully.
    expect(rc).not.toEqual(-22);
  });

  it("prefixed_ptr_len: host_symlink emits u32 len + target + linkpath", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    // Stage "/dst" at 0 (target = /dst), "/lnk" at 16 (linkpath).
    const u = new Uint8Array(buf);
    u.set(new TextEncoder().encode("/dst"), 0);
    u.set(new TextEncoder().encode("/lnk"), 16);
    const imports = buildWasmKernelImports(mk, () => buf);
    // host_symlink(targetPtr=0, targetLen=4, linkPtr=16, linkLen=4)
    const rc = await imports.host_symlink(0, 4, 16, 4);
    expect(rc).toEqual(0);
    // Confirm: readlink resolves the link back to the target.
    new Uint8Array(buf, 32, 32).fill(0);
    u.set(new TextEncoder().encode("/lnk"), 0);
    const n = await imports.host_readlink(0, 4, 32, 32);
    expect(n).toEqual(4);
    const got = new TextDecoder().decode(new Uint8Array(buf, 32, n));
    expect(got).toEqual("/dst");
  });

  it("out_cap: host_lstat reports the link itself (S_IFLNK), no follow", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    const u = new Uint8Array(buf);
    const imports = buildWasmKernelImports(mk, () => buf);
    // mkdir /d ; symlink /d -> /l
    u.set(new TextEncoder().encode("/d"), 0);
    expect(await imports.host_mkdir(0, 2)).toEqual(0);
    u.set(new TextEncoder().encode("/d"), 0);
    u.set(new TextEncoder().encode("/l"), 16);
    expect(await imports.host_symlink(0, 2, 16, 2)).toEqual(0);
    // lstat /l → 16-byte fstat record at offset 32. filetype is the
    // u32 at [+8]; 7 = S_IFLNK (lstat does NOT follow to S_IFDIR=3).
    u.fill(0);
    u.set(new TextEncoder().encode("/l"), 0);
    const n = await imports.host_lstat(0, 2, 32, 32);
    expect(n).toEqual(16);
    expect(new DataView(buf).getUint32(32 + 8, true)).toEqual(7);
  });

  it("rc_to_out: host_dup writes new fd into out memory", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(16);
    const imports = buildWasmKernelImports(mk, () => buf);
    // pipe() to get two real fds we can dup.
    const n = await imports.host_pipe(0, 8);
    expect(n).toEqual(8);
    const readFd = new DataView(buf).getUint32(0, true);
    // host_dup(fd, outPtr=8, outCap=4). Writes the new fd as
    // i32 LE at offset 8 and returns 4 (bytes-written).
    const r = await imports.host_dup(readFd, 8, 4);
    expect(r).toEqual(4);
    const newFd = new DataView(buf).getInt32(8, true);
    expect(newFd).toBeGreaterThan(readFd);
  });

  it("ignore_scalar: host_remove discards `recursive` flag", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    new Uint8Array(buf).set(new TextEncoder().encode("/tmpfile"));
    const imports = buildWasmKernelImports(mk, () => buf);
    // Unlink on a non-existent file returns -ENOENT; the test is
    // that the call decodes the wire (path bytes only) and that
    // the recursive scalar didn't poison the wire.
    const rc = await imports.host_remove(0, 8, 1);
    expect(rc).toEqual(-2); // -ENOENT, not -EINVAL
  });

  it("custom builder: host_time returns seconds-as-float from SYS_CLOCK_GETTIME", async () => {
    if (!HAS_JSPI) return;
    // Build a KernelHostInterface with a pinned now-time so the test is
    // deterministic. defaultHostState() supplies 0 by default;
    // we want a non-zero ns value to confirm the conversion.
    const bytes = await Deno.readFile(KERNEL_WASM);
    const mk = await KernelHostInterface.load(bytes, {
      ...defaultHostState(),
      nowRealtimeNs: 1_500_000_000n, // 1.5 seconds
    });
    const imports = buildWasmKernelImports(mk, () => new ArrayBuffer(0));
    const t = await imports.host_time();
    expect(t).toEqual(1.5);
  });

  it("compound custom: host_write_file then host_read_file round-trips bytes", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(128);
    const u = new Uint8Array(buf);
    // Stage "/data" at offset 0, "hello" at offset 16.
    u.set(new TextEncoder().encode("/data"), 0);
    u.set(new TextEncoder().encode("hello"), 16);
    const imports = buildWasmKernelImports(mk, () => buf);
    // host_write_file(pathPtr=0, pathLen=5, dataPtr=16, dataLen=5, mode=0)
    const written = await imports.host_write_file(0, 5, 16, 5, 0);
    expect(written).toEqual(5);
    // host_read_file(pathPtr=0, pathLen=5, outPtr=32, outCap=32)
    u.subarray(32, 64).fill(0);
    const n = await imports.host_read_file(0, 5, 32, 32);
    expect(n).toEqual(5);
    const got = new TextDecoder().decode(new Uint8Array(buf, 32, n));
    expect(got).toEqual("hello");
  });

  it("does not expose the defunct host_native_invoke wrapper", () => {
    const { mk } = capturingMk(0);
    const imports = buildWasmKernelImports(mk, () => new ArrayBuffer(64));

    expect("host_native_invoke" in imports).toEqual(false);
    expect(
      HOST_BINDINGS.some((binding) => binding.name === "host_native_invoke"),
    )
      .toEqual(false);
  });

  it("socket wrappers use the direct yurt_abi socket signatures", async () => {
    const buf = new ArrayBuffer(128);
    const u = new Uint8Array(buf);
    const { mk, calls } = capturingMk(0, new Uint8Array([9, 8, 7, 6]));
    const imports = buildWasmKernelImports(mk, () => buf);

    await imports.host_socket_open(1, 6, 0);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_OPEN,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([
      1,
      6,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);

    const connectAddr = sockaddrIn([127, 0, 0, 1], 8080);
    u.set(connectAddr, 0);
    await imports.host_socket_connect(7, 0, connectAddr.byteLength, 0x40);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_CONNECT,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request.slice(0, 4))).toEqual([
      7,
      0,
      0,
      0,
    ]);
    expect(Array.from(calls.at(-1)!.request.slice(4)))
      .toEqual(Array.from(connectAddr));

    const bindAddr = sockaddrIn([127, 0, 0, 1], 9090);
    u.set(bindAddr, 0);
    await imports.host_socket_bind(7, 0, bindAddr.byteLength);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_BIND,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request.slice(0, 4))).toEqual([
      7,
      0,
      0,
      0,
    ]);
    expect(Array.from(calls.at(-1)!.request.slice(4)))
      .toEqual(Array.from(bindAddr));

    u.set(new TextEncoder().encode("payload"), 32);
    await imports.host_socket_send(7, 32, 7, 0x02);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_SEND,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request.slice(0, 4))).toEqual([
      7,
      0,
      0,
      0,
    ]);
    expect(new TextDecoder().decode(calls.at(-1)!.request.slice(4)))
      .toEqual("payload");

    const received = await imports.host_socket_recv(7, 64, 4, 0x04);
    expect(received).toEqual(0);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_RECV,
      responseCap: 4,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([
      7,
      0,
      0,
      0,
      0x04,
      0,
      0,
      0,
    ]);

    await imports.host_socket_listen(7, 128);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_LISTEN,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([
      7,
      0,
      0,
      0,
      128,
      0,
      0,
      0,
    ]);

    const acceptOut = new Uint8Array(16);
    new DataView(acceptOut.buffer).setInt32(0, 11, true);
    const { mk: acceptMk, calls: acceptCalls } = capturingMk(11, acceptOut);
    const acceptImports = buildWasmKernelImports(acceptMk, () => buf);
    const acceptRc = await acceptImports.host_socket_accept(9, 80, 16);
    expect(acceptRc).toEqual(16);
    const accepted = new DataView(buf, 80, 16);
    expect(accepted.getInt32(0, true)).toEqual(11);
    expect(acceptCalls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_ACCEPT,
      responseCap: 0,
    });
    expect(Array.from(acceptCalls.at(-1)!.request)).toEqual([
      9,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);

    await imports.host_socket_addr(9, 0, 80, 16);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_ADDR,
      responseCap: 16,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([
      9,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);

    const unixPath = new TextEncoder().encode("/tmp/yurt-name.sock");
    const { mk: unixAddrMk, calls: unixAddrCalls } = capturingMk(
      unixPath.byteLength,
      unixPath,
    );
    const unixAddrBuf = new ArrayBuffer(128);
    const unixAddrImports = buildWasmKernelImports(
      unixAddrMk,
      () => unixAddrBuf,
    );
    const unixAddrRc = await unixAddrImports.host_socket_addr_unix(
      9,
      1,
      80,
      32,
      64,
    );
    expect(unixAddrRc).toEqual(unixPath.byteLength);
    expect(unixAddrCalls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_ADDR,
      responseCap: 32,
    });
    expect(Array.from(unixAddrCalls.at(-1)!.request)).toEqual([
      9,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
    ]);
    expect(new TextDecoder().decode(new Uint8Array(unixAddrBuf, 80, 19)))
      .toEqual("/tmp/yurt-name.sock");
    expect(new DataView(unixAddrBuf).getInt32(64, true)).toEqual(0);

    const abstractName = new Uint8Array([
      0,
      ...new TextEncoder().encode("yurt-abstract"),
    ]);
    const { mk: abstractAddrMk } = capturingMk(
      abstractName.byteLength,
      abstractName,
    );
    const abstractAddrBuf = new ArrayBuffer(128);
    const abstractAddrImports = buildWasmKernelImports(
      abstractAddrMk,
      () => abstractAddrBuf,
    );
    const abstractAddrRc = await abstractAddrImports.host_socket_addr_unix(
      9,
      1,
      80,
      32,
      64,
    );
    expect(abstractAddrRc).toEqual("yurt-abstract".length);
    expect(new TextDecoder().decode(
      new Uint8Array(abstractAddrBuf, 80, "yurt-abstract".length),
    )).toEqual("yurt-abstract");
    expect(new DataView(abstractAddrBuf).getInt32(64, true)).toEqual(1);

    const socketInfo = new Uint8Array(24);
    const socketInfoView = new DataView(socketInfo.buffer);
    socketInfoView.setUint32(0, 3, true); // AF_UNIX
    socketInfoView.setUint32(4, 5, true); // SOCK_DGRAM in WASI libc
    socketInfoView.setUint32(8, 0, true);
    socketInfoView.setInt32(12, 1234, true);
    socketInfoView.setUint32(16, 1000, true);
    socketInfoView.setUint32(20, 1000, true);
    const { mk: infoMk, calls: infoCalls } = capturingMk(24, socketInfo);
    const infoBuf = new ArrayBuffer(128);
    const infoImports = buildWasmKernelImports(infoMk, () => infoBuf);
    expect(await infoImports.host_socket_is_dgram(9)).toEqual(1);
    expect(infoCalls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_INFO,
      responseCap: 24,
    });
    expect(Array.from(infoCalls.at(-1)!.request)).toEqual([9, 0, 0, 0]);

    // SO_PEERCRED now wires to the dedicated sys_socket_peercred
    // syscall (12-byte i32 pid|uid|gid LE), NOT the sys_socket_info
    // offsets 12/16/20. (PR #58 [P1] — the old expectation here encoded
    // the wiring bug.)
    const peerCred = new Uint8Array(12);
    const peerCredView = new DataView(peerCred.buffer);
    peerCredView.setInt32(0, 1234, true); // pid
    peerCredView.setInt32(4, 1000, true); // uid
    peerCredView.setInt32(8, 1000, true); // gid
    const { mk: pcMk, calls: pcCalls } = capturingMk(12, peerCred);
    const pcBuf = new ArrayBuffer(128);
    const pcImports = buildWasmKernelImports(pcMk, () => pcBuf);
    expect(await pcImports.host_socket_peercred(9, 80, 84, 88)).toEqual(0);
    expect(pcCalls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_PEERCRED,
      responseCap: 12,
    });
    expect(Array.from(pcCalls.at(-1)!.request)).toEqual([9, 0, 0, 0]);
    expect(new DataView(pcBuf).getInt32(80, true)).toEqual(1234);
    expect(new DataView(pcBuf).getInt32(84, true)).toEqual(1000);
    expect(new DataView(pcBuf).getInt32(88, true)).toEqual(1000);

    const { mk: optionMk, calls: optionCalls } = capturingMk(0);
    const optionImports = buildWasmKernelImports(
      optionMk,
      () => new ArrayBuffer(64),
    );
    expect(await optionImports.host_socket_option(9, 1, 1, -7)).toEqual(0);
    expect(optionCalls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_OPTION,
      responseCap: 0,
    });
    expect(Array.from(optionCalls.at(-1)!.request)).toEqual([
      9,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      249,
      255,
      255,
      255,
    ]);

    const { mk: noDelayMk, calls: noDelayCalls } = capturingMk(0);
    const noDelayImports = buildWasmKernelImports(
      noDelayMk,
      () => new ArrayBuffer(64),
    );
    expect(await noDelayImports.host_socket_set_no_delay(9, 1)).toEqual(0);
    expect(noDelayCalls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_OPTION,
      responseCap: 0,
    });
    expect(Array.from(noDelayCalls.at(-1)!.request)).toEqual([
      9,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
    ]);

    const recvFromResponse = new Uint8Array(64);
    recvFromResponse.set(new TextEncoder().encode("pong"), 0);
    const recvFromPath = new TextEncoder().encode("/tmp/sender.sock");
    const recvFromView = new DataView(recvFromResponse.buffer);
    recvFromView.setUint32(16, recvFromPath.byteLength, true);
    recvFromView.setUint32(20, 0, true);
    recvFromResponse.set(recvFromPath, 24);
    const { mk: recvFromMk, calls: recvFromCalls } = capturingMk(
      4,
      recvFromResponse,
    );
    const recvFromBuf = new ArrayBuffer(256);
    const recvFromMem = new Uint8Array(recvFromBuf);
    recvFromMem.set(new TextEncoder().encode("unused"), 120);
    const recvFromImports = buildWasmKernelImports(
      recvFromMk,
      () => recvFromBuf,
    );
    expect(
      await recvFromImports.host_socket_recvfrom_unix(
        9,
        80,
        16,
        120,
        64,
        188,
        192,
      ),
    ).toEqual(4);
    expect(new TextDecoder().decode(new Uint8Array(recvFromBuf, 80, 4)))
      .toEqual("pong");
    expect(new TextDecoder().decode(
      new Uint8Array(recvFromBuf, 120, recvFromPath.byteLength),
    )).toEqual("/tmp/sender.sock");
    expect(new DataView(recvFromBuf).getInt32(188, true)).toEqual(
      recvFromPath.byteLength,
    );
    expect(new DataView(recvFromBuf).getInt32(192, true)).toEqual(0);
    expect(recvFromCalls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_RECVFROM,
      responseCap: 16 + 8 + 64,
    });

    await imports.host_socket_close(9);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_CLOSE,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([9, 0, 0, 0]);
  });

  it("returns required byte count without partial out_cap writes", async () => {
    const response = new TextEncoder().encode("/too/long\0");
    const { mk } = capturingMk(response.byteLength, response);
    const buf = new ArrayBuffer(32);
    const u = new Uint8Array(buf);
    u.fill(0xAA, 8, 12);
    const imports = buildWasmKernelImports(mk, () => buf);

    const rc = await imports.host_getcwd(8, 4);

    expect(rc).toEqual(response.byteLength);
    expect(Array.from(u.slice(8, 12))).toEqual([0xAA, 0xAA, 0xAA, 0xAA]);
  });

  it("durable KV wrappers round-trip put/get/list/delete", async () => {
    if (!HAS_JSPI) return;
    const host = defaultHostState();
    host.kv = new FakeKv();
    const mk = await KernelHostInterface.load(
      await Deno.readFile(KERNEL_WASM),
      host,
    );
    const buf = new ArrayBuffer(256);
    const u = new Uint8Array(buf);
    const imports = buildWasmKernelImports(mk, () => buf);

    const store = new TextEncoder().encode("sessions");
    const key = new TextEncoder().encode("alice");
    const value = new TextEncoder().encode("AAA");
    const putReq = new Uint8Array(
      1 + store.byteLength + 4 + key.byteLength + value.byteLength,
    );
    putReq[0] = store.byteLength;
    putReq.set(store, 1);
    new DataView(putReq.buffer).setUint32(
      1 + store.byteLength,
      key.byteLength,
      true,
    );
    putReq.set(key, 1 + store.byteLength + 4);
    putReq.set(value, 1 + store.byteLength + 4 + key.byteLength);
    u.set(putReq, 0);

    expect(await imports.host_idb_put(0, putReq.byteLength)).toEqual(0);

    const getReq = new Uint8Array(1 + store.byteLength + key.byteLength);
    getReq[0] = store.byteLength;
    getReq.set(store, 1);
    getReq.set(key, 1 + store.byteLength);
    u.set(getReq, 64);

    const gotLen = await imports.host_idb_get(64, getReq.byteLength, 128, 64);
    expect(gotLen).toEqual(3);
    expect(new TextDecoder().decode(new Uint8Array(buf, 128, gotLen)))
      .toEqual("AAA");

    const listLen = await imports.host_idb_list(
      64,
      store.byteLength + 1,
      128,
      64,
    );
    const listView = new DataView(buf, 128, listLen);
    expect(listView.getUint32(0, true)).toEqual(1);
    const keyLen = listView.getUint32(4, true);
    expect(new TextDecoder().decode(new Uint8Array(buf, 136, keyLen)))
      .toEqual("alice");

    expect(await imports.host_idb_delete(64, getReq.byteLength)).toEqual(0);
    expect(await imports.host_idb_get(64, getReq.byteLength, 128, 64))
      .toEqual(-2);
  });
});

describe("createWasmForkLifecycle", () => {
  // Minimal spy implementing WasmProcessHostRegistry; only the fork
  // lifecycle methods matter here.
  function spyRegistry() {
    const calls: string[] = [];
    const registry: WasmProcessHostRegistry = {
      processExitVersion: () => 0,
      waitForProcessExit: () => Promise.resolve(),
      prepareFork(parentPid) {
        calls.push(`prepareFork(${parentPid})`);
        return 4242; // child pid
      },
      commitFork(parentPid, childPid) {
        calls.push(`commitFork(${parentPid},${childPid})`);
        return 0;
      },
      rollbackFork(parentPid, childPid) {
        calls.push(`rollbackFork(${parentPid},${childPid})`);
        return 0;
      },
      recordExit(pid, status) {
        calls.push(`recordExit(${pid},${status})`);
        return 0;
      },
    };
    return { registry, calls };
  }

  it("without forkEvents delegates straight to the registry (substantive sync)", () => {
    const { registry, calls } = spyRegistry();
    const hooks = createWasmForkLifecycle(registry);
    expect(hooks.prepareFork(7)).toBe(4242);
    expect(hooks.commitFork(7, 4242)).toBe(0);
    expect(hooks.recordExit?.(4242, 0)).toBe(0);
    // Every call reached the Rust-kernel-backed registry.
    expect(calls).toEqual([
      "prepareFork(7)",
      "commitFork(7,4242)",
      "recordExit(4242,0)",
    ]);
  });

  it("with forkEvents delegates AND records observation strings", () => {
    const { registry, calls } = spyRegistry();
    const forkEvents: string[] = [];
    const hooks = createWasmForkLifecycle(registry, forkEvents);
    expect(hooks.prepareFork(7)).toBe(4242);
    hooks.commitFork(7, 4242);
    hooks.rollbackFork(7, 4242);
    hooks.recordExit?.(4242, 9);
    // Registry still received every call (sync not bypassed)...
    expect(calls).toEqual([
      "prepareFork(7)",
      "commitFork(7,4242)",
      "rollbackFork(7,4242)",
      "recordExit(4242,9)",
    ]);
    // ...and the observation side-channel saw them.
    expect(forkEvents).toEqual([
      "prepare:7:4242",
      "commit:7:4242",
      "rollback:7:4242",
      "exit:4242:9",
    ]);
  });
});

// Re-import METHOD so the unused-import lint stays quiet for
// embedders reading this test as documentation.
void METHOD;
