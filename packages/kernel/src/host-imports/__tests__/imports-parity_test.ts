import { assert, assertArrayIncludes, assertEquals } from "@std/assert";
import { createKernelImports } from "../kernel-imports.ts";

const KERNEL_IMPORTS_BASELINE = [
  "host_pipe",
  "host_spawn",
  "host_mark_exec_child",
  "host_wait",
  "host_close_fd",
  "host_getpid",
  "host_getppid",
  "host_getuid",
  "host_geteuid",
  "host_getgid",
  "host_getegid",
  "host_setresuid",
  "host_setresgid",
  "host_umask",
  "host_getcwd",
  "host_realpath",
  "host_chdir",
  "host_fchdir",
  "host_getpriority",
  "host_setpriority",
  "host_sched_getscheduler",
  "host_sched_getparam",
  "host_sched_setscheduler",
  "host_sched_setparam",
  "host_sched_getaffinity",
  "host_sched_setaffinity",
  "host_getrlimit",
  "host_setrlimit",
  "host_kill",
  "host_read_fd",
  "host_write_fd",
  "host_dup",
  "host_dup_min",
  "host_dup2",
  "host_set_fd_descriptor_flags",
  "host_network_fetch",
  "host_socket_bind",
  "host_socket_connect",
  "host_socket_listen",
  "host_socket_accept",
  "host_socket_send",
  "host_socket_recv",
  "host_socket_sendmsg",
  "host_socket_recvmsg",
  "host_socket_addr",
  "host_socket_option",
  "host_socket_set_no_delay",
  "host_socket_close",
  "host_extension_invoke",
  "host_setjmp",
  "host_longjmp",
  "host_fork",
  "host_yield",
  "host_list_processes",
  "host_stat",
  "host_read_file",
  "host_write_file",
  "host_readdir",
  "host_mkdir",
  "host_remove",
  "host_chmod",
  "host_chown",
  "host_fchown",
  "host_glob",
  "host_rename",
  "host_symlink",
  "host_readlink",
  "host_register_tool",
  "host_has_tool",
  "host_time",
  "host_read_command",
  "host_write_result",
  // Process groups / sessions
  "host_getpgid",
  "host_setpgid",
  "host_getsid",
  "host_setsid",
  "host_killpg",
  // TTY
  "host_isatty",
  "host_tcgetpgrp",
  "host_tcsetpgrp",
  "host_tcgetattr",
  "host_tcsetattr",
  "host_winsize",
  // TTY controlling terminal
  "host_tiocsctty",
  // DNS
  "host_dns_resolve",
  "host_get_local_addr",
];

const ABI_IMPORT_METHODS = new Map<string, string | null>([
  ["host_pipe", "sys_pipe"],
  ["host_dup", "sys_dup"],
  ["host_spawn", "sys_spawn"],
  ["host_wait", "sys_wait"],
  ["host_read_fd", "sys_read"],
  ["host_write_fd", "sys_write"],
  ["host_socket_send", "sys_socket_send"],
  ["host_socket_recv", "sys_socket_recv"],
  ["host_socket_connect", "sys_socket_connect"],
  ["host_socket_bind", "sys_socket_bind"],
  ["host_socket_listen", "sys_socket_listen"],
  ["host_socket_accept", "sys_socket_accept"],
  ["host_socket_addr", "sys_socket_addr"],
  ["host_socket_option", "sys_socket_option"],
  ["host_socket_close", "sys_socket_close"],
  ["host_dns_resolve", null],
  ["host_network_fetch", "sys_fetch"],
  ["host_extension_invoke", "sys_extension_invoke"],
  ["host_socket_set_no_delay", "sys_socket_option"],
  ["host_idb_get", "sys_idb_get"],
  ["host_idb_put", "sys_idb_put"],
  ["host_idb_delete", "sys_idb_delete"],
  ["host_idb_list", "sys_idb_list"],
]);

function tableNames(source: string, prefix: string): string[] {
  return [...source.matchAll(new RegExp(`^\\[${prefix}\\.([^\\]]+)\\]`, "gm"))]
    .map((match) => match[1])
    .sort();
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

Deno.test("yurt ABI host imports have Rust method mapping or documented deferral", async () => {
  const abi = await Deno.readTextFile(
    new URL("../../../../../abi/contract/yurt_abi.toml", import.meta.url),
  );
  const methods = await Deno.readTextFile(
    new URL(
      "../../../../../abi/contract/yurt_abi_methods.toml",
      import.meta.url,
    ),
  );
  const matrix = await Deno.readTextFile(
    new URL(
      "../../../../../docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix.md",
      import.meta.url,
    ),
  );

  const abiImports = tableNames(abi, "import").filter((name) =>
    name.startsWith("host_")
  );
  assertEquals([...ABI_IMPORT_METHODS.keys()].sort(), abiImports);

  const methodNames = new Set(tableNames(methods, "method"));
  for (const [hostImport, method] of ABI_IMPORT_METHODS) {
    assert(
      matrix.includes(hostImport),
      `${hostImport} missing from Rust parity matrix`,
    );
    if (method === null) {
      assert(
        matrix.includes(hostImport) &&
          matrix.includes("intentionally deferred"),
        `${hostImport} needs an explicit intentionally deferred matrix row`,
      );
    } else {
      assert(methodNames.has(method), `${method} missing from methods TOML`);
    }
  }
});
