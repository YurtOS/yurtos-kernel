# Yurtfile Image Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit `Yurtfile` support to `yurt image build`, including ordered file instructions, gated host-shell `HOSTRUN`, atomic build-file output writes, and docs/help coverage.

**Architecture:** Add a focused `packages/kernel/src/image-build-file.ts` module for parsing and executing build-file instructions. Keep `cli.ts` as the argument router: flag mode stays as-is, build-file mode delegates to the new module, and only CLI-level options such as `-o` and `--allow-hostrun` are shared. Integration tests exercise the real CLI through Deno, while parser tests cover syntax and validation without launching commands.

**Tech Stack:** TypeScript on Deno with Node compatibility imports, existing `YurtImageBuilder`, `node:child_process` for host shell execution, `node:fs/promises` for atomic output writes, and Deno test/assert helpers.

---

## File Structure

- Create `packages/kernel/src/image-build-file.ts`: typed `Yurtfile` parser, tokenization, path resolution, `HOSTRUN` preflight, host shell execution, ordered builder execution, and atomic output writer.
- Create `packages/kernel/src/__tests__/image-build-file_test.ts`: parser-focused tests for instruction shape, quoting, validation, relative path resolution, and conflict-free helper behavior.
- Modify `packages/kernel/src/cli.ts`: add `-f/--file`, `--allow-hostrun`, `--help`; reject `-f` mixed with flag-mode build-source inputs and operation flags; delegate build-file execution to `image-build-file.ts`.
- Modify `packages/kernel/src/__tests__/cli-image-build_test.ts`: add CLI integration tests for build-file happy path, hostrun gate, hostrun success/failure, atomic output preservation, relative base resolution, no implicit `Yurtfile`, and mixed argument rejection.
- Modify `docs/images.md`: document `Yurtfile`, `HOSTRUN`, `--allow-hostrun`, and build-file failure behavior while preserving flag examples.
- Modify `README.md`: keep the quick image-build example concise and point detailed image-build documentation to `docs/images.md`.

---

### Task 1: Add Yurtfile Parser

**Files:**
- Create: `packages/kernel/src/image-build-file.ts`
- Create: `packages/kernel/src/__tests__/image-build-file_test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `packages/kernel/src/__tests__/image-build-file_test.ts` with:

```ts
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
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/image-build-file_test.ts
```

Expected: FAIL because `packages/kernel/src/image-build-file.ts` does not exist.

- [ ] **Step 3: Implement parser types and `parseYurtfile`**

Create `packages/kernel/src/image-build-file.ts` with this initial content:

```ts
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

export interface ParsedYurtfile {
  path: string;
  pathForDiagnostics: string;
  base: YurtfileBase;
  instructions: YurtfileInstruction[];
}

export type YurtfileBase =
  | { kind: "empty"; line: number }
  | { kind: "image"; line: number; path: string };

export type YurtfileInstruction =
  | { kind: "copy"; line: number; source: string; destination: string }
  | { kind: "chmod"; line: number; mode: number; path: string }
  | { kind: "chown"; line: number; uid: number; gid: number; path: string }
  | { kind: "rm"; line: number; path: string }
  | { kind: "run"; line: number; argv: string[] }
  | { kind: "hostrun"; line: number; command: string };

export async function parseYurtfile(path: string): Promise<ParsedYurtfile> {
  const text = await readFile(path, "utf8");
  return parseYurtfileText(text, {
    path,
    pathForDiagnostics: path,
    baseDir: dirname(resolve(path)),
  });
}

