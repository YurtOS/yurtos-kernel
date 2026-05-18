// Runner end-to-end fixture parity: every test-fixtures/wasm/ guest run
// through the Runner (Rust kernel via the thin h/k interface) must match the
// behavior asserted directly against KernelHostInterface in
// packages/kernel-host-interface-js/__tests__/kernel-host-interface_test.ts.

import { assertEquals } from "@std/assert";
import { Runner } from "../index.ts";
import { buildFixture } from "./_build_fixture.ts";

// Shorthand: for fixtures whose artifact stem == crate name (all parity wasm).
function fix(crate: string): Promise<Uint8Array> {
  return buildFixture(crate, crate);
}

function newRunner(): Promise<Runner> {
  // Crate "yurt-kernel-wasm" produces artifact "yurt_kernel_wasm.wasm".
  return buildFixture("yurt-kernel-wasm", "yurt_kernel_wasm").then(
    (kernelWasm) => Runner.create({ kernelWasm }),
  );
}

Deno.test("hello-wasm prints via sys_write", async () => {
  const r = await newRunner();
  r.writeFile("/bin/hello", await fix("hello-wasm"));
  const res = r.runArgv(["/bin/hello"]);
  assertEquals(res.stdout, "hello from wasm\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("echo-args emits argv one per line", async () => {
  const r = await newRunner();
  r.writeFile("/bin/echo-args", await fix("echo-args-wasm"));
  const res = r.runArgv(["/bin/echo-args", "alpha", "beta", "gamma"]);
  assertEquals(res.stdout, "alpha\nbeta\ngamma\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("cat-ramfs reads a staged file", async () => {
  const r = await newRunner();
  r.writeFile("/etc/motd", new TextEncoder().encode("hello ramfs\n"));
  r.writeFile("/bin/cat-ramfs", await fix("cat-ramfs-wasm"));
  const res = r.runArgv(["/bin/cat-ramfs"]);
  assertEquals(res.stdout, "hello ramfs\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("proc-cmdline reads /proc/self/cmdline", async () => {
  const r = await newRunner();
  r.writeFile("/usr/bin/proc-cmdline", await fix("proc-cmdline-wasm"));
  const res = r.runArgv(["/usr/bin/proc-cmdline", "--flag", "value"]);
  assertEquals(res.stdout, "/usr/bin/proc-cmdline\0--flag\0value\0");
  assertEquals(res.exitCode, 0);
});

Deno.test("cat-stdin echoes stdin", async () => {
  const r = await newRunner();
  r.writeFile("/bin/cat-stdin", await fix("cat-stdin-wasm"));
  const res = r.runArgv(["/bin/cat-stdin"], {
    stdin: "sandboxed kernel input\n",
  });
  assertEquals(res.stdout, "sandboxed kernel input\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("wc-bytes counts stdin bytes", async () => {
  const r = await newRunner();
  r.writeFile("/bin/wc-bytes", await fix("wc-bytes-wasm"));
  const res = r.runArgv(["/bin/wc-bytes"], { stdin: "0123456789" });
  assertEquals(res.stdout, "10\n");
  assertEquals(res.exitCode, 0);
});

Deno.test("true-cmd exits 0", async () => {
  const r = await newRunner();
  r.writeFile("/bin/true", await fix("true-cmd-wasm"));
  assertEquals(r.runArgv(["/bin/true"]).exitCode, 0);
});

Deno.test("false-cmd exits non-zero", async () => {
  const r = await newRunner();
  r.writeFile("/bin/false", await fix("false-cmd-wasm"));
  const res = r.runArgv(["/bin/false"]);
  if (res.exitCode === 0) {
    throw new Error(`false-cmd should not exit 0; got ${res.exitCode}`);
  }
});
