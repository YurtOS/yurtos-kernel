import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Sandbox } from "../sandbox.ts";
import { NodeAdapter } from "../platform/node-adapter.ts";

const WASM_DIR = resolve(
  decodeURIComponent(
    new URL("../platform/__tests__/fixtures", import.meta.url).pathname,
  ),
);
const enc = new TextEncoder();
const dec = new TextDecoder();
const BOOT_RUNNER = "/bin/yurt-shell-exec";

async function createBaseRoot(): Promise<string> {
  const baseRoot = await mkdtemp(join(tmpdir(), "yurt-base-root-"));
  await mkdir(join(baseRoot, "bin"), { recursive: true });
  await mkdir(join(baseRoot, "etc/yurt"), { recursive: true });
  await mkdir(join(baseRoot, "tmp"), { recursive: true });

  await copyFile(join(WASM_DIR, "true-cmd.wasm"), join(baseRoot, "bin/true"));
  await writeFile(join(baseRoot, "etc/base-marker.txt"), "base");

  await writeFile(
    join(baseRoot, "etc/yurt/base-image.json"),
    JSON.stringify({
      version: 1,
      id: "test-base-root",
      files: [
        { path: "/bin", type: "dir", uid: 0, gid: 0, mode: 0o755 },
        { path: "/bin/true", type: "file", uid: 0, gid: 0, mode: 0o755 },
        { path: "/etc", type: "dir", uid: 0, gid: 0, mode: 0o755 },
        {
          path: "/etc/base-marker.txt",
          type: "file",
          uid: 1000,
          gid: 1000,
          mode: 0o644,
        },
        { path: "/etc/yurt", type: "dir", uid: 0, gid: 0, mode: 0o755 },
        {
          path: "/etc/yurt/base-image.json",
          type: "file",
          uid: 0,
          gid: 0,
          mode: 0o644,
        },
        { path: "/tmp", type: "dir", uid: 1000, gid: 1000, mode: 0o777 },
      ],
      tools: [{ name: "true", path: "/bin/true" }],
    }),
  );

  return baseRoot;
}

async function createShellBaseRoot(): Promise<string> {
  const baseRoot = await mkdtemp(join(tmpdir(), "yurt-base-root-"));
  await mkdir(join(baseRoot, "bin"), { recursive: true });
  await mkdir(join(baseRoot, "etc/yurt"), { recursive: true });
  await mkdir(join(baseRoot, "tmp"), { recursive: true });
  await mkdir(join(baseRoot, "usr/bin"), { recursive: true });

  const runnerFixture = typeof WebAssembly.Suspending === "function"
    ? "yurt-shell-exec.wasm"
    : "yurt-shell-exec-asyncify.wasm";
  await copyFile(
    join(WASM_DIR, runnerFixture),
    join(baseRoot, "bin/yurt-shell-exec"),
  );
  await copyFile(
    join(WASM_DIR, "busybox.wasm"),
    join(baseRoot, "usr/bin/busybox"),
  );
  for (const applet of ["cat", "mkdir", "mv"]) {
    await symlink("busybox", join(baseRoot, `usr/bin/${applet}`));
  }
  await writeFile(join(baseRoot, "etc/base-marker.txt"), "base");

  await writeFile(
    join(baseRoot, "etc/yurt/base-image.json"),
    JSON.stringify({
      version: 1,
      id: "test-shell-base-root",
      files: [
        { path: "/bin", type: "dir", uid: 0, gid: 0, mode: 0o755 },
        { path: BOOT_RUNNER, type: "file", uid: 0, gid: 0, mode: 0o755 },
        { path: "/etc", type: "dir", uid: 0, gid: 0, mode: 0o755 },
        {
          path: "/etc/base-marker.txt",
          type: "file",
          uid: 1000,
          gid: 1000,
          mode: 0o644,
        },
        { path: "/etc/yurt", type: "dir", uid: 0, gid: 0, mode: 0o755 },
        {
          path: "/etc/yurt/base-image.json",
          type: "file",
          uid: 0,
          gid: 0,
          mode: 0o644,
        },
        { path: "/tmp", type: "dir", uid: 1000, gid: 1000, mode: 0o777 },
        { path: "/usr", type: "dir", uid: 0, gid: 0, mode: 0o755 },
        { path: "/usr/bin", type: "dir", uid: 0, gid: 0, mode: 0o755 },
        { path: "/usr/bin/busybox", type: "file", uid: 0, gid: 0, mode: 0o755 },
        { path: "/usr/bin/cat", type: "symlink", uid: 0, gid: 0, mode: 0o777 },
        {
          path: "/usr/bin/mkdir",
          type: "symlink",
          uid: 0,
          gid: 0,
          mode: 0o777,
        },
        { path: "/usr/bin/mv", type: "symlink", uid: 0, gid: 0, mode: 0o777 },
      ],
      tools: [
        { name: "yurt-shell-exec", path: BOOT_RUNNER },
        { name: "busybox", path: "/usr/bin/busybox" },
        { name: "cat", path: "/usr/bin/cat" },
        { name: "mkdir", path: "/usr/bin/mkdir" },
        { name: "mv", path: "/usr/bin/mv" },
      ],
    }),
  );

  return baseRoot;
}

