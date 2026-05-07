import { dirname, join } from "path";

type AbiField = {
  name: string;
  type: string;
  doc?: string;
};

type AbiConstant = {
  name: string;
  type: string;
  value: number | string;
  doc?: string;
};

type AbiErrno = {
  name: string;
  value: number;
  doc?: string;
};

type AbiReturn = {
  name: string;
  doc?: string;
};

type AbiStruct = {
  name: string;
  doc?: string;
  fields: AbiField[];
};

type AbiImport = {
  name: string;
  doc?: string;
  return: string;
  args: AbiField[];
};

type AbiFunction = {
  name: string;
  doc?: string;
  return: string;
  args: AbiField[];
};

export type AbiContract = {
  constants: AbiConstant[];
  errno: AbiErrno[];
  returns: AbiReturn[];
  structs: AbiStruct[];
  imports: AbiImport[];
  functions: AbiFunction[];
};

export type RenderedContract = {
  cHeader: string;
  rust: string;
  typescript: string;
  markdown: string;
};

type Section =
  | { kind: "constant"; name: string; values: Record<string, unknown> }
  | { kind: "errno"; name: string; values: Record<string, unknown> }
  | { kind: "return"; name: string; values: Record<string, unknown> }
  | { kind: "struct"; name: string; values: Record<string, unknown> }
  | { kind: "import"; name: string; values: Record<string, unknown> }
  | { kind: "function"; name: string; values: Record<string, unknown> };

export async function loadContract(path: string): Promise<AbiContract> {
  return parseContract(await Deno.readTextFile(path));
}

function parseContract(source: string): AbiContract {
  const sections: Section[] = [];
  let current: Section | undefined;
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const header = line.match(/^\[([a-z_]+)\.([A-Za-z0-9_]+)\]$/);
    if (header) {
      current = {
        kind: header[1] as Section["kind"],
        name: header[2],
        values: {},
      } as Section;
      sections.push(current);
      continue;
    }

    if (!current) {
      throw new Error(`assignment outside section at line ${i + 1}`);
    }

    const assignment = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!assignment) {
      throw new Error(`invalid assignment at line ${i + 1}: ${line}`);
    }

    const key = assignment[1];
    let value = assignment[2].trim();
    if (value === "[") {
      const block: string[] = [];
      while (++i < lines.length) {
        const blockLine = lines[i].trim();
        if (blockLine === "]") {
          break;
        }
        if (blockLine !== "") {
          block.push(blockLine.replace(/,$/, ""));
        }
      }
      current.values[key] = block.map(parseInlineTable);
    } else {
      current.values[key] = parseValue(value);
    }
  }

  return {
    constants: sections
      .filter((s): s is Extract<Section, { kind: "constant" }> =>
        s.kind === "constant"
      )
      .map((s) => ({
        name: s.name,
        type: stringValue(s.values.type, `${s.name}.type`),
        value: constantValue(s.values.value, `${s.name}.value`),
        doc: optionalString(s.values.doc),
      })),
    errno: sections
      .filter((s): s is Extract<Section, { kind: "errno" }> =>
        s.kind === "errno"
      )
      .map((s) => ({
        name: s.name,
        value: numberValue(s.values.value, `${s.name}.value`),
        doc: optionalString(s.values.doc),
      })),
    returns: sections
      .filter((s): s is Extract<Section, { kind: "return" }> =>
        s.kind === "return"
      )
      .map((s) => ({ name: s.name, doc: optionalString(s.values.doc) })),
    structs: sections
      .filter((s): s is Extract<Section, { kind: "struct" }> =>
        s.kind === "struct"
      )
      .map((s) => ({
        name: s.name,
        doc: optionalString(s.values.doc),
        fields: fieldArray(s.values.fields, `${s.name}.fields`),
      })),
    imports: sections
      .filter((s): s is Extract<Section, { kind: "import" }> =>
        s.kind === "import"
      )
      .map((s) => ({
        name: s.name,
        doc: optionalString(s.values.doc),
        return: stringValue(s.values.return, `${s.name}.return`),
        args: fieldArray(s.values.args, `${s.name}.args`),
      })),
    functions: sections
      .filter((s): s is Extract<Section, { kind: "function" }> =>
        s.kind === "function"
      )
      .map((s) => ({
        name: s.name,
        doc: optionalString(s.values.doc),
        return: stringValue(s.values.return, `${s.name}.return`),
        args: fieldArray(s.values.args, `${s.name}.args`),
      })),
  };
}

function parseInlineTable(source: string): Record<string, unknown> {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error(`expected inline table: ${source}`);
  }
  const entries = splitTopLevel(trimmed.slice(1, -1), ",");
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    const [key, raw] = splitOnce(entry, "=");
    out[key.trim()] = parseValue(raw.trim());
  }
  return out;
}

