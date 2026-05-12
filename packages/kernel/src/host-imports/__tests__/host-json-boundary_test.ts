import { assertEquals } from "jsr:@std/assert@^1.0.19";

const scopedImports = [
  "host_read_fd",
  "host_list_processes",
  "host_network_fetch",
  "host_dns_resolve",
  "host_socket_connect",
  "host_socket_bind",
  "host_socket_listen",
  "host_socket_accept",
  "host_socket_addr",
  "host_socket_send",
  "host_socket_recv",
  "host_socket_option",
  "host_socket_close",
  "host_extension_invoke",
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
