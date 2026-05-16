import { assertEquals } from "@std/assert";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const script = join(repoRoot, "scripts", "rebuild-threaded-cpython.sh");

async function existsDir(path: string) {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function expectedSiblingRoot(name: string) {
  let base = repoRoot;
  while (base !== dirname(base)) {
    const candidate = resolve(base, "..", name);
    if (await existsDir(candidate)) return await Deno.realPath(candidate);
    base = dirname(base);
  }
  return resolve(repoRoot, "..", name);
}

async function printRoots(env: Record<string, string> = {}) {
  const tempDir = await Deno.makeTempDir();
  try {
    const command = new Deno.Command("/bin/bash", {
      args: [script, "print-roots"],
      cwd: tempDir,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(stderr, "");
    assertEquals(result.code, 0);
    return Object.fromEntries(
      new TextDecoder().decode(result.stdout).trim().split("\n").map((line) => {
        const [key, ...valueParts] = line.split("=");
        return [key, valueParts.join("=")];
      }),
    );
  } finally {
    await Deno.remove(tempDir);
  }
}

Deno.test("rebuild-threaded-cpython derives YURT_KERNEL_ROOT from script location", async () => {
  const roots = await printRoots();
  assertEquals(roots.YURT_KERNEL_ROOT, repoRoot);
  assertEquals(roots.YURT_PORTS_ROOT, await expectedSiblingRoot("yurt-ports"));
  assertEquals(
    roots.YURT_JUPYTER_ROOT,
    await expectedSiblingRoot("yurt-jupyter"),
  );
});

Deno.test("rebuild-threaded-cpython keeps explicit root overrides", async () => {
  const kernelRoot = await Deno.makeTempDir();
  const portsRoot = await Deno.makeTempDir();
  const jupyterRoot = await Deno.makeTempDir();
  try {
    const expectedKernelRoot = await Deno.realPath(kernelRoot);
    const expectedPortsRoot = await Deno.realPath(portsRoot);
    const expectedJupyterRoot = await Deno.realPath(jupyterRoot);
    const roots = await printRoots({
      YURT_KERNEL_ROOT: kernelRoot,
      YURT_PORTS_ROOT: portsRoot,
      YURT_JUPYTER_ROOT: jupyterRoot,
    });
    assertEquals(roots.YURT_KERNEL_ROOT, expectedKernelRoot);
    assertEquals(roots.YURT_PORTS_ROOT, expectedPortsRoot);
    assertEquals(roots.YURT_JUPYTER_ROOT, expectedJupyterRoot);
  } finally {
    await Deno.remove(kernelRoot);
    await Deno.remove(portsRoot);
    await Deno.remove(jupyterRoot);
  }
});
