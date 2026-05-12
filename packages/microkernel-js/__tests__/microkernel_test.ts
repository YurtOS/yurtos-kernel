/**
 * JS-microkernel parity tests for the sandboxed-kernel architecture.
 *
 * Tests the portable JS+wasm core in `packages/microkernel-js/`. The
 * code under test runs in any JS engine; Deno is the convenient
 * test driver because it has a stock test runner and WebAssembly
 * ready out of the box. The same code runs unchanged in browsers —
 * the only delta there is the loading path (fetch vs Deno.readFile),
 * which lives in the application layer above the microkernel.
 *
 * Loads the same `yurt-kernel-wasm` artifact the Rust tests build and
 * exercises the trampoline through the JS microkernel. Mirrors the
 * Rust integration tests in `packages/runtime-wasmtime/tests/` —
 * every architectural assertion that runs there should run here, on
 * the same kernel.wasm.
 */

import { assertEquals } from "@std/assert";
import {
  defaultHostState,
  denyAllPolicy,
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

Deno.test("microkernel binds wasm-engine kh imports", async () => {
  const fakeKernel = await wat2wasm(`
    (module
      (import "kh" "kh_spawn_process"
        (func $spawn (param i32 i32 i32 i32 i32 i32) (result i32)))
      (import "kh" "kh_destroy_instance"
        (func $destroy (param i32) (result i32)))
      (import "kh" "kh_process_mem_read"
        (func $mem_read (param i32 i32 i32 i32) (result i64)))
      (import "kh" "kh_process_mem_write"
        (func $mem_write (param i32 i32 i32 i32) (result i64)))
      (import "kh" "kh_process_resume"
        (func $resume (param i32 i64) (result i64)))
      (memory (export "memory") 1)
      (func (export "kernel_scratch_ptr") (result i32) (i32.const 1024))
      (func (export "kernel_scratch_len") (result i32) (i32.const 4096))
      (func (export "kernel_dispatch")
        (param i32 i32 i32 i32 i32 i32)
        (result i64)
        (i64.add
          (i64.add
            (i64.extend_i32_s
              (call $spawn
                (i32.const 0) (i32.const 0)
                (i32.const 0) (i32.const 0)
                (i32.const 0) (i32.const 0)))
            (i64.extend_i32_s (call $destroy (i32.const 0))))
          (i64.add
            (i64.add
              (call $mem_read
                (i32.const 0) (i32.const 0)
                (i32.const 0) (i32.const 0))
              (call $mem_write
                (i32.const 0) (i32.const 0)
                (i32.const 0) (i32.const 0)))
            (call $resume (i32.const 0) (i64.const 0))))))
  `);
  const mk = await Microkernel.load(fakeKernel, defaultHostState());
  const { rc } = mk.syscall(0, new Uint8Array(0), 0);
  assertEquals(rc, -67n);
});

Deno.test("kh_spawn_process manages cached wasm instance handles", async () => {
  const processWasm = await wat2wasm(`
    (module
      (memory (export "memory") 1))
  `);
  const fakeKernel = await wat2wasm(`
    (module
      (import "kh" "kh_spawn_process"
        (func $spawn (param i32 i32 i32 i32 i32 i32) (result i32)))
      (import "kh" "kh_destroy_instance"
        (func $destroy (param i32) (result i32)))
      (import "kh" "kh_process_mem_read"
        (func $mem_read (param i32 i32 i32 i32) (result i64)))
      (import "kh" "kh_process_mem_write"
        (func $mem_write (param i32 i32 i32 i32) (result i64)))
      (memory (export "memory") 1)
      (data (i32.const 2048) "mem-proc")
      (data (i32.const 2064) "ok")
      (func (export "kernel_scratch_ptr") (result i32) (i32.const 1024))
      (func (export "kernel_scratch_len") (result i32) (i32.const 4096))
      (func (export "kernel_dispatch")
        (param $method i32) (param $pid i32)
        (param $in_ptr i32) (param $in_len i32)
        (param $out_ptr i32) (param $out_cap i32)
        (result i64)
        (local $handle i32)
        (local $rc i64)
        (local.set $handle
          (call $spawn
            (i32.const 2048) (i32.const 8)
            (i32.const 0) (i32.const 0)
            (i32.const 0) (i32.const 0)))
        (if (result i64) (i32.lt_s (local.get $handle) (i32.const 0))
          (then (return (i64.extend_i32_s (local.get $handle))))
          (else (i64.const 0)))
        (drop)
        (local.set $rc
          (call $mem_write
            (local.get $handle)
            (i32.const 16)
            (i32.const 2064)
            (i32.const 2)))
        (if (i64.ne (local.get $rc) (i64.const 2))
          (then (return (local.get $rc))))
        (local.set $rc
          (call $mem_read
            (local.get $handle)
            (i32.const 16)
            (local.get $out_ptr)
            (i32.const 2)))
        (if (i64.ne (local.get $rc) (i64.const 2))
          (then (return (local.get $rc))))
        (drop (call $destroy (local.get $handle)))
        (i64.const 2)))
  `);
  const mk = await Microkernel.load(fakeKernel, defaultHostState());
  mk.cacheProcessModule(s("mem-proc"), processWasm);
  const { rc, response } = mk.syscall(0, new Uint8Array(0), 2);
  assertEquals(rc, 2n);
  assertEquals(new TextDecoder().decode(response.subarray(0, 2)), "ok");
});

Deno.test("kernel_spawn_process allocates pid through kernel and kh adapter", async () => {
  const processWasm = await wat2wasm(`
    (module
      (memory (export "memory") 1))
  `);
  const mk = await freshMicrokernel();
  mk.cacheProcessModule(s("kernel-owned-process"), processWasm);

  const pid = mk.spawnCachedProcess(
    s("kernel-owned-process"),
    [s("/bin/kernel-owned-process")],
  );

  assertEquals(pid, 1);
  const [proc] = mk.listProcesses();
  assertEquals(proc.pid, 1);
  assertEquals(proc.ppid, 0);
  assertEquals(
    new TextDecoder().decode(proc.command),
    "/bin/kernel-owned-process",
  );
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

Deno.test(
  "process group + session syscalls round-trip through the trampoline",
  async () => {
    // Mirror of fixture_parity / kernel_wasm_trampoline equivalents on
    // the wasmtime side. Each direct .syscall() call passes KERNEL_PID
    // (0) as the caller, so we use an explicit non-zero target pid.
    const mk = await freshMicrokernel();

    const targetPid = 42;
    const target = new Uint8Array(4);
    new DataView(target.buffer).setUint32(0, targetPid, true);

    // getpgid(42) lazily primes pgid to the target pid.
    let { rc } = mk.syscall(METHOD.SYS_GETPGID, target, 0);
    assertEquals(Number(rc), targetPid);

    // setpgid(42, 99).
    const setReq = new Uint8Array(8);
    const setView = new DataView(setReq.buffer);
    setView.setUint32(0, targetPid, true);
    setView.setUint32(4, 99, true);
    ({ rc } = mk.syscall(METHOD.SYS_SETPGID, setReq, 0));
    assertEquals(Number(rc), 0);

    // getpgid now reflects 99.
    ({ rc } = mk.syscall(METHOD.SYS_GETPGID, target, 0));
    assertEquals(Number(rc), 99);

    // getsid(42) lazily primes sid independently.
    ({ rc } = mk.syscall(METHOD.SYS_GETSID, target, 0));
    assertEquals(Number(rc), targetPid);
  },
);

Deno.test(
  "signal stubs (kill + sigaction) round-trip through the trampoline",
  async () => {
    const mk = await freshMicrokernel();

    // sigaction(SIGTERM=15, SIG_IGN=1) → previous SIG_DFL=0.
    const sa1 = new Uint8Array(8);
    const sa1View = new DataView(sa1.buffer);
    sa1View.setUint32(0, 15, true);
    sa1View.setUint32(4, 1, true);
    let { rc } = mk.syscall(METHOD.SYS_SIGACTION, sa1, 0);
    assertEquals(Number(rc), 0);

    // Replace with user handler 0xDEAD; previous should be 1 (SIG_IGN).
    const sa2 = new Uint8Array(8);
    const sa2View = new DataView(sa2.buffer);
    sa2View.setUint32(0, 15, true);
    sa2View.setUint32(4, 0xDEAD, true);
    ({ rc } = mk.syscall(METHOD.SYS_SIGACTION, sa2, 0));
    assertEquals(Number(rc), 1);

    // kill(target=7, sig=0) succeeds (alive probe).
    const k1 = new Uint8Array(8);
    new DataView(k1.buffer).setUint32(0, 7, true);
    ({ rc } = mk.syscall(METHOD.SYS_KILL, k1, 0));
    assertEquals(Number(rc), 0);

    // kill out-of-range → -EINVAL (-22).
    const k2 = new Uint8Array(8);
    const k2View = new DataView(k2.buffer);
    k2View.setUint32(0, 7, true);
    k2View.setUint32(4, 64, true);
    ({ rc } = mk.syscall(METHOD.SYS_KILL, k2, 0));
    assertEquals(Number(rc), -22);
  },
);

Deno.test(
  "sched_yield + nanosleep round-trip through the trampoline",
  async () => {
    const mk = await freshMicrokernel();
    let { rc } = mk.syscall(METHOD.SYS_SCHED_YIELD, new Uint8Array(0), 0);
    assertEquals(Number(rc), 0);

    const ns = new Uint8Array(8);
    new DataView(ns.buffer).setBigUint64(0, 1_500_000n, true);
    ({ rc } = mk.syscall(METHOD.SYS_NANOSLEEP, ns, 0));
    assertEquals(Number(rc), 0);

    // Short request → -EINVAL (-22).
    ({ rc } = mk.syscall(METHOD.SYS_NANOSLEEP, new Uint8Array([1, 2, 3]), 0));
    assertEquals(Number(rc), -22);
  },
);

Deno.test(
  "ramfs register_file + sys_open + sys_read round-trip content",
  async () => {
    const mk = await freshMicrokernel();
    const enc = new TextEncoder();
    mk.registerRamfsFile(enc.encode("/etc/motd"), enc.encode("hello ramfs\n"));

    // Open via direct kernel syscall (KERNEL_PID is the caller).
    // sys_open wire format: u32 flags + path bytes. flags=0 = read-only.
    const buildOpen = (flags: number, path: Uint8Array) => {
      const req = new Uint8Array(4 + path.byteLength);
      new DataView(req.buffer).setUint32(0, flags >>> 0, true);
      req.set(path, 4);
      return req;
    };
    const open = mk.syscall(
      METHOD.SYS_OPEN,
      buildOpen(0, enc.encode("/etc/motd")),
      0,
    );
    const fd = Number(open.rc);
    if (fd < 0) throw new Error(`expected open success, got ${fd}`);

    const fdReq = new Uint8Array(4);
    new DataView(fdReq.buffer).setUint32(0, fd >>> 0, true);
    const { rc, response } = mk.syscall(METHOD.SYS_READ, fdReq, 64);
    const n = Number(rc);
    assertEquals(
      new TextDecoder().decode(response.subarray(0, n)),
      "hello ramfs\n",
    );

    // Unknown path → -ENOENT (-2).
    const missing = mk.syscall(
      METHOD.SYS_OPEN,
      buildOpen(0, enc.encode("/no/such")),
      0,
    );
    assertEquals(Number(missing.rc), -2);
  },
);

Deno.test(
  "PolicyEnforcer denies extension at the kh_* boundary",
  async () => {
    // Policy mirrors the Rust BlockEvil test: deny anything
    // containing "evil" before the extension registry sees it.
    const recorded: Uint8Array[] = [];
    const registry: ExtensionRegistry = {
      invoke(req, _cap) {
        recorded.push(req);
        return new TextEncoder().encode("ok");
      },
    };
    const mk = await Microkernel.load(await kernelWasm(), {
      ...defaultHostState(),
      extensions: registry,
      policy: {
        mayInvokeExtension(request) {
          const text = new TextDecoder().decode(request);
          return text.includes("evil") ? "deny" : "allow";
        },
      },
    });

    // Allowed call goes through.
    const benign = new TextEncoder().encode("benign request");
    const ok = mk.syscall(METHOD.SYS_EXTENSION_INVOKE, benign, 64);
    if (Number(ok.rc) <= 0) {
      throw new Error(`expected positive rc, got ${ok.rc}`);
    }
    assertEquals(recorded.length, 1);

    // Denied call returns -EACCES (-13) and never reaches registry.
    const evil = new TextEncoder().encode("do something evil");
    const denied = mk.syscall(METHOD.SYS_EXTENSION_INVOKE, evil, 64);
    assertEquals(Number(denied.rc), -13);
    assertEquals(recorded.length, 1, "registry must not see denied call");
  },
);

Deno.test(
  "denyAllPolicy blocks kh_now_realtime → sys_clock_gettime",
  async () => {
    const mk = await Microkernel.load(await kernelWasm(), {
      ...defaultHostState(),
      policy: denyAllPolicy,
    });
    const { rc } = mk.syscall(
      METHOD.SYS_CLOCK_GETTIME,
      new Uint8Array(4), // clock_id = 0 (REALTIME), little-endian zero
      8,
    );
    if (Number(rc) >= 0) {
      throw new Error(`expected denial, got rc=${rc}`);
    }
  },
);

Deno.test("microkernel direct syscalls use kernel pid 0", async () => {
  const mk = await freshMicrokernel();
  const { rc } = mk.syscall(METHOD.SYS_GETPID, new Uint8Array(0), 0);
  assertEquals(rc, 0n);
});

Deno.test("listProcesses reads the kernel-owned process snapshot", async () => {
  const mk = await freshMicrokernel();
  const childPid = 7;
  const encoder = new TextEncoder();

  const command = encoder.encode("/bin/wc");
  const argvReq = new Uint8Array(4 + 4 + command.byteLength);
  const argvView = new DataView(argvReq.buffer);
  argvView.setUint32(0, childPid, true);
  argvView.setUint32(4, command.byteLength, true);
  argvReq.set(command, 8);
  mk.syscall(METHOD.KERNEL_SET_ARGV, argvReq, 0);

  const reg = new Uint8Array(8);
  const regView = new DataView(reg.buffer);
  regView.setUint32(0, 1, true);
  regView.setUint32(4, childPid, true);
  mk.syscall(METHOD.KERNEL_REGISTER_CHILD, reg, 0);

  const exit = new Uint8Array(8);
  const exitView = new DataView(exit.buffer);
  exitView.setUint32(0, childPid, true);
  exitView.setInt32(4, 2, true);
  mk.syscall(METHOD.KERNEL_RECORD_EXIT, exit, 0);

  const procs = mk.listProcesses();
  const child = procs.find((p) => p.pid === childPid);
  if (!child) throw new Error("child process missing from kernel snapshot");
  assertEquals(child.ppid, 1);
  assertEquals(child.pgid, childPid);
  assertEquals(child.sid, childPid);
  assertEquals(child.state, "exited");
  assertEquals(child.exitStatus, 2);
  assertEquals(new TextDecoder().decode(child.command), "/bin/wc");
  assertEquals(child.fds, [0, 1, 2]);
});

Deno.test("waitProcess and killProcess enter kernel-owned process control", async () => {
  const mk = await freshMicrokernel();

  const reg = new Uint8Array(8);
  const regView = new DataView(reg.buffer);
  regView.setUint32(0, 1, true);
  regView.setUint32(4, 8, true);
  mk.syscall(METHOD.KERNEL_REGISTER_CHILD, reg, 0);

  const exit = new Uint8Array(8);
  const exitView = new DataView(exit.buffer);
  exitView.setUint32(0, 8, true);
  exitView.setInt32(4, 17, true);
  mk.syscall(METHOD.KERNEL_RECORD_EXIT, exit, 0);

  assertEquals(mk.waitProcess(1, 0, 0), { pid: 8, status: 17 });
  assertEquals(mk.killProcess(8, 15), 0);
  assertEquals(mk.killProcess(8, 64), -22);
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
  assertEquals(
    mk.listProcesses().map((p) => p.pid),
    [1, 2, 3],
  );
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

Deno.test(
  "cat-ramfs fixture reads /etc/motd via WASI path_open + sys_open",
  async () => {
    const wasm = await fixtureWasm("cat-ramfs-wasm", "cat-ramfs-wasm");
    const mk = await freshMicrokernel();
    mk.registerRamfsFile(s("/etc/motd"), s("hello ramfs\n"));
    const user = mk.spawnUserProcessWithArgs(wasm, [s("cat-ramfs")]);
    captureProcExit(user);
    assertEquals(user.capturedStdout(), s("hello ramfs\n"));
  },
);

Deno.test(
  "proc-cmdline fixture reads /proc/self/cmdline through the WASI shim",
  async () => {
    const wasm = await fixtureWasm("proc-cmdline-wasm", "proc-cmdline-wasm");
    const mk = await freshMicrokernel();
    const argv = [
      s("/usr/bin/proc-cmdline"),
      s("--flag"),
      s("value"),
    ];
    const user = mk.spawnUserProcessWithArgs(wasm, argv);
    captureProcExit(user);
    assertEquals(
      user.capturedStdout(),
      s("/usr/bin/proc-cmdline\0--flag\0value\0"),
    );
  },
);

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
