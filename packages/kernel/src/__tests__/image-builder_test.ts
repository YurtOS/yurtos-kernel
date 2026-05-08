import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NodeAdapter } from "../platform/node-adapter.ts";
import { YurtImageBuilder } from "../image-builder.ts";
import { exportVfsToYurtImage } from "../image-exporter.ts";
import { loadYurtImage } from "../image-loader.ts";
import { TarImageRootProvider } from "../vfs/tar-image-root-provider.ts";
import { VFS } from "../vfs/vfs.ts";

const WASM_DIR = resolve(
  decodeURIComponent(
    new URL("../platform/__tests__/fixtures", import.meta.url).pathname,
  ),
);
const enc = new TextEncoder();
const dec = new TextDecoder();

async function providerFromImage(
  image: Uint8Array,
): Promise<TarImageRootProvider> {
  const loaded = await loadYurtImage(image);
  return new TarImageRootProvider({
    id: loaded.baseId,
    image: loaded.tarBytes,
    index: loaded.index,
  });
}

describe("YurtImageBuilder", () => {
  it("builds from an empty disk with copied files and metadata", async () => {
    const dir = await mkdtemp("/tmp/yurt-builder-");
    const src = join(dir, "config.txt");
    await writeFile(src, "config");

    const builder = await YurtImageBuilder.empty({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      await builder.copyIn(src, "/etc/config.txt", {
        uid: 10,
        gid: 20,
        mode: 0o640,
      });
      builder.symlink("/etc/config.txt", "/config-link");
      const root = await providerFromImage(await builder.exportImage());

      expect(dec.decode(root.readFile("/etc/config.txt"))).toBe("config");
      expect(root.stat("/etc/config.txt")).toMatchObject({
        uid: 10,
        gid: 20,
        permissions: 0o640,
      });
      expect(root.readlink("/config-link")).toBe("/etc/config.txt");
      expect(() => root.stat("/dev")).toThrow();
    } finally {
      builder.destroy();
    }
  });

  it("builds from a base image and omits deleted base paths", async () => {
    const baseVfs = new VFS({ layout: "empty" });
    baseVfs.withWriteAccess(() => {
      baseVfs.mkdir("/etc");
      baseVfs.writeFile("/etc/base.txt", enc.encode("base"));
      baseVfs.writeFile("/etc/delete-me.txt", enc.encode("delete"));
    });
    const baseImage = await exportVfsToYurtImage(baseVfs);

    const builder = await YurtImageBuilder.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      baseImage,
    });
    try {
      await builder.copyIn(enc.encode("upper"), "/etc/upper.txt");
      builder.remove("/etc/delete-me.txt");
      const root = await providerFromImage(await builder.exportImage());

      expect(dec.decode(root.readFile("/etc/base.txt"))).toBe("base");
      expect(dec.decode(root.readFile("/etc/upper.txt"))).toBe("upper");
      expect(() => root.stat("/etc/delete-me.txt")).toThrow();
    } finally {
      builder.destroy();
    }
  });

  it("runs argv-native commands during build", async () => {
    const builder = await YurtImageBuilder.empty({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      await builder.copyIn(
        await Deno.readFile(join(WASM_DIR, "echo-args.wasm")),
        "/bin/echo-args",
        { mode: 0o555 },
      );
      const result = await builder.run(["/bin/echo-args", "a b", "$HOME"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b\n$HOME\n");
    } finally {
      builder.destroy();
    }
  });
});
