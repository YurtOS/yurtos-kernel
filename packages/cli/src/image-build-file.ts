import { spawn } from "node:child_process";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { YurtImageBuilder } from "../../kernel/src/image-builder.js";
import type { PlatformAdapter } from "../../kernel/src/platform/adapter.js";
import { NodeAdapter } from "../../kernel/src/platform/node-adapter.js";

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

export async function executeYurtfileBuild(
  options: ExecuteYurtfileBuildOptions,
): Promise<ExecuteYurtfileBuildResult> {
  const stdout = options.stdout ??
    ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ??
    ((chunk: string) => process.stderr.write(chunk));
  let parsed: ParsedYurtfile;
  try {
    parsed = await parseYurtfile(options.file);
    const hostrun = parsed.instructions.find((instruction) =>
      instruction.kind === "hostrun"
    );
    if (hostrun && !options.allowHostrun) {
      stderr(
        `${parsed.pathForDiagnostics}:${hostrun.line}: HOSTRUN requires --allow-hostrun\n`,
      );
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
      const result = await executeInstruction(parsed, instruction, builder, {
        stdout,
        stderr,
      });
      if (result.exitCode !== 0) return result;
    }

    await writeOutputAtomically(
      options.outputPath,
      await builder.exportImage(),
    );
    return { exitCode: 0 };
  } catch (error) {
    const line = builder === undefined ? parsed.base.line : undefined;
    const prefix = builder === undefined && line !== undefined
      ? `${parsed.pathForDiagnostics}:${line}: FROM failed: `
      : "";
    stderr(
      `${prefix}${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { exitCode: 1 };
  } finally {
    builder?.destroy();
  }
}

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
    const rawInstruction = firstSpace === -1
      ? content
      : content.slice(0, firstSpace);
    const instruction = rawInstruction.trim().toUpperCase();
    const remainder = firstSpace === -1
      ? ""
      : content.slice(firstSpace).trimStart();

    if (instruction !== "FROM" && base === undefined) {
      throw yurtfileError(
        options.pathForDiagnostics,
        lineNumber,
        "first instruction must be FROM",
      );
    }

    if (instruction === "HOSTRUN") {
      if (remainder.trim() === "") {
        throw yurtfileError(
          options.pathForDiagnostics,
          lineNumber,
          "HOSTRUN requires a shell command",
        );
      }
      instructions.push({
        kind: "hostrun",
        line: lineNumber,
        command: remainder,
      });
      continue;
    }

    const tokens = tokenizeYurtfileLine(
      remainder,
      options.pathForDiagnostics,
      lineNumber,
    );

    if (instruction === "FROM") {
      if (base !== undefined) {
        throw yurtfileError(
          options.pathForDiagnostics,
          lineNumber,
          "duplicate FROM instruction",
        );
      }
      if (tokens.length !== 1) {
        throw yurtfileError(
          options.pathForDiagnostics,
          lineNumber,
          "FROM requires exactly one argument",
        );
      }
      base = tokens[0] === "empty" ? { kind: "empty", line: lineNumber } : {
        kind: "image",
        line: lineNumber,
        path: resolveHostPath(options.baseDir, tokens[0]),
      };
      continue;
    }

    if (instruction === "COPY") {
      requireArity(options.pathForDiagnostics, lineNumber, "COPY", tokens, 2);
      assertAbsoluteImagePath(
        options.pathForDiagnostics,
        lineNumber,
        "COPY",
        tokens[1],
      );
      instructions.push({
        kind: "copy",
        line: lineNumber,
        source: resolveHostPath(options.baseDir, tokens[0]),
        destination: tokens[1],
      });
    } else if (instruction === "CHMOD") {
      requireArity(options.pathForDiagnostics, lineNumber, "CHMOD", tokens, 2);
      assertAbsoluteImagePath(
        options.pathForDiagnostics,
        lineNumber,
        "CHMOD",
        tokens[1],
      );
      instructions.push({
        kind: "chmod",
        line: lineNumber,
        mode: parseMode(tokens[0], options.pathForDiagnostics, lineNumber),
        path: tokens[1],
      });
    } else if (instruction === "CHOWN") {
      requireArity(options.pathForDiagnostics, lineNumber, "CHOWN", tokens, 2);
      assertAbsoluteImagePath(
        options.pathForDiagnostics,
        lineNumber,
        "CHOWN",
        tokens[1],
      );
      const colon = tokens[0].indexOf(":");
      if (colon <= 0 || colon === tokens[0].length - 1) {
        throw yurtfileError(
          options.pathForDiagnostics,
          lineNumber,
          "invalid CHOWN owner; expected uid:gid",
        );
      }
      instructions.push({
        kind: "chown",
        line: lineNumber,
        uid: parseDecimal(
          tokens[0].slice(0, colon),
          "uid",
          options.pathForDiagnostics,
          lineNumber,
        ),
        gid: parseDecimal(
          tokens[0].slice(colon + 1),
          "gid",
          options.pathForDiagnostics,
          lineNumber,
        ),
        path: tokens[1],
      });
    } else if (instruction === "RM") {
      requireArity(options.pathForDiagnostics, lineNumber, "RM", tokens, 1);
      assertAbsoluteImagePath(
        options.pathForDiagnostics,
        lineNumber,
        "RM",
        tokens[0],
      );
      instructions.push({ kind: "rm", line: lineNumber, path: tokens[0] });
    } else if (instruction === "RUN") {
      if (tokens.length === 0) {
        throw yurtfileError(
          options.pathForDiagnostics,
          lineNumber,
          "RUN requires argv",
        );
      }
      instructions.push({ kind: "run", line: lineNumber, argv: tokens });
    } else {
      throw yurtfileError(
        options.pathForDiagnostics,
        lineNumber,
        `unknown instruction: ${instruction}`,
      );
    }
  }

  if (base === undefined) {
    throw yurtfileError(
      options.pathForDiagnostics,
      1,
      "first instruction must be FROM",
    );
  }

  return {
    path: options.path,
    pathForDiagnostics: options.pathForDiagnostics,
    base,
    instructions,
  };
}

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
        io.stderr(
          `${parsed.pathForDiagnostics}:${instruction.line}: COPY does not support directories yet; copy individual files\n`,
        );
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
        io.stderr(
          `${parsed.pathForDiagnostics}:${instruction.line}: RUN exited with status ${result.exitCode}: ${
            instruction.argv.join(" ")
          }\n`,
        );
      }
      return { exitCode: result.exitCode };
    }
    return await runHostCommand(parsed, instruction, io);
  } catch (error) {
    io.stderr(
      `${parsed.pathForDiagnostics}:${instruction.line}: ${
        instructionName(instruction)
      } failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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

    child.stdout?.on(
      "data",
      (chunk: Uint8Array) => io.stdout(new TextDecoder().decode(chunk)),
    );
    child.stderr?.on(
      "data",
      (chunk: Uint8Array) => io.stderr(new TextDecoder().decode(chunk)),
    );
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        // Use 1 for signal termination; do not encode shell-style 128+signal.
        io.stderr(
          `${parsed.pathForDiagnostics}:${instruction.line}: HOSTRUN terminated by signal ${signal}: ${instruction.command}\n`,
        );
        resolveResult({ exitCode: 1 });
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        io.stderr(
          `${parsed.pathForDiagnostics}:${instruction.line}: HOSTRUN exited with status ${exitCode}: ${instruction.command}\n`,
        );
      }
      resolveResult({ exitCode });
    });
  });
}

async function writeOutputAtomically(
  outputPath: string,
  bytes: Uint8Array,
): Promise<void> {
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
      `${instruction} requires exactly ${expected} argument${
        expected === 1 ? "" : "s"
      }`,
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
    throw yurtfileError(
      pathForDiagnostics,
      line,
      `${instruction} image path must be absolute`,
    );
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

function yurtfileError(
  pathForDiagnostics: string,
  line: number,
  message: string,
): Error {
  return new Error(`${pathForDiagnostics}:${line}: ${message}`);
}
