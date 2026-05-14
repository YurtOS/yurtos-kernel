#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export const OPEN_POSIX_URL =
  "https://github.com/bytecodealliance/open-posix-test-suite.git";

export const DEFAULT_CASES = [
  "pthread_self/1-1",
  "pthread_equal/1-1",
  "pthread_create/1-1",
];

export type PosixStatus =
  | "PASS"
  | "FAIL"
  | "UNRESOLVED"
  | "UNSUPPORTED"
  | "UNTESTED"
  | "UNKNOWN";

export interface OpenPosixCase {
  id: string;
  interfaceName: string;
  assertionName: string;
  sourcePath: string;
}

interface YurtCcArgsInput {
  repoRoot: string;
  sourceRoot: string;
  outputPath: string;
  testCase: OpenPosixCase;
}

interface CliOptions {
  sourceRoot: string;
  buildRoot: string;
  cases: string[];
  buildOnly: boolean;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function classifyExitCode(code: number): PosixStatus {
  switch (code) {
    case 0:
      return "PASS";
    case 1:
      return "FAIL";
    case 2:
      return "UNRESOLVED";
    case 4:
      return "UNSUPPORTED";
    case 5:
      return "UNTESTED";
    default:
      return "UNKNOWN";
  }
}

export async function resolveCases(
  sourceRoot: string,
  ids: string[],
): Promise<OpenPosixCase[]> {
  const root = resolve(sourceRoot);
  const cases: OpenPosixCase[] = [];
  for (const id of ids) {
    const parts = id.split("/");
    if (
      parts.length !== 2 ||
      parts.some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new Error(`case id must be interface/name, got ${id}`);
    }
    const [interfaceName, assertionName] = parts;
    const sourcePath = resolve(
      root,
      "conformance",
      "interfaces",
      interfaceName,
      `${assertionName}.c`,
    );
    const rel = relative(root, sourcePath);
    if (
      rel.startsWith("..") || rel === "" ||
      normalize(rel).startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`)
    ) {
      throw new Error(`case escapes source root: ${id}`);
    }
    try {
      const info = await Deno.stat(sourcePath);
      if (!info.isFile) throw new Error("not a regular file");
    } catch (error) {
      throw new Error(
        `missing Open POSIX case ${id} at ${sourcePath}: ${error}`,
      );
    }
    cases.push({ id, interfaceName, assertionName, sourcePath });
  }
  return cases;
}

export function outputPathForCase(
  buildRoot: string,
  testCase: OpenPosixCase,
): string {
  return resolve(
    buildRoot,
    testCase.interfaceName,
    `${testCase.assertionName}.wasm`,
  );
}

export function yurtCcArgsForCase(input: YurtCcArgsInput): string[] {
  return [
    resolve(input.repoRoot, "target/release/yurt-cc"),
    "-std=gnu99",
    "-I",
    resolve(input.sourceRoot, "include"),
    input.testCase.sourcePath,
    "-o",
    input.outputPath,
  ];
}

function parseArgs(args: string[]): CliOptions {
  let sourceRoot = Deno.env.get("OPEN_POSIX_SOURCE") ??
    resolve(repoRoot, "test-fixtures/open-posix-test-suite");
  let buildRoot = Deno.env.get("OPEN_POSIX_BUILD") ??
    resolve(repoRoot, "test-fixtures/open-posix-build");
  let cases = [...DEFAULT_CASES];
  let buildOnly = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--source") {
      sourceRoot = args[++i] ?? "";
    } else if (arg === "--build-root") {
      buildRoot = args[++i] ?? "";
    } else if (arg === "--cases") {
      cases = (args[++i] ?? "").split(",").filter(Boolean);
    } else if (arg === "--case") {
      cases = [args[++i] ?? ""];
    } else if (arg === "--build-only") {
      buildOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      Deno.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!sourceRoot) throw new Error("--source requires a path");
  if (!buildRoot) throw new Error("--build-root requires a path");
  if (cases.length === 0) throw new Error("at least one case is required");
  return {
    sourceRoot: resolve(sourceRoot),
    buildRoot: resolve(buildRoot),
    cases,
    buildOnly,
  };
}

function printUsage(): void {
  console.log(`Usage: deno run -A scripts/open-posix-harness.ts [options]

Options:
  --source <path>      Open POSIX Test Suite checkout. Defaults to test-fixtures/open-posix-test-suite.
  --build-root <path>  Generated wasm output dir. Defaults to test-fixtures/open-posix-build.
  --cases <a,b,c>      Comma-separated interface/assertion ids.
  --case <id>          Run one interface/assertion id.
  --build-only         Compile selected cases but do not execute them.
`);
}

async function runCommand(
  command: string,
  args: string[],
  options: Deno.CommandOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Deno.Command(command, {
    ...options,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

async function ensureSource(sourceRoot: string): Promise<void> {
  if (existsSync(join(sourceRoot, "include/posixtest.h"))) return;
  await Deno.mkdir(dirname(sourceRoot), { recursive: true });
  const clone = await runCommand("git", [
    "clone",
    "--depth",
    "1",
    OPEN_POSIX_URL,
    sourceRoot,
  ], {
    cwd: repoRoot,
  });
  if (clone.code !== 0) {
    throw new Error(
      `failed to clone ${OPEN_POSIX_URL}\n${clone.stderr}${clone.stdout}`,
    );
  }
}

async function buildCase(
  options: CliOptions,
  testCase: OpenPosixCase,
): Promise<string> {
  const outputPath = outputPathForCase(options.buildRoot, testCase);
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  const args = yurtCcArgsForCase({
    repoRoot,
    sourceRoot: options.sourceRoot,
    outputPath,
    testCase,
  });
  const [command, ...commandArgs] = args;
  const result = await runCommand(command, commandArgs, {
    cwd: repoRoot,
    env: {
      YURT_CC_ARCHIVE: resolve(repoRoot, "abi/build/libyurt_abi.a"),
    },
  });
  if (result.code !== 0) {
    throw new Error(
      `compile failed for ${testCase.id} with exit ${result.code}\n${result.stderr}${result.stdout}`,
    );
  }
  return outputPath;
}

async function runCase(
  testCase: OpenPosixCase,
  wasmPath: string,
): Promise<PosixStatus> {
  const result = await runCommand(
    Deno.execPath(),
    [
      "run",
      "-A",
      "scripts/run-wasm-test-in-sandbox.ts",
      wasmPath,
    ],
    { cwd: repoRoot },
  );
  if (result.stdout) console.log(result.stdout.trimEnd());
  if (result.stderr) console.error(result.stderr.trimEnd());
  const status = classifyExitCode(result.code);
  console.log(`[open-posix] ${testCase.id}: ${status}`);
  return status;
}

export async function main(args = Deno.args): Promise<number> {
  const options = parseArgs(args);
  await ensureSource(options.sourceRoot);
  const cases = await resolveCases(options.sourceRoot, options.cases);
  const results: Array<{ id: string; status: PosixStatus }> = [];

  for (const testCase of cases) {
    const wasmPath = await buildCase(options, testCase);
    if (options.buildOnly) {
      console.log(`[open-posix] ${testCase.id}: BUILT ${wasmPath}`);
      continue;
    }
    results.push({
      id: testCase.id,
      status: await runCase(testCase, wasmPath),
    });
  }

  if (options.buildOnly) return 0;

  const failing = results.filter((result) => result.status !== "PASS");
  console.log(
    `[open-posix] summary: ${
      results.length - failing.length
    } passed, ${failing.length} non-pass`,
  );
  return failing.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
