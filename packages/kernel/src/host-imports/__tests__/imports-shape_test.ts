import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { createKernelImports } from "../kernel-imports.ts";
import { readString } from "../common.ts";
import { VFS } from "../../vfs/vfs.ts";
import { OverlayVFS } from "../../vfs/overlay-vfs.ts";
import { MemoryRoot } from "../../vfs/__tests__/helpers.ts";
import { ProcessKernel } from "../../process/kernel.ts";
import { FdTable } from "../../vfs/fd-table.ts";
import { createVfsFileTarget, type FdTarget } from "../../wasi/fd-target.ts";
import { WasiExitError, WasiHost } from "../../wasi/wasi-host.ts";
import { createAsyncPipe } from "../../vfs/pipe.ts";
import type { RuntimeEngineBackend } from "../../engine/backend.ts";
import type { SocketBackend } from "../../network/socket-backend.ts";
import { buildNativeSpawnRequest } from "./spawn-request-fixture.ts";

const encoder = new TextEncoder();

function writeString(memory: WebAssembly.Memory, ptr: number, value: string) {
  const bytes = encoder.encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function readWaitResult(memory: WebAssembly.Memory, ptr: number) {
  const view = new DataView(memory.buffer);
  return {
    pid: view.getInt32(ptr, true),
    exit_code: view.getInt32(ptr + 4, true),
    signal: view.getInt32(ptr + 8, true),
    flags: view.getInt32(ptr + 12, true),
  };
}

const POLLIN = 0x0001;
const POLLOUT = 0x0002;
const POLLHUP = 0x2000;
const POLLNVAL = 0x4000;

function writePollFd(
  memory: WebAssembly.Memory,
  ptr: number,
  fd: number,
  events: number,
) {
  const view = new DataView(memory.buffer);
  view.setInt32(ptr, fd, true);
  view.setInt16(ptr + 4, events, true);
  view.setInt16(ptr + 6, 0, true);
}

function readPollRevents(memory: WebAssembly.Memory, ptr: number): number {
  return new DataView(memory.buffer).getInt16(ptr + 6, true);
}

Deno.test("kernel host_spawn accepts native spawn request records", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel({ maxProcesses: 3 });
  const parentPid = kernel.allocPid(1, "parent");
  const request = buildNativeSpawnRequest({
    prog: "/bin/echo",
    argv0: "echo",
    args: ["hello", "world"],
    env: [["A", "B"]],
    cwd: "/tmp",
    stdin_fd: 3,
    stdout_fd: 4,
    stderr_fd: 5,
    pass_fds: [6, 7],
    fd_map: [[3, 8], [6, 9]],
    stdin_data: "input",
  });
  new Uint8Array(memory.buffer, 0, request.byteLength).set(request);

  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
    spawnProcess: (req) => {
      assertEquals(req, {
        prog: "/bin/echo",
        argv0: "echo",
        args: ["hello", "world"],
        env: [["A", "B"]],
        cwd: "/tmp",
        stdin_fd: 3,
        stdout_fd: 4,
        stderr_fd: 5,
        pass_fds: [6, 7],
        fd_map: [[3, 8], [6, 9]],
        stdin_data: "input",
        nice: 0,
      });
      return 42;
    },
  });

  assertEquals(
    (imports.host_spawn as (...args: number[]) => number)(
      0,
      request.byteLength,
      4096,
      4,
    ),
    4,
  );
  assertEquals(new DataView(memory.buffer).getInt32(4096, true), 42);
  kernel.dispose();
});

Deno.test("kernel host_spawn reserves a process slot before fd cloning", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel({ maxProcesses: 1 });
  const parentPid = kernel.allocPid();
  const request = buildNativeSpawnRequest({
    prog: "/bin/cat",
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
  });
  new Uint8Array(memory.buffer, 0, request.byteLength).set(request);
  const reqLen = request.byteLength;
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
  const request = buildNativeSpawnRequest({
    prog: "/bin/cat",
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
  });
  new Uint8Array(memory.buffer, 0, request.byteLength).set(request);
  const reqLen = request.byteLength;

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

Deno.test("kernel host_spawn preserves cloned stdin refs when stdin_data spawn fails", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel({ maxProcesses: 2 });
  const parentPid = kernel.allocPid();
  const vfs = new VFS();
  vfs.writeFile("/tmp/in.txt", new TextEncoder().encode("data"));
  const fdTable = new FdTable(vfs);
  const fd = fdTable.open("/tmp/in.txt", "r");
  const target = createVfsFileTarget(fdTable, fd);
  kernel.setFdTarget(parentPid, 0, target);
  const request = buildNativeSpawnRequest({
    prog: "/bin/cat",
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
    stdin_data: "override",
  });
  new Uint8Array(memory.buffer, 0, request.byteLength).set(request);
  const reqLen = request.byteLength;

  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
    spawnProcess: () => {
      throw new Error("boom");
    },
  });

  assertEquals(
    (imports.host_spawn as (...args: number[]) => number)(0, reqLen),
    -1,
  );
  assertEquals(target.refs, 1);
  assertEquals(fdTable.isOpen(fd), true);
  kernel.dispose();
});

Deno.test("kernel host_wait only reaps children of the caller", async () => {
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
  const deniedLen = await (siblingImports.host_wait as (
    ...args: number[]
  ) => Promise<number>)(
    childPid,
    0,
    4096,
    1024,
  );
  assertEquals(deniedLen, -10);
  assertEquals(kernel.hasProcess(childPid), true);

  const parentImports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
  });
  const waitedLen = await (parentImports.host_wait as (
    ...args: number[]
  ) => Promise<number>)(
    childPid,
    0,
    4096,
    1024,
  );
  assertEquals(waitedLen, 16);
  assertEquals(readWaitResult(memory, 4096), {
    pid: childPid,
    exit_code: 5,
    signal: 0,
    flags: 0,
  });
  assertEquals(kernel.hasProcess(childPid), false);
  kernel.dispose();
});

