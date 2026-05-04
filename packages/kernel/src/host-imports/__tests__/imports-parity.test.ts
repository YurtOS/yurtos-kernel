import { assertArrayIncludes, assertEquals } from "jsr:@std/assert@^1.0.19";
import { createKernelImports } from "../kernel-imports.ts";
import { createShellImports } from "../shell-imports.ts";

const KERNEL_IMPORTS_BASELINE = [
  "host_pipe",
  "host_spawn",
  "host_waitpid",
  "host_waitpid_nohang",
  "host_close_fd",
  "host_getpid",
  "host_getppid",
  "host_kill",
  "host_list_processes",
  "host_read_fd",
  "host_write_fd",
  "host_dup",
  "host_dup2",
  "host_network_fetch",
  "host_socket_connect",
  "host_socket_bind",
  "host_socket_listen",
  "host_socket_accept",
  "host_socket_send",
  "host_socket_recv",
  "host_socket_addr",
  "host_socket_option",
  "host_socket_close",
  "host_extension_invoke",
  "host_native_invoke",
  "host_setjmp",
  "host_longjmp",
  "host_yield",
  "host_run_command",
];

const SHELL_IMPORTS_BASELINE = [
  "host_stat",
  "host_read_file",
  "host_write_file",
  "host_readdir",
  "host_mkdir",
  "host_remove",
  "host_chmod",
  "host_glob",
  "host_rename",
  "host_symlink",
  "host_readlink",
  "host_register_tool",
  "host_has_tool",
  "host_time",
  "host_read_command",
  "host_write_result",
];

function shellImports() {
  return createShellImports({
    memory: new WebAssembly.Memory({ initial: 1 }),
  });
}

Deno.test("kernel-imports baseline export names", () => {
  const imports = createKernelImports({
    memory: new WebAssembly.Memory({ initial: 1 }),
  });
  const names = Object.keys(imports);

  for (const expected of KERNEL_IMPORTS_BASELINE) {
    assertArrayIncludes(names, [expected]);
  }
});

Deno.test("shell-imports baseline names", () => {
  const names = Object.keys(shellImports());

  for (const expected of SHELL_IMPORTS_BASELINE) {
    assertArrayIncludes(names, [expected]);
  }
});

Deno.test("shell-imports and kernel-imports do not overlap", () => {
  const kernelNames = new Set(
    Object.keys(
      createKernelImports({ memory: new WebAssembly.Memory({ initial: 1 }) }),
    ),
  );
  const overlapping = Object.keys(shellImports()).filter((name) =>
    kernelNames.has(name)
  );

  assertEquals(overlapping, []);
});