export function parseYurtfileText(
  text: string,
  options: {
    path: string;
    pathForDiagnostics: string;
    baseDir: string;
  },
): ParsedYurtfile {
  let base: YurtfileBase | undefined;
  const instructions: YurtfileInstruction[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const content = rawLine.trimStart();
    const firstSpace = content.search(/\s/);
    const rawInstruction = firstSpace === -1 ? content : content.slice(0, firstSpace);
    const instruction = rawInstruction.trim().toUpperCase();
    const remainder = firstSpace === -1 ? "" : content.slice(firstSpace).trimStart();

    if (instruction !== "FROM" && base === undefined) {
      throw yurtfileError(options.pathForDiagnostics, lineNumber, "first instruction must be FROM");
    }

    if (instruction === "HOSTRUN") {
      if (remainder.trim() === "") {
        throw yurtfileError(options.pathForDiagnostics, lineNumber, "HOSTRUN requires a shell command");
      }
      instructions.push({ kind: "hostrun", line: lineNumber, command: remainder });
      continue;
    }

    const tokens = tokenizeYurtfileLine(remainder, options.pathForDiagnostics, lineNumber);

    if (instruction === "FROM") {
      if (base !== undefined) {
        throw yurtfileError(options.pathForDiagnostics, lineNumber, "duplicate FROM instruction");
      }
      if (tokens.length !== 1) {
        throw yurtfileError(options.pathForDiagnostics, lineNumber, "FROM requires exactly one argument");
      }
      base = tokens[0] === "empty"
        ? { kind: "empty", line: lineNumber }
        : {
          kind: "image",
          line: lineNumber,
          path: resolveHostPath(options.baseDir, tokens[0]),
        };
      continue;
    }

    if (instruction === "COPY") {
      requireArity(options.pathForDiagnostics, lineNumber, "COPY", tokens, 2);
      assertAbsoluteImagePath(options.pathForDiagnostics, lineNumber, "COPY", tokens[1]);
      instructions.push({
        kind: "copy",
        line: lineNumber,
        source: resolveHostPath(options.baseDir, tokens[0]),
        destination: tokens[1],
      });
    } else if (instruction === "CHMOD") {
      requireArity(options.pathForDiagnostics, lineNumber, "CHMOD", tokens, 2);
      assertAbsoluteImagePath(options.pathForDiagnostics, lineNumber, "CHMOD", tokens[1]);
      instructions.push({
        kind: "chmod",
        line: lineNumber,
        mode: parseMode(tokens[0], options.pathForDiagnostics, lineNumber),
        path: tokens[1],
      });
    } else if (instruction === "CHOWN") {
      requireArity(options.pathForDiagnostics, lineNumber, "CHOWN", tokens, 2);
      assertAbsoluteImagePath(options.pathForDiagnostics, lineNumber, "CHOWN", tokens[1]);
      const colon = tokens[0].indexOf(":");
      if (colon <= 0 || colon === tokens[0].length - 1) {
        throw yurtfileError(options.pathForDiagnostics, lineNumber, "invalid CHOWN owner; expected uid:gid");
      }
      instructions.push({
        kind: "chown",
        line: lineNumber,
        uid: parseDecimal(tokens[0].slice(0, colon), "uid", options.pathForDiagnostics, lineNumber),
        gid: parseDecimal(tokens[0].slice(colon + 1), "gid", options.pathForDiagnostics, lineNumber),
        path: tokens[1],
      });
    } else if (instruction === "RM") {
      requireArity(options.pathForDiagnostics, lineNumber, "RM", tokens, 1);
      assertAbsoluteImagePath(options.pathForDiagnostics, lineNumber, "RM", tokens[0]);
      instructions.push({ kind: "rm", line: lineNumber, path: tokens[0] });
    } else if (instruction === "RUN") {
      if (tokens.length === 0) {
        throw yurtfileError(options.pathForDiagnostics, lineNumber, "RUN requires argv");
      }
      instructions.push({ kind: "run", line: lineNumber, argv: tokens });
    } else {
      throw yurtfileError(options.pathForDiagnostics, lineNumber, `unknown instruction: ${instruction}`);
    }
  }

  if (base === undefined) {
    throw yurtfileError(options.pathForDiagnostics, 1, "first instruction must be FROM");
  }

  return {
    path: options.path,
    pathForDiagnostics: options.pathForDiagnostics,
    base,
    instructions,
  };
}
```

- [ ] **Step 4: Implement tokenizer and validation helpers**

Append these helpers to `packages/kernel/src/image-build-file.ts`:

```ts
function tokenizeYurtfileLine(
  input: string,
  pathForDiagnostics: string,
  line: number,
): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | undefined;
  let tokenStarted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (quote) {
      if (char === "\\") {
        const next = input[++i];
        if (next === undefined) {
          token += "\\";
        } else if (next === "\\" || next === quote) {
          token += next;
        } else {
          token += `\\${next}`;
        }
      } else if (char === quote) {
        quote = undefined;
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }

    if (char === "\\") {
      const next = input[++i];
      if (next === undefined) {
        token += "\\";
      } else if (/\s/.test(next)) {
        token += next;
      } else {
        token += `\\${next}`;
      }
      tokenStarted = true;
      continue;
    }

    token += char;
    tokenStarted = true;
  }

  if (quote) {
    throw yurtfileError(pathForDiagnostics, line, "unterminated quote");
  }
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function requireArity(
  pathForDiagnostics: string,
  line: number,
  instruction: string,
  tokens: string[],
  expected: number,
): void {
  if (tokens.length !== expected) {
    throw yurtfileError(
      pathForDiagnostics,
      line,
      `${instruction} requires exactly ${expected} argument${expected === 1 ? "" : "s"}`,
    );
  }
}

function resolveHostPath(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : join(baseDir, path);
}