Deno.test("kernel host_wait nohang distinguishes running from ECHILD", () => {
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

  assertEquals(
    (parentImports.host_wait as (...args: number[]) => number)(
      childPid,
      1,
      4096,
      1024,
    ),
    -11,
  );
  assertEquals(
    (siblingImports.host_wait as (...args: number[]) => number)(
      childPid,
      1,
      4096,
      1024,
    ),
    -10,
  );
  assertEquals(
    (parentImports.host_wait as (...args: number[]) => number)(
      999,
      1,
      4096,
      1024,
    ),
    -10,
  );
  kernel.dispose();
});

Deno.test("kernel host_wait nohang reaps any exited child for pid -1 synchronously", () => {
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

  const written = (imports.host_wait as (
    pid: number,
    flags: number,
    outPtr: number,
    outCap: number,
  ) => number)(
    -1,
    1,
    4096,
    1024,
  );

  assertEquals(written, 16);
  assertEquals(readWaitResult(memory, 4096), {
    pid: exitedPid,
    exit_code: 8,
    signal: 0,
    flags: 0,
  });
  assertEquals(kernel.hasProcess(exitedPid), false);
  assertEquals(kernel.hasProcess(runningPid), true);
  assertEquals(
    (imports.host_wait as (
      pid: number,
      flags: number,
      outPtr: number,
      outCap: number,
    ) => number)(
      -1,
      1,
      4096,
      1024,
    ),
    -11,
  );
  kernel.dispose();
});

Deno.test("kernel host_wait returns ECHILD for wait-any when no children remain", () => {
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

  const written = (imports.host_wait as (
    pid: number,
    flags: number,
    outPtr: number,
    outCap: number,
  ) => number)(
    -1,
    1,
    4096,
    1024,
  );
  assertEquals(written, 16);
  assertEquals(readWaitResult(memory, 4096), {
    pid: childPid,
    exit_code: 0,
    signal: 0,
    flags: 0,
  });
  assertEquals(
    (imports.host_wait as (
      pid: number,
      flags: number,
      outPtr: number,
      outCap: number,
    ) => number)(
      -1,
      1,
      4096,
      1024,
    ),
    -10,
  );
  kernel.dispose();
});

Deno.test("kernel host imports do not expose legacy waitpid entry points", () => {
  const imports = createKernelImports({
    memory: new WebAssembly.Memory({ initial: 1 }),
  });

  assertEquals("host_waitpid" in imports, false);
  assertEquals("host_waitpid_nohang" in imports, false);
});

Deno.test("kernel host_get_local_addr reports configured sandbox address", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports = createKernelImports({
    memory,
    socketLocalHost: "10.8.0.42",
  });

  const written =
    (imports.host_get_local_addr as (outPtr: number, outCap: number) => number)(
      4096,
      1024,
    );

  assertEquals(readString(memory, 4096, written), "10.8.0.42");
});

Deno.test("kernel host_dns_resolve resolves loopback and the sandbox local address locally", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports = createKernelImports({ memory, socketLocalHost: "10.8.0.42" });

  let hostLen = writeString(memory, 0, "localhost");
  let written =
    await (imports.host_dns_resolve as (...args: number[]) => Promise<number>)(
      0,
      hostLen,
      4096,
      1024,
    );
  assertEquals(readString(memory, 4096, written), "127.0.0.1");

  hostLen = writeString(memory, 0, "10.8.0.42");
  written =
    await (imports.host_dns_resolve as (...args: number[]) => Promise<number>)(
      0,
      hostLen,
      4096,
      1024,
    );
  assertEquals(readString(memory, 4096, written), "10.8.0.42");
});

Deno.test("kernel host_dns_resolve produces stable synthetic IPv4 names for socket-backed guests", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let socketBackend: SocketBackend;
  socketBackend = {
    connect: () => ({ ok: false, error: "unused" }),
    send: () => ({ ok: false, error: "unused" }),
    recv: () => ({ ok: false, error: "unused" }),
    close: () => ({ ok: true }),
    acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
    recvAsync: (socket, maxBytes) =>
      Promise.resolve(socketBackend.recv(socket, maxBytes)),
  };
  const imports = createKernelImports({ memory, socketBackend });
  const hostLen = writeString(memory, 0, "nonexistent-yurt.invalid");

  const firstLen =
    await (imports.host_dns_resolve as (...args: number[]) => Promise<number>)(
      0,
      hostLen,
      4096,
      1024,
    );
  const first = readString(memory, 4096, firstLen);
  const secondLen =
    await (imports.host_dns_resolve as (...args: number[]) => Promise<number>)(
      0,
      hostLen,
      8192,
      1024,
    );
  const second = readString(memory, 8192, secondLen);

  assertEquals(first.startsWith("10.0.2."), true);
  assertEquals(second, first);
});

Deno.test("host_chmod allows the file owner and denies non-owners", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.writeFile("/tmp/user-owned.txt", new Uint8Array(1));
  vfs.withWriteAccess(() => {
    vfs.writeFile("/tmp/root-owned.txt", new Uint8Array(1));
  });

  const imports = createKernelImports({
    memory,
    vfs,
    callerUid: 1000,
    callerGid: 1000,
  });

  let pathLen = writeString(memory, 0, "/tmp/user-owned.txt");
  assertEquals(
    (imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o444),
    0,
  );
  assertEquals(vfs.stat("/tmp/user-owned.txt").permissions, 0o444);

  pathLen = writeString(memory, 0, "/tmp/root-owned.txt");
  assertEquals(
    (imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o777),
    -2,
  );
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
  const imports = createKernelImports({
    memory,
    vfs,
    kernel,
    callerPid: pid,
    callerUid: 0,
  });

  const pathLen = writeString(memory, 0, "/tmp/root-owned.txt");
  assertEquals(
    (imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o777),
    -2,
  );
  assertEquals(vfs.stat("/tmp/root-owned.txt").permissions, 0o644);
});

