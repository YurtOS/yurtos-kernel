# Remove Host JSON Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove JSON as a transport format from host syscall imports while preserving plugin invocation as a native extension ABI.

**Architecture:** Convert byte-moving syscalls to direct pointer/span imports, convert socket metadata to scalars and fixed structs, and convert rich payload syscalls to native variable records generated from `abi/contract/yurt_abi.toml`. TypeScript and Wasmtime host imports decode at the host boundary; C guest shims use small local builders/parsers only for records they call.

**Tech Stack:** Rust, C ABI shims, TypeScript on Deno, WebAssembly host imports, existing native ABI generator.

---

## File Structure

- Modify `abi/contract/yurt_abi.toml`: add native socket metadata imports and fixed/record structs for socket, DNS, fetch, extension, and process-list results.
- Modify `scripts/generate-native-abi.ts`: generate new constants/structs if the current generator does not cover the new record declarations.
- Regenerate `docs/abi/generated/yurt_abi.h`, `docs/abi/generated/native_abi_generated.rs`, `docs/abi/generated/native-generated.ts`, and `docs/abi/native-syscall-abi.md`.
- Modify `abi/src/yurt_runtime.h`: install shipped native import signatures.
- Modify `abi/src/yurt_socket.c`: remove socket JSON and base64 host transport.
- Modify `abi/src/yurt_fetch.c`: replace fetch JSON request/response with native fetch records.
- Modify `abi/src/yurt_netdb.c`: consume native DNS address records.
- Modify `packages/kernel/src/host-imports/common.ts`: delete `writeJson`; add fixed-struct and native-record memory helpers.
- Modify `packages/kernel/src/host-imports/kernel-imports.ts`: implement native host import signatures and response writers.
- Modify `packages/kernel/src/host-imports/__tests__/socket-fds_test.ts`, `socket-listen-policy_test.ts`, `network-fetch-import_test.ts`, and `imports-shape_test.ts`: test native signatures and memory layouts.
- Modify `packages/runtime-wasmtime/src/wasm/network.rs` and `packages/runtime-wasmtime/src/wasm/mod.rs`: decode native fetch requests, write native responses, and match native socket signatures.
- Add `packages/kernel/src/host-imports/__tests__/host-json-boundary_test.ts`: grep canaries for host-boundary JSON regressions.

---

### Task 1: Contract And Native Layouts

**Files:**
- Modify: `abi/contract/yurt_abi.toml`
- Modify: `scripts/generate-native-abi.ts`
- Modify generated: `docs/abi/generated/yurt_abi.h`
- Modify generated: `docs/abi/generated/native_abi_generated.rs`
- Modify generated: `docs/abi/generated/native-generated.ts`
- Modify generated: `docs/abi/native-syscall-abi.md`

- [ ] **Step 1: Write the contract drift test expectation**

Run the generator before edits to establish the current drift surface:

```bash
/Users/sunny/.deno/bin/deno run --allow-read --allow-write scripts/generate-native-abi.ts
git diff -- docs/abi/generated/yurt_abi.h docs/abi/generated/native_abi_generated.rs docs/abi/generated/native-generated.ts docs/abi/native-syscall-abi.md
```

Expected before implementation: no diff, or only pre-existing formatting drift. If there is pre-existing drift, stop and commit the drift separately before continuing.

- [ ] **Step 2: Add socket fixed structs and imports**

Extend `abi/contract/yurt_abi.toml` with fixed structs equivalent to:

```toml
[constant.YURT_SOCKET_ADDR_LOCAL]
type = "u32"
value = 0
doc = "Select local socket address."

[constant.YURT_SOCKET_ADDR_PEER]
type = "u32"
value = 1
doc = "Select peer socket address."

[constant.YURT_SOCKET_OPT_TCP_NODELAY]
type = "u32"
value = 1
doc = "TCP_NODELAY socket option."

[constant.YURT_SOCKET_FLAG_TLS]
type = "u32"
value = 1
doc = "Connect using TLS."

[constant.YURT_MSG_PEEK]
type = "u32"
value = 2
doc = "Socket recv peek flag."

[struct.yurt_socket_addr_result_v1]
doc = "Fixed IPv4 socket address result."
fields = [
  { name = "host_be", type = "u32", doc = "IPv4 address in network byte order." },
  { name = "port_be", type = "u16", doc = "Port in network byte order." },
  { name = "reserved", type = "u16", doc = "Reserved; must be zero." },
]

[struct.yurt_socket_accept_result_v1]
doc = "Fixed accept result."
fields = [
  { name = "fd", type = "i32", doc = "Accepted socket fd." },
  { name = "peer_host_be", type = "u32", doc = "Peer IPv4 address in network byte order." },
  { name = "peer_port_be", type = "u16", doc = "Peer port in network byte order." },
  { name = "local_port_be", type = "u16", doc = "Local port in network byte order." },
  { name = "local_host_be", type = "u32", doc = "Local IPv4 address in network byte order." },
]

[import.host_socket_connect]
doc = "Connect a socket fd to host:port. Flags may include YURT_SOCKET_FLAG_TLS."
return = "scalar_errno"
args = [
  { name = "fd", type = "fd" },
  { name = "host_ptr", type = "ptr" },
  { name = "host_len", type = "usize" },
  { name = "port", type = "u32" },
  { name = "flags", type = "u32" },
]

[import.host_socket_bind]
doc = "Bind a socket fd to host:port."
return = "scalar_errno"
args = [
  { name = "fd", type = "fd" },
  { name = "host_ptr", type = "ptr" },
  { name = "host_len", type = "usize" },
  { name = "port", type = "u32" },
]

[import.host_socket_listen]
doc = "Listen on a bound socket fd."
return = "scalar_errno"
args = [
  { name = "fd", type = "fd" },
  { name = "backlog", type = "i32" },
]

[import.host_socket_accept]
doc = "Accept a connection and write yurt_socket_accept_result_v1."
return = "fixed_out"
args = [
  { name = "fd", type = "fd" },
  { name = "out_ptr", type = "ptr" },
  { name = "out_cap", type = "usize" },
]

[import.host_socket_addr]
doc = "Write yurt_socket_addr_result_v1 for local or peer address."
return = "fixed_out"
args = [
  { name = "fd", type = "fd" },
  { name = "which", type = "u32" },
  { name = "out_ptr", type = "ptr" },
  { name = "out_cap", type = "usize" },
]

[import.host_socket_option]
doc = "Set or get a scalar socket option."
return = "scalar_errno"
args = [
  { name = "fd", type = "fd" },
  { name = "option", type = "u32" },
  { name = "has_value", type = "u32" },
  { name = "value", type = "i32" },
]

[import.host_socket_close]
doc = "Close a socket fd."
return = "scalar_errno"
args = [
  { name = "fd", type = "fd" },
]
```

- [ ] **Step 3: Add native record declarations for fetch, DNS, extension, process list**

Add record structs to the contract with these semantic fields:

```text
yurt_dns_addr_result_v1:
  header, family, addr_be, reserved

yurt_fetch_request_v1:
  header, url_off/url_len, method_off/method_len, headers_off/headers_count,
  body_off/body_len, redirect_mode

yurt_fetch_response_v1:
  header, status, flags, headers_off/headers_count, body_off/body_len,
  error_off/error_len

yurt_extension_request_v1:
  header, name_off/name_len, argv_off/argv_count, stdin_off/stdin_len,
  cwd_off/cwd_len, env_off/env_count, payload_off/payload_len

yurt_extension_response_v1:
  header, exit_code, stdout_off/stdout_len, stderr_off/stderr_len,
  payload_off/payload_len

yurt_process_list_response_v1:
  header, entries_off, entries_count, strings_off, strings_len
```

Use offset/length pairs relative to the start of each record. For vectors, use fixed entries containing offset/length pairs into the same record.

- [ ] **Step 4: Generate and inspect**

Run:

```bash
/Users/sunny/.deno/bin/deno run --allow-read --allow-write scripts/generate-native-abi.ts
/Users/sunny/.deno/bin/deno fmt abi/contract/yurt_abi.toml scripts/generate-native-abi.ts docs/abi/generated/native-generated.ts
```

Expected: generated files contain all new constants, structs, and imports.

- [ ] **Step 5: Commit**

```bash
git add abi/contract/yurt_abi.toml scripts/generate-native-abi.ts docs/abi/generated/yurt_abi.h docs/abi/generated/native_abi_generated.rs docs/abi/generated/native-generated.ts docs/abi/native-syscall-abi.md
git commit -m "feat: define native host json replacement abi"
```

---

### Task 2: Socket Direct ABI In TypeScript

**Files:**
- Modify: `packages/kernel/src/host-imports/common.ts`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify tests: `packages/kernel/src/host-imports/__tests__/socket-fds_test.ts`
- Modify tests: `packages/kernel/src/host-imports/__tests__/socket-listen-policy_test.ts`

- [ ] **Step 1: Write failing direct socket send/recv tests**

Update one existing socket test so it calls:

