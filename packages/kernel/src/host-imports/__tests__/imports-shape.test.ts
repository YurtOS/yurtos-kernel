import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { createKernelImports } from "../kernel-imports.ts";
import { readString } from "../common.ts";
import { VFS } from "../../vfs/vfs.ts";
import { ProcessKernel } from "../../process/kernel.ts";
import { FdTable } from "../../vfs/fd-table.ts";
import { createVfsFileTarget } from "../../wasi/fd-target.ts";
import type { RuntimeEngineBackend } from "../../engine/backend.ts";

const encoder = new TextEncoder();

function writeString(memory: WebAssembly.Memory, ptr: number, value: string) {
  const bytes = encoder.encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function readJson(memory: WebAssembly.Memory, ptr: number, len: number) {
  return JSON.parse(readString(memory, ptr, len)) as Record<string, unknown>;
}

Deno.test("kernel host_spawn preserves shell's legacy synchronous result ABI", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const request = JSON.stringify({
    program: "echo",
    args: ["hello"],
    env: [["A", "B"]],
    cwd: "/tmp",
    stdin: "input",
  });
  const reqLen = writeString(memory, 0, request);

  const imports = createKernelImports({
    memory,
    syncSpawn: (cmd, args, env, stdin, cwd) => {
      assertEquals(cmd, "echo");
      assertEquals(args, ["hello"]);
      assertEquals(env, { A: "B" });
      assertEquals(new TextDecoder().decode(stdin), "input");
      assertEquals(cwd, "/tmp");
      return { exit_code: 0, stdout: "hello\n", stderr: "" };
    },
  });

  const written = (imports.host_spawn as (...args: number[]) => number)(
    0,
    reqLen,
    4096,
    1024,
  );

  assertEquals(readJson(memory, 4096, written), {
    exit_code: 0,
    stdout: "hello\n",
    stderr: "",
  });
});

Deno.test("kernel host_spawn reserves a process slot before fd cloning", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel({ maxProcesses: 1 });
  const parentPid = kernel.allocPid();
  const request = JSON.stringify({
    prog: "/bin/cat",
    args: [],
    env: [],
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
  });
  const reqLen = writeString(memory, 0, request);
  let spawned = false;

  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
    spawnProcess: () => {
      spawned = true;
      return 123;
    },
  });

  const pid = (imports.host_spawn as (...args: number[]) => number)(0, reqLen);
  assertEquals(pid, -1);
  assertEquals(spawned, false);
  assertEquals(kernel.getReservedProcessCount(), 1);
  assertEquals(kernel.getPpid(3), 0);
  assertEquals(kernel.getFdTarget(3, 0), null);
  kernel.dispose();
});

Deno.test("kernel host_spawn releases cloned fd refs when spawnProcess fails", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel({ maxProcesses: 2 });
  const parentPid = kernel.allocPid();
  const vfs = new VFS();
  vfs.writeFile("/tmp/in.txt", new TextEncoder().encode("data"));
  const fdTable = new FdTable(vfs);
  const fd = fdTable.open("/tmp/in.txt", "r");
  const target = createVfsFileTarget(fdTable, fd);
  kernel.setFdTarget(parentPid, 0, target);
  const request = JSON.stringify({
    prog: "/bin/cat",
    args: [],
    env: [],
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
  });
  const reqLen = writeString(memory, 0, request);

  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
    spawnProcess: () => {
      throw new Error("boom");
    },
  });

  const pid = (imports.host_spawn as (...args: number[]) => number)(0, reqLen);
  assertEquals(pid, -1);
  assertEquals(target.refs, 1);
  assertEquals(fdTable.isOpen(fd), true);
  assertEquals(kernel.getReservedProcessCount(), 1);
  kernel.dispose();
});

Deno.test("kernel host_waitpid only reaps children of the caller", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid();
  const siblingPid = kernel.allocPid();
  const childPid = kernel.allocPid(parentPid, "child");
  kernel.releaseProcess(childPid, 5);

  const siblingImports = createKernelImports({
    memory,
    kernel,
    callerPid: siblingPid,
  });
  const deniedLen = await (siblingImports.host_waitpid as (...args: number[]) => Promise<number>)(
    childPid,
    4096,
    1024,
  );
  assertEquals(readJson(memory, 4096, deniedLen), { pid: childPid, exit_code: -1 });
  assertEquals(kernel.hasProcess(childPid), true);

  const parentImports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
  });
  const waitedLen = await (parentImports.host_waitpid as (...args: number[]) => Promise<number>)(
    childPid,
    4096,
    1024,
  );
  assertEquals(readJson(memory, 4096, waitedLen), { pid: childPid, exit_code: 5 });
  assertEquals(kernel.hasProcess(childPid), false);
  kernel.dispose();
});

