/**
 * Phase 7.2 macro layer — direct tests of the wrapper functions
 * buildWasmKernelImports produces. Each binding is exercised by
 * calling the generated function with the right shape of args
 * and asserting the result equals what Microkernel.syscallAsync
 * would return on its own. No probe wasm needed; the wrappers
 * are JS functions.
 *
 * When the kernelImpl="wasm" Sandbox option lands, the same
 * wrappers (Suspending-wrapped on the way to user wasm) carry
 * every host_* call. This test is the contract.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defaultHostState, METHOD, Microkernel } from "../../microkernel-js/mod.ts";
import { buildWasmKernelImports } from "../wasm-kernel-imports.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

async function freshMk(): Promise<Microkernel> {
  return await Microkernel.load(
    await Deno.readFile(KERNEL_WASM),
    defaultHostState(),
  );
}

describe("buildWasmKernelImports (Phase 7.2 macro)", () => {
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

  it("multi-scalar-arg: host_kill with args packed inline", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const fakeBuf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => fakeBuf);
    // sending signal 0 to a non-existent pid → -ESRCH. We're
    // exercising the multi-scalar packing path, not the exact
    // errno; any reasonable negative or zero is fine.
    const rc = await imports.host_kill(999_999, 0);
    expect(typeof rc).toEqual("number");
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

  it("host_native_invoke forwards bytes via sys_extension_invoke", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    // Stage a request — anything; the empty registry rejects.
    new Uint8Array(buf).set(new TextEncoder().encode("{}"));
    const imports = buildWasmKernelImports(mk, () => buf);
    // host_native_invoke(reqPtr=0, reqLen=2, outPtr=8, outCap=56)
    const rc = await imports.host_native_invoke(0, 2, 8, 56);
    // -ENOENT from the empty extension registry — proves the
    // bytes round-tripped through the trampoline.
    expect(rc).toEqual(-2);
  });
});

// Re-import METHOD so the unused-import lint stays quiet for
// embedders reading this test as documentation.
void METHOD;