Deno.test("host_chmod stats paths using caller credentials", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.withWriteAccess(() => {
    vfs.mkdirp("/root-only");
    vfs.chmod("/root-only", 0o700);
    vfs.writeFile("/root-only/conf.txt", new Uint8Array(1));
    vfs.chmod("/root-only/conf.txt", 0o644);
  });
  const imports = createKernelImports({
    memory,
    vfs,
    callerUid: 0,
    callerGid: 0,
  });

  const pathLen = writeString(memory, 0, "/root-only/conf.txt");
  assertEquals(
    (imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o600),
    0,
  );
  assertEquals(
    vfs.withCredential(
      { uid: 0, gid: 0 },
      () => vfs.stat("/root-only/conf.txt").permissions,
    ),
    0o600,
  );
});

Deno.test("host_chmod and host_chown apply root kernel credentials to overlay VFS", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const base = new MemoryRoot();
  base.addDir("/etc", { uid: 0, gid: 0, permissions: 0o755 });
  base.addFile("/etc/root.conf", "root", {
    uid: 0,
    gid: 0,
    permissions: 0o644,
  });
  const vfs = new OverlayVFS({ base, upper: new VFS() });
  const kernel = new ProcessKernel();
  const rootPid = 1;
  const imports = createKernelImports({
    memory,
    vfs,
    kernel,
    callerPid: rootPid,
  });

  let pathLen = writeString(memory, 0, "/etc/root.conf");
  assertEquals(
    (imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o600),
    0,
  );
  pathLen = writeString(memory, 0, "/etc/root.conf");
  assertEquals(
    (imports.host_chown as (...args: number[]) => number)(
      0,
      pathLen,
      1000,
      1000,
      1,
    ),
    0,
  );

  assertEquals(vfs.stat("/etc/root.conf").permissions, 0o600);
  assertEquals(vfs.stat("/etc/root.conf").uid, 1000);
  assertEquals(vfs.stat("/etc/root.conf").gid, 1000);
  assertEquals(base.stat("/etc/root.conf").uid, 0);
  assertEquals(base.stat("/etc/root.conf").permissions, 0o644);
  kernel.dispose();
});

Deno.test("host_chown denies owner changes for users but permits owner group self-change", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.writeFile("/tmp/owned.txt", new Uint8Array(1));

  let pathLen = writeString(memory, 0, "/tmp/owned.txt");
  const userImports = createKernelImports({
    memory,
    vfs,
    callerUid: 1000,
    callerGid: 1000,
  });
  assertEquals(
    (userImports.host_chown as (...args: number[]) => number)(
      0,
      pathLen,
      2000,
      2000,
      1,
    ),
    -2,
  );
  assertEquals(vfs.stat("/tmp/owned.txt").uid, 1000);

  pathLen = writeString(memory, 0, "/tmp/owned.txt");
  assertEquals(
    (userImports.host_chown as (...args: number[]) => number)(
      0,
      pathLen,
      1000,
      1000,
      1,
    ),
    0,
  );
  assertEquals(vfs.stat("/tmp/owned.txt").uid, 1000);
  assertEquals(vfs.stat("/tmp/owned.txt").gid, 1000);

  pathLen = writeString(memory, 0, "/tmp/owned.txt");
  assertEquals(
    (userImports.host_chown as (...args: number[]) => number)(
      0,
      pathLen,
      0xffffffff,
      1000,
      1,
    ),
    0,
  );
  assertEquals(vfs.stat("/tmp/owned.txt").uid, 1000);
  assertEquals(vfs.stat("/tmp/owned.txt").gid, 1000);

  pathLen = writeString(memory, 0, "/tmp/owned.txt");
  const rootImports = createKernelImports({
    memory,
    vfs,
    callerUid: 0,
    callerGid: 0,
  });
  assertEquals(
    (rootImports.host_chown as (...args: number[]) => number)(
      0,
      pathLen,
      2000,
      2000,
      1,
    ),
    0,
  );
  assertEquals(vfs.stat("/tmp/owned.txt").uid, 2000);
  assertEquals(vfs.stat("/tmp/owned.txt").gid, 2000);
});

Deno.test("host_chown checks credentials before probing paths and supports dangling lchown", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.symlink("/tmp/missing-target.txt", "/tmp/dangling.txt");

  let pathLen = writeString(memory, 0, "/tmp/missing.txt");
  const userImports = createKernelImports({
    memory,
    vfs,
    callerUid: 1000,
    callerGid: 1000,
  });
  assertEquals(
    (userImports.host_chown as (...args: number[]) => number)(
      0,
      pathLen,
      2000,
      2000,
      1,
    ),
    -2,
  );

  pathLen = writeString(memory, 0, "/tmp/dangling.txt");
  const rootImports = createKernelImports({
    memory,
    vfs,
    callerUid: 0,
    callerGid: 0,
  });
  assertEquals(
    (rootImports.host_chown as (...args: number[]) => number)(
      0,
      pathLen,
      2000,
      2000,
      0,
    ),
    0,
  );
  assertEquals(vfs.lstat("/tmp/dangling.txt").uid, 2000);
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

  const userImports = createKernelImports({
    memory,
    vfs,
    kernel,
    callerPid: userPid,
    callerUid: 0,
  });
  assertEquals(
    (userImports.host_fchown as (...args: number[]) => number)(fd, 2000, 2000),
    -2,
  );

  const rootImports = createKernelImports({
    memory,
    vfs,
    kernel,
    callerPid: 1,
  });
  assertEquals(
    (rootImports.host_fchown as (...args: number[]) => number)(fd, 2000, 2000),
    0,
  );
  assertEquals(vfs.stat("/tmp/fd-owned.txt").uid, 2000);
  assertEquals(vfs.stat("/tmp/fd-owned.txt").gid, 2000);
});