Deno.test("kernel host_waitpid_nohang distinguishes running from ECHILD", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid();
  const siblingPid = kernel.allocPid();
  const childPid = kernel.allocPid(parentPid, "child");

  const parentImports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
  });
  const siblingImports = createKernelImports({
    memory,
    kernel,
    callerPid: siblingPid,
  });

  assertEquals((parentImports.host_waitpid_nohang as (pid: number) => number)(childPid), -1);
  assertEquals((siblingImports.host_waitpid_nohang as (pid: number) => number)(childPid), -2);
  assertEquals((parentImports.host_waitpid_nohang as (pid: number) => number)(999), -2);
  kernel.dispose();
});

Deno.test("kernel host_waitpid_nohang reaps any exited child for pid -1", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid();
  const runningPid = kernel.allocPid(parentPid, "running");
  const exitedPid = kernel.allocPid(parentPid, "exited");
  kernel.releaseProcess(exitedPid, 8);

  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
  });

  const written = (imports.host_waitpid_nohang as (pid: number, outPtr: number, outCap: number) => number)(
    -1,
    4096,
    1024,
  );

  assertEquals(readJson(memory, 4096, written), { pid: exitedPid, exit_code: 8 });
  assertEquals(kernel.hasProcess(exitedPid), false);
  assertEquals(kernel.hasProcess(runningPid), true);
  assertEquals((imports.host_waitpid_nohang as (pid: number, outPtr: number, outCap: number) => number)(
    -1,
    4096,
    1024,
  ), -1);
  kernel.dispose();
});

Deno.test("kernel host_waitpid_nohang returns ECHILD for wait-any when no children remain", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid();
  const childPid = kernel.allocPid(parentPid, "child");
  kernel.releaseProcess(childPid, 0);

  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
  });

  const written = (imports.host_waitpid_nohang as (pid: number, outPtr: number, outCap: number) => number)(
    -1,
    4096,
    1024,
  );
  assertEquals(readJson(memory, 4096, written), { pid: childPid, exit_code: 0 });
  assertEquals((imports.host_waitpid_nohang as (pid: number, outPtr: number, outCap: number) => number)(
    -1,
    4096,
    1024,
  ), -2);
  kernel.dispose();
});

Deno.test("host_chmod allows the file owner and denies non-owners", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.writeFile("/tmp/user-owned.txt", new Uint8Array(1));
  vfs.withWriteAccess(() => {
    vfs.writeFile("/tmp/root-owned.txt", new Uint8Array(1));
  });

  const imports = createKernelImports({ memory, vfs, callerUid: 1000, callerGid: 1000 });

  let pathLen = writeString(memory, 0, "/tmp/user-owned.txt");
  assertEquals((imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o444), 0);
  assertEquals(vfs.stat("/tmp/user-owned.txt").permissions, 0o444);

  pathLen = writeString(memory, 0, "/tmp/root-owned.txt");
  assertEquals((imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o777), -2);
  assertEquals(vfs.stat("/tmp/root-owned.txt").permissions, 0o644);
});

Deno.test("host_chmod trusts kernel credentials over caller-supplied uid", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.withWriteAccess(() => {
    vfs.writeFile("/tmp/root-owned.txt", new Uint8Array(1));
  });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const imports = createKernelImports({ memory, vfs, kernel, callerPid: pid, callerUid: 0 });

  const pathLen = writeString(memory, 0, "/tmp/root-owned.txt");
  assertEquals((imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o777), -2);
  assertEquals(vfs.stat("/tmp/root-owned.txt").permissions, 0o644);
});

Deno.test("host_chown is root-only and mutates inode ownership", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.writeFile("/tmp/owned.txt", new Uint8Array(1));

  let pathLen = writeString(memory, 0, "/tmp/owned.txt");
  const userImports = createKernelImports({ memory, vfs, callerUid: 1000, callerGid: 1000 });
  assertEquals((userImports.host_chown as (...args: number[]) => number)(0, pathLen, 2000, 2000, 1), -2);
  assertEquals(vfs.stat("/tmp/owned.txt").uid, 1000);

  pathLen = writeString(memory, 0, "/tmp/owned.txt");
  const rootImports = createKernelImports({ memory, vfs, callerUid: 0, callerGid: 0 });
  assertEquals((rootImports.host_chown as (...args: number[]) => number)(0, pathLen, 2000, 2000, 1), 0);
  assertEquals(vfs.stat("/tmp/owned.txt").uid, 2000);
  assertEquals(vfs.stat("/tmp/owned.txt").gid, 2000);
});

