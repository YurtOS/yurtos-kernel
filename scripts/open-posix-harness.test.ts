import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  classifyExitCode,
  DEFAULT_CASES,
  outputPathForCase,
  resolveCases,
  yurtCcArgsForCase,
} from "./open-posix-harness.ts";

Deno.test("open POSIX harness resolves curated cases inside the source tree", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/conformance/interfaces/pthread_self`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${root}/conformance/interfaces/pthread_self/1-1.c`,
    "int main(void) { return 0; }\n",
  );

  const [testCase] = await resolveCases(root, ["pthread_self/1-1"]);

  assertEquals(testCase.id, "pthread_self/1-1");
  assertEquals(
    testCase.sourcePath,
    `${root}/conformance/interfaces/pthread_self/1-1.c`,
  );
});

Deno.test("open POSIX harness rejects path traversal in case ids", async () => {
  const root = await Deno.makeTempDir();

  await assertRejects(
    () => resolveCases(root, ["../escape"]),
    Error,
    "case id must be interface/name",
  );
});

Deno.test("open POSIX harness builds through yurt-cc with upstream include path", async () => {
  const root = await Deno.makeTempDir();
  const buildRoot = `${root}/build`;
  await Deno.mkdir(`${root}/conformance/interfaces/pthread_equal`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${root}/conformance/interfaces/pthread_equal/1-1.c`,
    "int main(void) { return 0; }\n",
  );
  const [testCase] = await resolveCases(root, ["pthread_equal/1-1"]);

  const outputPath = outputPathForCase(buildRoot, testCase);
  const args = yurtCcArgsForCase({
    repoRoot: "/repo",
    sourceRoot: root,
    outputPath,
    testCase,
  });

  assertEquals(outputPath, `${buildRoot}/pthread_equal/1-1.wasm`);
  assertEquals(args.at(0), "/repo/target/release/yurt-cc");
  assertEquals(args.includes("-I"), true);
  assertEquals(args.includes(`${root}/include`), true);
  assertEquals(args.includes(testCase.sourcePath), true);
  assertEquals(args.at(-1), outputPath);
});

Deno.test("open POSIX harness classifies standard PTS result codes", () => {
  assertEquals(classifyExitCode(0), "PASS");
  assertEquals(classifyExitCode(1), "FAIL");
  assertEquals(classifyExitCode(2), "UNRESOLVED");
  assertEquals(classifyExitCode(4), "UNSUPPORTED");
  assertEquals(classifyExitCode(5), "UNTESTED");
  assertEquals(classifyExitCode(99), "UNKNOWN");
});

Deno.test("open POSIX harness default cases start with pthread smoke coverage", () => {
  assertStringIncludes(DEFAULT_CASES.join("\n"), "pthread_self/1-1");
  assertStringIncludes(DEFAULT_CASES.join("\n"), "pthread_equal/1-1");
  assertStringIncludes(DEFAULT_CASES.join("\n"), "pthread_create/1-1");
});
