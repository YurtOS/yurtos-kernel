import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDirectoryRootProvider } from "../../vfs/node-directory-root-provider.ts";
import { buildBaseImage } from "../build-base-image.ts";

const dec = new TextDecoder();

describe("buildBaseImage", () => {
  it("builds a Yurt base-root directory with manifest metadata", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "yurt-base-src-"));
    const outDir = await mkdtemp(join(tmpdir(), "yurt-base-"));
    await mkdir(join(sourceDir, "fixtures"), { recursive: true });
    await writeFile(
      join(sourceDir, "fixtures/tool.wasm"),
      new Uint8Array([0, 0x61, 0x73, 0x6d]),
    );
    await writeFile(join(sourceDir, "fixtures/config.json"), "{}");
    await writeFile(join(sourceDir, "fixtures/cache.txt"), "cache");

    const manifest = await buildBaseImage({
      outDir,
      dirs: [{ path: "/var/tmp", uid: 1000, gid: 1000, mode: 0o777 }],
      files: [
        {
          src: join(sourceDir, "fixtures/tool.wasm"),
          dest: "/bin/tool",
          uid: 0,
          gid: 0,
          mode: 0o755,
        },
        {
          src: join(sourceDir, "fixtures/config.json"),
          dest: "/etc/tool/config.json",
          uid: 1000,
          gid: 1000,
          mode: 0o644,
        },
        {
          src: join(sourceDir, "fixtures/cache.txt"),
          dest: "/var/tmp/cache.txt",
          uid: 1000,
          gid: 1000,
          mode: 0o644,
        },
      ],
      symlinks: [{ target: "tool", link: "/bin/tool-alias" }],
      tools: [
        { name: "tool", path: "/bin/tool" },
        { name: "tool-alias", path: "/bin/tool-alias" },
      ],
    });

    expect(manifest.version).toBe(1);
    expect(manifest.id).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(join(outDir, "bin/tool"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(outDir, "etc/tool/config.json"))).mode & 0o777)
      .toBe(0o644);
    expect(manifest.files.find((f) => f.path === "/bin/tool")?.uid).toBe(0);
    expect(manifest.files.find((f) => f.path === "/etc/tool/config.json")?.uid)
      .toBe(1000);
    expect(manifest.files.find((f) => f.path === "/etc/tool")?.type).toBe(
      "dir",
    );
    expect(manifest.files.find((f) => f.path === "/etc")?.uid).toBe(0);
    expect(manifest.files.find((f) => f.path === "/etc/yurt")?.type).toBe(
      "dir",
    );
    expect(
      manifest.files.find((f) => f.path === "/etc/yurt/base-image.json"),
    ).toEqual({
      path: "/etc/yurt/base-image.json",
      type: "file",
      uid: 0,
      gid: 0,
      mode: 0o644,
    });
    expect(manifest.files.find((f) => f.path === "/var/tmp")?.uid).toBe(1000);
    expect(manifest.files.find((f) => f.path === "/var/tmp")?.mode).toBe(0o777);
    expect(manifest.files.find((f) => f.path === "/bin/tool-alias")).toEqual({
      path: "/bin/tool-alias",
      type: "symlink",
      uid: 0,
      gid: 0,
      mode: 0o777,
      target: "tool",
    });
    expect(await readlink(join(outDir, "bin/tool-alias"))).toBe("tool");
    expect((await lstat(join(outDir, "bin/tool-alias"))).isSymbolicLink()).toBe(
      true,
    );
    expect(manifest.tools).toEqual([
      { name: "tool", path: "/bin/tool" },
      { name: "tool-alias", path: "/bin/tool-alias" },
    ]);
    expect(
      JSON.parse(
        await readFile(join(outDir, "etc/yurt/base-image.json"), "utf8"),
      ).id,
    ).toBe(manifest.id);
  });

  it("produces a manifest consumable by NodeDirectoryRootProvider", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "yurt-base-src-"));
    const outDir = await mkdtemp(join(tmpdir(), "yurt-base-"));
    await writeFile(join(sourceDir, "tool.wasm"), "wasm");

    const manifest = await buildBaseImage({
      outDir,
      files: [{
        src: join(sourceDir, "tool.wasm"),
        dest: "/bin/tool",
        uid: 0,
        gid: 0,
        mode: 0o755,
      }],
      tools: [{ name: "tool", path: "/bin/tool" }],
    });
    const provider = new NodeDirectoryRootProvider(outDir, {
      id: manifest.id,
      metadata: Object.fromEntries(manifest.files.map((f) => [
        f.path,
        { uid: f.uid, gid: f.gid, mode: f.mode },
      ])),
    });

    expect(provider.id).toBe(manifest.id);
    expect(dec.decode(provider.readFile("/bin/tool"))).toBe("wasm");
    expect(provider.stat("/bin/tool").permissions).toBe(0o755);
    expect(provider.stat("/bin/tool").uid).toBe(0);
  });

  it("rejects paths that are not absolute package-root paths", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "yurt-base-src-"));
    const outDir = await mkdtemp(join(tmpdir(), "yurt-base-"));
    await writeFile(join(sourceDir, "tool.wasm"), "wasm");

    await expect(buildBaseImage({
      outDir,
      files: [{ src: join(sourceDir, "tool.wasm"), dest: "../bin/tool" }],
    })).rejects.toThrow(/invalid base image destination/);

    await expect(buildBaseImage({
      outDir,
      dirs: [{ path: "/tmp/../etc" }],
      files: [],
    })).rejects.toThrow(/invalid base image directory/);

    await expect(buildBaseImage({
      outDir,
      files: [],
      symlinks: [{ target: "tool", link: "bin/tool" }],
    })).rejects.toThrow(/invalid base image symlink/);
  });
});