Deno.test("host_fchown resolves vfs file descriptors through the kernel", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.writeFile("/tmp/fd-owned.txt", new Uint8Array(1));
  const fdTable = new FdTable(vfs);
  const fd = fdTable.open("/tmp/fd-owned.txt", "rw");
  const kernel = new ProcessKernel();
  const userPid = kernel.allocPid(1, "guest");
  kernel.setFdTarget(1, fd, createVfsFileTarget(fdTable, fd));
  kernel.setFdTarget(userPid, fd, createVfsFileTarget(fdTable, fd));

  const userImports = createKernelImports({ memory, vfs, kernel, callerPid: userPid, callerUid: 0 });
  assertEquals((userImports.host_fchown as (...args: number[]) => number)(fd, 2000, 2000), -2);

  const rootImports = createKernelImports({ memory, vfs, kernel, callerPid: 1 });
  assertEquals((rootImports.host_fchown as (...args: number[]) => number)(fd, 2000, 2000), 0);
  assertEquals(vfs.stat("/tmp/fd-owned.txt").uid, 2000);
  assertEquals(vfs.stat("/tmp/fd-owned.txt").gid, 2000);
});

Deno.test("host uid/gid imports are backed by kernel credentials", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const imports = createKernelImports({ memory, kernel, callerPid: pid, callerUid: 0 });

  assertEquals((imports.host_getuid as () => number)(), 1000);
  assertEquals((imports.host_geteuid as () => number)(), 1000);
  assertEquals((imports.host_getgid as () => number)(), 1000);
  assertEquals((imports.host_getegid as () => number)(), 1000);
});

Deno.test("host_setresuid and host_setresgid deny unprivileged root escalation but allow no-op transitions", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals((imports.host_setresuid as (...args: number[]) => number)(1000, 1000, 1000), 0);
  assertEquals((imports.host_setresuid as (...args: number[]) => number)(-1, -1, -1), 0);
  assertEquals((imports.host_setresuid as (...args: number[]) => number)(0, 0, 0), -2);
  assertEquals((imports.host_setresgid as (...args: number[]) => number)(1000, 1000, 1000), 0);
  assertEquals((imports.host_setresgid as (...args: number[]) => number)(-1, -1, -1), 0);
  assertEquals((imports.host_setresgid as (...args: number[]) => number)(0, 0, 0), -2);
  assertEquals(kernel.getCredentials(pid), { uid: 1000, gid: 1000, euid: 1000, egid: 1000, suid: 1000, sgid: 1000 });
});

Deno.test("root process can change effective credentials for future authorization", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.withWriteAccess(() => {
    vfs.writeFile("/tmp/root-owned.txt", new Uint8Array(1));
  });
  const kernel = new ProcessKernel();
  const imports = createKernelImports({ memory, vfs, kernel, callerPid: 1 });

  assertEquals((imports.host_setresuid as (...args: number[]) => number)(1000, 1000, 1000), 0);
  const pathLen = writeString(memory, 0, "/tmp/root-owned.txt");
  assertEquals((imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o777), -2);
  assertEquals(vfs.stat("/tmp/root-owned.txt").permissions, 0o644);
});

Deno.test("host_umask stores process-local mask inherited by children", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid(1, "parent");
  const imports = createKernelImports({ memory, kernel, callerPid: parentPid });

  assertEquals((imports.host_umask as (mask: number) => number)(0o077), 0o022);
  assertEquals(kernel.getUmask(parentPid), 0o077);

  const childPid = kernel.allocPid(parentPid, "child");
  assertEquals(kernel.getUmask(childPid), 0o077);

  assertEquals((imports.host_umask as (mask: number) => number)(0o002), 0o077);
  assertEquals(kernel.getUmask(parentPid), 0o002);
  assertEquals(kernel.getUmask(childPid), 0o077);
});

Deno.test("host_chdir stores cwd in kernel process state and validates directories", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.mkdir("/tmp/cwd-target");
  vfs.writeFile("/tmp/not-a-dir.txt", new Uint8Array(0));
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const imports = createKernelImports({ memory, vfs, kernel, callerPid: pid });

  const dirLen = writeString(memory, 0, "/tmp/cwd-target");
  assertEquals((imports.host_chdir as (...args: number[]) => number)(0, dirLen), 0);
  assertEquals(kernel.getCwd(pid), "/tmp/cwd-target");

  const childPid = kernel.allocPid(pid, "child");
  assertEquals(kernel.getCwd(childPid), "/tmp/cwd-target");

  const fileLen = writeString(memory, 64, "/tmp/not-a-dir.txt");
  assertEquals((imports.host_chdir as (...args: number[]) => number)(64, fileLen), -4);
  assertEquals(kernel.getCwd(pid), "/tmp/cwd-target");

  const missingLen = writeString(memory, 128, "/tmp/missing-dir");
  assertEquals((imports.host_chdir as (...args: number[]) => number)(128, missingLen), -1);
});