function assertAbsoluteImagePath(
  pathForDiagnostics: string,
  line: number,
  instruction: string,
  path: string,
): void {
  if (!path.startsWith("/")) {
    throw yurtfileError(pathForDiagnostics, line, `${instruction} image path must be absolute`);
  }
}

function parseMode(
  value: string,
  pathForDiagnostics: string,
  line: number,
): number {
  if (!/^[0-7]+$/.test(value)) {
    throw yurtfileError(pathForDiagnostics, line, `invalid mode: ${value}`);
  }
  return parseInt(value, 8);
}

function parseDecimal(
  value: string,
  label: string,
  pathForDiagnostics: string,
  line: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw yurtfileError(pathForDiagnostics, line, `invalid ${label}: ${value}`);
  }
  return Number(value);
}

function yurtfileError(pathForDiagnostics: string, line: number, message: string): Error {
  return new Error(`${pathForDiagnostics}:${line}: ${message}`);
}
```

- [ ] **Step 5: Run parser tests and verify pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/image-build-file_test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit parser**

Run:

```bash
git add packages/kernel/src/image-build-file.ts packages/kernel/src/__tests__/image-build-file_test.ts
git commit -m "feat: add yurtfile parser"
```

---

### Task 2: Add Yurtfile Executor And Atomic Output

**Files:**
- Modify: `packages/kernel/src/image-build-file.ts`
- Modify: `packages/kernel/src/__tests__/image-build-file_test.ts`

- [ ] **Step 1: Add focused executor tests**

First extend the existing imports at the top of
`packages/kernel/src/__tests__/image-build-file_test.ts` so they are:

```ts
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.19";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  executeYurtfileBuild,
  parseYurtfile,
} from "../image-build-file.ts";
import { loadYurtImage } from "../image-loader.ts";
import { TarImageRootProvider } from "../vfs/tar-image-root-provider.ts";
```

Then append these tests and helpers to the same file:

```ts
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
    wasmDir: join(resolve("."), "packages/kernel/src/platform/__tests__/fixtures"),
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
    wasmDir: join(resolve("."), "packages/kernel/src/platform/__tests__/fixtures"),
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
    wasmDir: join(resolve("."), "packages/kernel/src/platform/__tests__/fixtures"),
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
    wasmDir: join(resolve("."), "packages/kernel/src/platform/__tests__/fixtures"),
    stdout: () => {},
    stderr: (chunk) => stderr.push(chunk),
  });

  assertEquals(result.exitCode, 1);
  assertStringIncludes(stderr.join(""), "COPY does not support directories yet; copy individual files");
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
    wasmDir: join(resolve("."), "packages/kernel/src/platform/__tests__/fixtures"),
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
    wasmDir: join(resolve("."), "packages/kernel/src/platform/__tests__/fixtures"),
    stdout: () => {},
    stderr: (chunk) => stderr.push(chunk),
  });

  assertEquals(result.exitCode, 1);
  assertStringIncludes(stderr.join(""), `${file}:2: COPY failed:`);
  await assertRejects(() => stat(out));
});
```

- [ ] **Step 2: Run executor tests and verify failure**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/__tests__/image-build-file_test.ts
```

Expected: FAIL because `executeYurtfileBuild` is not implemented.

- [ ] **Step 3: Add executor imports, options, and result types**

Modify the top of `packages/kernel/src/image-build-file.ts` so the imports become:

```ts
import { spawn } from "node:child_process";
import {
  dirname,
  isAbsolute,
  join,
  basename,
  resolve,
} from "node:path";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { PlatformAdapter } from "./platform/adapter.ts";
import { YurtImageBuilder } from "./image-builder.ts";
import { NodeAdapter } from "./platform/node-adapter.ts";
```

Add these interfaces after `YurtfileInstruction`:

```ts
export interface ExecuteYurtfileBuildOptions {
  file: string;
  outputPath: string;
  allowHostrun: boolean;
  wasmDir: string;
  adapter?: PlatformAdapter;
  imageCacheDir?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

export interface ExecuteYurtfileBuildResult {
  exitCode: number;
}
```

- [ ] **Step 4: Implement `executeYurtfileBuild`**

Add this function before `parseYurtfile`:

```ts
export async function executeYurtfileBuild(
  options: ExecuteYurtfileBuildOptions,
): Promise<ExecuteYurtfileBuildResult> {
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  let parsed: ParsedYurtfile;
  try {
    parsed = await parseYurtfile(options.file);
    const hostrun = parsed.instructions.find((instruction) => instruction.kind === "hostrun");
    if (hostrun && !options.allowHostrun) {
      stderr(`${parsed.pathForDiagnostics}:${hostrun.line}: HOSTRUN requires --allow-hostrun\n`);
      return { exitCode: 2 };
    }
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }

  let builder: YurtImageBuilder | undefined;
  try {
    const adapter = options.adapter ?? new NodeAdapter();
    builder = parsed.base.kind === "empty"
      ? await YurtImageBuilder.empty({ wasmDir: options.wasmDir, adapter })
      : await YurtImageBuilder.create({
        wasmDir: options.wasmDir,
        adapter,
        baseImage: parsed.base.path,
        imageCacheDir: options.imageCacheDir,
      });

    for (const instruction of parsed.instructions) {
      const result = await executeInstruction(parsed, instruction, builder, { stdout, stderr });
      if (result.exitCode !== 0) return result;
    }

    await writeOutputAtomically(options.outputPath, await builder.exportImage());
    return { exitCode: 0 };
  } catch (error) {
    const line = builder === undefined ? parsed.base.line : undefined;
    const prefix = builder === undefined && line !== undefined
      ? `${parsed.pathForDiagnostics}:${line}: FROM failed: `
      : "";
    stderr(`${prefix}${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  } finally {
    builder?.destroy();
  }
}
```

- [ ] **Step 5: Implement instruction execution helpers**

Append these helpers before `tokenizeYurtfileLine`:

```ts
async function executeInstruction(
  parsed: ParsedYurtfile,
  instruction: YurtfileInstruction,
  builder: YurtImageBuilder,
  io: {
    stdout: (chunk: string) => void;
    stderr: (chunk: string) => void;
  },
): Promise<ExecuteYurtfileBuildResult> {
  try {
    if (instruction.kind === "copy") {
      const sourceStat = await stat(instruction.source);
      if (sourceStat.isDirectory()) {
        io.stderr(`${parsed.pathForDiagnostics}:${instruction.line}: COPY does not support directories yet; copy individual files\n`);
        return { exitCode: 1 };
      }
      await builder.copyIn(instruction.source, instruction.destination);
      return { exitCode: 0 };
    }
    if (instruction.kind === "chmod") {
      builder.chmod(instruction.path, instruction.mode);
      return { exitCode: 0 };
    }
    if (instruction.kind === "chown") {
      builder.chown(instruction.path, instruction.uid, instruction.gid);
      return { exitCode: 0 };
    }
    if (instruction.kind === "rm") {
      builder.remove(instruction.path);
      return { exitCode: 0 };
    }
    if (instruction.kind === "run") {
      const result = await builder.run(instruction.argv);
      if (result.stdout) io.stdout(result.stdout);
      if (result.stderr) io.stderr(result.stderr);
      if (result.exitCode !== 0) {
        io.stderr(`${parsed.pathForDiagnostics}:${instruction.line}: RUN exited with status ${result.exitCode}: ${instruction.argv.join(" ")}\n`);
      }
      return { exitCode: result.exitCode };
    }
    return await runHostCommand(parsed, instruction, io);
  } catch (error) {
    io.stderr(`${parsed.pathForDiagnostics}:${instruction.line}: ${instructionName(instruction)} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  }
}

function instructionName(instruction: YurtfileInstruction): string {
  return instruction.kind.toUpperCase();
}

function runHostCommand(
  parsed: ParsedYurtfile,
  instruction: Extract<YurtfileInstruction, { kind: "hostrun" }>,
  io: {
    stdout: (chunk: string) => void;
    stderr: (chunk: string) => void;
  },
): Promise<ExecuteYurtfileBuildResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(instruction.command, {
      cwd: dirname(resolve(parsed.path)),
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Uint8Array) => io.stdout(new TextDecoder().decode(chunk)));
    child.stderr?.on("data", (chunk: Uint8Array) => io.stderr(new TextDecoder().decode(chunk)));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        // Use 1 for signal termination; do not encode shell-style 128+signal.
        io.stderr(`${parsed.pathForDiagnostics}:${instruction.line}: HOSTRUN terminated by signal ${signal}: ${instruction.command}\n`);
        resolveResult({ exitCode: 1 });
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        io.stderr(`${parsed.pathForDiagnostics}:${instruction.line}: HOSTRUN exited with status ${exitCode}: ${instruction.command}\n`);
      }
      resolveResult({ exitCode });
    });
  });
}

async function writeOutputAtomically(outputPath: string, bytes: Uint8Array): Promise<void> {
  const dir = dirname(outputPath);
  const tempPath = join(
    dir,
    `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, outputPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
```

- [ ] **Step 6: Run executor tests and verify pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/__tests__/image-build-file_test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit executor**

Run:

```bash
git add packages/kernel/src/image-build-file.ts packages/kernel/src/__tests__/image-build-file_test.ts
git commit -m "feat: execute yurtfile image builds"
```

---

### Task 3: Wire Build-File Mode Into CLI

**Files:**
- Modify: `packages/kernel/src/cli.ts`
- Modify: `packages/kernel/src/__tests__/cli-image-build_test.ts`

- [ ] **Step 1: Add failing CLI tests for build-file mode**

Append these tests to `packages/kernel/src/__tests__/cli-image-build_test.ts`:

```ts
Deno.test("yurt image build uses explicit Yurtfile", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-yurtfile-");
  const src = join(dir, "hello.txt");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(src, "hello from file");
  await writeFile(
    file,
    [
      "FROM empty",
      "COPY hello.txt /etc/hello.txt",
      "CHMOD 640 /etc/hello.txt",
      "CHOWN 10:20 /etc/hello.txt",
    ].join("\n"),
  );

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-f",
      file,
      "-o",
      out,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stderr = dec.decode(result.stderr);
  assertEquals(result.code, 0, stderr);
  const root = await rootFromFile(out);
  assertEquals(dec.decode(root.readFile("/etc/hello.txt")), "hello from file");
  assertEquals(root.stat("/etc/hello.txt").permissions, 0o640);
  assertEquals(root.stat("/etc/hello.txt").uid, 10);
  assertEquals(root.stat("/etc/hello.txt").gid, 20);
});

Deno.test("yurt image build does not auto-discover Yurtfile", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-no-auto-yurtfile-");
  await writeFile(join(dir, "Yurtfile"), "FROM empty\n");
  const out = join(dir, "out.yurtimg");

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-o",
      out,
    ],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 2);
  assertStringIncludes(dec.decode(result.stderr), "missing base image; pass --empty for an empty disk");
});