Deno.test("host uid/gid imports are backed by kernel credentials", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: pid,
    callerUid: 0,
  });

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

  assertEquals(
    (imports.host_setresuid as (...args: number[]) => number)(1000, 1000, 1000),
    0,
  );
  assertEquals(
    (imports.host_setresuid as (...args: number[]) => number)(-1, -1, -1),
    0,
  );
  assertEquals(
    (imports.host_setresuid as (...args: number[]) => number)(0, 0, 0),
    -2,
  );
  assertEquals(
    (imports.host_setresgid as (...args: number[]) => number)(1000, 1000, 1000),
    0,
  );
  assertEquals(
    (imports.host_setresgid as (...args: number[]) => number)(-1, -1, -1),
    0,
  );
  assertEquals(
    (imports.host_setresgid as (...args: number[]) => number)(0, 0, 0),
    -2,
  );
  assertEquals(kernel.getCredentials(pid), {
    uid: 1000,
    gid: 1000,
    euid: 1000,
    egid: 1000,
    suid: 1000,
    sgid: 1000,
  });
});

Deno.test("root process can change effective credentials for future authorization", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.withWriteAccess(() => {
    vfs.writeFile("/tmp/root-owned.txt", new Uint8Array(1));
  });
  const kernel = new ProcessKernel();
  const imports = createKernelImports({ memory, vfs, kernel, callerPid: 1 });

  assertEquals(
    (imports.host_setresuid as (...args: number[]) => number)(1000, 1000, 1000),
    0,
  );
  const pathLen = writeString(memory, 0, "/tmp/root-owned.txt");
  assertEquals(
    (imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o777),
    -2,
  );
  assertEquals(vfs.stat("/tmp/root-owned.txt").permissions, 0o644);
});

Deno.test("host_chmod resolves relative paths against caller cwd", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.mkdir("/tmp/work");
  vfs.writeFile("/tmp/work/script.sh", new Uint8Array(0));
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  kernel.setCwd(pid, "/tmp/work");
  const imports = createKernelImports({ memory, vfs, kernel, callerPid: pid });

  const pathLen = writeString(memory, 0, "script.sh");
  assertEquals(
    (imports.host_chmod as (...args: number[]) => number)(0, pathLen, 0o755),
    0,
  );
  assertEquals(vfs.stat("/tmp/work/script.sh").permissions, 0o755);
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
  assertEquals(
    (imports.host_chdir as (...args: number[]) => number)(0, dirLen),
    0,
  );
  assertEquals(kernel.getCwd(pid), "/tmp/cwd-target");

  const childPid = kernel.allocPid(pid, "child");
  assertEquals(kernel.getCwd(childPid), "/tmp/cwd-target");

  const fileLen = writeString(memory, 64, "/tmp/not-a-dir.txt");
  assertEquals(
    (imports.host_chdir as (...args: number[]) => number)(64, fileLen),
    -4,
  );
  assertEquals(kernel.getCwd(pid), "/tmp/cwd-target");

  const missingLen = writeString(memory, 128, "/tmp/missing-dir");
  assertEquals(
    (imports.host_chdir as (...args: number[]) => number)(128, missingLen),
    -1,
  );
});

Deno.test("host_chdir normalizes dot segments without resolving symlink names", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.mkdir("/tmp/zsh-tests");
  vfs.mkdir("/tmp/zsh-tests/cdtst.tmp");
  vfs.mkdir("/tmp/zsh-tests/cdtst.tmp/real");
  vfs.mkdir("/tmp/zsh-tests/cdtst.tmp/sub");
  vfs.symlink("../real", "/tmp/zsh-tests/cdtst.tmp/sub/fake");
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  kernel.setCwd(pid, "/tmp/zsh-tests/.");
  const imports = createKernelImports({ memory, vfs, kernel, callerPid: pid });

  assertEquals(kernel.getCwd(pid), "/tmp/zsh-tests");

  const dirLen = writeString(memory, 0, "cdtst.tmp/sub/fake");
  assertEquals(
    (imports.host_chdir as (...args: number[]) => number)(0, dirLen),
    0,
  );
  assertEquals(kernel.getCwd(pid), "/tmp/zsh-tests/cdtst.tmp/sub/fake");
});

Deno.test("host_getcwd writes the caller cwd and reports required size", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  kernel.setCwd(pid, "/tmp/work");
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals(
    (imports.host_getcwd as (...args: number[]) => number)(0, 5),
    10,
  );
  assertEquals(
    (imports.host_getcwd as (...args: number[]) => number)(0, 32),
    10,
  );
  assertEquals(
    new TextDecoder().decode(new Uint8Array(memory.buffer, 0, 9)),
    "/tmp/work",
  );
  assertEquals(new Uint8Array(memory.buffer)[9], 0);
});

Deno.test("host_getcwd returns the physical cwd for symlinked process cwd", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.mkdir("/tmp/cwd-real");
  vfs.symlink("cwd-real", "/tmp/cwd-link");
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  kernel.setCwd(pid, "/tmp/cwd-link");
  const imports = createKernelImports({ memory, vfs, kernel, callerPid: pid });

  assertEquals(
    (imports.host_getcwd as (...args: number[]) => number)(0, 64),
    "/tmp/cwd-real".length + 1,
  );
  assertEquals(
    new TextDecoder().decode(
      new Uint8Array(memory.buffer, 0, "/tmp/cwd-real".length),
    ),
    "/tmp/cwd-real",
  );
});

