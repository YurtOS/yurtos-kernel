# Wasmtime Runtime Port Design

**Date:** 2026-05-06
**Status:** Approved for implementation

## Summary

Port Codepod's Rust `sdk-server-wasmtime` crate into Yurt as a first-class runtime backend. The immediate goal is to preserve the real Wasmtime engine behavior that JavaScript cannot provide: epoch interruption, nice-to-quantum scheduling metadata, timeout enforcement, and a native backend server boundary.

## Scope

This slice imports the Rust runtime crate, renames it for Yurt, wires it into the Cargo workspace, and proves the Wasmtime engine path is alive with focused Rust tests. It does not try to make BusyBox run through the Rust backend in the same slice; that comes after the crate compiles and the backend contract is stable.

## Architecture

The new crate lives at `packages/runtime-wasmtime` and builds both a library and `yurt-runtime-wasmtime` binary. It starts from Codepod's `packages/sdk-server-wasmtime` implementation, then changes names and public protocol labels from Codepod to Yurt.

The Rust runtime owns the Wasmtime engine path. It configures `async_support`, fuel, and `epoch_interruption`, starts a 1 ms epoch ticker, and applies `epoch_deadline_async_yield_and_update()` to parent and child stores based on POSIX nice values. The existing TypeScript kernel remains the current Deno/browser path while this backend is brought up.

## Backend Semantics

`nice` maps to epoch quantum using the existing Codepod formula: `max(1, 10 - nice / 2)` for nice values clamped to `0..19`. Higher nice values yield more often and therefore lower effective priority.

Timeouts are real backend behavior. The Rust runtime wraps command execution in a Tokio timeout. If a command times out, the sandbox returns exit code `124`, marks the sandbox poisoned, and rejects later commands instead of pretending the store is still safe.

Preemption is a runtime capability. The Deno/JS runner remains cooperative and cannot interrupt a tight guest loop with no host calls. The Wasmtime backend can because epoch interruption is checked by the engine.

## Integration Plan

The first implementation slice creates `packages/runtime-wasmtime` from the old crate and adds it to the root Cargo workspace `members`, but not `default-members`. That avoids making every normal `cargo test` pay the Wasmtime dependency cost while still allowing explicit backend tests with `cargo test -p yurt-runtime-wasmtime`.

The second slice renames package metadata, binary names, Rust module comments, and JSON protocol strings enough that the crate is a Yurt crate rather than a Codepod crate. Compatibility with the old Codepod RPC names is not required for this new repository.

The third slice adds a focused test proving the engine uses epoch interruption and that `nice_to_quantum` is stable. A later slice can add the BusyBox test runner backend and turn `ash/ash-signals/continue_and_trap1.tests` from `preemptive-backend` XFAIL into a required pass for `wasmtime-epoch`.

## Testing

The port is verified with:

- `cargo test -p yurt-runtime-wasmtime nice_to_quantum`
- `cargo test -p yurt-runtime-wasmtime test_wasm_engine_constructs_with_epoch_support`
- `cargo test -p yurt-runtime-wasmtime`

The existing BusyBox Deno runner remains unchanged until a real Wasmtime runner exists. We must not use an environment variable to relabel Deno results as Wasmtime results.

## Non-Goals

- Replacing the TypeScript kernel in one step.
- Running BusyBox's full upstream tests through Wasmtime before the crate compiles and has focused backend tests.
- Implementing a fake Wasmtime path around plain `wasmtime run`; Yurt binaries need host imports and kernel state.
- Keeping Codepod naming in new public crate or binary names.
