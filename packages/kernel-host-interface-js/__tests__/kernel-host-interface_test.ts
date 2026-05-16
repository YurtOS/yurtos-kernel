/**
 * JS-kernel-host interface parity tests for the sandboxed-kernel architecture.
 *
 * Tests the portable JS+wasm core in `packages/kernel-host-interface-js/`. The
 * code under test runs in any JS engine; Deno is the convenient
 * test driver because it has a stock test runner and WebAssembly
 * ready out of the box. The same code runs unchanged in browsers —
 * the only delta there is the loading path (fetch vs Deno.readFile),
 * which lives in the application layer above the kernel-host interface.
 *
 * Loads the same `yurt-kernel-wasm` artifact the Rust tests build and
 * exercises the trampoline through the JS kernel-host interface. Mirrors the
 * Rust integration tests in `packages/runtime-wasmtime/tests/` —
 * every architectural assertion that runs there should run here, on
 * the same kernel.wasm.
 */

import { assertEquals } from "@std/assert";
import {
  defaultHostState,
  denyAllPolicy,
  type ExtensionRegistry,
  KernelHostInterface,
  type LogSink,
  METHOD,
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

async function freshKernelHostInterface(): Promise<KernelHostInterface> {
  return await KernelHostInterface.load(await kernelWasm(), defaultHostState());
}

function encodeSysSpawnRequest(
  path: Uint8Array,
  argv: Uint8Array[],
): Uint8Array {
  let len = 4 + path.byteLength;
  for (const arg of argv) len += 4 + arg.byteLength;
  const req = new Uint8Array(len);
  const view = new DataView(req.buffer);
  let off = 0;
  view.setUint32(off, path.byteLength, true);
  off += 4;
  req.set(path, off);
  off += path.byteLength;
  for (const arg of argv) {
    view.setUint32(off, arg.byteLength, true);
    off += 4;
    req.set(arg, off);
    off += arg.byteLength;
  }
  return req;
}

function encodeTwoPathRequest(
  first: Uint8Array,
  second: Uint8Array,
): Uint8Array {
  const req = new Uint8Array(4 + first.byteLength + second.byteLength);
  new DataView(req.buffer).setUint32(0, first.byteLength, true);
  req.set(first, 4);
  req.set(second, 4 + first.byteLength);
  return req;
}

function u32(value: number): Uint8Array {
  const req = new Uint8Array(4);
  new DataView(req.buffer).setUint32(0, value >>> 0, true);
  return req;
}

function spawnFromRamfs(
  mk: KernelHostInterface,
  parentPid: number,
  path: Uint8Array,
  argv: Uint8Array[],
): number {
  mk.registerRamfsFile(path, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const { rc } = mk.kernelSyscall(
    METHOD.SYS_SPAWN,
    parentPid,
    encodeSysSpawnRequest(path, argv),
    0,
  );
  const pid = Number(rc);
  if (pid < 1000) {
    throw new Error(`expected kernel-allocated child pid, got ${pid}`);
  }
  return pid;
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

async function optionalGeneratedFixtureWasm(
  name: string,
): Promise<Uint8Array | undefined> {
  try {
    return await Deno.readFile(
      join(
        workspaceRoot(),
        "packages",
        "kernel",
        "src",
        "platform",
        "__tests__",
        "fixtures",
        name,
      ),
    );
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
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
  const mk = await freshKernelHostInterface();
  const { rc } = mk.syscall(0xDEAD_BEEF, new Uint8Array(0), 0);
  assertEquals(rc, -38n);
});

Deno.test("kernel-host interface binds wasm-engine kh imports", async () => {
  const fakeKernel = await wat2wasm(`
    (module
      (import "kh" "kh_spawn_process"
        (func $spawn (param i32 i32 i32 i32) (result i32)))
      (import "kh" "kh_destroy_instance"
        (func $destroy (param i32) (result i32)))
      (import "kh" "kh_process_mem_read"
        (func $mem_read (param i32 i32 i32 i32) (result i64)))
      (import "kh" "kh_process_mem_write"
        (func $mem_write (param i32 i32 i32 i32) (result i64)))
      (import "kh" "kh_process_resume"
        (func $resume (param i32 i64 i64) (result i64)))
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
            (call $resume (i32.const 0) (i64.const 0) (i64.const 1000000))))))
  `);
  const mk = await KernelHostInterface.load(fakeKernel, defaultHostState());
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
        (func $spawn (param i32 i32 i32 i32) (result i32)))
      (import "kh" "kh_destroy_instance"
        (func $destroy (param i32) (result i32)))
      (import "kh" "kh_process_mem_read"
        (func $mem_read (param i32 i32 i32 i32) (result i64)))
      (import "kh" "kh_process_mem_write"
        (func $mem_write (param i32 i32 i32 i32) (result i64)))
      (memory (export "memory") 1)
      (data (i32.const 2048) "mem-proc")
      (data (i32.const 2064) "ok")
      (data (i32.const 2072) "\\01\\00\\00\\00\\01\\00\\00\\00\\00\\00\\00\\00")
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
            (i32.const 2072) (i32.const 12)))
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
  const mk = await KernelHostInterface.load(fakeKernel, defaultHostState());
  mk.cacheProcessModule(s("mem-proc"), processWasm);
  const { rc, response } = mk.syscall(0, new Uint8Array(0), 2);
  assertEquals(rc, 2n);
  assertEquals(new TextDecoder().decode(response.subarray(0, 2)), "ok");
});

