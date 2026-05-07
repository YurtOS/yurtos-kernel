import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  loadContract,
  renderContract,
  writeGeneratedFiles,
} from "./generate-native-abi.ts";

Deno.test("native ABI generator renders contract views", async () => {
  const contract = await loadContract("abi/contract/yurt_abi.toml");
  const rendered = renderContract(contract);

  assertStringIncludes(rendered.cHeader, "typedef struct yurt_pipe_result_v1");
  assertStringIncludes(rendered.rust, "pub struct YurtPipeResultV1");
  assertStringIncludes(rendered.typescript, "YURT_ABI_IMPORTS");
  assertStringIncludes(rendered.markdown, "# Native Syscall ABI");
  assertStringIncludes(rendered.markdown, "host_pipe");
  assert(!rendered.cHeader.includes("host_run_command"));
  assert(!rendered.typescript.includes("host_run_command"));
});

Deno.test("native ABI generator check mode detects drift", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/abi/contract`, { recursive: true });
  await Deno.mkdir(`${root}/abi/include`, { recursive: true });
  await Deno.mkdir(`${root}/abi/rust/yurt-abi-core/src`, { recursive: true });
  await Deno.mkdir(`${root}/packages/kernel/src/host-imports`, {
    recursive: true,
  });
  await Deno.mkdir(`${root}/docs/abi`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/abi/contract/yurt_abi.toml`,
    `
[constant.YURT_ABI_RECORD_VERSION]
type = "u16"
value = 1
doc = "Native record version."

[struct.yurt_pipe_result_v1]
doc = "Pipe creation result."
fields = [
  { name = "read_fd", type = "i32", doc = "Read end fd." },
  { name = "write_fd", type = "i32", doc = "Write end fd." },
]

[import.host_pipe]
doc = "Create a pipe."
return = "fixed_out"
args = [
  { name = "out_ptr", type = "ptr" },
  { name = "out_cap", type = "usize" },
]
`,
  );

  const contract = await loadContract(`${root}/abi/contract/yurt_abi.toml`);
  const rendered = renderContract(contract);
  const first = await writeGeneratedFiles(root, rendered, { check: true });
  assertEquals(first.ok, false);
  assertEquals(first.changed.length, 4);

  await writeGeneratedFiles(root, rendered, { check: false });
  const second = await writeGeneratedFiles(root, rendered, { check: true });
  assertEquals(second, { ok: true, changed: [] });

  await Deno.writeTextFile(`${root}/abi/include/yurt_abi.h`, "stale");
  const third = await writeGeneratedFiles(root, rendered, { check: true });
  assertEquals(third.ok, false);
  assertEquals(third.changed, ["abi/include/yurt_abi.h"]);
});