Deno.test("host_realpath canonicalizes dot segments and symlinks", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.mkdir("/tmp/work");
  vfs.mkdir("/tmp/work/real");
  vfs.mkdir("/tmp/work/sub");
  vfs.symlink("../real", "/tmp/work/sub/fake");
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  kernel.setCwd(pid, "/tmp/work");
  const imports = createKernelImports({ memory, vfs, kernel, callerPid: pid });

  const pathLen = writeString(memory, 0, "./sub/fake/.");
  const expected = "/tmp/work/real";
  assertEquals(
    (imports.host_realpath as (...args: number[]) => number)(
      0,
      pathLen,
      128,
      8,
    ),
    expected.length + 1,
  );
  assertEquals(
    (imports.host_realpath as (...args: number[]) => number)(
      0,
      pathLen,
      128,
      64,
    ),
    expected.length + 1,
  );
  assertEquals(
    new TextDecoder().decode(
      new Uint8Array(memory.buffer, 128, expected.length),
    ),
    expected,
  );
  assertEquals(new Uint8Array(memory.buffer)[128 + expected.length], 0);
});

Deno.test("host_realpath applies parent traversal after symlink path components", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS({ uid: 1000, gid: 1000 });
  vfs.mkdirp("/tmp/work/dir3/subdir");
  vfs.mkdirp("/tmp/work/dir3/hello");
  vfs.writeFile("/tmp/work/dir3/hello/world", new Uint8Array());
  vfs.symlink("dir3/subdir", "/tmp/work/link");
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  kernel.setCwd(pid, "/tmp/work");
  const imports = createKernelImports({ memory, vfs, kernel, callerPid: pid });

  const pathLen = writeString(memory, 0, "link/../hello/world");
  const expected = "/tmp/work/dir3/hello/world";
  assertEquals(
    (imports.host_realpath as (...args: number[]) => number)(
      0,
      pathLen,
      128,
      64,
    ),
    expected.length + 1,
  );
  assertEquals(
    new TextDecoder().decode(
      new Uint8Array(memory.buffer, 128, expected.length),
    ),
    expected,
  );
});

Deno.test("host process-group imports enforce session boundaries", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const parent = kernel.allocPid(1, "parent");
  const child = kernel.allocPid(parent, "child");
  const imports = createKernelImports({ memory, kernel, callerPid: child });

  assertEquals((imports.host_getpgid as (pid: number) => number)(0), 1);
  assertEquals((imports.host_getsid as (pid: number) => number)(0), 1);
  assertEquals((imports.host_setsid as () => number)(), child);
  assertEquals((imports.host_getpgid as (pid: number) => number)(0), child);
  assertEquals((imports.host_getsid as (pid: number) => number)(0), child);
  assertEquals((imports.host_setsid as () => number)(), -1);
  assertEquals(
    (imports.host_setpgid as (pid: number, pgid: number) => number)(0, parent),
    -1,
  );
});

Deno.test("host tcsetpgrp rejects missing and cross-session process groups", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const ttyOwner = kernel.allocPid(1, "tty-owner");
  assertEquals(kernel.setsid(ttyOwner), ttyOwner);
  kernel.openTtyForProcess(ttyOwner);
  const foreground = kernel.allocPid(ttyOwner, "foreground");
  const otherSession = kernel.allocPid(1, "other-session");
  const imports = createKernelImports({ memory, kernel, callerPid: ttyOwner });

  assertEquals((imports.host_tiocsctty as (fd: number) => number)(0), 0);
  assertEquals(
    (imports.host_setpgid as (pid: number, pgid: number) => number)(
      foreground,
      foreground,
    ),
    0,
  );
  assertEquals(kernel.setsid(otherSession), otherSession);

  assertEquals(
    (imports.host_tcsetpgrp as (fd: number, pgid: number) => number)(
      0,
      foreground,
    ),
    0,
  );
  assertEquals(
    (imports.host_tcgetpgrp as (fd: number) => number)(0),
    foreground,
  );

  assertEquals(
    (imports.host_tcsetpgrp as (fd: number, pgid: number) => number)(0, 9999),
    -1,
  );
  assertEquals(
    (imports.host_tcgetpgrp as (fd: number) => number)(0),
    foreground,
  );

  assertEquals(
    (imports.host_tcsetpgrp as (fd: number, pgid: number) => number)(
      0,
      otherSession,
    ),
    -1,
  );
  assertEquals(
    (imports.host_tcgetpgrp as (fd: number) => number)(0),
    foreground,
  );
});

Deno.test("host tiocsctty requires a session leader", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  kernel.openTtyForProcess(pid);
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals((imports.host_tiocsctty as (fd: number) => number)(0), -1);
  assertEquals((imports.host_setsid as () => number)(), pid);
  assertEquals((imports.host_tiocsctty as (fd: number) => number)(0), 0);
});

Deno.test("host_setpriority reports unsupported when no scheduler backend can apply the change", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals(
    (imports.host_getpriority as (...args: number[]) => number)(0, 0),
    0,
  );
  assertEquals(
    (imports.host_setpriority as (...args: number[]) => number)(0, 0, 5),
    -38,
  );
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

  assertEquals(
    (imports.host_setpriority as (...args: number[]) => number)(0, 0, 7),
    0,
  );
  assertEquals(
    (imports.host_getpriority as (...args: number[]) => number)(0, 0),
    7,
  );
  assertEquals(calls, [{ pid, nice: 7 }]);
});