Deno.test("kernel_spawn_process allocates pid through kernel and kh adapter", async () => {
  const processWasm = await wat2wasm(`
    (module
      (import "env" "sys_getpid" (func $getpid (result i32)))
      (memory (export "memory") 1)
      (func (export "run") (result i32) (call $getpid)))
  `);
  const mk = await freshKernelHostInterface();
  mk.cacheProcessModule(s("kernel-owned-process"), processWasm);

  const user = mk.spawnCachedUserProcess(
    s("kernel-owned-process"),
    [s("/bin/kernel-owned-process")],
  );

  assertEquals(user.pid, 1);
  assertEquals(user.callExportI32("run"), 1);
  const [proc] = mk.listProcesses();
  assertEquals(proc.pid, 1);
  assertEquals(proc.ppid, 0);
  assertEquals(
    new TextDecoder().decode(proc.command),
    "/bin/kernel-owned-process",
  );
  assertEquals(mk.killProcess(user.pid, 15), 0);
  assertEquals(mk.killProcess(user.pid, 15), 0);
});

Deno.test("memory-mediated request/response round-trips bytes", async () => {
  const mk = await freshKernelHostInterface();
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
  const mk = await freshKernelHostInterface();
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
  const mk = await KernelHostInterface.load(await kernelWasm(), {
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
  const mk = await KernelHostInterface.load(await kernelWasm(), {
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
    // (0) as the caller, so we create an explicit non-zero target pid.
    const mk = await freshKernelHostInterface();

    const targetPid = spawnFromRamfs(mk, 1, s("/bin/pgid"), [s("pgid")]);
    const target = new Uint8Array(4);
    new DataView(target.buffer).setUint32(0, targetPid, true);

    // getpgid(pid) returns the process's initial pgid.
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
    const mk = await freshKernelHostInterface();

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

    const targetPid = spawnFromRamfs(mk, 1, s("/bin/signal-target"), [
      s("signal-target"),
    ]);

    // kill(sig=0) succeeds as an alive probe for an existing process.
    const k1 = new Uint8Array(8);
    new DataView(k1.buffer).setUint32(0, targetPid, true);
    ({ rc } = mk.syscall(METHOD.SYS_KILL, k1, 0));
    assertEquals(Number(rc), 0);

    // kill out-of-range → -EINVAL (-22).
    const k2 = new Uint8Array(8);
    const k2View = new DataView(k2.buffer);
    k2View.setUint32(0, targetPid, true);
    k2View.setUint32(4, 64, true);
    ({ rc } = mk.syscall(METHOD.SYS_KILL, k2, 0));
    assertEquals(Number(rc), -22);
  },
);

Deno.test(
  "sched_yield + nanosleep round-trip through the trampoline",
  async () => {
    const mk = await freshKernelHostInterface();
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
    const mk = await freshKernelHostInterface();
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
    const mk = await KernelHostInterface.load(await kernelWasm(), {
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
    const mk = await KernelHostInterface.load(await kernelWasm(), {
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

Deno.test("kernel-host interface direct syscalls use kernel pid 0", async () => {
  const mk = await freshKernelHostInterface();
  const { rc } = mk.syscall(METHOD.SYS_GETPID, new Uint8Array(0), 0);
  assertEquals(rc, 0n);
});

Deno.test("listProcesses reads the kernel-owned process snapshot", async () => {
  const mk = await freshKernelHostInterface();
  const childPid = spawnFromRamfs(mk, 1, s("/bin/wc"), [s("/bin/wc")]);

  mk.recordExit(childPid, 2);

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

Deno.test("listThreads reads the kernel-owned thread snapshot", async () => {
  const mk = await freshKernelHostInterface();
  const childPid = spawnFromRamfs(mk, 1, s("/bin/threaded"), [s("threaded")]);

  const threads = mk.listThreads(childPid);
  assertEquals(threads, [{
    tid: 1,
    state: "runnable",
    detached: false,
    exitValue: -1,
    hostThreadHandle: -1,
  }]);
});

Deno.test("thread lifecycle controls mutate the kernel-owned thread snapshot", async () => {
  const mk = await freshKernelHostInterface();
  const childPid = spawnFromRamfs(mk, 1, s("/bin/threaded"), [s("threaded")]);

  const tid = mk.spawnThread(childPid, 91);
  assertEquals(tid, 2);
  assertEquals(mk.listThreads(childPid).find((t) => t.tid === tid), {
    tid,
    state: "runnable",
    detached: false,
    exitValue: -1,
    hostThreadHandle: 91,
  });

  mk.blockThread(childPid, tid);
  assertEquals(
    mk.listThreads(childPid).find((t) => t.tid === tid)?.state,
    "blocked",
  );

  mk.unblockThread(childPid, tid);
  assertEquals(
    mk.listThreads(childPid).find((t) => t.tid === tid)?.state,
    "runnable",
  );

  mk.detachThread(childPid, tid);
  assertEquals(
    mk.listThreads(childPid).find((t) => t.tid === tid)?.detached,
    true,
  );

  mk.recordThreadExit(childPid, tid, 123);
  assertEquals(mk.listThreads(childPid).find((t) => t.tid === tid), undefined);
});

Deno.test("thread dispatch authenticates main caller tid for pthread_self", async () => {
  const mk = await freshKernelHostInterface();
  const childPid = spawnFromRamfs(mk, 1, s("/bin/threaded"), [s("threaded")]);

  const out = mk.kernelThreadSyscall(
    METHOD.SYS_THREAD_SELF,
    childPid,
    1,
    new Uint8Array(0),
    0,
  );

  assertEquals(Number(out.rc), 0);
});

Deno.test("user-process host_thread_self routes through Rust thread dispatch", async () => {
  const wasm = await wat2wasm(`(module
    (import "yurt" "host_thread_self" (func $host_thread_self (result i32)))
    (func (export "run") (result i32)
      call $host_thread_self))`);
  const mk = await freshKernelHostInterface();
  const user = mk.spawnUserProcess(wasm);

  assertEquals(user.callExportI32("run"), 0);
});

Deno.test("user-process host_thread_spawn executes and joins through Rust state", async () => {
  const wasm = await wat2wasm(`(module
    (import "yurt" "host_thread_spawn" (func $spawn (param i32 i32) (result i32)))
    (import "yurt" "host_thread_join" (func $join (param i32 i32) (result i32)))
    (memory (export "memory") 1)
    (global $tid (mut i32) (i32.const 0))
    (func $worker (param i32) (result i32)
      local.get 0)
    (table (export "__indirect_function_table") 1 funcref)
    (elem (i32.const 0) $worker)
    (func (export "spawn") (result i32)
      i32.const 0
      i32.const 0x80000000
      call $spawn
      global.set $tid
      global.get $tid)
    (func (export "join") (result i32)
      global.get $tid
      i32.const 4
      call $join))`);
  const mk = await freshKernelHostInterface();
  const user = mk.spawnUserProcess(wasm);

  assertEquals(user.callExportI32("spawn"), 2);
  await Promise.resolve();
  assertEquals(user.callExportI32("join"), 0);
  assertEquals(
    new DataView(user.readMemory(4, 4).buffer).getUint32(0, true),
    0x8000_0000,
  );
  assertEquals(mk.listThreads(user.pid).find((t) => t.tid === 2), undefined);
});

Deno.test("spawned user-process thread sees its Rust-owned tid", async () => {
  const wasm = await wat2wasm(`(module
    (import "yurt" "host_thread_spawn" (func $spawn (param i32 i32) (result i32)))
    (import "yurt" "host_thread_join" (func $join (param i32 i32) (result i32)))
    (import "yurt" "host_thread_self" (func $self (result i32)))
    (memory (export "memory") 1)
    (global $tid (mut i32) (i32.const 0))
    (func $worker (param i32) (result i32)
      call $self)
    (table (export "__indirect_function_table") 1 funcref)
    (elem (i32.const 0) $worker)
    (func (export "spawn") (result i32)
      i32.const 0
      i32.const 0
      call $spawn
      global.set $tid
      global.get $tid)
    (func (export "join") (result i32)
      global.get $tid
      i32.const 4
      call $join))`);
  const mk = await freshKernelHostInterface();
  const user = mk.spawnUserProcess(wasm);

  assertEquals(user.callExportI32("spawn"), 2);
  await Promise.resolve();
  assertEquals(user.callExportI32("join"), 0);
  assertEquals(
    new DataView(user.readMemory(4, 4).buffer).getUint32(0, true),
    2,
  );
});

Deno.test("thread dispatch returns join status separately from raw retval bits", async () => {
  const mk = await freshKernelHostInterface();
  const childPid = spawnFromRamfs(mk, 1, s("/bin/threaded"), [s("threaded")]);
  const tid = mk.spawnThread(childPid, 91);
  mk.recordThreadExit(childPid, tid, 0x8000_0000);

  const out = mk.kernelThreadSyscall(
    METHOD.SYS_THREAD_JOIN,
    childPid,
    1,
    u32(tid),
    4,
  );

  assertEquals(Number(out.rc), 0);
  assertEquals(
    new DataView(out.response.buffer, out.response.byteOffset, 4).getUint32(
      0,
      true,
    ),
    0x8000_0000,
  );
});

Deno.test("scheduleNext reads kernel-owned runnable decisions with budgets", async () => {
  const mk = await freshKernelHostInterface();
  const childPid = spawnFromRamfs(mk, 1, s("/bin/threaded"), [s("threaded")]);
  const tid = mk.spawnThread(childPid, 91);
  mk.recordThreadExit(1, 1, 0);

  assertEquals(mk.scheduleNext(), {
    pid: childPid,
    tid: 1,
    hostThreadHandle: -1,
    flags: 0,
    budgetNs: 20_000_000n,
  });
  assertEquals(mk.scheduleNext(), {
    pid: childPid,
    tid,
    hostThreadHandle: 91,
    flags: 0,
    budgetNs: 20_000_000n,
  });

  mk.blockThread(childPid, tid);
  mk.recordThreadExit(childPid, 1, 0);
  assertEquals(mk.scheduleNext(), undefined);
});

Deno.test("kernel snapshot returns a versioned binary state envelope", async () => {
  const mk = await freshKernelHostInterface();
  const childPid = spawnFromRamfs(mk, 1, s("/bin/threaded"), [s("threaded")]);
  const tid = mk.spawnThread(childPid, 91);
  mk.blockThread(childPid, tid);

  const snapshot = mk.snapshotKernelState();
  const magic = new TextDecoder().decode(snapshot.subarray(0, 7));
  const view = new DataView(
    snapshot.buffer,
    snapshot.byteOffset,
    snapshot.byteLength,
  );
  assertEquals(magic, "YURTSNP");
  assertEquals(snapshot[7], 0);
  assertEquals(view.getUint16(8, true), 1);
  assertEquals(view.getUint16(10, true), 4);
  assertEquals(view.getUint32(12, true), 0);

  let offset = 16;
  let sawProcessSection = false;
  let sawThreadSection = false;
  let sawWaitSection = false;
  let sawRunnableSection = false;
  for (let i = 0; i < 4; i++) {
    const sectionType = view.getUint32(offset, true);
    offset += 4;
    const sectionLen = view.getUint32(offset, true);
    offset += 4;
    const section = snapshot.subarray(offset, offset + sectionLen);
    offset += sectionLen;
    if (sectionType === 1) {
      sawProcessSection = true;
      assertEquals(section.includes(childPid & 0xff), true);
    } else if (sectionType === 2) {
      sawThreadSection = true;
      assertEquals(section.includes(tid), true);
      assertEquals(section.includes(2), true);
    } else if (sectionType === 3) {
      sawWaitSection = true;
      const waitView = new DataView(
        section.buffer,
        section.byteOffset,
        section.byteLength,
      );
      assertEquals(waitView.getUint32(0, true), 1);
      assertEquals(waitView.getUint32(4, true), childPid);
      assertEquals(waitView.getUint32(8, true), tid);
      assertEquals(waitView.getUint32(12, true), 1);
      assertEquals(waitView.getUint32(16, true), 0);
    } else if (sectionType === 4) {
      sawRunnableSection = true;
      const runnableView = new DataView(
        section.buffer,
        section.byteOffset,
        section.byteLength,
      );
      const runnableCount = runnableView.getUint32(0, true);
      let sawMainThread = false;
      for (let j = 0; j < runnableCount; j++) {
        const entryOffset = 4 + j * 8;
        const runnablePid = runnableView.getUint32(entryOffset, true);
        const runnableTid = runnableView.getUint32(entryOffset + 4, true);
        if (runnablePid === childPid && runnableTid === 1) {
          sawMainThread = true;
        }
      }
      assertEquals(sawMainThread, true);
    }
  }
  assertEquals(offset, snapshot.byteLength);
  assertEquals(sawProcessSection, true);
  assertEquals(sawThreadSection, true);
  assertEquals(sawWaitSection, true);
  assertEquals(sawRunnableSection, true);
});

Deno.test("waitProcess and killProcess enter kernel-owned process control", async () => {
  const mk = await freshKernelHostInterface();
  const childPid = spawnFromRamfs(mk, 1, s("/bin/child"), [s("child")]);

  mk.recordExit(childPid, 17);

  assertEquals(mk.waitProcess(1, 0, 0), { pid: childPid, status: 17 });
  assertEquals(mk.killProcess(childPid, 15), 0);
  assertEquals(mk.killProcess(childPid, 64), -22);
});

Deno.test("drainPendingSpawn and recordExit use typed kernel lifecycle exports", async () => {
  const mk = await freshKernelHostInterface();
  const wasmBody = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 9, 9, 9]);
  mk.registerRamfsFile(s("/bin/echo"), wasmBody);

  const path = s("/bin/echo");
  const arg0 = s("echo");
  const arg1 = s("hi");
  const parentPid = 1;
  const { rc } = mk.kernelSyscall(
    METHOD.SYS_SPAWN,
    parentPid,
    encodeSysSpawnRequest(path, [arg0, arg1]),
    0,
  );
  const childPid = Number(rc);
  if (childPid < 1000) {
    throw new Error(`expected kernel-allocated child pid, got ${childPid}`);
  }

  const pending = mk.drainPendingSpawn();
  if (pending === null) throw new Error("expected pending spawn record");
  assertEquals(pending.childPid, childPid);
  assertEquals(pending.wasmBytes, wasmBody);
  assertEquals(pending.argv, [arg0, arg1]);
  assertEquals(mk.drainPendingSpawn(), null);

  mk.recordExit(childPid, 7);
  assertEquals(mk.waitProcess(parentPid, 0, 0), { pid: childPid, status: 7 });
});

Deno.test("sys_spawn follows executable symlinks without rewriting argv0", async () => {
  const mk = await freshKernelHostInterface();
  const wasmBody = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 2, 3]);
  mk.registerRamfsFile(s("/usr/bin/hello"), wasmBody);
  assertEquals(
    Number(
      mk.kernelSyscall(
        METHOD.SYS_SYMLINK,
        1,
        encodeTwoPathRequest(s("/usr/bin/hello"), s("/bin/hello-link")),
        0,
      ).rc,
    ),
    0,
  );

  const path = s("/bin/hello-link");
  const argv0 = s("/bin/hello-link");
  const arg1 = s("world");
  const parentPid = 1;
  const childPid = Number(
    mk.kernelSyscall(
      METHOD.SYS_SPAWN,
      parentPid,
      encodeSysSpawnRequest(path, [argv0, arg1]),
      0,
    ).rc,
  );
  if (childPid < 1000) {
    throw new Error(`expected kernel-allocated child pid, got ${childPid}`);
  }

  const pending = mk.drainPendingSpawn();
  if (pending === null) throw new Error("expected pending spawn record");
  assertEquals(pending.childPid, childPid);
  assertEquals(pending.wasmBytes, wasmBody);
  assertEquals(pending.argv, [argv0, arg1]);
});

// ── User-process tests via inline WAT (require wabt) ─────────────────────

Deno.test("user process calls sys_getuid through the full trampoline", async () => {
  const mk = await freshKernelHostInterface();
  const userWasm = await wat2wasm(`
    (module
      (import "env" "sys_getuid" (func $getuid (result i32)))
      (func (export "run") (result i32) (call $getuid)))
  `);
  const user = mk.spawnUserProcess(userWasm);
  assertEquals(user.callExportI32("run"), 1000);
});

Deno.test("each spawned process gets a unique pid", async () => {
  const mk = await freshKernelHostInterface();
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
  const mk = await freshKernelHostInterface();
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

Deno.test("user process poll reports pipe write readiness", async () => {
  const mk = await freshKernelHostInterface();
  const userWasm = await wat2wasm(`
    (module
      (import "env" "sys_pipe" (func $pipe (param i32) (result i32)))
      (import "env" "sys_poll" (func $poll (param i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (func (export "setup") (result i32)
        (call $pipe (i32.const 16)))
      (func (export "poll_writer") (result i32)
        (i32.store (i32.const 32) (i32.load (i32.const 20)))
        (i32.store16 (i32.const 36) (i32.const 2))
        (i32.store16 (i32.const 38) (i32.const 0))
        (call $poll (i32.const 32) (i32.const 1) (i32.const 0)))
      (func (export "writer_revents") (result i32)
        (i32.load16_u (i32.const 38))))
  `);
  const user = mk.spawnUserProcess(userWasm);
  assertEquals(user.callExportI32("setup"), 0);
  assertEquals(user.callExportI32("poll_writer"), 1);
  assertEquals(user.callExportI32("writer_revents"), 2);
});

Deno.test("user process priority imports route through kernel scheduler state", async () => {
  const mk = await freshKernelHostInterface();
  const userWasm = await wat2wasm(`
    (module
      (import "yurt" "host_getpriority"
        (func $getpriority (param i32 i32) (result i32)))
      (import "yurt" "host_setpriority"
        (func $setpriority (param i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (func (export "get") (result i32)
        (call $getpriority (i32.const 0) (i32.const 0)))
      (func (export "set10") (result i32)
        (call $setpriority (i32.const 0) (i32.const 0) (i32.const 10)))
      (func (export "raise_priority") (result i32)
        (call $setpriority (i32.const 0) (i32.const 0) (i32.const -1))))
  `);
  const user = mk.spawnUserProcess(userWasm);

  assertEquals(user.callExportI32("get"), 0);
  assertEquals(user.callExportI32("set10"), 0);
  assertEquals(user.callExportI32("get"), 10);
  assertEquals(user.callExportI32("raise_priority"), -1);
});

Deno.test("user process scheduler imports route through kernel scheduler state", async () => {
  const mk = await freshKernelHostInterface();
  const userWasm = await wat2wasm(`
    (module
      (import "yurt" "host_sched_getscheduler"
        (func $getscheduler (param i32) (result i32)))
      (import "yurt" "host_sched_getparam"
        (func $getparam (param i32) (result i32)))
      (import "yurt" "host_sched_setscheduler"
        (func $setscheduler (param i32 i32 i32) (result i32)))
      (import "yurt" "host_sched_setparam"
        (func $setparam (param i32 i32) (result i32)))
      (memory (export "memory") 1)
      (func (export "get_policy") (result i32)
        (call $getscheduler (i32.const 0)))
      (func (export "get_param") (result i32)
        (call $getparam (i32.const 0)))
      (func (export "setscheduler_other") (result i32)
        (call $setscheduler (i32.const 0) (i32.const 0) (i32.const 0)))
      (func (export "setparam_zero") (result i32)
        (call $setparam (i32.const 0) (i32.const 0)))
      (func (export "setparam_nonzero") (result i32)
        (call $setparam (i32.const 0) (i32.const 1)))
      (func (export "setscheduler_fifo") (result i32)
        (call $setscheduler (i32.const 0) (i32.const 1) (i32.const 1))))
  `);
  const user = mk.spawnUserProcess(userWasm);

  assertEquals(user.callExportI32("get_policy"), 0);
  assertEquals(user.callExportI32("get_param"), 0);
  assertEquals(user.callExportI32("setscheduler_other"), 0);
  assertEquals(user.callExportI32("setparam_zero"), 0);
  assertEquals(user.callExportI32("setparam_nonzero"), -22);
  assertEquals(user.callExportI32("setscheduler_fifo"), -1);
});

// ── Real-fixture parity tests (mirror Rust fixture_parity.rs) ─────────────

Deno.test("hello-wasm prints via sys_write through kernel.wasm", async () => {
  const wasm = await fixtureWasm("hello-wasm", "hello-wasm");
  const mk = await freshKernelHostInterface();
  const user = mk.spawnUserProcess(wasm);
  captureProcExit(user); // proc_exit traps; that's expected
  const stdout = new TextDecoder().decode(user.capturedStdout());
  assertEquals(stdout, "hello from wasm\n");
});

Deno.test("echo-args fixture emits argv one per line", async () => {
  const wasm = await fixtureWasm("echo-args-wasm", "echo-args-wasm");
  const mk = await freshKernelHostInterface();
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
    const mk = await freshKernelHostInterface();
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
    const mk = await freshKernelHostInterface();
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
  const mk = await freshKernelHostInterface();
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
  const mk = await freshKernelHostInterface();
  const user = mk.spawnUserProcessWithArgsAndStdin(
    wasm,
    [s("wc-bytes")],
    s("0123456789"),
    true,
  );
  captureProcExit(user);
  assertEquals(new TextDecoder().decode(user.capturedStdout()), "10\n");
});

Deno.test("std-fs fixture creates, stats, reads, and unlinks a file", async () => {
  const wasm = await optionalGeneratedFixtureWasm("std-fs-canary.wasm");
  if (!wasm) return;
  const mk = await freshKernelHostInterface();
  const user = mk.spawnUserProcessWithArgs(wasm, [s("std-fs-canary")]);
  captureProcExit(user);
  assertEquals(
    new TextDecoder().decode(user.capturedStdout()),
    "canonical=/yurt-std-fs-canary.txt\ncontents=yurt\n",
  );
});

Deno.test("true-cmd fixture proc_exits zero", async () => {
  const wasm = await fixtureWasm("true-cmd-wasm", "true-cmd-wasm");
  const mk = await freshKernelHostInterface();
  const user = mk.spawnUserProcess(wasm);
  const { error } = captureProcExit(user);
  if (!error) throw new Error("expected proc_exit trap");
  if (!error.message.includes("proc_exit")) {
    throw new Error(`expected proc_exit in: ${error.message}`);
  }
});

Deno.test("false-cmd fixture proc_exits non-zero", async () => {
  const wasm = await fixtureWasm("false-cmd-wasm", "false-cmd-wasm");
  const mk = await freshKernelHostInterface();
  const user = mk.spawnUserProcess(wasm);
  const { error } = captureProcExit(user);
  if (!error) throw new Error("expected proc_exit trap");
  if (error.message.includes("proc_exit(0)")) {
    throw new Error(`false-cmd should not exit 0; got: ${error.message}`);
  }
});
