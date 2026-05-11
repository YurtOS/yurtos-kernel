/**
 * End-to-end tests using the pre-built standard.yurtimg.
 *
 * These tests are gated on test-fixtures/standard.yurtimg existing
 * (produced by scripts/build-standard-image.ts).  They verify:
 *
 *  - The standard image mounts as the read-only base layer
 *  - sandbox.run() uses the POSIX spawn path (busybox ash as the shell)
 *  - Basic busybox applets are functional (echo, cat, ls, sh)
 *  - /sbin/init symlink is present (boot-path readiness)
 */

import { afterEach, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Sandbox } from "../sandbox.js";
import { NodeAdapter } from "../platform/node-adapter.js";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);
const STANDARD_IMAGE = resolve(
  import.meta.dirname!,
  "../../../../test-fixtures/standard.yurtimg",
);

// Skip the whole suite if the standard image hasn't been built yet.
// Run `deno run -A scripts/build-standard-image.ts` to produce it.
const HAVE_IMAGE = existsSync(STANDARD_IMAGE);

describe(
  "standard image sandbox",
  { sanitizeResources: false, sanitizeOps: false },
  () => {
    let sandbox: Sandbox;

    beforeAll(() => {
      if (!HAVE_IMAGE) {
        console.warn(
          "SKIP: standard.yurtimg not found - run scripts/build-standard-image.ts first",
        );
      }
    });

    afterEach(() => {
      sandbox?.destroy();
    });

    it("mounts standard image as base layer (busybox visible)", async () => {
      if (!HAVE_IMAGE) return;
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        image: STANDARD_IMAGE,
        bootArgv: ["/bin/sh"],
        adapter: new NodeAdapter(),
      });

      const st = sandbox.lstat("/bin/busybox");
      expect(st.type).toBe("file");

      const sh = sandbox.lstat("/bin/sh");
      expect(sh.type).toBe("symlink");

      // /sbin/init symlink exists (init applet enabled after busybox rebuild)
      const init = sandbox.lstat("/sbin/init");
      expect(init.type).toBe("symlink");
    });

    it("sandbox.run() uses busybox ash via POSIX spawn path", async () => {
      if (!HAVE_IMAGE) return;
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        image: STANDARD_IMAGE,
        bootArgv: ["/bin/sh"],
        adapter: new NodeAdapter(),
      });

      const result = await sandbox.run("echo hello from busybox");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello from busybox");
    });

    it("busybox applets are functional: cat, wc, printf", async () => {
      if (!HAVE_IMAGE) return;
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        image: STANDARD_IMAGE,
        bootArgv: ["/bin/sh"],
        adapter: new NodeAdapter(),
      });

      const cat = await sandbox.run("printf 'line1\\nline2\\n' | wc -l");
      expect(cat.exitCode).toBe(0);
      expect(cat.stdout.trim()).toBe("2");
    });

    it("/etc/passwd and /etc/inittab are provisioned over the image", async () => {
      if (!HAVE_IMAGE) return;
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        image: STANDARD_IMAGE,
        bootArgv: ["/bin/sh"],
        adapter: new NodeAdapter(),
      });

      const passwd = new TextDecoder().decode(sandbox.readFile("/etc/passwd"));
      expect(passwd).toContain("user:");

      const inittab = new TextDecoder().decode(
        sandbox.readFile("/etc/inittab"),
      );
      expect(inittab).toContain("getty");
    });

    it("pkg binary is present in the image", async () => {
      if (!HAVE_IMAGE) return;
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        image: STANDARD_IMAGE,
        bootArgv: ["/bin/sh"],
        adapter: new NodeAdapter(),
      });

      const st = sandbox.stat("/bin/pkg");
      expect(st.type).toBe("file");
    });
  },
);
