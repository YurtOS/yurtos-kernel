/**
 * Deno-side parity tests for the sandboxed-kernel architecture.
 *
 * Loads the same `yurt-kernel-wasm` artifact the Rust tests build and
 * exercises the trampoline through the Deno microkernel. These tests
 * are the second backend (after `microkernel-wasmtime`) validating
 * that the contract is genuinely runtime-agnostic — same kernel.wasm,
 * different host.
 *
 * Note: user-process spawn() tests require a WAT-to-wasm compiler,
 * which most envs don't have available out of the box. The
 * spawn-side path uses identical code to the kernel-side import
 * resolution validated below; richer Deno-side user-process tests
 * land when a JS wabt is wired in (see TODO at the bottom).
 */

import { assertEquals } from "@std/assert";
import {
  defaultHostState,
  type ExtensionRegistry,
  type LogSink,
  METHOD,
  Microkernel,
} from "../mod.ts";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function workspaceRoot(): string {
  // packages/microkernel-deno/__tests__/x.ts → up 4 dirnames
  // (file → __tests__ → microkernel-deno → packages → workspace).
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

let cachedKernelWasm: Uint8Array | undefined;
async function kernelWasm(): Promise<Uint8Array> {
  if (cachedKernelWasm) return cachedKernelWasm;
  const targetDir = Deno.env.get("CARGO_TARGET_DIR") ??
    join(workspaceRoot(), "target");
  const path = join(
    targetDir,
    "wasm32-wasip1",
    "release",
    "yurt_kernel_wasm.wasm",
  );
  try {
    const buf = await Deno.readFile(path);
    cachedKernelWasm = buf;
    return buf;
  } catch {
    const cmd = new Deno.Command("cargo", {
      args: [
        "build",
        "--release",
        "-p",
        "yurt-kernel-wasm",
        "--target",
        "wasm32-wasip1",
      ],
      cwd: workspaceRoot(),
    });
    const { code } = await cmd.output();
    if (code !== 0) throw new Error("cargo build of yurt-kernel-wasm failed");
    const buf = await Deno.readFile(path);
    cachedKernelWasm = buf;
    return buf;
  }
}

async function freshMicrokernel(): Promise<Microkernel> {
  return await Microkernel.load(await kernelWasm(), defaultHostState());
}

Deno.test("unknown method returns -ENOSYS through the trampoline", async () => {
  const mk = await freshMicrokernel();
  const { rc } = mk.syscall(0xDEAD_BEEF, new Uint8Array(0), 0);
  assertEquals(rc, -38n, "expected -ENOSYS (-38)");
});

Deno.test("memory-mediated request/response round-trips bytes", async () => {
  const mk = await freshMicrokernel();
  const request = new TextEncoder().encode("trampoline-validates-arch");
  const { rc, response } = mk.syscall(
    METHOD.KERNEL_ECHO,
    request,
    request.byteLength,
  );
  assertEquals(Number(rc), request.byteLength);
  assertEquals(response.subarray(0, request.byteLength), request);
});

Deno.test("kh_now_realtime serves host clock through dispatch", async () => {
  const mk = await freshMicrokernel();
  mk.hostStateMut().nowRealtimeNs = 1_715_000_000_000_000_000n;
  const { rc, response } = mk.syscall(
    METHOD.KERNEL_NOW_REALTIME,
    new Uint8Array(0),
    8,
  );
  assertEquals(Number(rc), 8);
  const view = new DataView(response.buffer);
  assertEquals(view.getBigUint64(0, true), 1_715_000_000_000_000_000n);
});

Deno.test("kh_log routes kernel messages to the configured LogSink", async () => {
  const collected: { severity: number; message: string }[] = [];
  const sink: LogSink = {
    emit(severity, message) {
      collected.push({ severity, message });
    },
  };
  const mk = await Microkernel.load(await kernelWasm(), {
    ...defaultHostState(),
    logSink: sink,
  });
  const { rc } = mk.syscall(METHOD.KERNEL_LOG_TEST, new Uint8Array(0), 0);
  assertEquals(Number(rc), 0);
  assertEquals(collected.length, 1);
  assertEquals(collected[0].severity, 1, "INFO");
  assertEquals(collected[0].message, "kernel.wasm hello via kh_log");
});

Deno.test("sys_extension_invoke forwards bytes through the registry", async () => {
  const recorded: Uint8Array[] = [];
  const registry: ExtensionRegistry = {
    invoke(req, _cap) {
      recorded.push(req);
      return new TextEncoder().encode(
        '{"exit_code":0,"stdout":"hello","stderr":""}',
      );
    },
  };
  const mk = await Microkernel.load(await kernelWasm(), {
    ...defaultHostState(),
    extensions: registry,
  });
  const req = new TextEncoder().encode(
    '{"name":"my_ext","args":["a"],"stdin":"","cwd":"/"}',
  );
  const { rc, response } = mk.syscall(METHOD.SYS_EXTENSION_INVOKE, req, 256);
  const written = Number(rc);
  if (written <= 0) throw new Error(`expected positive write, got ${rc}`);
  assertEquals(recorded.length, 1);
  assertEquals(recorded[0], req);
  assertEquals(
    new TextDecoder().decode(response.subarray(0, written)),
    '{"exit_code":0,"stdout":"hello","stderr":""}',
  );
});

Deno.test("microkernel direct syscalls use kernel pid 0", async () => {
  // Direct mk.syscall (no user process) reaches the kernel with
  // caller_pid=0, which is the KERNEL_PID convention. sys_getpid
  // returns the caller_pid as a scalar, so we should see 0 here.
  const mk = await freshMicrokernel();
  const { rc } = mk.syscall(METHOD.SYS_GETPID, new Uint8Array(0), 0);
  assertEquals(rc, 0n, "direct call sees KERNEL_PID");
});

Deno.test("default credentials read 1000 via direct syscall", async () => {
  const mk = await freshMicrokernel();
  const { rc } = mk.syscall(METHOD.SYS_GETUID, new Uint8Array(0), 0);
  // Direct calls use pid 0 → lazy-default Process → uid 1000.
  assertEquals(rc, 1000n);
});

// ── User-process parity tests (require wat2wasm) ───────────────────────────

async function wat2wasm(wat: string): Promise<Uint8Array> {
  const cmd = new Deno.Command("wat2wasm", {
    args: ["-", "--output=-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(wat));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(
      `wat2wasm failed (exit ${code}): ${new TextDecoder().decode(stderr)}\n` +
        "Install wabt — see scripts/setup-dev-env.sh.",
    );
  }
  return stdout;
}

Deno.test("user process calls sys_getuid through the full trampoline", async () => {
  const mk = await freshMicrokernel();
  const userWasm = await wat2wasm(`
    (module
      (import "env" "sys_getuid" (func $getuid (result i32)))
      (func (export "run") (result i32) (call $getuid)))
  `);
  const user = mk.spawnUserProcess(userWasm);
  assertEquals(user.callExportI32("run"), 1000);
});

Deno.test("each spawned process gets a unique pid", async () => {
  const mk = await freshMicrokernel();
  const userWasm = await wat2wasm(`
    (module
      (import "env" "sys_getpid" (func $getpid (result i32)))
      (func (export "run") (result i32) (call $getpid)))
  `);
  const a = mk.spawnUserProcess(userWasm);
  const b = mk.spawnUserProcess(userWasm);
  const c = mk.spawnUserProcess(userWasm);
  assertEquals(a.pid, 1);
  assertEquals(b.pid, 2);
  assertEquals(c.pid, 3);
  assertEquals(a.callExportI32("run"), 1);
  assertEquals(b.callExportI32("run"), 2);
  assertEquals(c.callExportI32("run"), 3);
});

Deno.test("user process umask persists across calls for same pid", async () => {
  const mk = await freshMicrokernel();
  const userWasm = await wat2wasm(`
    (module
      (import "env" "sys_umask" (func $umask (param i32) (result i32)))
      (func (export "first") (result i32) (call $umask (i32.const 63)))
      (func (export "second") (result i32) (call $umask (i32.const 7))))
  `);
  const user = mk.spawnUserProcess(userWasm);
  assertEquals(user.callExportI32("first"), 0o022);
  assertEquals(user.callExportI32("second"), 0o077);
});

Deno.test("user process setresuid changes subsequent getuid", async () => {
  const mk = await freshMicrokernel();
  const userWasm = await wat2wasm(`
    (module
      (import "env" "sys_setresuid"
        (func $setresuid (param i32 i32 i32) (result i32)))
      (import "env" "sys_getuid" (func $getuid (result i32)))
      (func (export "set") (result i32)
        (call $setresuid (i32.const 4242) (i32.const 4242) (i32.const 4242)))
      (func (export "get") (result i32) (call $getuid)))
  `);
  const user = mk.spawnUserProcess(userWasm);
  assertEquals(user.callExportI32("get"), 1000);
  assertEquals(user.callExportI32("set"), 0);
  assertEquals(user.callExportI32("get"), 4242);
});

Deno.test("user process chdir then getcwd round trips", async () => {
  const mk = await freshMicrokernel();
  const userWasm = await wat2wasm(`
    (module
      (import "env" "sys_chdir" (func $chdir (param i32 i32) (result i32)))
      (import "env" "sys_getcwd" (func $getcwd (param i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 16) "/srv/yurt")
      (func (export "set") (result i32)
        (call $chdir (i32.const 16) (i32.const 9)))
      (func (export "get") (result i32)
        (call $getcwd (i32.const 64) (i32.const 64))))
  `);
  const user = mk.spawnUserProcess(userWasm);
  assertEquals(user.callExportI32("get"), 2, 'default cwd "/" + NUL');
  assertEquals(user.callExportI32("set"), 0);
  assertEquals(user.callExportI32("get"), 10, "/srv/yurt + NUL");
  const got = user.readMemory(64, 10);
  assertEquals(new TextDecoder().decode(got), "/srv/yurt\0");
});
