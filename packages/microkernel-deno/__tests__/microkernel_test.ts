/**
 * Deno-side parity tests for the sandboxed-kernel architecture.
 *
 * Loads the same `yurt-kernel-wasm` artifact the Rust tests build and
 * exercises the trampoline through the Deno microkernel. Mirrors the
 * Rust integration tests in `packages/runtime-wasmtime/tests/` —
 * every architectural assertion that runs there should run here, on
 * the same kernel.wasm.
 */

import { assertEquals } from "@std/assert";
import {
  defaultHostState,
  type ExtensionRegistry,
  type LogSink,
  METHOD,
  Microkernel,
  s,
  type UserProcess,
} from "../mod.ts";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function workspaceRoot(): string {
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
    cachedKernelWasm = await Deno.readFile(path);
    return cachedKernelWasm;
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
    cachedKernelWasm = await Deno.readFile(path);
    return cachedKernelWasm;
  }
}

async function freshMicrokernel(): Promise<Microkernel> {
  return await Microkernel.load(await kernelWasm(), defaultHostState());
}

async function fixtureWasm(
  crateName: string,
  artifact: string,
): Promise<Uint8Array> {
  const targetDir = Deno.env.get("CARGO_TARGET_DIR") ??
    join(workspaceRoot(), "target");
  const path = join(targetDir, "wasm32-wasip1", "release", `${artifact}.wasm`);
  try {
    return await Deno.readFile(path);
  } catch {
    const cmd = new Deno.Command("cargo", {
      args: [
        "build",
        "--release",
        "-p",
        crateName,
        "--target",
        "wasm32-wasip1",
      ],
      cwd: workspaceRoot(),
    });
    const { code } = await cmd.output();
    if (code !== 0) throw new Error(`build of ${crateName} failed`);
    return await Deno.readFile(path);
  }
}

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
      `wat2wasm failed: ${new TextDecoder().decode(stderr)}\n` +
        "Install wabt — see scripts/setup-dev-env.sh.",
    );
  }
  return stdout;
}

function captureProcExit(user: UserProcess): { error?: Error } {
  try {
    user.runStart();
    return {};
  } catch (e) {
    return { error: e as Error };
  }
}

// ── Kernel-side trampoline tests ──────────────────────────────────────────

