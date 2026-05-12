# Remove JSON From Host Syscall Boundaries

## Context

The current host syscall layer still uses JSON for several guest-to-kernel calls. That is inconsistent with the native syscall ABI direction in `2026-05-07-native-syscall-abi-design.md`: scalar and byte-stream syscalls should use direct arguments and spans, while structured calls should use compact native records decoded at the host boundary.

The goal of this work is to remove JSON as a host syscall transport. JSON may still appear inside application payloads when a plugin, HTTP endpoint, or user program chooses JSON as its own data format. The kernel ABI must not require JSON parsing or JSON response building to service host imports.

## Confirmed Scope

The PR must convert these live host imports away from JSON:

- `host_socket_connect`
- `host_socket_bind`
- `host_socket_listen`
- `host_socket_accept`
- `host_socket_addr`
- `host_socket_send`
- `host_socket_recv`
- `host_socket_option`
- `host_socket_close`
- `host_network_fetch`
- `host_extension_invoke`
- `host_read_fd`
- `host_list_processes`

`host_dns_resolve` already avoids JSON, but it returns raw address text while the ABI contract describes a native address record. This PR converts it to a native address record so DNS follows the same structured-output convention as socket address calls.

`host_extension_invoke` is not Python compatibility debt. It is the generic plugin invocation syscall for extensions that may call LLMs, databases, or other host capabilities. It stays, but its request and response transport must become native records.

## Non-Goals

- Do not remove JSON from ordinary application data, VFS manifests, package metadata, network bridge internals, or plugin-specific payloads.
- Do not remove `host_extension_invoke`.
- Do not add a general guest-side ABI codec framework. C shims can have small local builders/parsers for the records they use.
- Do not convert unrelated host imports just because they contain pointer/span arguments.

## ABI Design

### Direct Stream Syscalls

Stream calls use POSIX-style partial transfer semantics:

- `host_read_fd(fd, out_ptr, out_cap) -> i32`
- `host_write_fd(fd, data_ptr, data_len) -> i32`
- `host_socket_send(fd, data_ptr, data_len, flags) -> i32`
- `host_socket_recv(fd, out_ptr, out_cap, flags) -> i32`

Return values are bytes transferred, `0` for EOF on reads, or negative POSIX errno. These calls never use required-size retry responses and never wrap success or errors in JSON.

### Socket Metadata Syscalls

Socket metadata should be scalar where possible and fixed native structs where output is required:

- `host_socket_connect(fd, host_ptr, host_len, port, flags) -> i32`
- `host_socket_bind(fd, host_ptr, host_len, port) -> i32`
- `host_socket_listen(fd, backlog) -> i32`
- `host_socket_accept(fd, out_ptr, out_cap) -> i32`
- `host_socket_addr(fd, which, out_ptr, out_cap) -> i32`
- `host_socket_option(fd, option, has_value, value) -> i32`
- `host_socket_close(fd) -> i32`

`host_socket_accept` writes a fixed result containing the accepted fd and peer/local IPv4 address and port fields. `host_socket_addr` writes a fixed address result for either peer or local address, selected by `which`. Errors return negative errno directly.

### Native Variable Records

Calls with rich variable payloads use native records with an ABI header, offset/length string or byte spans, and count-prefixed vectors. The source of truth is `abi/contract/yurt_abi.toml`, regenerated into C, Rust, TS reference metadata, and Markdown before host implementation changes:

- `host_network_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32`
- `host_extension_invoke(req_ptr, req_len, out_ptr, out_cap) -> i32`
- `host_dns_resolve(host_ptr, host_len, out_ptr, out_cap) -> i32`
- `host_list_processes(out_ptr, out_cap) -> i32`

`host_network_fetch` request records include URL, method, headers, body bytes, and redirect mode. Responses include status, headers, body bytes, and an optional error string. There is no base64 field.

`host_extension_invoke` request records include extension name, argv vector, stdin bytes, cwd, environment vector, and optional opaque plugin payload bytes. Responses include exit code, stdout bytes, stderr bytes, and optional opaque plugin response bytes. The opaque bytes allow a plugin to carry JSON, protobuf, SQL, or any other application protocol without making JSON part of the syscall ABI.

`host_list_processes` writes a process snapshot record with fixed process entries plus offset/length string data for command names or metadata that cannot fit fixed fields.

## Implementation Shape

TypeScript host imports in `packages/kernel/src/host-imports/kernel-imports.ts` decode native records or direct spans at the boundary, perform the existing kernel/network/socket/extension operations, and write native outputs back to guest memory. Any async import must re-derive memory views after `await`.

The C guest shims in `abi/src/yurt_socket.c` and `abi/src/yurt_fetch.c` stop building JSON strings. Socket send/recv pass user buffers directly. Socket address helpers read fixed structs. Fetch and extension compatibility helpers use local native-record builders.

The Wasmtime host path must match the same signatures. Existing JSON fetch parsing in `packages/runtime-wasmtime/src/wasm/network.rs` changes to native request parsing and native response writing. Socket stubs change signatures so modules linked against the native ABI instantiate consistently.

The ABI contract and generated docs must be brought into alignment with the shipped runtime headers. `abi/contract/yurt_abi.toml`, `docs/abi/native-syscall-abi.md`, generated ABI references, and `abi/src/yurt_runtime.h` should describe the same signatures.

## Tests

Add focused unit tests for TS host imports that call the new signatures directly against WebAssembly memory. Existing socket, listen-policy, fetch, DNS, and process tests should be updated to assert native outputs instead of JSON objects.

Add C canary coverage through the existing socket and fetch canaries so the shipped guest shims prove they no longer depend on JSON or base64 at the host boundary.

Add grep canaries for the host boundary:

- no `writeJson` under `packages/kernel/src/host-imports`;
- no `JSON.parse(readString(...))` in host import implementations;
- no socket JSON builders/parsers in `abi/src/yurt_socket.c`;
- no fetch request/response JSON builders in `abi/src/yurt_fetch.c`;
- no `serde_json` in Wasmtime host fetch or process-list host import paths.