Deno.test("yurt image build rejects Yurtfile mixed with flag operations and base inputs", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-yurtfile-mix-");
  const file = join(dir, "Yurtfile");
  await writeFile(file, "FROM empty\n");

  const cases = [
    ["--empty"],
    ["base.yurtimg"],
    ["--copy", "a:/a"],
    ["--chmod", "555:/a"],
    ["--chown", "0:0:/a"],
    ["--rm", "/a"],
    ["--run", "/bin/true"],
  ];

  for (const extra of cases) {
    const result = await new Deno.Command(deno, {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        CLI,
        "image",
        "build",
        "-f",
        file,
        "-o",
        join(dir, `out-${extra[0].replaceAll("/", "_")}.yurtimg`),
        ...extra,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(result.code, 2, dec.decode(result.stderr));
    assertStringIncludes(dec.decode(result.stderr), "-f/--file cannot be combined");
  }
});

Deno.test("yurt image build rejects --allow-hostrun without a Yurtfile", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-hostrun-flag-mode-");
  const out = join(dir, "out.yurtimg");

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "--empty",
      "-o",
      out,
      "--allow-hostrun",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 2);
  assertStringIncludes(dec.decode(result.stderr), "--allow-hostrun requires -f/--file");
});
```

- [ ] **Step 2: Run CLI tests and verify failure**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/__tests__/cli-image-build_test.ts
```

Expected: FAIL because `cli.ts` does not parse `-f/--file`.

- [ ] **Step 3: Import build-file executor and extend argument types**

Modify imports in `packages/kernel/src/cli.ts`:

```ts
import { writeFile } from 'node:fs/promises';
import { executeYurtfileBuild } from './image-build-file.js';
```

Extend `ImageBuildArgs`:

```ts
interface ImageBuildArgs {
  empty: boolean;
  baseImage?: string;
  outputPath: string;
  ops: ImageBuildOp[];
  runArgv?: string[];
  file?: string;
  allowHostrun: boolean;
}
```

- [ ] **Step 4: Delegate build-file mode in `runImageBuild`**

In `runImageBuild`, after parsing succeeds and after creating `const adapter = new NodeAdapter();`, add:

```ts
  if (parsed.file) {
    const result = await executeYurtfileBuild({
      file: parsed.file,
      outputPath: parsed.outputPath,
      allowHostrun: parsed.allowHostrun,
      wasmDir: FIXTURES,
      adapter,
      imageCacheDir: process.env.YURT_IMAGE_CACHE_DIR ??
        join(tmpdir(), 'yurt-image-cache'),
    });
    process.exitCode = result.exitCode;
    return;
  }
```

- [ ] **Step 5: Parse `-f/--file` and `--allow-hostrun`**

Modify `parseImageBuildArgs`:

```ts
function parseImageBuildArgs(args: string[]): ImageBuildArgs {
  let empty = false;
  let outputPath: string | undefined;
  let baseImage: string | undefined;
  let runArgv: string[] | undefined;
  let file: string | undefined;
  let allowHostrun = false;
  const ops: ImageBuildOp[] = [];
```