```ts
const sent = (imports.host_socket_send as (...args: number[]) => number)(
  fd,
  dataPtr,
  data.length,
  0,
);
expect(sent).toBe(data.length);

const received = await (imports.host_socket_recv as (...args: number[]) => number | Promise<number>)(
  fd,
  outPtr,
  outCap,
  0,
);
expect(received).toBe(data.length);
expect([...new Uint8Array(memory.buffer, outPtr, received)]).toEqual([...data]);
```

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__/socket-fds_test.ts
```

Expected: FAIL because `host_socket_send` and `host_socket_recv` still expect JSON request pointers.

- [ ] **Step 2: Implement minimal direct socket send/recv**

Change `host_socket_send` to:

```ts
host_socket_send(fd: number, dataPtr: number, dataLen: number, flags: number): number {
  void flags;
  if (!socketBackend) return -5;
  const target = opts.kernel?.getFdTarget(callerPid, fd);
  if (!target || target.type !== "socket" || target.socket === null) return -107;
  const data = new Uint8Array(memory.buffer, dataPtr, dataLen).slice();
  const result = socketBackend.send(target.socket, bytesToBase64(data));
  if (!result.ok) return result.error === "EAGAIN" ? -11 : -5;
  return result.bytes_sent ?? dataLen;
}
```

Change `host_socket_recv` to write decoded bytes directly into `outPtr` and return bytes read, `0`, or negative errno. Keep the existing peek-buffer logic, but replace every `writeJson(... data_b64 ...)` path with `writeBytes(memory, outPtr, outCap, data)`.

- [ ] **Step 3: Verify socket send/recv tests pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__/socket-fds_test.ts
```

Expected: PASS for the updated direct send/recv tests.

- [ ] **Step 4: Write failing socket metadata tests**

Update connect/bind/listen/accept/addr/option/close tests to call native signatures:

```ts
const hostPtr = writeString(memory, 64, "127.0.0.1");
const rc = imports.host_socket_bind(fd, hostPtr, "127.0.0.1".length, 18081);
expect(rc).toBe(0);

const addrLen = imports.host_socket_addr(fd, 0, outPtr, 8);
expect(addrLen).toBe(8);
```

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__/socket-fds_test.ts packages/kernel/src/host-imports/__tests__/socket-listen-policy_test.ts
```

Expected: FAIL because metadata imports still parse JSON.

- [ ] **Step 5: Implement socket metadata signatures**

Replace JSON parsing in `kernel-imports.ts` with scalar args. Write fixed structs little-endian with helpers:

```ts
function writeSocketAddrResult(memory: WebAssembly.Memory, ptr: number, cap: number, host: string, port: number): number {
  const size = 8;
  if (cap < size) return size;
  const view = new DataView(memory.buffer, ptr, size);
  view.setUint32(0, ipv4ToU32(host), true);
  view.setUint16(4, port, true);
  view.setUint16(6, 0, true);
  return size;
}
```

Use negative errno for errors: `-9` bad fd, `-22` invalid argument, `-95` unsupported operation, `-111` connect refused, `-11` would block.

- [ ] **Step 6: Verify socket metadata tests pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__/socket-fds_test.ts packages/kernel/src/host-imports/__tests__/socket-listen-policy_test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/host-imports/common.ts packages/kernel/src/host-imports/kernel-imports.ts packages/kernel/src/host-imports/__tests__/socket-fds_test.ts packages/kernel/src/host-imports/__tests__/socket-listen-policy_test.ts
git commit -m "feat: use native socket host imports"
```

---

### Task 3: C Socket Shim Native Calls

**Files:**
- Modify: `abi/src/yurt_runtime.h`
- Modify: `abi/src/yurt_socket.c`

- [ ] **Step 1: Write failing canary check**

Run current socket canary after Task 2:

```bash
make -C abi copy-fixtures
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/__tests__/abi_test.ts --filter socket
```

Expected: FAIL at wasm instantiation or socket behavior because C shims still import old JSON signatures.

- [ ] **Step 2: Install native socket import declarations**

Change `abi/src/yurt_runtime.h` declarations to:

```c
int yurt_host_socket_connect(int fd, int host_ptr, int host_len, unsigned port, unsigned flags);
int yurt_host_socket_bind(int fd, int host_ptr, int host_len, unsigned port);
int yurt_host_socket_listen(int fd, int backlog);
int yurt_host_socket_accept(int fd, int out_ptr, int out_cap);
int yurt_host_socket_send(int fd, int data_ptr, int data_len, int flags);
int yurt_host_socket_recv(int fd, int out_ptr, int out_cap, int flags);
int yurt_host_socket_addr(int fd, unsigned which, int out_ptr, int out_cap);
int yurt_host_socket_option(int fd, unsigned option, unsigned has_value, int value);
int yurt_host_socket_close(int fd);
```

