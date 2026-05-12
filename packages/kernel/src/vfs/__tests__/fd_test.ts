import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { VFS } from "../vfs.js";
import { FdTable } from "../fd-table.js";
import { createPipe } from "../pipe.js";
import { OverlayVFS } from "../overlay-vfs.ts";
import { MemoryRoot } from "./helpers.ts";

const text = new TextEncoder();
const decode = (data: Uint8Array): string => new TextDecoder().decode(data);

describe("FdTable", () => {
  it("opens a file and returns an fd", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("hello"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    expect(fd).toBeGreaterThanOrEqual(3); // 0,1,2 reserved for stdio
  });

  it("reads from an fd", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("hello"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    const buf = new Uint8Array(5);
    const n = fdt.read(fd, buf);
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });

  it("writes to an fd", () => {
    const vfs = new VFS();
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/out.txt", "w");
    fdt.write(fd, new TextEncoder().encode("written"));
    fdt.close(fd);
    expect(new TextDecoder().decode(vfs.readFile("/home/user/out.txt"))).toBe(
      "written",
    );
  });

  it("restores buffered write state when immediate flush fails", () => {
    const vfs = new VFS({ fsLimitBytes: 3 });
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/out.txt", "w");
    fdt.write(fd, text.encode("abc"));

    expect(() => fdt.write(fd, text.encode("d"))).toThrow(/ENOSPC/);

    expect(fdt.tell(fd)).toBe(3);
    fdt.seek(fd, 0, "set");
    const buf = new Uint8Array(4);
    const n = fdt.read(fd, buf);
    expect(n).toBe(3);
    expect(decode(buf.subarray(0, n))).toBe("abc");
    fdt.close(fd);
    expect(decode(vfs.readFile("/home/user/out.txt"))).toBe("abc");
  });

  it("does not leak same-size failed writes into flushed VFS content", () => {
    const vfs = new VFS();
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/out.txt", "w");
    fdt.write(fd, text.encode("abc"));
    vfs.chmod("/home/user/out.txt", 0o444);

    expect(() => fdt.pwrite(fd, text.encode("xyz"), 0)).toThrow(/EACCES/);

    expect(decode(vfs.readFile("/home/user/out.txt"))).toBe("abc");
    const buf = new Uint8Array(3);
    const n = fdt.pread(fd, buf, 0);
    expect(n).toBe(3);
    expect(decode(buf)).toBe("abc");
    vfs.chmod("/home/user/out.txt", 0o644);
    fdt.close(fd);
  });

  it("restores buffered pwrite state when immediate flush fails", () => {
    const vfs = new VFS({ fsLimitBytes: 3 });
    vfs.writeFile("/home/user/out.txt", text.encode("abc"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/out.txt", "rw");

    expect(() => fdt.pwrite(fd, text.encode("d"), 3)).toThrow(/ENOSPC/);

    const buf = new Uint8Array(4);
    const n = fdt.pread(fd, buf, 0);
    expect(n).toBe(3);
    expect(decode(buf.subarray(0, n))).toBe("abc");
    fdt.close(fd);
    expect(decode(vfs.readFile("/home/user/out.txt"))).toBe("abc");
  });

  it("restores buffered truncate state when immediate flush fails", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/out.txt", text.encode("abc"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/out.txt", "rw");
    fdt.seek(fd, 3, "set");
    vfs.chmod("/home/user/out.txt", 0o444);

    expect(() => fdt.truncate(fd, 1)).toThrow(/EACCES/);

    expect(fdt.tell(fd)).toBe(3);
    const buf = new Uint8Array(3);
    const n = fdt.pread(fd, buf, 0);
    expect(n).toBe(3);
    expect(decode(buf)).toBe("abc");
    vfs.chmod("/home/user/out.txt", 0o644);
    fdt.close(fd);
    expect(decode(vfs.readFile("/home/user/out.txt"))).toBe("abc");
  });

  it("makes writes visible to stat before close", () => {
    const vfs = new VFS();
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/out.txt", "w");

    fdt.pwrite(fd, new TextEncoder().encode("sqlite-header"), 0);

    expect(vfs.stat("/home/user/out.txt").size).toBe("sqlite-header".length);
    expect(new TextDecoder().decode(vfs.readFile("/home/user/out.txt"))).toBe(
      "sqlite-header",
    );
  });

  it("makes truncate visible to stat before close", () => {
    const vfs = new VFS();
    vfs.writeFile(
      "/home/user/out.txt",
      new TextEncoder().encode("old content"),
    );
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/out.txt", "rw");

    fdt.truncate(fd, 3);

    expect(vfs.stat("/home/user/out.txt").size).toBe(3);
    expect(new TextDecoder().decode(vfs.readFile("/home/user/out.txt"))).toBe(
      "old",
    );
  });

  it("seeks in a file", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("abcdef"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    fdt.seek(fd, 3, "set");
    const buf = new Uint8Array(3);
    fdt.read(fd, buf);
    expect(new TextDecoder().decode(buf)).toBe("def");
  });

  it("duplicates fds", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("hello"));
    const fdt = new FdTable(vfs);
    const fd1 = fdt.open("/home/user/test.txt", "r");
    const fd2 = fdt.dup(fd1);
    expect(fd2).not.toBe(fd1);
    const buf = new Uint8Array(5);
    fdt.read(fd2, buf);
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });

  it("flushes shared file descriptions when any descriptor closes", () => {
    const vfs = new VFS();
    const parent = new FdTable(vfs);
    const fd = parent.open("/home/user/out.txt", "w");
    parent.dupToShared(fd, 1);

    const child = parent.duplicateSharedDetached(1, 1);
    child.table.write(child.fd, new TextEncoder().encode("child output\n"));
    child.table.close(child.fd);

    expect(new TextDecoder().decode(vfs.readFile("/home/user/out.txt"))).toBe(
      "child output\n",
    );
    expect(parent.isOpen(1)).toBe(true);
  });

  it("clones fd table for fork", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("hello"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    const clone = fdt.clone();
    expect(clone.isOpen(fd)).toBe(true);
  });

  it("advances offset after read", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("abcdef"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    const buf1 = new Uint8Array(3);
    fdt.read(fd, buf1);
    expect(new TextDecoder().decode(buf1)).toBe("abc");
    const buf2 = new Uint8Array(3);
    fdt.read(fd, buf2);
    expect(new TextDecoder().decode(buf2)).toBe("def");
  });

  it("returns 0 when reading past end of file", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("hi"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    const buf = new Uint8Array(10);
    const n1 = fdt.read(fd, buf);
    expect(n1).toBe(2);
    const n2 = fdt.read(fd, buf);
    expect(n2).toBe(0);
  });

  it("reports offset with tell", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("abcdef"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    expect(fdt.tell(fd)).toBe(0);
    fdt.seek(fd, 4, "set");
    expect(fdt.tell(fd)).toBe(4);
  });

  it("seeks relative to current position", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("abcdef"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    fdt.seek(fd, 2, "set");
    fdt.seek(fd, 1, "cur");
    expect(fdt.tell(fd)).toBe(3);
  });

  it("seeks relative to end of file", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("abcdef"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    fdt.seek(fd, -2, "end");
    const buf = new Uint8Array(2);
    fdt.read(fd, buf);
    expect(new TextDecoder().decode(buf)).toBe("ef");
  });

  it("throws on operations with closed fd", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("hello"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "r");
    fdt.close(fd);
    expect(fdt.isOpen(fd)).toBe(false);
    expect(() => fdt.read(fd, new Uint8Array(5))).toThrow();
  });

  it("opens file in append mode", () => {
    const vfs = new VFS();
    vfs.writeFile("/home/user/test.txt", new TextEncoder().encode("hello"));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "a");
    fdt.write(fd, new TextEncoder().encode(" world"));
    fdt.close(fd);
    expect(new TextDecoder().decode(vfs.readFile("/home/user/test.txt"))).toBe(
      "hello world",
    );
  });

  it("write mode truncates existing content", () => {
    const vfs = new VFS();
    vfs.writeFile(
      "/home/user/test.txt",
      new TextEncoder().encode("old content"),
    );
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/home/user/test.txt", "w");
    fdt.write(fd, new TextEncoder().encode("new"));
    fdt.close(fd);
    expect(new TextDecoder().decode(vfs.readFile("/home/user/test.txt"))).toBe(
      "new",
    );
  });

  it("flushes writes on close for files created through privileged overlay setup", () => {
    const base = new MemoryRoot();
    base.addDir("/tmp", { uid: 0, gid: 0, permissions: 0o777 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.writeFile("/tmp/out.txt", new Uint8Array(0));
    const fdt = new FdTable(vfs);
    const fd = fdt.open("/tmp/out.txt", "w");
    fdt.write(fd, new TextEncoder().encode("buffered close flush"));
    fdt.close(fd);

    expect(new TextDecoder().decode(vfs.readFile("/tmp/out.txt"))).toBe(
      "buffered close flush",
    );
  });

  it("flushes writes with the descriptor credentials, not privileged VFS access", () => {
    const vfs = new VFS();
    vfs.withWriteAccess(() => {
      vfs.writeFile(
        "/root-owned.txt",
        new TextEncoder().encode("original"),
        0o444,
      );
      vfs.chown("/root-owned.txt", 0, 0);
    });

    const fdt = new FdTable(vfs, { uid: 1000, gid: 1000 });
    const fd = fdt.open("/root-owned.txt", "w");

    expect(() => fdt.write(fd, new TextEncoder().encode("bypass"))).toThrow(
      "permission denied",
    );
    expect(new TextDecoder().decode(vfs.readFile("/root-owned.txt"))).toBe(
      "original",
    );
    expect(() => fdt.close(fd)).toThrow("permission denied");
  });
});