Deno.test("host scheduler policy reports metadata and rejects unsupported changes", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "guest");
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals(
    (imports.host_sched_getscheduler as (...args: number[]) => number)(0),
    0,
  );
  assertEquals(
    (imports.host_sched_getparam as (...args: number[]) => number)(0),
    0,
  );
  assertEquals(
    (imports.host_sched_setscheduler as (...args: number[]) => number)(0, 0, 0),
    0,
  );
  assertEquals(
    (imports.host_sched_setparam as (...args: number[]) => number)(0, 0),
    0,
  );
  assertEquals(
    (imports.host_sched_setscheduler as (...args: number[]) => number)(0, 1, 1),
    -2,
  );
  const rootImports = createKernelImports({ memory, kernel, callerPid: 1 });
  assertEquals(
    (rootImports.host_sched_setscheduler as (...args: number[]) => number)(
      1,
      1,
      1,
    ),
    -38,
  );
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
        calls.push({
          pid: request.targetPid,
          policy: request.policy,
          priority: request.priority,
        });
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

  assertEquals(
    (imports.host_sched_setscheduler as (...args: number[]) => number)(1, 1, 4),
    0,
  );
  assertEquals(
    (imports.host_sched_getscheduler as (...args: number[]) => number)(1),
    1,
  );
  assertEquals(
    (imports.host_sched_getparam as (...args: number[]) => number)(1),
    4,
  );
  assertEquals(
    (imports.host_sched_setparam as (...args: number[]) => number)(1, 5),
    0,
  );
  assertEquals(kernel.getScheduler(1), { policy: 1, priority: 5 });
  assertEquals(calls, [
    { pid: 1, policy: 1, priority: 4 },
    { pid: 1, policy: 1, priority: 5 },
  ]);
});

Deno.test("host scheduler affinity reports single CPU and validates target pid", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "worker");
  const imports = createKernelImports({ memory, kernel, callerPid: pid });
  const view = new DataView(memory.buffer);

  assertEquals(
    (imports.host_sched_getaffinity as (...args: number[]) => number)(
      0,
      128,
      4,
    ),
    0,
  );
  assertEquals(view.getUint32(128, true), 1);

  assertEquals(
    (imports.host_sched_getaffinity as (...args: number[]) => number)(
      0,
      128,
      3,
    ),
    -22,
  );

  assertEquals(
    (imports.host_sched_getaffinity as (...args: number[]) => number)(
      999,
      128,
      4,
    ),
    -1,
  );
});

Deno.test("host scheduler affinity accepts only CPU 0 in the single-CPU ABI", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "worker");
  const imports = createKernelImports({ memory, kernel, callerPid: pid });
  const view = new DataView(memory.buffer);

  view.setUint32(128, 1, true);
  assertEquals(
    (imports.host_sched_setaffinity as (...args: number[]) => number)(
      0,
      128,
      4,
    ),
    0,
  );

  view.setUint32(128, 2, true);
  assertEquals(
    (imports.host_sched_setaffinity as (...args: number[]) => number)(
      0,
      128,
      4,
    ),
    -22,
  );

  assertEquals(
    (imports.host_sched_setaffinity as (...args: number[]) => number)(
      0,
      128,
      3,
    ),
    -22,
  );
});

Deno.test("host rlimit stores process-local limits inherited by children", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid(1, "parent");
  const imports = createKernelImports({ memory, kernel, callerPid: parentPid });

  assertEquals(
    (imports.host_getrlimit as (...args: number[]) => number)(7, 64),
    0,
  );
  assertEquals(view.getBigUint64(64, true), 1024n);
  assertEquals(view.getBigUint64(72, true), 1024n);

  assertEquals(
    (imports.host_setrlimit as (...args: unknown[]) => number)(7, 4n, 1024n),
    0,
  );
  assertEquals(
    (imports.host_getrlimit as (...args: number[]) => number)(7, 64),
    0,
  );
  assertEquals(view.getBigUint64(64, true), 4n);
  assertEquals(view.getBigUint64(72, true), 1024n);

  const childPid = kernel.allocPid(parentPid, "child");
  assertEquals(kernel.getResourceLimit(childPid, 7), { soft: 4, hard: 1024 });
});

Deno.test("host rlimit preserves 64-bit values and RLIM_INFINITY", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const kernel = new ProcessKernel();
  const pid = 1;
  const imports = createKernelImports({ memory, kernel, callerPid: pid });
  const fiveGiB = 5n * 1024n * 1024n * 1024n;
  const infinity = 0xffff_ffff_ffff_ffffn;

  assertEquals(
    (imports.host_setrlimit as (...args: unknown[]) => number)(
      0,
      fiveGiB,
      infinity,
    ),
    0,
  );
  assertEquals(
    (imports.host_getrlimit as (...args: number[]) => number)(0, 64),
    0,
  );
  assertEquals(view.getBigUint64(64, true), fiveGiB);
  assertEquals(view.getBigUint64(72, true), infinity);
});

Deno.test("host_setrlimit reports EPERM when a user raises the hard limit", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const userPid = kernel.allocPid(1, "user");
  const imports = createKernelImports({ memory, kernel, callerPid: userPid });

  assertEquals(
    (imports.host_setrlimit as (...args: unknown[]) => number)(7, 1024n, 2048n),
    -2,
  );
  assertEquals(kernel.getResourceLimit(userPid, 7), { soft: 1024, hard: 1024 });
});

Deno.test("host_dup2 closes overwritten WasiHost ioFds target", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS();
  const fdTable = new FdTable(vfs);
  vfs.writeFile("/tmp/old.txt", new Uint8Array(1));
  const oldFd = fdTable.open("/tmp/old.txt", "r");
  const oldTarget = createVfsFileTarget(fdTable, oldFd);
  const ioFds = new Map<number, FdTarget>([
    [1, createVfsFileTarget(fdTable, fdTable.open("/tmp/old.txt", "r"))],
    [2, oldTarget],
  ]);
  const srcTarget = ioFds.get(1)! as FdTarget & { type: "vfs_file" };
  const wasiHost = new WasiHost({
    vfs,
    args: [],
    env: {},
    preopens: {},
    ioFds,
  });
  const imports = createKernelImports({ memory, wasiHost });

  assertEquals((imports.host_dup2 as (...args: number[]) => number)(1, 2), 0);
  assertEquals(oldTarget.refs, 0);
  assertEquals(fdTable.isOpen(oldFd), false);
  assertEquals(srcTarget.refs, 2);
  const duplicated = wasiHost.getIoFds().get(2);
  assertEquals(duplicated?.type, "vfs_file");
  if (duplicated?.type === "vfs_file") {
    assertEquals(duplicated.fd, 2);
    assertEquals(duplicated.fdTable, srcTarget.fdTable);
    assertEquals(duplicated.refs, 1);
  }
});