- [ ] **Step 3: Replace socket JSON builders/parsers**

In `abi/src/yurt_socket.c`:

- delete `parse_json_int`, `parse_json_ok`, `json_contains`, `parse_json_string_field`, `base64_encode`, and `base64_decode`;
- call `yurt_host_socket_connect(sockfd, (int)(intptr_t)host, strlen(host), ntohs(port), 0)`;
- call `yurt_host_socket_send(sockfd, (int)(intptr_t)buf, len, flags)`;
- call `yurt_host_socket_recv(sockfd, (int)(intptr_t)buf, len, flags)`;
- call `yurt_host_socket_close(sockfd)`;
- read `yurt_socket_addr_result_v1` and `yurt_socket_accept_result_v1` structs for address output.

- [ ] **Step 4: Verify C socket shim**

Run:

```bash
make -C abi copy-fixtures
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/__tests__/abi_test.ts --filter socket
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add abi/src/yurt_runtime.h abi/src/yurt_socket.c packages/kernel/src/platform/__tests__/fixtures
git commit -m "feat: remove socket json from c shim"
```

---

### Task 4: Native Fetch, DNS, Extension, And Process Records

**Files:**
- Modify: `packages/kernel/src/host-imports/common.ts`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify: `abi/src/yurt_fetch.c`
- Modify: `abi/src/yurt_netdb.c`
- Modify tests: `packages/kernel/src/host-imports/__tests__/network-fetch-import_test.ts`
- Modify tests: `packages/kernel/src/host-imports/__tests__/imports-shape_test.ts`

- [ ] **Step 1: Write failing native fetch test**

Update `network-fetch-import_test.ts` to build a native fetch request record in memory and assert the response record contains `status`, headers, and raw body bytes. Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__/network-fetch-import_test.ts
```

Expected: FAIL because `host_network_fetch` still parses request JSON.

- [ ] **Step 2: Implement TS native fetch decode/write**

Add local helpers in `common.ts`:

```ts
export function readRecordHeader(memory: WebAssembly.Memory, ptr: number, len: number): { size: number; version: number; flags: number } | null;
export function readSpan(memory: WebAssembly.Memory, base: number, size: number, off: number, len: number): Uint8Array | null;
export function writeRecord(memory: WebAssembly.Memory, ptr: number, cap: number, bytes: Uint8Array): number;
```

Use those helpers in `host_network_fetch`; pass decoded URL/method/headers/body to the existing `networkBridge`, and write a native response record with raw body bytes.

- [ ] **Step 3: Write failing DNS record test**

Update DNS tests to assert a fixed native address record rather than raw string bytes. Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__/imports-shape_test.ts --filter host_dns_resolve
```

Expected: FAIL because DNS still writes dotted-decimal text.

- [ ] **Step 4: Implement native DNS record output**

Change `host_dns_resolve` to write `family = AF_INET`, `addr_be`, and reserved zeros. Update `abi/src/yurt_netdb.c` to read that record and return the IPv4 address.

- [ ] **Step 5: Write failing extension native record test**

Add a host-import test that registers an extension, builds a native extension request for `name`, `argv`, `stdin`, `cwd`, and env, invokes `host_extension_invoke`, and asserts a native response with exit code/stdout/stderr bytes. Run the test and expect JSON parse failure.

- [ ] **Step 6: Implement native extension invoke**

Change `host_extension_invoke` to decode the native request and call `opts.extensionRegistry.invoke`. Preserve opaque payload bytes in the record model, but pass the existing registry `args/stdin/env/cwd` shape until the registry grows payload support.

- [ ] **Step 7: Write failing process-list native record test**

Update `host_list_processes` tests to decode a native process-list record. Run and expect JSON response failure.

- [ ] **Step 8: Implement native process-list output**

Write process entries as fixed records plus trailing strings. Return required size if `out_cap` is too small.

