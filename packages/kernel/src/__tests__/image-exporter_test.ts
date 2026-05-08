import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { VFS } from "../vfs/vfs.ts";
import { exportVfsToTar, exportVfsToYurtImage } from "../image-exporter.ts";
import { loadYurtImage } from "../image-loader.ts";
import { TarImageRootProvider } from "../vfs/tar-image-root-provider.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("exportVfsToYurtImage", () => {
  it("exports an empty-disk VFS as a reloadable zstd yurt image", async () => {
    const vfs = new VFS({ layout: "empty" });
    vfs.withWriteAccess(() => {
      vfs.mkdir("/etc");
      vfs.writeFile("/etc/config.txt", enc.encode("config"), 0o640);
      vfs.chown("/etc/config.txt", 42, 43);
      vfs.symlink("/etc/config.txt", "/config-link");
      vfs.chown("/config-link", 44, 45, false);
    });

    const image = await exportVfsToYurtImage(vfs);
    const loaded = await loadYurtImage(image);
    const root = new TarImageRootProvider({
      id: loaded.baseId,
      image: loaded.tarBytes,
      index: loaded.index,
    });

    expect(dec.decode(root.readFile("/etc/config.txt"))).toBe("config");
    expect(root.stat("/etc/config.txt")).toMatchObject({
      type: "file",
      permissions: 0o640,
      uid: 42,
      gid: 43,
    });
    expect(root.lstat("/config-link")).toMatchObject({
      type: "symlink",
      uid: 44,
      gid: 45,
    });
    expect(root.readlink("/config-link")).toBe("/etc/config.txt");
    expect(root.readdir("/").map((entry) => entry.name).sort()).toEqual([
      "config-link",
      "etc",
    ]);
  });

  it("skips virtual provider paths and is deterministic", async () => {
    const vfs = new VFS({ layout: "empty" });
    vfs.withWriteAccess(() => {
      vfs.mkdir("/bin");
      vfs.writeFile("/bin/a", enc.encode("a"), 0o555);
    });

    const first = await exportVfsToYurtImage(vfs);
    const second = await exportVfsToYurtImage(vfs);
    expect(first).toEqual(second);

    const loaded = await loadYurtImage(first);
    const root = new TarImageRootProvider({
      id: loaded.baseId,
      image: loaded.tarBytes,
      index: loaded.index,
    });
    expect(root.readdir("/").map((entry) => entry.name)).toEqual(["bin"]);
    expect(() => root.stat("/dev")).toThrow();
    expect(() => root.stat("/proc")).toThrow();
  });

  it("orders tar entries by codepoint, independent of localeCompare", async () => {
    const vfs = new VFS({ layout: "empty" });
    vfs.withWriteAccess(() => {
      vfs.writeFile("/b", enc.encode("b"));
      vfs.writeFile("/a", enc.encode("a"));
    });

    const originalLocaleCompare = String.prototype.localeCompare;
    try {
      String.prototype.localeCompare = function (other: string): number {
        const self = String(this);
        return self < other ? 1 : self > other ? -1 : 0;
      };

      expect(tarNames(await exportVfsToTar(vfs))).toEqual(["a", "b"]);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });
});

function tarNames(tar: Uint8Array): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const block = tar.subarray(offset, offset + 512);
    offset += 512;
    if (block.every((byte) => byte === 0)) break;

    const name = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    names.push(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(readString(block, 124, 12).trim() || "0", 8);
    offset += Math.ceil(size / 512) * 512;
  }
  return names;
}

function readString(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return dec.decode(end >= 0 ? field.subarray(0, end) : field).trimEnd();
}
