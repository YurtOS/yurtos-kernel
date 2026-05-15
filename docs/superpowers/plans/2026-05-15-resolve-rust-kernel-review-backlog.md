# Resolve Rust Kernel Review Backlog

## Goal

Close the remaining review issues on the Rust kernel / thin host interface branch without adding compatibility shortcuts:

- move stateful pthread TLS/condattr logic out of C and into the Rust shim layer;
- keep any unavoidable C as marker/marshalling wrappers only;
- add generation-aware pthread TLS storage so recycled key slots cannot expose stale values;
- extend host policy enforcement to remaining outside-world `kh_*` crossings;
- verify locally and re-check PR status before claiming completion.

## Acceptance Criteria

- Red tests exist before implementation for pthread shim ownership and host policy gaps.
- `abi/src/yurt_pthread.c` no longer owns the TLS key table or condattr state.
- Rust pthread TLS uses fixed-size storage with key generations and narrow unsafe blocks only for raw C ABI pointer access / static storage access.
- `DenyAllPolicy` denies process spawning, process memory/resume hooks, socket send/recv/accept/address queries, and existing gates.
- Focused Rust tests pass, followed by broader local gates where practical.

## Steps

1. Add failing tests:
   - source ownership test requiring pthread TLS/condattr state to live in `abi/rust/yurt-libc/src/pthread.rs`;
   - Wasmtime trampoline tests proving deny-all policy blocks socket data/accept/address and process spawn.
2. Implement Rust-backed pthread TLS/condattr helpers and reduce C functions to marker-preserving wrappers.
3. Add PolicyEnforcer hooks and enforce them in Wasmtime `kh_*` bindings.
4. Run targeted tests, then formatting/clippy and the broader test set.
5. Push the branch and inspect PR checks.