Deno.test("host_dup2 does not duplicate refcounts twice when WasiHost uses the kernel fd table", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS();
  const fdTable = new FdTable(vfs);
  const kernel = new ProcessKernel();
  const pid = 1;
  vfs.writeFile("/tmp/shared.txt", new Uint8Array(1));
  vfs.writeFile("/tmp/old-shared.txt", new Uint8Array(1));
  const srcTarget = createVfsFileTarget(
    fdTable,
    fdTable.open("/tmp/shared.txt", "r"),
  );
  const oldFd = fdTable.open("/tmp/old-shared.txt", "r");
  const oldTarget = createVfsFileTarget(fdTable, oldFd);
  kernel.setFdTarget(pid, 1, srcTarget);
  kernel.setFdTarget(pid, 2, oldTarget);
  const wasiHost = new WasiHost({
    vfs,
    args: [],
    env: {},
    preopens: {},
    ioFds: kernel.getFdTable(pid),
    kernel,
    pid,
  });
  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: pid,
    wasiHost,
  });

  assertEquals((imports.host_dup2 as (...args: number[]) => number)(1, 2), 0);
  assertEquals(srcTarget.refs, 1);
  assertEquals(oldTarget.refs, 0);
  assertEquals(fdTable.isOpen(oldFd), false);
  const duplicated = kernel.getFdTarget(pid, 2);
  assertEquals(duplicated?.type, "vfs_file");
  if (duplicated?.type === "vfs_file") {
    assertEquals(duplicated.fd, 2);
    assertEquals(duplicated.fdTable, srcTarget.fdTable);
  }
});

Deno.test("host_dup_min mirrors F_DUPFD into the active WasiHost file table", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS();
  vfs.writeFile("/tmp/script.sh", new TextEncoder().encode("echo ok\n"));
  const wasiHost = new WasiHost({
    vfs,
    args: [],
    env: {},
    preopens: {},
  });
  const fdTable = (wasiHost as unknown as { fdTable: FdTable }).fdTable;
  const fd = fdTable.open("/tmp/script.sh", "r");
  const imports = createKernelImports({ memory, wasiHost });

  assertEquals(
    (imports.host_dup_min as (...args: number[]) => number)(fd, 10),
    10,
  );
  assertEquals(fdTable.isOpen(10), true);
  fdTable.close(fd);
  assertEquals(fdTable.isOpen(10), true);
});

Deno.test("host_dup_min keeps the kernel and WasiHost fd tables in sync", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS();
  const fdTable = new FdTable(vfs);
  const kernel = new ProcessKernel();
  const pid = 1;
  vfs.writeFile("/tmp/script.sh", new TextEncoder().encode("echo ok\n"));
  const fd = fdTable.open("/tmp/script.sh", "r");
  const srcTarget = createVfsFileTarget(fdTable, fd);
  kernel.setFdTarget(pid, fd, srcTarget);
  const wasiHost = new WasiHost({
    vfs,
    args: [],
    env: {},
    preopens: {},
    ioFds: kernel.getFdTable(pid),
    kernel,
    pid,
  });
  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: pid,
    wasiHost,
  });

  assertEquals(
    (imports.host_dup_min as (...args: number[]) => number)(fd, 10),
    10,
  );
  assertEquals(kernel.getFdTarget(pid, 10)?.type, "vfs_file");
  assertEquals(fdTable.isOpen(10), true);
  assertEquals(srcTarget.refs, 1);
  assertEquals(kernel.closeFd(pid, fd), true);
  assertEquals(fdTable.isOpen(10), true);
});

Deno.test("kernel /proc fd listing includes close-on-exec descriptors", () => {
  const vfs = new VFS();
  const fdTable = new FdTable(vfs);
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "ash");
  vfs.writeFile("/tmp/script.sh", new TextEncoder().encode("echo ok\n"));
  const fd = fdTable.open("/tmp/script.sh", "r");
  kernel.setFdTarget(pid, fd, createVfsFileTarget(fdTable, fd));
  kernel.setFdDescriptorFlags(pid, fd, 1);

  assertEquals(
    kernel.listProcesses().find((proc) => proc.pid === pid)?.fds.includes(fd),
    true,
  );
});

Deno.test("host_spawn rejects nonzero nice when the engine has no scheduler backend", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const request = buildNativeSpawnRequest({
    prog: "echo",
    args: ["hello"],
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
    nice: 5,
  });
  new Uint8Array(memory.buffer, 0, request.byteLength).set(request);
  const reqLen = request.byteLength;
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid(1, "parent");
  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
    spawnProcess: () => {
      throw new Error(
        "spawnProcess should not run when scheduler support is absent",
      );
    },
  });

  assertEquals(
    (imports.host_spawn as (...args: number[]) => number)(0, reqLen),
    -38,
  );
});

Deno.test("host_thread_exit maps main-thread pthread_exit to process exit", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports = createKernelImports({
    memory,
    threadsBackend: {
      kind: "cooperative-serial",
      setIndirectCallTable() {},
      async spawn() {
        return -1;
      },
      async join() {
        return -1;
      },
      async detach() {
        return -1;
      },
      exit(): never {
        throw new Error("spawned-thread exit path should not run");
      },
      self() {
        return 0;
      },
      async yield_() {
        return 0;
      },
      async mutexLock() {
        return 0;
      },
      mutexUnlock() {
        return 0;
      },
      mutexTryLock() {
        return 0;
      },
      async condWait() {
        return 0;
      },
      condSignal() {
        return 0;
      },
      condBroadcast() {
        return 0;
      },
    },
  });

  try {
    (imports.host_thread_exit as (retval: number) => never)(123);
    throw new Error("host_thread_exit returned");
  } catch (err) {
    assertEquals(err instanceof WasiExitError, true);
    assertEquals((err as WasiExitError).code, 0);
  }
});