describe(
  "Sandbox baseRoot",
  { sanitizeResources: false, sanitizeOps: false },
  () => {
    it("boots from a read-only base root and writes changes only to the upper layer", async () => {
      const baseRoot = await createBaseRoot();
      const sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        baseRoot,
        bootArgv: ["/bin/true"],
        bootWasmPath: join(WASM_DIR, "true-cmd.wasm"),
      });

      try {
        expect(dec.decode(sandbox.readFile("/etc/base-marker.txt"))).toBe(
          "base",
        );

        sandbox.writeFile("/etc/base-marker.txt", enc.encode("upper"));

        expect(dec.decode(sandbox.readFile("/etc/base-marker.txt"))).toBe(
          "upper",
        );
        expect(
          dec.decode(await readFile(join(baseRoot, "etc/base-marker.txt"))),
        ).toBe("base");
        expect(() => sandbox.writeFile("/bin/true", enc.encode("not wasm")))
          .toThrow(/EACCES/);
        expect(() =>
          sandbox.writeFile("/etc/yurt/base-image.json", enc.encode("{}"))
        ).toThrow(/EACCES/);
        expect(() => sandbox.mkdir("/etc/backdoor.d")).toThrow(/EACCES/);
        expect(dec.decode(sandbox.readFile("/etc/yurt/base-image.json")))
          .toContain("test-base-root");
      } finally {
        sandbox.destroy();
      }
    });

    it("rejects guest attempts to shadow root-owned base files", async () => {
      const baseRoot = await createShellBaseRoot();
      const sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        baseRoot,
        bootArgv: [BOOT_RUNNER],
        bootWasmPath: join(WASM_DIR, "yurt-shell-exec.wasm"),
      });

      try {
        const binWrite = await sandbox.run("echo evil > /bin/true");
        expect(binWrite.exitCode).not.toBe(0);

        const etcWrite = await sandbox.run(
          "echo evil > /etc/yurt/base-image.json",
        );
        expect(etcWrite.exitCode).not.toBe(0);

        const etcCreate = await sandbox.run("mkdir /etc/backdoor.d");
        expect(etcCreate.exitCode).not.toBe(0);

        expect(dec.decode(sandbox.readFile("/etc/yurt/base-image.json")))
          .toContain("test-shell-base-root");
        expect(() => sandbox.readFile("/etc/backdoor.d/payload")).toThrow();
        expect(
          dec.decode(
            await readFile(join(baseRoot, "etc/yurt/base-image.json")),
          ),
        ).toContain("test-shell-base-root");
      } finally {
        sandbox.destroy();
      }
    });

    it("rejects guest renames into and out of root-owned base directories", async () => {
      const baseRoot = await createShellBaseRoot();
      const sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        baseRoot,
        bootArgv: [BOOT_RUNNER],
        bootWasmPath: join(WASM_DIR, "yurt-shell-exec.wasm"),
      });

      try {
        const intoEtc = await sandbox.run(
          "echo payload > /tmp/payload; mv /tmp/payload /etc/payload",
        );
        expect(intoEtc.exitCode).not.toBe(0);
        expect(dec.decode(sandbox.readFile("/tmp/payload")).trim()).toBe(
          "payload",
        );
        expect(() => sandbox.readFile("/etc/payload")).toThrow();

        const outOfBin = await sandbox.run(
          "mv /bin/yurt-shell-exec /tmp/yurt-shell-exec",
        );
        expect(outOfBin.exitCode).not.toBe(0);
        expect(sandbox.stat(BOOT_RUNNER).type).toBe("file");
        expect(() => sandbox.readFile("/tmp/yurt-shell-exec")).toThrow();
      } finally {
        sandbox.destroy();
      }
    });

    it("snapshots and restores upper changes without touching base files", async () => {
      const baseRoot = await createBaseRoot();
      const sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        baseRoot,
        bootArgv: ["/bin/true"],
        bootWasmPath: join(WASM_DIR, "true-cmd.wasm"),
      });

      try {
        const snap = sandbox.snapshot();
        sandbox.writeFile("/etc/base-marker.txt", enc.encode("upper"));
        sandbox.restore(snap);

        expect(dec.decode(sandbox.readFile("/etc/base-marker.txt"))).toBe(
          "base",
        );
        expect(
          dec.decode(await readFile(join(baseRoot, "etc/base-marker.txt"))),
        ).toBe("base");
      } finally {
        sandbox.destroy();
      }
    });

    it("forks with the same base root and an isolated upper layer", async () => {
      const baseRoot = await createBaseRoot();
      const parent = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        baseRoot,
        bootArgv: ["/bin/true"],
        bootWasmPath: join(WASM_DIR, "true-cmd.wasm"),
      });
      let child: Sandbox | undefined;

      try {
        parent.writeFile("/etc/base-marker.txt", enc.encode("parent"));
        child = await parent.fork();
        child.writeFile("/etc/base-marker.txt", enc.encode("child"));

        expect(dec.decode(parent.readFile("/etc/base-marker.txt"))).toBe(
          "parent",
        );
        expect(dec.decode(child.readFile("/etc/base-marker.txt"))).toBe(
          "child",
        );
        expect(
          dec.decode(await readFile(join(baseRoot, "etc/base-marker.txt"))),
        ).toBe("base");
      } finally {
        child?.destroy();
        parent.destroy();
      }
    });
  },
);