Deno.test("host_getcwd writes the caller cwd and reports required size", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  kernel.setCwd(pid, "/tmp/work");
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals((imports.host_getcwd as (...args: number[]) => number)(0, 5), 10);
  assertEquals((imports.host_getcwd as (...args: number[]) => number)(0, 32), 10);
  assertEquals(new TextDecoder().decode(new Uint8Array(memory.buffer, 0, 9)), "/tmp/work");
  assertEquals(new Uint8Array(memory.buffer)[9], 0);
});

Deno.test("host_setpriority reports unsupported when no scheduler backend can apply the change", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals((imports.host_getpriority as (...args: number[]) => number)(0, 0), 0);
  assertEquals((imports.host_setpriority as (...args: number[]) => number)(0, 0, 5), -38);
  assertEquals(kernel.getPriority(pid), 0);
});

Deno.test("host_setpriority applies through an explicit scheduler backend", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const calls: Array<{ pid: number; nice: number }> = [];
  const runtimeBackend: RuntimeEngineBackend = {
    scheduler: {
      setPriority(request) {
        calls.push({ pid: request.targetPid, nice: request.nice });
        return { ok: true };
      },
    },
  };
  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: pid,
    runtimeBackend,
  });

  assertEquals((imports.host_setpriority as (...args: number[]) => number)(0, 0, 7), 0);
  assertEquals((imports.host_getpriority as (...args: number[]) => number)(0, 0), 7);
  assertEquals(calls, [{ pid, nice: 7 }]);
});

Deno.test("host scheduler policy reports metadata and rejects unsupported changes", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals((imports.host_sched_getscheduler as (...args: number[]) => number)(0), 0);
  assertEquals((imports.host_sched_getparam as (...args: number[]) => number)(0), 0);
  assertEquals((imports.host_sched_setscheduler as (...args: number[]) => number)(0, 0, 0), 0);
  assertEquals((imports.host_sched_setparam as (...args: number[]) => number)(0, 0), 0);
  assertEquals((imports.host_sched_setscheduler as (...args: number[]) => number)(0, 1, 1), -2);
  const rootImports = createKernelImports({ memory, kernel, callerPid: 1 });
  assertEquals((rootImports.host_sched_setscheduler as (...args: number[]) => number)(1, 1, 1), -38);
  assertEquals(kernel.getScheduler(pid), { policy: 0, priority: 0 });
});

Deno.test("host scheduler policy applies through an explicit scheduler backend", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const calls: Array<{ pid: number; policy: number; priority: number }> = [];
  const runtimeBackend: RuntimeEngineBackend = {
    scheduler: {
      setPriority() {
        return { ok: true };
      },
      setScheduler(request) {
        calls.push({ pid: request.targetPid, policy: request.policy, priority: request.priority });
        return { ok: true };
      },
    },
  };
  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: 1,
    runtimeBackend,
  });

  assertEquals((imports.host_sched_setscheduler as (...args: number[]) => number)(1, 1, 4), 0);
  assertEquals((imports.host_sched_getscheduler as (...args: number[]) => number)(1), 1);
  assertEquals((imports.host_sched_getparam as (...args: number[]) => number)(1), 4);
  assertEquals((imports.host_sched_setparam as (...args: number[]) => number)(1, 5), 0);
  assertEquals(kernel.getScheduler(1), { policy: 1, priority: 5 });
  assertEquals(calls, [
    { pid: 1, policy: 1, priority: 4 },
    { pid: 1, policy: 1, priority: 5 },
  ]);
});

Deno.test("host rlimit stores process-local limits inherited by children", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid(1, "parent");
  const imports = createKernelImports({ memory, kernel, callerPid: parentPid });

  assertEquals((imports.host_getrlimit as (...args: number[]) => number)(7, 64), 0);
  assertEquals(view.getUint32(64, true), 1024);
  assertEquals(view.getUint32(68, true), 1024);

  assertEquals((imports.host_setrlimit as (...args: number[]) => number)(7, 4, 1024), 0);
  assertEquals((imports.host_getrlimit as (...args: number[]) => number)(7, 64), 0);
  assertEquals(view.getUint32(64, true), 4);
  assertEquals(view.getUint32(68, true), 1024);

  const childPid = kernel.allocPid(parentPid, "child");
  assertEquals(kernel.getResourceLimit(childPid, 7), { soft: 4, hard: 1024 });
});

Deno.test("host_spawn rejects nonzero nice when the engine has no scheduler backend", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const request = JSON.stringify({
    prog: "echo",
    args: ["hello"],
    env: [],
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
    nice: 5,
  });
  const reqLen = writeString(memory, 0, request);
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid(1, "parent");
  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
    spawnProcess: () => {
      throw new Error("spawnProcess should not run when scheduler support is absent");
    },
  });

  assertEquals((imports.host_spawn as (...args: number[]) => number)(0, reqLen), -38);
});
