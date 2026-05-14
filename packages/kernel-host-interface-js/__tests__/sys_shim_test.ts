import { assertEquals } from "@std/assert";
import { buildSysImports } from "../sys_shim.ts";

Deno.test("sys_write returns -EFAULT for out-of-bounds guest buffer", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = {
    scratchLen: 4096,
    syscall() {
      throw new Error("kernel syscall should not run for bad guest memory");
    },
  };
  const imports = buildSysImports(7, kernel as never, { memory });

  let rc: number | undefined;
  let threw = false;
  try {
    rc = imports.sys_write(1, memory.buffer.byteLength + 1, 4);
  } catch {
    threw = true;
  }

  assertEquals(threw, false);
  assertEquals(rc, -14);
});