describe("Pipe", () => {
  it("writes to pipe and reads from it", () => {
    const [readEnd, writeEnd] = createPipe();
    writeEnd.write(new TextEncoder().encode("piped"));
    writeEnd.close();
    const buf = new Uint8Array(5);
    const n = readEnd.read(buf);
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf)).toBe("piped");
  });

  it("returns 0 bytes when pipe is closed and empty", () => {
    const [readEnd, writeEnd] = createPipe();
    writeEnd.close();
    const buf = new Uint8Array(10);
    const n = readEnd.read(buf);
    expect(n).toBe(0);
  });

  it("reads partial data from pipe", () => {
    const [readEnd, writeEnd] = createPipe();
    writeEnd.write(new TextEncoder().encode("hello world"));
    const buf = new Uint8Array(5);
    const n = readEnd.read(buf);
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });

  it("reads remaining data after partial read", () => {
    const [readEnd, writeEnd] = createPipe();
    writeEnd.write(new TextEncoder().encode("abcdef"));
    writeEnd.close();
    const buf1 = new Uint8Array(3);
    readEnd.read(buf1);
    expect(new TextDecoder().decode(buf1)).toBe("abc");
    const buf2 = new Uint8Array(3);
    readEnd.read(buf2);
    expect(new TextDecoder().decode(buf2)).toBe("def");
  });

  it("handles multiple writes before read", () => {
    const [readEnd, writeEnd] = createPipe();
    writeEnd.write(new TextEncoder().encode("hello"));
    writeEnd.write(new TextEncoder().encode(" world"));
    writeEnd.close();
    const buf = new Uint8Array(11);
    const n = readEnd.read(buf);
    expect(n).toBe(11);
    expect(new TextDecoder().decode(buf)).toBe("hello world");
  });

  it("returns 0 when read end reads from open but empty pipe", () => {
    const [readEnd, writeEnd] = createPipe();
    const buf = new Uint8Array(10);
    const n = readEnd.read(buf);
    expect(n).toBe(0);
    writeEnd.close();
  });
});