Deno.test("host_poll reports regular file readiness and invalid fds", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const vfs = new VFS();
  const fdTable = new FdTable(vfs);
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "poller");
  vfs.writeFile("/tmp/data.txt", encoder.encode("data"));
  const fd = fdTable.open("/tmp/data.txt", "r");
  kernel.setFdTarget(pid, fd, createVfsFileTarget(fdTable, fd));
  writePollFd(memory, 64, fd, POLLIN | POLLOUT);
  writePollFd(memory, 72, 999, POLLIN);
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  const ready = (imports.host_poll as (...args: number[]) => number)(
    64,
    2,
    0,
  );

  assertEquals(ready, 2);
  assertEquals(readPollRevents(memory, 64), POLLIN | POLLOUT);
  assertEquals(readPollRevents(memory, 72), POLLNVAL);
  kernel.dispose();
});

Deno.test("host_poll reports pipe readiness, capacity, and hangup", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "poller");
  const [readEnd, writeEnd] = createAsyncPipe(4);
  kernel.setFdTarget(pid, 3, { type: "pipe_read", pipe: readEnd });
  kernel.setFdTarget(pid, 4, { type: "pipe_write", pipe: writeEnd });
  writePollFd(memory, 128, 3, POLLIN);
  writePollFd(memory, 136, 4, POLLOUT);
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals(
    (imports.host_poll as (...args: number[]) => number)(128, 2, 0),
    1,
  );
  assertEquals(readPollRevents(memory, 128), 0);
  assertEquals(readPollRevents(memory, 136), POLLOUT);

  assertEquals(writeEnd.write(encoder.encode("abcd")), 4);
  assertEquals(
    (imports.host_poll as (...args: number[]) => number)(128, 2, 0),
    1,
  );
  assertEquals(readPollRevents(memory, 128), POLLIN);
  assertEquals(readPollRevents(memory, 136), 0);

  writeEnd.close();
  writePollFd(memory, 136, -1, POLLOUT);
  assertEquals(
    (imports.host_poll as (...args: number[]) => number)(128, 2, 0),
    1,
  );
  assertEquals(readPollRevents(memory, 128), POLLIN);
  readEnd.drainSync();
  assertEquals(
    (imports.host_poll as (...args: number[]) => number)(128, 2, 0),
    1,
  );
  assertEquals(readPollRevents(memory, 128), POLLHUP);
  kernel.dispose();
});

Deno.test("host_poll probes sockets and preserves queued read bytes", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "poller");
  let queued = encoder.encode("x");
  const socketTarget: FdTarget & { type: "socket" } = {
    type: "socket",
    socket: 1,
    refs: 1,
    send: () => ({ ok: true, bytes_sent: 0 }),
    recv: () => {
      if (queued.byteLength === 0) return { ok: false, error: "EAGAIN" };
      const data = queued.slice(0, 1);
      queued = queued.slice(1);
      return { ok: true, data };
    },
    recvAsync: () => Promise.resolve({ ok: false, error: "EAGAIN" }),
    close: () => {},
  };
  kernel.setFdTarget(pid, 5, socketTarget);
  writePollFd(memory, 256, 5, POLLIN | POLLOUT);
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals(
    (imports.host_poll as (...args: number[]) => number)(256, 1, 0),
    1,
  );
  assertEquals(readPollRevents(memory, 256), POLLIN | POLLOUT);
  assertEquals(socketTarget.peekBuffer, encoder.encode("x"));

  assertEquals(
    (imports.host_poll as (...args: number[]) => number)(256, 1, 0),
    1,
  );
  assertEquals(readPollRevents(memory, 256), POLLIN | POLLOUT);
  kernel.dispose();
});

Deno.test("host_poll socket EOF probe makes blocking recv return EOF", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "poller");
  const socketTarget: FdTarget & { type: "socket" } = {
    type: "socket",
    socket: 1,
    refs: 1,
    send: () => ({ ok: true, bytes_sent: 0 }),
    recv: () => ({ ok: true, data: new Uint8Array(0) }),
    recvAsync: () => {
      throw new Error("readShutdown recv should not block");
    },
    close: () => {},
  };
  kernel.setFdTarget(pid, 5, socketTarget);
  writePollFd(memory, 256, 5, POLLIN);
  const socketBackend: SocketBackend = {
    connect: () => ({ ok: false, error: "unused" }),
    send: () => ({ ok: false, error: "unused" }),
    recv: () => ({ ok: false, error: "unused" }),
    close: () => ({ ok: true }),
    recvAsync: () => Promise.resolve({ ok: false, error: "unused" }),
  };
  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: pid,
    socketBackend,
  });

  assertEquals(
    (imports.host_poll as (...args: number[]) => number)(256, 1, 0),
    1,
  );
  assertEquals(readPollRevents(memory, 256), POLLIN);
  assertEquals(socketTarget.readShutdown, true);

  const recvLen = (imports.host_socket_recv as (...args: number[]) => number)(
    5,
    512,
    16,
    0,
  );
  assertEquals(recvLen, 0);
  kernel.dispose();
});

Deno.test("host_poll reports exhausted static input as readable EOF", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid(1, "poller");
  kernel.setFdTarget(pid, 0, {
    type: "static",
    data: encoder.encode("stdin"),
    offset: 5,
  });
  writePollFd(memory, 256, 0, POLLIN);
  const imports = createKernelImports({ memory, kernel, callerPid: pid });

  assertEquals(
    (imports.host_poll as (...args: number[]) => number)(256, 1, 0),
    1,
  );
  assertEquals(readPollRevents(memory, 256), POLLIN);
  kernel.dispose();
});
