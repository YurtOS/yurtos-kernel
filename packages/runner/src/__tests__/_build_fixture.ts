// Shared helper: resolve a wasm fixture artifact, auto-building via cargo if
// the release binary is absent. Mirrors the convention used by
// packages/kernel-host-interface-js/__tests__/kernel-host-interface_test.ts.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function workspaceRoot(): string {
  return dirname(
    dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
  );
}

function releaseDir(): string {
  const targetDir = Deno.env.get("CARGO_TARGET_DIR") ??
    join(workspaceRoot(), "target");
  return join(targetDir, "wasm32-wasip1", "release");
}

/**
 * Return the bytes of `<artifact>.wasm` from the cargo release dir,
 * running `cargo build --release -p <crate> --target wasm32-wasip1` first if
 * the file is absent. Throws only if the cargo invocation itself fails.
 */
export async function buildFixture(
  crate: string,
  artifact: string,
): Promise<Uint8Array> {
  const path = join(releaseDir(), `${artifact}.wasm`);
  try {
    return await Deno.readFile(path);
  } catch {
    const cmd = new Deno.Command("cargo", {
      args: [
        "build",
        "--release",
        "-p",
        crate,
        "--target",
        "wasm32-wasip1",
      ],
      cwd: workspaceRoot(),
    });
    const { code } = await cmd.output();
    if (code !== 0) {
      throw new Error(`cargo build of ${crate} failed`);
    }
    return await Deno.readFile(path);
  }
}
