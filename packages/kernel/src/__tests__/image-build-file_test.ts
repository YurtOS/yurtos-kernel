import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.19";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseYurtfile } from "../image-build-file.ts";

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
