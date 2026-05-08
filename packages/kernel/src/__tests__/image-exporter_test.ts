import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { VFS } from "../vfs/vfs.ts";
import { exportVfsToYurtImage } from "../image-exporter.ts";
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
});