- [ ] **Step 9: Verify rich record tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__/network-fetch-import_test.ts packages/kernel/src/host-imports/__tests__/imports-shape_test.ts packages/kernel/src/__tests__/extensions_test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/kernel/src/host-imports/common.ts packages/kernel/src/host-imports/kernel-imports.ts abi/src/yurt_fetch.c abi/src/yurt_netdb.c packages/kernel/src/host-imports/__tests__/network-fetch-import_test.ts packages/kernel/src/host-imports/__tests__/imports-shape_test.ts packages/kernel/src/__tests__/extensions_test.ts
git commit -m "feat: use native records for rich host imports"
```

---

### Task 5: Wasmtime Runtime Parity

**Files:**
- Modify: `packages/runtime-wasmtime/src/wasm/network.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/mod.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/native_abi.rs`

- [ ] **Step 1: Write failing Wasmtime native fetch test**

Add or update a Rust test so `network::fetch` accepts native request bytes and returns native response bytes. Run:

```bash
cargo test -p runtime-wasmtime network
```

Expected: FAIL because `network::fetch` still accepts JSON.

- [ ] **Step 2: Implement native fetch parser/writer in Rust**

Decode the generated native request layout in `network.rs`, issue the existing `reqwest` request, and return native response bytes. Remove `serde_json` from this path.

- [ ] **Step 3: Update import signatures**

Change `add_network_imports` socket stubs to match native signatures:

```rust
host_socket_connect(fd, host_ptr, host_len, port, flags) -> i32
host_socket_send(fd, data_ptr, data_len, flags) -> i32
host_socket_recv(fd, out_ptr, out_cap, flags) -> i32
host_socket_close(fd) -> i32
```

Add stubs for bind/listen/accept/addr/option if Wasmtime exposes those imports to native-linked guests.

- [ ] **Step 4: Verify Wasmtime**

Run:

```bash
cargo test -p runtime-wasmtime
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-wasmtime/src/wasm/network.rs packages/runtime-wasmtime/src/wasm/mod.rs packages/runtime-wasmtime/src/wasm/native_abi.rs
git commit -m "feat: align wasmtime host imports with native abi"
```

---

### Task 6: JSON Boundary Deletion And Canaries

**Files:**
- Modify: `packages/kernel/src/host-imports/common.ts`
- Add: `packages/kernel/src/host-imports/__tests__/host-json-boundary_test.ts`
- Modify: any remaining host-boundary JSON callers found by grep.

- [ ] **Step 1: Write failing grep canary**

Create `host-json-boundary_test.ts` with assertions equivalent to:

```ts
const forbidden = [
  ["packages/kernel/src/host-imports", "writeJson"],
  ["packages/kernel/src/host-imports/kernel-imports.ts", "JSON.parse(readString"],
  ["abi/src/yurt_socket.c", "parse_json"],
  ["abi/src/yurt_socket.c", "data_b64"],
  ["abi/src/yurt_fetch.c", "build_fetch_request"],
  ["packages/runtime-wasmtime/src/wasm/network.rs", "serde_json"],
];
```

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read packages/kernel/src/host-imports/__tests__/host-json-boundary_test.ts
```

Expected: FAIL until remaining JSON helpers are deleted.

- [ ] **Step 2: Delete `writeJson` and remaining host-boundary JSON code**

Remove `writeJson` from `common.ts` and update imports. Grep:

```bash
rg -n "writeJson|JSON\\.parse\\(readString|parse_json|data_b64|build_fetch_request|serde_json" packages/kernel/src/host-imports abi/src/yurt_socket.c abi/src/yurt_fetch.c packages/runtime-wasmtime/src/wasm/network.rs
```

Expected after cleanup: no host-boundary matches. Matches in non-boundary application code are allowed only outside the checked paths.

- [ ] **Step 3: Verify targeted tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/__tests__/abi_test.ts packages/kernel/src/__tests__/extensions_test.ts
cargo test -p runtime-wasmtime
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/host-imports/common.ts packages/kernel/src/host-imports/__tests__/host-json-boundary_test.ts packages/kernel/src/host-imports packages/runtime-wasmtime/src/wasm abi/src
git commit -m "test: reject json host syscall transport"
```

---

### Task 7: Full Verification And PR

**Files:**
- Modify only files required by failing gates.

- [ ] **Step 1: Run local gates**

Run:

```bash
pre-commit run --all-files
cargo test --tests
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net 'packages/**/*_test.ts'
make -C abi copy-fixtures rust-canaries rust-std-canaries
```

Expected: PASS.

- [ ] **Step 2: Push branch and open draft PR**

Run:

```bash
git status --short
git push -u origin fix/remove-host-json
gh pr create --draft --title "fix: remove json host syscall transport" --body-file /tmp/remove-host-json-pr.md
```

PR body must include:

```markdown
## Summary
- removes JSON transport from host syscall imports
- converts sockets to scalar/direct-span/fixed-struct ABI
- converts fetch, DNS, extension invoke, and process list to native records

## Test plan
- pre-commit run --all-files
- cargo test --tests
- deno test fast tier
- make -C abi copy-fixtures rust-canaries rust-std-canaries
```

- [ ] **Step 3: Verify PR checks**

Run:

```bash
gh pr checks --watch
```

Expected: every required CI job green. If any job is red, inspect logs, fix the underlying issue, commit, push, and re-run checks.
