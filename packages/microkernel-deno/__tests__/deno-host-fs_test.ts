/**
 * DenoHostFs round-trip — confirms the Deno-backed HostFsImpl
 * actually reads/writes real disk under a configured root and
 * refuses traversals that escape it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { DenoHostFs } from "../mod.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function tempRoot(): string {
  const dir = Deno.makeTempDirSync({ prefix: "yurt-deno-host-fs-" });
  return dir;
}

describe("DenoHostFs", () => {
  it("opens, writes, reads, closes a file under the root", () => {
    const root = tempRoot();
    try {
      const fs = new DenoHostFs(root);
      const fd = fs.open(enc("/hello.txt"), 0b011); // writable+create
      expect(fd).toBeGreaterThan(0);
      const wrote = fs.write(fd, enc("hello deno"));
      expect(wrote).toEqual("hello deno".length);
      fs.close(fd);

      const fd2 = fs.open(enc("/hello.txt"), 0);
      expect(fd2).toBeGreaterThan(0);
      const buf = new Uint8Array(64);
      const n = fs.read(fd2, buf);
      expect(new TextDecoder().decode(buf.subarray(0, n))).toEqual(
        "hello deno",
      );
      fs.close(fd2);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("refuses traversal that climbs above the root", () => {
    const parent = Deno.makeTempDirSync({ prefix: "yurt-deno-host-fs-esc-" });
    try {
      Deno.mkdirSync(`${parent}/inner`, { recursive: true });
      Deno.mkdirSync(`${parent}/outside`, { recursive: true });
      Deno.writeTextFileSync(`${parent}/outside/secret.txt`, "no peeking");
      const fs = new DenoHostFs(`${parent}/inner`);
      const rc = fs.open(enc("/../outside/secret.txt"), 0);
      expect(rc).toBeLessThan(0);
      // Real file untouched.
      expect(Deno.readTextFileSync(`${parent}/outside/secret.txt`)).toEqual(
        "no peeking",
      );
    } finally {
      Deno.removeSync(parent, { recursive: true });
    }
  });

  it("mkdir + rename + unlink land on real disk", () => {
    const root = tempRoot();
    try {
      const fs = new DenoHostFs(root);
      Deno.writeTextFileSync(`${root}/a.txt`, "hi");
      expect(fs.mkdir(enc("/sub"), 0o755)).toEqual(0);
      expect(Deno.statSync(`${root}/sub`).isDirectory).toEqual(true);
      expect(fs.rename(enc("/a.txt"), enc("/sub/b.txt"))).toEqual(0);
      expect(Deno.statSync(`${root}/sub/b.txt`).isFile).toEqual(true);
      expect(fs.unlink(enc("/sub/b.txt"))).toEqual(0);
      let exists = true;
      try { Deno.statSync(`${root}/sub/b.txt`); } catch { exists = false; }
      expect(exists).toEqual(false);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });
});
