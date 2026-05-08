import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executeYurtfileBuild, parseYurtfile } from "../image-build-file.ts";
import { loadYurtImage } from "../../../kernel/src/image-loader.ts";
import { TarImageRootProvider } from "../../../kernel/src/vfs/tar-image-root-provider.ts";

Deno.test("parseYurtfile parses ordered image instructions", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-parse-");
  const file = join(dir, "Yurtfile");
  await writeFile(
    file,
    [
      "# comment",
      "  FROM empty",
      "\tCOPY ./hello.txt /etc/hello.txt",
      "  CHMOD 640 /etc/hello.txt",
      "\tCHOWN 10:20 /etc/hello.txt",
      "  RM /var/cache",
      '  RUN /bin/echo-args "# header"',
      "\tHOSTRUN make -C runtimes/python python.wasm # host shell sees this",
      "",
    ].join("\n"),
  );

  const parsed = await parseYurtfile(file);

  assertEquals(parsed.pathForDiagnostics, file);
  assertEquals(parsed.base, { kind: "empty", line: 2 });
  assertEquals(parsed.instructions, [
    {
      kind: "copy",
      line: 3,
      source: join(dir, "hello.txt"),
      destination: "/etc/hello.txt",
    },
    { kind: "chmod", line: 4, mode: 0o640, path: "/etc/hello.txt" },
    { kind: "chown", line: 5, uid: 10, gid: 20, path: "/etc/hello.txt" },
    { kind: "rm", line: 6, path: "/var/cache" },
    {
      kind: "run",
      line: 7,
      argv: ["/bin/echo-args", "# header"],
    },
    {
      kind: "hostrun",
      line: 8,
      command: "make -C runtimes/python python.wasm # host shell sees this",
    },
  ]);
});

Deno.test("parseYurtfile resolves relative base image against Yurtfile directory", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-base-");
  const file = join(dir, "subdir", "Yurtfile");
  await Deno.mkdir(join(dir, "subdir"));
  await writeFile(file, "FROM ../base.yurtimg\n");

  const parsed = await parseYurtfile(file);

  assertEquals(parsed.base, {
    kind: "image",
    line: 1,
    path: join(dir, "base.yurtimg"),
  });
});

Deno.test("parseYurtfile supports minimal quoting and escaping", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-quote-");
  const file = join(dir, "Yurtfile");
  await writeFile(
    file,
    [
      "FROM empty",
      String.raw`COPY "input \"file\".txt" '/etc/output file.txt'`,
      String.raw`RUN /bin/echo-args one\ arg "two \"arg\"" 'three \'arg\''`,
    ].join("\n"),
  );

  const parsed = await parseYurtfile(file);

  assertEquals(parsed.instructions[0], {
    kind: "copy",
    line: 2,
    source: join(dir, 'input "file".txt'),
    destination: "/etc/output file.txt",
  });
  assertEquals(parsed.instructions[1], {
    kind: "run",
    line: 3,
    argv: ["/bin/echo-args", "one arg", 'two "arg"', "three 'arg'"],
  });
});

Deno.test("parseYurtfile preserves unknown escape sequences literally", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-unknown-escape-");
  const file = join(dir, "Yurtfile");
  await writeFile(
    file,
    String.raw`FROM empty
RUN /bin/echo-args "line\n" path\name`,
  );

  const parsed = await parseYurtfile(file);

  assertEquals(parsed.instructions[0], {
    kind: "run",
    line: 2,
    argv: ["/bin/echo-args", String.raw`line\n`, String.raw`path\name`],
  });
});

Deno.test("parseYurtfile treats # as ordinary text outside full-line comments", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-hash-");
  const file = join(dir, "Yurtfile");
  await writeFile(
    file,
    [
      "# full-line comments are ignored",
      "FROM empty",
      "RUN /bin/echo-args hi # comment text is argv",
      "COPY #host /#image",
    ].join("\n"),
  );

  const parsed = await parseYurtfile(file);

  assertEquals(parsed.instructions, [
    {
      kind: "run",
      line: 3,
      argv: ["/bin/echo-args", "hi", "#", "comment", "text", "is", "argv"],
    },
    {
      kind: "copy",
      line: 4,
      source: join(dir, "#host"),
      destination: "/#image",
    },
  ]);
});

Deno.test("parseYurtfile rejects missing and duplicate FROM", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-invalid-");
  const missing = join(dir, "missing.Yurtfile");
  const duplicate = join(dir, "duplicate.Yurtfile");
  await writeFile(missing, "COPY ./a /a\n");
  await writeFile(duplicate, "FROM empty\nFROM empty\n");

  await assertRejects(
    () => parseYurtfile(missing),
    Error,
    `${missing}:1: first instruction must be FROM`,
  );
  await assertRejects(
    () => parseYurtfile(duplicate),
    Error,
    `${duplicate}:2: duplicate FROM instruction`,
  );
});

