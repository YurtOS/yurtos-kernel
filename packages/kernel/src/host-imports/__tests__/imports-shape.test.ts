import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { createKernelImports } from "../kernel-imports.ts";
import { readString } from "../common.ts";

const encoder = new TextEncoder();

function writeString(memory: WebAssembly.Memory, ptr: number, value: string) {
  const bytes = encoder.encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function readJson(memory: WebAssembly.Memory, ptr: number, len: number) {
  return JSON.parse(readString(memory, ptr, len)) as Record<string, unknown>;
}

Deno.test("kernel host_spawn preserves shell's legacy synchronous result ABI", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const request = JSON.stringify({
    program: "echo",
    args: ["hello"],
    env: [["A", "B"]],
    cwd: "/tmp",
    stdin: "input",
  });
  const reqLen = writeString(memory, 0, request);

  const imports = createKernelImports({
    memory,
    syncSpawn: (cmd, args, env, stdin, cwd) => {
      assertEquals(cmd, "echo");
      assertEquals(args, ["hello"]);
      assertEquals(env, { A: "B" });
      assertEquals(new TextDecoder().decode(stdin), "input");
      assertEquals(cwd, "/tmp");
      return { exit_code: 0, stdout: "hello\n", stderr: "" };
    },
  });

  const written = (imports.host_spawn as (...args: number[]) => number)(
    0,
    reqLen,
    4096,
    1024,
  );

  assertEquals(readJson(memory, 4096, written), {
    exit_code: 0,
    stdout: "hello\n",
    stderr: "",
  });
});
