/**
 * Unit tests for the host-side yurtpkg extractor (pkg-installer.ts).
 *
 * All tests use synthetic tar bytes built inline — no network, no fixtures.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { installYurtPackageTar } from "../pkg-installer.js";
import { VFS } from "../vfs/vfs.js";

// ---------------------------------------------------------------------------
// Minimal tar builder for tests
// ---------------------------------------------------------------------------

const BLOCK = 512;
const enc = new TextEncoder();

function pad(s: string, n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const bytes = enc.encode(s);
  buf.set(bytes.subarray(0, n));
  return buf;
}

function octal(n: number, len: number): Uint8Array {
  return pad(n.toString(8).padStart(len - 1, "0") + "\0", len);
}

/** Build a minimal POSIX tar header block. */
function header(opts: {
  path: string;
  type: string;
  size?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  linkname?: string;
}): Uint8Array {
  const block = new Uint8Array(BLOCK);
  block.set(pad(opts.path, 100), 0); // name
  block.set(octal(opts.mode ?? 0o644, 8), 100); // mode
  block.set(octal(opts.uid ?? 0, 8), 108); // uid
  block.set(octal(opts.gid ?? 0, 8), 116); // gid
  block.set(octal(opts.size ?? 0, 12), 124); // size
  block.set(octal(0, 12), 136); // mtime
  block.set(pad(opts.type, 1), 156); // typeflag
  if (opts.linkname) block.set(pad(opts.linkname, 100), 157); // linkname
  // compute checksum
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i];
  block.set(octal(sum, 7), 148);
  block[155] = 0x20; // space after octal
  return block;
}

/** Assemble a list of (headerBlock, dataBytes?) tuples into a tar archive. */
function tar(
  entries: Array<{ hdr: Uint8Array; data?: Uint8Array }>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const { hdr, data } of entries) {
    parts.push(hdr);
    if (data && data.byteLength > 0) {
      const padded = Math.ceil(data.byteLength / BLOCK) * BLOCK;
      const buf = new Uint8Array(padded);
      buf.set(data);
      parts.push(buf);
    }
  }
  // Two zero blocks (end-of-archive)
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("installYurtPackageTar", () => {
  it("installs a regular file into the VFS", () => {
    const data = enc.encode("hello");
    const archive = tar([
      {
        hdr: header({ path: "bin/hello.txt", type: "0", size: data.byteLength }),
        data,
      },
    ]);

    const vfs = new VFS({ layout: "empty" });
    installYurtPackageTar(archive, vfs);

    const got = new TextDecoder().decode(vfs.readFile("/bin/hello.txt"));
    expect(got).toBe("hello");
  });

  it("creates parent directories implicitly", () => {
    const data = enc.encode("x");
    const archive = tar([
      {
        hdr: header({ path: "a/b/c/file.txt", type: "0", size: data.byteLength }),
        data,
      },
    ]);

    const vfs = new VFS({ layout: "empty" });
    installYurtPackageTar(archive, vfs);

    expect(vfs.stat("/a").type).toBe("dir");
    expect(vfs.stat("/a/b").type).toBe("dir");
    expect(vfs.stat("/a/b/c").type).toBe("dir");
    expect(vfs.stat("/a/b/c/file.txt").type).toBe("file");
  });

  it("installs an explicit directory entry", () => {
    const archive = tar([
      { hdr: header({ path: "usr/bin/", type: "5", mode: 0o755 }) },
    ]);

    const vfs = new VFS({ layout: "empty" });
    installYurtPackageTar(archive, vfs);

    expect(vfs.stat("/usr/bin").type).toBe("dir");
  });

  it("installs a symlink", () => {
    const data = enc.encode("binary");
    const archive = tar([
      {
        hdr: header({
          path: "bin/busybox",
          type: "0",
          size: data.byteLength,
          mode: 0o755,
        }),
        data,
      },
      {
        hdr: header({ path: "bin/sh", type: "2", linkname: "busybox" }),
      },
    ]);

    const vfs = new VFS({ layout: "empty" });
    installYurtPackageTar(archive, vfs);

    const lstat = vfs.lstat("/bin/sh");
    expect(lstat.type).toBe("symlink");
    expect(vfs.readlink("/bin/sh")).toBe("busybox");
  });

  it("installs a hardlink using vfs.link", () => {
    const data = enc.encode("binary");
    const archive = tar([
      {
        hdr: header({ path: "bin/busybox", type: "0", size: data.byteLength }),
        data,
      },
      {
        hdr: header({ path: "bin/ash", type: "1", linkname: "bin/busybox" }),
      },
    ]);

    const vfs = new VFS({ layout: "empty" });
    installYurtPackageTar(archive, vfs);

    const content = new TextDecoder().decode(vfs.readFile("/bin/ash"));
    expect(content).toBe("binary");
  });

  it("skips the info/ metadata subtree", () => {
    const meta = enc.encode('{"name":"test"}');
    const data = enc.encode("real");
    const archive = tar([
      {
        hdr: header({ path: "info/index.json", type: "0", size: meta.byteLength }),
        data: meta,
      },
      {
        hdr: header({ path: "info/files.json", type: "0", size: meta.byteLength }),
        data: meta,
      },
      {
        hdr: header({ path: "bin/tool", type: "0", size: data.byteLength }),
        data,
      },
    ]);

    const vfs = new VFS({ layout: "empty" });
    installYurtPackageTar(archive, vfs);

    // info/ should not appear in the VFS
    expect(() => vfs.stat("/info")).toThrow();
    // real content should be present
    expect(new TextDecoder().decode(vfs.readFile("/bin/tool"))).toBe("real");
  });

  it("preserves mode bits", () => {
    const data = enc.encode("exe");
    const archive = tar([
      {
        hdr: header({ path: "bin/tool", type: "0", size: data.byteLength, mode: 0o755 }),
        data,
      },
    ]);

    const vfs = new VFS({ layout: "empty" });
    installYurtPackageTar(archive, vfs);

    const st = vfs.stat("/bin/tool");
    expect(st.permissions & 0o777).toBe(0o755);
  });

  it("rejects absolute paths in the archive", () => {
    const data = enc.encode("x");
    const archive = tar([
      {
        hdr: header({ path: "/etc/passwd", type: "0", size: data.byteLength }),
        data,
      },
    ]);

    const vfs = new VFS({ layout: "empty" });
    expect(() => installYurtPackageTar(archive, vfs)).toThrow(/absolute path/);
  });

  it("rejects path traversal in the archive", () => {
    const data = enc.encode("x");
    const archive = tar([
      {
        hdr: header({ path: "../../etc/passwd", type: "0", size: data.byteLength }),
        data,
      },
    ]);

    const vfs = new VFS({ layout: "empty" });
    expect(() => installYurtPackageTar(archive, vfs)).toThrow(/traversal/);
  });
});
