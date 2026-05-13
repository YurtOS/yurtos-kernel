import { assertEquals } from "jsr:@std/assert@^1.0.19";

const scopedImports = [
  "host_read_fd",
  "host_network_fetch",
  "host_dns_resolve",
  "host_socket_connect",
  "host_socket_listen",
  "host_socket_accept",
  "host_socket_addr",
  "host_socket_send",
  "host_socket_recv",
  "host_socket_close",
  "host_extension_invoke",
  "host_stat",
  "host_readdir",
  "host_glob",
];

function extractImportBody(source: string, name: string): string {
  const start = source.indexOf(`${name}(`);
  if (start < 0) throw new Error(`missing import ${name}`);
  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return source.slice(bodyStart, i + 1);
  }
  throw new Error(`unterminated body for ${name}`);
}

Deno.test("scoped host imports do not use JSON as their syscall transport", async () => {
  const source = await Deno.readTextFile(
    new URL("../kernel-imports.ts", import.meta.url),
  );
  const offenders = scopedImports.filter((name) =>
    /\bJSON\.parse\b|\bwriteJson\b/.test(extractImportBody(source, name))
  );

  assertEquals(offenders, []);
});

Deno.test("production host-import helpers do not expose JSON transport utilities", async () => {
  const files = [
    new URL("../common.ts", import.meta.url),
    new URL("../kernel-imports.ts", import.meta.url),
  ];
  const offenders: string[] = [];
  const jsonTransport = /\bwriteJson\b|\bJSON\.parse\b|\bJSON\.stringify\b/;
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    if (jsonTransport.test(source)) {
      offenders.push(file.pathname);
    }
  }

  assertEquals(offenders, []);
});

Deno.test("fetch ABI exposes the native host primitive without JSON helper aliases", async () => {
  const files = [
    new URL("../../../../../abi/contract/yurt_abi.toml", import.meta.url),
    new URL("../../../../../docs/abi/generated/yurt_abi.h", import.meta.url),
    new URL("../../../../../docs/abi/native-syscall-abi.md", import.meta.url),
    new URL("../../../../../abi/include/yurt_abi.h", import.meta.url),
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    if (source.includes("yurt_fetch_text") || source.includes("headers_json")) {
      offenders.push(file.pathname);
    }
  }

  assertEquals(offenders, []);
});
