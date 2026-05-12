/**
 * The resident command runner must exist as a real VFS file marked executable
 * after Sandbox.create. Sandbox.run calls its __run_command export; BusyBox
 * ash remains an ordinary spawned shell/tool.
 */
import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "node:path";
import { Sandbox } from "../sandbox.js";
import { NodeAdapter } from "../platform/node-adapter.js";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);

const BOOT_RUNNER = "/bin/yurt-shell-exec";

describe("Sandbox installs resident command runner", () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it("Sandbox.create installs the resident command runner", async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });

    const stat = sandbox.stat(BOOT_RUNNER);
    expect(stat).toBeDefined();
    expect(stat.type).toBe("file");
    // Lower 9 bits should include executable for owner (0o100).
    expect(stat.permissions & 0o100).not.toBe(0);

    // Should look like wasm: starts with \0asm magic.
    const bytes = sandbox.readFile(BOOT_RUNNER);
    expect(bytes.length).toBeGreaterThan(8);
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x61); // 'a'
    expect(bytes[2]).toBe(0x73); // 's'
    expect(bytes[3]).toBe(0x6d); // 'm'
  });

  it("Sandbox.fork inherits the resident command runner in child", async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    const child = await sandbox.fork();
    try {
      const stat = child.stat(BOOT_RUNNER);
      expect(stat).toBeDefined();
      expect(stat.type).toBe("file");
      expect(stat.permissions & 0o100).not.toBe(0);

      const bytes = child.readFile(BOOT_RUNNER);
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x61);
      expect(bytes[2]).toBe(0x73);
      expect(bytes[3]).toBe(0x6d);
    } finally {
      child.destroy();
    }
  });
});