function splitTopLevel(source: string, delimiter: string): string[] {
  const parts: string[] = [];
  let quote = false;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' && source[i - 1] !== "\\") {
      quote = !quote;
    }
    if (!quote && ch === delimiter) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function splitOnce(source: string, delimiter: string): [string, string] {
  const index = source.indexOf(delimiter);
  if (index === -1) {
    throw new Error(`missing delimiter ${delimiter}: ${source}`);
  }
  return [source.slice(0, index), source.slice(index + 1)];
}

function parseValue(source: string): unknown {
  if (source.startsWith('"') && source.endsWith('"')) {
    return source.slice(1, -1);
  }
  if (/^-?\d+$/.test(source)) {
    return Number(source);
  }
  throw new Error(`unsupported value: ${source}`);
}

function fieldArray(value: unknown, name: string): AbiField[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an inline table array`);
  }
  return value.map((field, index) => {
    if (!field || typeof field !== "object") {
      throw new Error(`${name}[${index}] must be an inline table`);
    }
    const values = field as Record<string, unknown>;
    return {
      name: stringValue(values.name, `${name}[${index}].name`),
      type: stringValue(values.type, `${name}[${index}].type`),
      doc: optionalString(values.doc),
    };
  });
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function constantValue(value: unknown, name: string): number | string {
  if (typeof value === "string") {
    return value;
  }
  return numberValue(value, name);
}

export function renderContract(contract: AbiContract): RenderedContract {
  return {
    cHeader: renderCHeader(contract),
    rust: renderRust(contract),
    typescript: renderTypeScript(contract),
    markdown: renderMarkdown(contract),
  };
}

function renderCHeader(contract: AbiContract): string {
  const out: string[] = [
    "/* @generated by scripts/generate-native-abi.ts. Do not edit by hand. */",
    "#ifndef YURT_ABI_H",
    "#define YURT_ABI_H",
    "",
    "#include <stdint.h>",
    "#include <stdio.h>",
    "",
  ];

  for (const constant of contract.constants) {
    pushCComment(out, constant.doc);
    out.push(`#define ${constant.name} ${cConstantValue(constant)}`);
    out.push("");
  }

  for (const item of contract.errno) {
    pushCComment(out, item.doc);
    out.push(`#define YURT_ERRNO_${item.name} ${item.value}`);
    out.push("");
  }

  out.push("extern uint32_t yurt_abi_version;");
  out.push("");

  for (const item of contract.structs) {
    pushCComment(out, item.doc);
    out.push(`typedef struct ${item.name} {`);
    for (const field of item.fields) {
      out.push(`  ${cType(field.type)} ${field.name};`);
    }
    out.push(`} ${item.name};`);
    out.push("");
  }

  for (const item of contract.imports) {
    pushCComment(out, item.doc);
    out.push(
      `__attribute__((import_module("yurt"), import_name("${item.name}")))`,
    );
    out.push(
      `int yurt_${item.name}(${
        item.args.map((arg) => `${cType(arg.type)} ${arg.name}`).join(", ")
      });`,
    );
    out.push("");
  }

  for (const item of contract.functions) {
    pushCComment(out, item.doc);
    out.push(
      `${item.return} ${item.name}(${
        item.args.map((arg) => `${arg.type} ${arg.name}`).join(", ")
      });`,
    );
    out.push("");
  }

  out.push("#endif");
  return `${out.join("\n").trimEnd()}\n`;
}

function cConstantValue(constant: AbiConstant): string {
  if (typeof constant.value === "string") {
    return `"${constant.value}"`;
  }
  return constant.type.startsWith("u")
    ? `${constant.value}u`
    : String(constant.value);
}

function pushCComment(out: string[], doc: string | undefined): void {
  if (doc) {
    out.push(`/* ${doc} */`);
  }
}

function renderRust(contract: AbiContract): string {
  const out: string[] = [
    "// @generated by scripts/generate-native-abi.ts. Do not edit by hand.",
    "",
  ];

  for (const constant of contract.constants) {
    pushRustDoc(out, constant.doc);
    out.push(
      `pub const ${constant.name}: ${rustType(constant.type)} = ${
        rustValue(constant.value)
      };`,
    );
    out.push("");
  }

  for (const item of contract.errno) {
    pushRustDoc(out, item.doc);
    out.push(`pub const ${item.name}: i32 = ${item.value};`);
    out.push("");
  }

  for (const item of contract.structs) {
    pushRustDoc(out, item.doc);
    out.push("#[repr(C)]");
    out.push("#[derive(Debug, Clone, Copy, PartialEq, Eq)]");
    out.push(`pub struct ${pascalCase(item.name)} {`);
    for (const field of item.fields) {
      pushRustDoc(out, field.doc, "    ");
      out.push(`    pub ${field.name}: ${rustType(field.type)},`);
    }
    out.push("}");
    out.push("");
  }

  return `${out.join("\n").trimEnd()}\n`;
}

function pushRustDoc(
  out: string[],
  doc: string | undefined,
  indent = "",
): void {
  if (doc) {
    out.push(`${indent}/// ${doc}`);
  }
}