Deno.test("unknown method returns -ENOSYS through the trampoline", async () => {
  const mk = await freshMicrokernel();
  const { rc } = mk.syscall(0xDEAD_BEEF, new Uint8Array(0), 0);
  assertEquals(rc, -38n);
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

Deno.test("kh_now_realtime serves host clock", async () => {
  const mk = await freshMicrokernel();
  mk.hostStateMut().nowRealtimeNs = 1_715_000_000_000_000_000n;
  const { rc, response } = mk.syscall(
    METHOD.KERNEL_NOW_REALTIME,
    new Uint8Array(0),
    8,
  );
  assertEquals(Number(rc), 8);
  assertEquals(
    new DataView(response.buffer).getBigUint64(0, true),
    1_715_000_000_000_000_000n,
  );
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
  assertEquals(collected[0].severity, 1);
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
  assertEquals(recorded[0], req);
  assertEquals(
    new TextDecoder().decode(response.subarray(0, written)),
    '{"exit_code":0,"stdout":"hello","stderr":""}',
  );
});

Deno.test("microkernel direct syscalls use kernel pid 0", async () => {
  const mk = await freshMicrokernel();
  const { rc } = mk.syscall(METHOD.SYS_GETPID, new Uint8Array(0), 0);
  assertEquals(rc, 0n);
});

// ── User-process tests via inline WAT (require wabt) ─────────────────────

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

Deno.test("user process pipe round-trip within one process", async () => {
  const mk = await freshMicrokernel();
  const userWasm = await wat2wasm(`
    (module
      (import "env" "sys_pipe"  (func $pipe  (param i32) (result i32)))
      (import "env" "sys_read"  (func $read  (param i32 i32 i32) (result i32)))
      (import "env" "sys_write" (func $write (param i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 64) "hello pipe")
      (func (export "do_pipe") (result i32) (call $pipe (i32.const 16)))
      (func (export "do_write") (result i32)
        (call $write (i32.load (i32.const 20)) (i32.const 64) (i32.const 10)))
      (func (export "do_read") (result i32)
        (call $read (i32.load (i32.const 16)) (i32.const 128) (i32.const 16))))
  `);
  const user = mk.spawnUserProcess(userWasm);
  assertEquals(user.callExportI32("do_pipe"), 0);
  assertEquals(user.callExportI32("do_write"), 10);
  assertEquals(user.callExportI32("do_read"), 10);
  const got = user.readMemory(128, 10);
  assertEquals(new TextDecoder().decode(got), "hello pipe");
});

// ── Real-fixture parity tests (mirror Rust fixture_parity.rs) ─────────────

Deno.test("hello-wasm prints via sys_write through kernel.wasm", async () => {
  const wasm = await fixtureWasm("hello-wasm", "hello-wasm");
  const mk = await freshMicrokernel();
  const user = mk.spawnUserProcess(wasm);
  captureProcExit(user); // proc_exit traps; that's expected
  const stdout = new TextDecoder().decode(user.capturedStdout());
  assertEquals(stdout, "hello from wasm\n");
});

Deno.test("echo-args fixture emits argv one per line", async () => {
  const wasm = await fixtureWasm("echo-args-wasm", "echo-args-wasm");
  const mk = await freshMicrokernel();
  const user = mk.spawnUserProcessWithArgs(wasm, [
    s("echo-args"),
    s("alpha"),
    s("beta"),
    s("gamma"),
  ]);
  captureProcExit(user);
  const stdout = new TextDecoder().decode(user.capturedStdout());
  assertEquals(stdout, "alpha\nbeta\ngamma\n");
});

Deno.test("cat-stdin fixture echoes stdin to stdout", async () => {
  const wasm = await fixtureWasm("cat-stdin-wasm", "cat-stdin-wasm");
  const mk = await freshMicrokernel();
  const user = mk.spawnUserProcessWithArgsAndStdin(
    wasm,
    [s("cat-stdin")],
    s("sandboxed kernel input\n"),
    true,
  );
  captureProcExit(user);
  assertEquals(
    user.capturedStdout(),
    s("sandboxed kernel input\n"),
  );
});

Deno.test("wc-bytes fixture counts stdin bytes", async () => {
  const wasm = await fixtureWasm("wc-bytes-wasm", "wc-bytes-wasm");
  const mk = await freshMicrokernel();
  const user = mk.spawnUserProcessWithArgsAndStdin(
    wasm,
    [s("wc-bytes")],
    s("0123456789"),
    true,
  );
  captureProcExit(user);
  assertEquals(new TextDecoder().decode(user.capturedStdout()), "10\n");
});

Deno.test("true-cmd fixture proc_exits zero", async () => {
  const wasm = await fixtureWasm("true-cmd-wasm", "true-cmd-wasm");
  const mk = await freshMicrokernel();
  const user = mk.spawnUserProcess(wasm);
  const { error } = captureProcExit(user);
  if (!error) throw new Error("expected proc_exit trap");
  if (!error.message.includes("proc_exit")) {
    throw new Error(`expected proc_exit in: ${error.message}`);
  }
});

Deno.test("false-cmd fixture proc_exits non-zero", async () => {
  const wasm = await fixtureWasm("false-cmd-wasm", "false-cmd-wasm");
  const mk = await freshMicrokernel();
  const user = mk.spawnUserProcess(wasm);
  const { error } = captureProcExit(user);
  if (!error) throw new Error("expected proc_exit trap");
  if (error.message.includes("proc_exit(0)")) {
    throw new Error(`false-cmd should not exit 0; got: ${error.message}`);
  }
});