Inside the loop, insert the help, file, and hostrun branches before the existing
`--empty` branch in the same attached `if` / `else if` chain.

```ts
    if (arg === '-h' || arg === '--help') {
      throw new ImageBuildHelp();
    } else if (arg === '-f' || arg === '--file') {
      file = requiredValue(args, ++i, arg);
    } else if (arg === '--allow-hostrun') {
      allowHostrun = true;
    } else if (arg === '--empty') {
      empty = true;
```

Keep the existing `-o` and operation branches after that as `else if` branches.

Before final flag-mode validation, add:

```ts
  if (file) {
    if (empty || baseImage || ops.length > 0 || runArgv) {
      throw new Error('-f/--file cannot be combined with --empty, a base image, --copy, --chmod, --chown, --rm, or --run');
    }
    if (!outputPath) throw new Error('missing -o/--output');
    return { empty: false, outputPath, ops, file, allowHostrun };
  }

  if (allowHostrun) {
    throw new Error('--allow-hostrun requires -f/--file');
  }
```

Change the final return to:

```ts
  return { empty, baseImage, outputPath, ops, runArgv, allowHostrun };
```

- [ ] **Step 6: Add image build help output**

Add this class and function near the parser helpers in `packages/kernel/src/cli.ts`:

```ts
class ImageBuildHelp extends Error {}

function imageBuildHelp(): string {
  return [
    'usage:',
    '  yurt image build --empty -o <out.yurtimg> [--copy host:/path ...] [--run argv...]',
    '  yurt image build <base.yurtimg> -o <out.yurtimg> [--copy host:/path ...] [--run argv...]',
    '  yurt image build -f <Yurtfile> -o <out.yurtimg> [--allow-hostrun]',
    '',
    'build-file mode:',
    '  -f, --file <path>     read ordered image instructions from a Yurtfile',
    '  --allow-hostrun       allow HOSTRUN instructions to execute host shell commands',
    '',
    'flag mode:',
    '  --empty               start from an empty image',
    '  --copy host:/path     copy a host file into the image',
    '  --chmod mode:/path    set octal permissions',
    '  --chown uid:gid:/path set ownership metadata',
    '  --rm /path            remove a path from the image',
    '  --run argv...         run an image command before export',
    '',
  ].join('\n');
}
```

Change the `runImageBuild` parse error handling to:

```ts
  } catch (error) {
    if (error instanceof ImageBuildHelp) {
      process.stdout.write(imageBuildHelp());
      process.exitCode = 0;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    return;
  }
```

- [ ] **Step 7: Run CLI tests and verify pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/__tests__/cli-image-build_test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit CLI integration**

Run:

```bash
git add packages/kernel/src/cli.ts packages/kernel/src/__tests__/cli-image-build_test.ts
git commit -m "feat: wire yurtfile image build cli"
```

---

### Task 4: Add CLI Integration Coverage For HOSTRUN, RUN Failure, Atomic Writes, And Relative Base

**Files:**
- Modify: `packages/kernel/src/__tests__/cli-image-build_test.ts`

- [ ] **Step 1: Add remaining integration tests**

The existing `packages/kernel/src/__tests__/cli-image-build_test.ts` imports
already include `enc`, `VFS`, and `exportVfsToYurtImage`. If those imports have
changed, ensure the file has:

```ts
import { exportVfsToYurtImage } from "../image-exporter.ts";
import { VFS } from "../vfs/vfs.ts";
```

Append these tests to `packages/kernel/src/__tests__/cli-image-build_test.ts`:

```ts
Deno.test("yurt image build gates HOSTRUN before execution", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-hostrun-gate-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  const marker = join(dir, "marker.txt");
  await writeFile(file, `FROM empty\nHOSTRUN printf touched > ${marker}\n`);
  await writeFile(out, "existing");

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-f",
      file,
      "-o",
      out,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 2);
  assertStringIncludes(dec.decode(result.stderr), "HOSTRUN requires --allow-hostrun");
  assertEquals(await readFile(out, "utf8"), "existing");
  try {
    await readFile(marker);
    throw new Error("expected HOSTRUN marker not to exist");
  } catch (error) {
    assertStringIncludes(String(error), "ENOENT");
  }
});

Deno.test("yurt image build runs allowed HOSTRUN through shell", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-hostrun-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(
    file,
    [
      "FROM empty",
      "HOSTRUN printf shell-generated > generated.txt",
      "COPY generated.txt /etc/generated.txt",
    ].join("\n"),
  );

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-f",
      file,
      "-o",
      out,
      "--allow-hostrun",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 0, dec.decode(result.stderr));
  const root = await rootFromFile(out);
  assertEquals(dec.decode(root.readFile("/etc/generated.txt")), "shell-generated");
});

Deno.test("yurt image build preserves existing output after failing HOSTRUN", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-hostrun-fail-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(file, "FROM empty\nHOSTRUN exit 7\n");
  await writeFile(out, "existing");

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-f",
      file,
      "-o",
      out,
      "--allow-hostrun",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 7);
  assertStringIncludes(dec.decode(result.stderr), "HOSTRUN exited with status 7");
  assertEquals(await readFile(out, "utf8"), "existing");
});

Deno.test("yurt image build preserves existing output after failing RUN", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-run-fail-");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(
    file,
    [
      "FROM empty",
      `COPY ${resolve("packages/kernel/src/platform/__tests__/fixtures/false-cmd.wasm")} /bin/false`,
      "CHMOD 555 /bin/false",
      "RUN /bin/false",
    ].join("\n"),
  );
  await writeFile(out, "existing");

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-f",
      file,
      "-o",
      out,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 1);
  assertStringIncludes(dec.decode(result.stderr), "RUN exited with status 1");
  assertEquals(await readFile(out, "utf8"), "existing");
});

Deno.test("yurt image build resolves relative FROM from Yurtfile directory", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-relative-from-");
  const subdir = join(dir, "build");
  const otherCwd = join(dir, "other-cwd");
  await Deno.mkdir(subdir);
  await Deno.mkdir(otherCwd);
  const base = join(dir, "base.yurtimg");
  const file = join(subdir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  const vfs = new VFS({ layout: "empty" });
  vfs.withWriteAccess(() => {
    vfs.mkdir("/etc");
    vfs.writeFile("/etc/base.txt", enc.encode("base"));
  });
  await writeFile(base, await exportVfsToYurtImage(vfs));
  await writeFile(file, "FROM ../base.yurtimg\n");

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-f",
      file,
      "-o",
      out,
    ],
    cwd: otherCwd,
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 0, dec.decode(result.stderr));
  const root = await rootFromFile(out);
  assertEquals(dec.decode(root.readFile("/etc/base.txt")), "base");
});

Deno.test("yurt image build --help documents Yurtfile and HOSTRUN", async () => {
  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "--help",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 0);
  const stdout = dec.decode(result.stdout);
  assertStringIncludes(stdout, "yurt image build -f <Yurtfile>");
  assertStringIncludes(stdout, "--allow-hostrun");
});

Deno.test("yurt image build -h documents Yurtfile and HOSTRUN", async () => {
  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-h",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 0);
  const stdout = dec.decode(result.stdout);
  assertStringIncludes(stdout, "yurt image build -f <Yurtfile>");
  assertStringIncludes(stdout, "--allow-hostrun");
});
```

- [ ] **Step 2: Run focused CLI tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/__tests__/cli-image-build_test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit remaining integration tests**

Run:

```bash
git add packages/kernel/src/__tests__/cli-image-build_test.ts
git commit -m "test: cover yurtfile image build cli behavior"
```

---

### Task 5: Update Image Build Documentation

**Files:**
- Modify: `docs/images.md`
- Modify: `README.md`

- [ ] **Step 1: Update `docs/images.md` with Yurtfile section**

Insert this section after the initial flag-mode build example in `docs/images.md`:

````markdown
### Build With A Yurtfile

For repeatable image builds, put ordered instructions in a `Yurtfile` and pass
it explicitly with `-f`:

```yurtfile
FROM empty
COPY packages/kernel/src/platform/__tests__/fixtures/true-cmd.wasm /bin/true
CHMOD 555 /bin/true
COPY packages/kernel/src/platform/__tests__/fixtures/echo-args.wasm /bin/echo-args
CHMOD 555 /bin/echo-args
RUN /bin/echo-args build step
```

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/kernel/src/cli.ts image build \
  -f Yurtfile \
  -o /tmp/generated.yurtimg
```

`Yurtfile` instructions run in order. `RUN` executes inside the image sandbox
with `cwd=/`, `HOME=/`, `PATH=/bin:/usr/bin`, `PWD=/`, and `USER=root`.
The CLI does not auto-discover `./Yurtfile`; build-file mode is used only when
`-f` or `--file` is passed.

`HOSTRUN` executes a raw command through the host shell, with the `Yurtfile`
directory as its working directory and the CLI process environment inherited.
Because this runs arbitrary host code, it requires an explicit opt-in:

```yurtfile
FROM empty
HOSTRUN make -C runtimes/python python.wasm
COPY runtimes/python/python.wasm /bin/python
CHMOD 555 /bin/python
```

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/kernel/src/cli.ts image build \
  -f Yurtfile \
  -o /tmp/python.yurtimg \
  --allow-hostrun
```

