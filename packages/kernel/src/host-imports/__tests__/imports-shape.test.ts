import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { createKernelImports } from "../kernel-imports.ts";
import { readString } from "../common.ts";
import { VFS } from "../../vfs/vfs.ts";
import { ProcessKernel } from "../../process/kernel.ts";
import { FdTable } from "../../vfs/fd-table.ts";
import { createVfsFileTarget } from "../../wasi/fd-target.ts";

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
