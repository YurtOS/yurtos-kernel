import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function hasFileConformanceFixtures(fixturesDir: string): boolean {
  return existsSync(resolve(fixturesDir, "file.wasm")) &&
    existsSync(resolve(fixturesDir, "magic.mgc"));
}
