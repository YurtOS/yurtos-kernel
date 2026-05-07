import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "node:path";
import { Sandbox } from "../sandbox.js";
import { NodeAdapter } from "../platform/node-adapter.js";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);

describe("kernel package boundary", () => {
  let sandbox: Sandbox | undefined;

  afterEach(() => {
    sandbox?.destroy();
    sandbox = undefined;
  });

  it("does not expose package-manager commands", async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });

    const pkg = await sandbox.run("pkg list");
    const pip = await sandbox.run("pip list");

    expect(pkg.exitCode).not.toBe(0);
    expect(pkg.stderr).not.toContain("package manager");
    expect(pkg.stderr).toContain("spawn(pkg)");
    expect(pip.exitCode).not.toBe(0);
    expect(pip.stderr).toContain("spawn(pip)");
  });

  it("does not install package-manager policy into kernel config", async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });

    expect(() => sandbox!.readFile("/etc/yurt/pkg-policy.json")).toThrow();
    expect(() => sandbox!.readFile("/etc/yurt/pip-policy.json")).toThrow();
    expect(() => sandbox!.readFile("/etc/yurt/pip-registry.json")).toThrow();
    expect(() => sandbox!.readFile("/etc/yurt/pip-installed.json")).toThrow();
  });
});