function renderTypeScript(contract: AbiContract): string {
  const imports = contract.imports.map((item) => ({
    name: item.name,
    return: item.return,
    doc: item.doc ?? "",
    args: item.args.map((arg) => ({
      name: arg.name,
      type: arg.type,
      doc: arg.doc ?? "",
    })),
  }));
  const out = [
    "// @generated by scripts/generate-native-abi.ts. Do not edit by hand.",
    "",
    `export const YURT_ABI_CONSTANTS = ${
      jsonObject(
        Object.fromEntries(
          contract.constants.map((item) => [item.name, item.value]),
        ),
      )
    } as const;`,
    "",
    `export const YURT_ABI_ERRNO = ${
      jsonObject(
        Object.fromEntries(
          contract.errno.map((item) => [item.name, item.value]),
        ),
      )
    } as const;`,
    "",
    `export const YURT_ABI_IMPORTS = ${jsonObject(imports)} as const;`,
    "",
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

function renderMarkdown(contract: AbiContract): string {
  const out: string[] = [
    "<!-- @generated by scripts/generate-native-abi.ts. Do not edit by hand. -->",
    "# Native Syscall ABI",
    "",
    "This document is generated from `abi/contract/yurt_abi.toml`.",
    "",
    "## Return Conventions",
    "",
  ];

  for (const item of contract.returns) {
    out.push(`- \`${item.name}\`: ${item.doc ?? ""}`);
  }

  out.push("", "## Constants", "");
  for (const item of contract.constants) {
    out.push(`- \`${item.name}\` = \`${item.value}\`: ${item.doc ?? ""}`);
  }

  out.push("", "## Errno", "");
  for (const item of contract.errno) {
    out.push(`- \`${item.name}\` = \`${item.value}\`: ${item.doc ?? ""}`);
  }

  out.push("", "## Structs", "");
  for (const item of contract.structs) {
    out.push(`### \`${item.name}\``, "");
    if (item.doc) out.push(item.doc, "");
    out.push("| Field | Type | Description |", "| --- | --- | --- |");
    for (const field of item.fields) {
      out.push(
        `| \`${field.name}\` | \`${field.type}\` | ${field.doc ?? ""} |`,
      );
    }
    out.push("");
  }

  out.push("## Imports", "");
  for (const item of contract.imports) {
    out.push(`### \`${item.name}\``, "");
    if (item.doc) out.push(item.doc, "");
    out.push(`Return convention: \`${item.return}\``, "");
    out.push("| Argument | Type | Description |", "| --- | --- | --- |");
    for (const arg of item.args) {
      out.push(`| \`${arg.name}\` | \`${arg.type}\` | ${arg.doc ?? ""} |`);
    }
    out.push("");
  }

  out.push("## C Compatibility Functions", "");
  for (const item of contract.functions) {
    out.push(
      `- \`${item.return} ${item.name}(${
        item.args.map((arg) => `${arg.type} ${arg.name}`).join(", ")
      })\`: ${item.doc ?? ""}`,
    );
  }

  return `${out.join("\n").trimEnd()}\n`;
}

function jsonObject(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function cType(type: string): string {
  switch (type) {
    case "u32":
      return "uint32_t";
    case "u16":
      return "uint16_t";
    case "i32":
    case "fd":
    case "pid":
    case "ptr":
    case "usize":
      return "int";
    default:
      throw new Error(`unsupported C type: ${type}`);
  }
}

function rustType(type: string): string {
  switch (type) {
    case "str":
      return "&str";
    case "u32":
      return "u32";
    case "u16":
      return "u16";
    case "i32":
    case "fd":
    case "pid":
    case "ptr":
    case "usize":
      return "i32";
    default:
      throw new Error(`unsupported Rust type: ${type}`);
  }
}

function rustValue(value: number | string): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function pascalCase(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

export async function writeGeneratedFiles(
  root: string,
  rendered: RenderedContract,
  options: { check: boolean },
): Promise<{ ok: boolean; changed: string[] }> {
  const files = [
    ["abi/include/yurt_abi.h", rendered.cHeader],
    [
      "packages/runtime-wasmtime/src/wasm/native_abi_generated.rs",
      rendered.rust,
    ],
    [
      "packages/kernel/src/host-imports/native-generated.ts",
      rendered.typescript,
    ],
    ["docs/abi/native-syscall-abi.md", rendered.markdown],
  ] as const;

  const changed: string[] = [];
  for (const [relative, content] of files) {
    const path = join(root, relative);
    let current: string | undefined;
    try {
      current = await Deno.readTextFile(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    if (current === content) {
      continue;
    }
    changed.push(relative);
    if (!options.check) {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
  }

  return { ok: changed.length === 0, changed };
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const root = Deno.cwd();
  const contract = await loadContract(join(root, "abi/contract/yurt_abi.toml"));
  const result = await writeGeneratedFiles(root, renderContract(contract), {
    check,
  });
  if (check && !result.ok) {
    console.error(
      `native ABI generated files are stale:\n${
        result.changed.map((path) => `  ${path}`).join("\n")
      }`,
    );
    Deno.exit(1);
  }
}
