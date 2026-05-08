import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
