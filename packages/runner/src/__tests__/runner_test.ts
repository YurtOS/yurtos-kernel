// Runner end-to-end fixture parity: every test-fixtures/wasm/ guest run
// through the Runner (Rust kernel via the thin h/k interface) must match the
// behavior asserted directly against KernelHostInterface in
// packages/kernel-host-interface-js/__tests__/kernel-host-interface_test.ts.

import { assertEquals } from "@std/assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runner } from "../index.ts";

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

function artifact(name: string): Uint8Array {
  const path = join(releaseDir(), `${name}.wasm`);
  try {
    return Deno.readFileSync(path);
  } catch {
    throw new Error(
      `missing ${path}. Build it first:\n` +
        `  cargo build --release --target wasm32-wasip1 -p yurt-kernel-wasm ` +
        `-p hello-wasm -p echo-args-wasm -p cat-ramfs-wasm -p proc-cmdline-wasm ` +
        `-p cat-stdin-wasm -p wc-bytes-wasm -p true-cmd-wasm -p false-cmd-wasm`,
    );
  }
}

function newRunner(): Promise<Runner> {
  return Runner.create({ kernelWasm: artifact("yurt_kernel_wasm") });
}

Deno.test("hello-wasm prints via sys_write", async () => {
  const r = await newRunner();
  r.writeFile("/bin/hello", artifact("hello-wasm"));
  const res = r.runArgv(["/bin/hello"]);
  assertEquals(res.stdout, "hello from wasm\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("echo-args emits argv one per line", async () => {
  const r = await newRunner();
  r.writeFile("/bin/echo-args", artifact("echo-args-wasm"));
  const res = r.runArgv(["/bin/echo-args", "alpha", "beta", "gamma"]);
  assertEquals(res.stdout, "alpha\nbeta\ngamma\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("cat-ramfs reads a staged file", async () => {
  const r = await newRunner();
  r.writeFile("/etc/motd", new TextEncoder().encode("hello ramfs\n"));
  r.writeFile("/bin/cat-ramfs", artifact("cat-ramfs-wasm"));
  const res = r.runArgv(["/bin/cat-ramfs"]);
  assertEquals(res.stdout, "hello ramfs\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("proc-cmdline reads /proc/self/cmdline", async () => {
  const r = await newRunner();
  r.writeFile("/usr/bin/proc-cmdline", artifact("proc-cmdline-wasm"));
  const res = r.runArgv(["/usr/bin/proc-cmdline", "--flag", "value"]);
  assertEquals(res.stdout, "/usr/bin/proc-cmdline\0--flag\0value\0");
  assertEquals(res.exitCode, 0);
});

Deno.test("cat-stdin echoes stdin", async () => {
  const r = await newRunner();
  r.writeFile("/bin/cat-stdin", artifact("cat-stdin-wasm"));
  const res = r.runArgv(["/bin/cat-stdin"], {
    stdin: "sandboxed kernel input\n",
  });
  assertEquals(res.stdout, "sandboxed kernel input\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("wc-bytes counts stdin bytes", async () => {
  const r = await newRunner();
  r.writeFile("/bin/wc-bytes", artifact("wc-bytes-wasm"));
  const res = r.runArgv(["/bin/wc-bytes"], { stdin: "0123456789" });
  assertEquals(res.stdout, "10\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("true-cmd exits 0", async () => {
  const r = await newRunner();
  r.writeFile("/bin/true", artifact("true-cmd-wasm"));
  assertEquals(r.runArgv(["/bin/true"]).exitCode, 0);
});

Deno.test("false-cmd exits non-zero", async () => {
  const r = await newRunner();
  r.writeFile("/bin/false", artifact("false-cmd-wasm"));
  const res = r.runArgv(["/bin/false"]);
  if (res.exitCode === 0) {
    throw new Error(`false-cmd should not exit 0; got ${res.exitCode}`);
  }
});
