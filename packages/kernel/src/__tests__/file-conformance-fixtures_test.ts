import { assertEquals } from "@std/assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasFileConformanceFixtures } from "./file-conformance-fixtures.ts";

Deno.test("hasFileConformanceFixtures requires both file.wasm and magic.mgc", async () => {
  const root = await Deno.makeTempDir();

  assertEquals(hasFileConformanceFixtures(root), false);

  writeFileSync(join(root, "file.wasm"), new Uint8Array([0x00]));
  assertEquals(hasFileConformanceFixtures(root), false);

  writeFileSync(join(root, "magic.mgc"), new Uint8Array([0x00]));
  assertEquals(hasFileConformanceFixtures(root), true);
});

Deno.test("hasFileConformanceFixtures ignores nested fixture lookalikes", async () => {
  const root = await Deno.makeTempDir();
  const nested = join(root, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, "file.wasm"), new Uint8Array([0x00]));
  writeFileSync(join(nested, "magic.mgc"), new Uint8Array([0x00]));

  assertEquals(hasFileConformanceFixtures(root), false);
});