Build-file mode writes the output image atomically. If parsing, `HOSTRUN`, `RUN`,
or another instruction fails, an existing output image is left unchanged.
````

Also update the accepted-options list to include:

```markdown
- `-f, --file <path>`: read ordered image build instructions from a `Yurtfile`.
- `--allow-hostrun`: allow `HOSTRUN` instructions in a `Yurtfile` to execute
  host shell commands.
```

- [ ] **Step 2: Update `README.md` image-build pointer**

Replace the long flag-only image-build block in `README.md` with this shorter
pointer and example:

````markdown
## Images

Yurt images are zstd-compressed tar filesystem images. The kernel can build them
from flags for small one-off cases or from an ordered `Yurtfile` for repeatable
recipes. See [docs/images.md](docs/images.md) for the full image guide.

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/kernel/src/cli.ts image build \
  -f Yurtfile \
  -o /tmp/generated.yurtimg
```
````

- [ ] **Step 3: Run docs formatting check**

Run:

```bash
/Users/sunny/.deno/bin/deno fmt --check docs/images.md
```

Expected: PASS. If formatting changes are required, run:

```bash
/Users/sunny/.deno/bin/deno fmt docs/images.md
```

Then re-run the `--check` command.

- [ ] **Step 4: Commit documentation**

Run:

```bash
git add docs/images.md README.md
git commit -m "docs: document yurtfile image builds"
```

---

### Task 6: Focused Verification And Polish

**Files:**
- Modify only files needed to fix failures found by verification.

- [ ] **Step 1: Run focused Deno tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/__tests__/image-build-file_test.ts packages/kernel/src/__tests__/cli-image-build_test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Deno check for package sources**

Run:

```bash
/Users/sunny/.deno/bin/deno check 'packages/**/*.ts'
```

Expected: PASS.

- [ ] **Step 3: Run Deno lint**

Run:

```bash
/Users/sunny/.deno/bin/deno lint
```

Expected: PASS.

- [ ] **Step 4: Run Deno fmt check**

Run:

```bash
/Users/sunny/.deno/bin/deno fmt --check
```

Expected: PASS.

- [ ] **Step 5: Fix any verification failures with targeted commits**

For a TypeScript source failure, edit the source or test named in the error,
then stage the Yurtfile implementation files and commit:

```bash
git add packages/kernel/src/image-build-file.ts packages/kernel/src/cli.ts packages/kernel/src/__tests__/image-build-file_test.ts packages/kernel/src/__tests__/cli-image-build_test.ts
git commit -m "fix: address yurtfile verification failure"
```

For a documentation formatting failure, format and stage the documentation files:

```bash
/Users/sunny/.deno/bin/deno fmt docs/images.md README.md
git add docs/images.md README.md
git commit -m "fix: format yurtfile docs"
```

- [ ] **Step 6: Final local gate subset**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-run --allow-env 'packages/**/*_test.ts'
```

Expected: PASS. This is the Deno fast-tier test glob from the repo instructions.

---

## Self-Review

- Spec coverage: The plan covers explicit `-f`, preserving flag mode, all initial instructions, host-shell `HOSTRUN`, `--allow-hostrun` preflight, no implicit `Yurtfile`, conflict rejection, relative host path/base resolution, parser quoting, pinned `#` behavior for full-line comments versus ordinary argv/path text, atomic writes, source-location diagnostics, docs, CLI help, and focused tests.
- Boundary check: Parser and executor live in `image-build-file.ts`; `cli.ts` only routes arguments and delegates build-file execution. No new `YurtImageBuilder` methods are introduced.
- TDD check: Each implementation task starts with failing tests, then implementation, then focused verification.
- Placeholder scan: The plan contains no open-ended implementation placeholders. Commands, expected results, file paths, and code snippets are concrete.
- Type consistency: `ParsedYurtfile`, `YurtfileInstruction`, `ExecuteYurtfileBuildOptions`, and `ExecuteYurtfileBuildResult` are introduced once and reused consistently.
- Review follow-up: `--allow-hostrun` is explicitly rejected without `-f`, parser branches are specified as one attached `if` / `else if` chain, executor and CLI build-file paths use an explicit `NodeAdapter`, unknown escapes and literal non-leading `#` behavior are pinned, host signal termination gets a distinct diagnostic with exit code `1`, relative-FROM tests avoid `/tmp` symlink assumptions, and both `--help` and `-h` are covered.
- Deferred quality note: `writeOutputAtomically` intentionally preserves current CLI behavior for missing output directories: it reports a normal write failure instead of creating parent directories. `ParsedYurtfile.path` and `pathForDiagnostics` remain separate so a future CLI can preserve the user-supplied diagnostic path while using a normalized execution path; the first implementation sets them to the same value.