Deno.test("parseYurtfile rejects invalid instruction arguments", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-invalid-args-");
  const cases: Array<[string, string]> = [
    ["FROM empty\nCOPY ./a relative\n", "COPY image path must be absolute"],
    ["FROM empty\nCHMOD u+x /bin/tool\n", "invalid mode: u+x"],
    ["FROM empty\nCHOWN root:root /bin/tool\n", "invalid uid: root"],
    ["FROM empty\nRUN\n", "RUN requires argv"],
    ["FROM empty\nHOSTRUN   \n", "HOSTRUN requires a shell command"],
    ["FROM empty\nBOGUS x\n", "unknown instruction: BOGUS"],
    ['FROM empty\nRUN "unterminated\n', "unterminated quote"],
  ];

  for (let i = 0; i < cases.length; i++) {
    const [content, message] = cases[i];
    const file = join(dir, `case-${i}.Yurtfile`);
    await writeFile(file, content);
    const error = await assertRejects(() => parseYurtfile(file), Error);
    assertStringIncludes(error.message, message);
  }
});

const dec = new TextDecoder();

async function rootFromImage(path: string): Promise<TarImageRootProvider> {
  const loaded = await loadYurtImage(await readFile(path));
  return new TarImageRootProvider({
    id: loaded.baseId,
    image: loaded.tarBytes,
    index: loaded.index,
  });
}

Deno.test("executeYurtfileBuild fails HOSTRUN preflight before touching output", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-hostrun-gate-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(file, "FROM empty\nHOSTRUN echo blocked\n");
  await writeFile(out, "existing");

  const result = await executeYurtfileBuild({
    file,
    outputPath: out,
    allowHostrun: false,
    wasmDir: join(
      resolve("."),
      "packages/kernel/src/platform/__tests__/fixtures",
    ),
    stdout: () => {},
    stderr: () => {},
  });

  assertEquals(result.exitCode, 2);
  assertEquals(await readFile(out, "utf8"), "existing");
});

Deno.test("executeYurtfileBuild runs HOSTRUN through the host shell", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-hostrun-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(
    file,
    [
      "FROM empty",
      "HOSTRUN printf generated > generated.txt",
      "COPY generated.txt /etc/generated.txt",
    ].join("\n"),
  );

  const result = await executeYurtfileBuild({
    file,
    outputPath: out,
    allowHostrun: true,
    wasmDir: join(
      resolve("."),
      "packages/kernel/src/platform/__tests__/fixtures",
    ),
    stdout: () => {},
    stderr: () => {},
  });

  assertEquals(result.exitCode, 0);
  const root = await rootFromImage(out);
  assertEquals(dec.decode(root.readFile("/etc/generated.txt")), "generated");
});

Deno.test("executeYurtfileBuild propagates failing HOSTRUN and preserves existing output", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-hostrun-fail-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(file, "FROM empty\nHOSTRUN exit 7\n");
  await writeFile(out, "existing");

  const result = await executeYurtfileBuild({
    file,
    outputPath: out,
    allowHostrun: true,
    wasmDir: join(
      resolve("."),
      "packages/kernel/src/platform/__tests__/fixtures",
    ),
    stdout: () => {},
    stderr: () => {},
  });

  assertEquals(result.exitCode, 7);
  assertEquals(await readFile(out, "utf8"), "existing");
});

Deno.test("executeYurtfileBuild rejects directory COPY with specific message", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-copy-dir-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await Deno.mkdir(join(dir, "srcdir"));
  await writeFile(file, "FROM empty\nCOPY srcdir /srcdir\n");

  const stderr: string[] = [];
  const result = await executeYurtfileBuild({
    file,
    outputPath: out,
    allowHostrun: false,
    wasmDir: join(
      resolve("."),
      "packages/kernel/src/platform/__tests__/fixtures",
    ),
    stdout: () => {},
    stderr: (chunk) => stderr.push(chunk),
  });

  assertEquals(result.exitCode, 1);
  assertStringIncludes(
    stderr.join(""),
    "COPY does not support directories yet; copy individual files",
  );
  await assertRejects(() => stat(out));
});

Deno.test("executeYurtfileBuild reports FROM load failures with source location", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-missing-from-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(file, "FROM ./missing.yurtimg\n");

  const stderr: string[] = [];
  const result = await executeYurtfileBuild({
    file,
    outputPath: out,
    allowHostrun: false,
    wasmDir: join(
      resolve("."),
      "packages/kernel/src/platform/__tests__/fixtures",
    ),
    stdout: () => {},
    stderr: (chunk) => stderr.push(chunk),
  });

  assertEquals(result.exitCode, 1);
  assertStringIncludes(stderr.join(""), `${file}:1: FROM failed:`);
  await assertRejects(() => stat(out));
});

Deno.test("executeYurtfileBuild reports non-RUN instruction failures with source location", async () => {
  const dir = await mkdtemp("/tmp/yurtfile-missing-copy-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(file, "FROM empty\nCOPY missing.txt /etc/missing.txt\n");

  const stderr: string[] = [];
  const result = await executeYurtfileBuild({
    file,
    outputPath: out,
    allowHostrun: false,
    wasmDir: join(
      resolve("."),
      "packages/kernel/src/platform/__tests__/fixtures",
    ),
    stdout: () => {},
    stderr: (chunk) => stderr.push(chunk),
  });

  assertEquals(result.exitCode, 1);
  assertStringIncludes(stderr.join(""), `${file}:2: COPY failed:`);
  await assertRejects(() => stat(out));
});
