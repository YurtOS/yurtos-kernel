# VFS Overlay Base Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a kernel-owned overlay VFS so a sandbox can boot from an immutable base root while writes persist only in an upper VFS.

**Architecture:** Port Codepod's overlay behavior into Yurt naming and APIs: read-only `RootProvider`, `NodeDirectoryRootProvider`, `OverlayVFS`, serializer support, and `Sandbox.create({ baseRoot })`. Keep all authorization in VFS/kernel code and persist only upper-layer state plus whiteouts.

**Tech Stack:** TypeScript, Deno tests, Yurt kernel VFS/process/persistence APIs.

---

### Task 1: Root Provider And Overlay Unit Surface

**Files:**
- Create: `packages/kernel/src/vfs/root-provider.ts`
- Create: `packages/kernel/src/vfs/node-directory-root-provider.ts`
- Create: `packages/kernel/src/vfs/overlay-vfs.ts`
- Create: `packages/kernel/src/vfs/__tests__/helpers.ts`
- Create: `packages/kernel/src/vfs/__tests__/root-provider.test.ts`
- Create: `packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts`
- Modify: `packages/kernel/src/vfs/vfs-like.ts`
- Modify: `packages/kernel/src/vfs/inode.ts`

- [x] Import Codepod root-provider and overlay sources.
- [x] Rename Codepod-specific identifiers to Yurt.
- [x] Adapt `FsCredential`/`StatResult` to Yurt's current inode types.
- [x] Run: `/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts packages/kernel/src/vfs/__tests__/root-provider.test.ts`
- [x] Commit: `feat(vfs): add overlay root filesystem`

### Task 2: Persistence Support

**Files:**
- Modify: `packages/kernel/src/persistence/serializer.ts`
- Modify: `packages/kernel/src/persistence/types.ts`
- Test: `packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts`

- [x] Extend exported state with overlay metadata `{ baseId, whiteouts }`.
- [x] Restore overlay state only when the VFS supports overlay import.
- [x] Reject mismatched base ids.
- [x] Run overlay persistence tests.
- [x] Commit: `feat(vfs): persist overlay upper state`

### Task 3: Sandbox Base Root Integration

**Files:**
- Modify: `packages/kernel/src/sandbox.ts`
- Modify: `packages/kernel/src/index.ts`
- Create or modify: `packages/kernel/src/__tests__/sandbox-base-root.test.ts`

- [x] Add `SandboxOptions.baseRoot`.
- [x] Build `NodeDirectoryRootProvider` from the base root path and manifest metadata.
- [x] Register base-root tools from manifest without mutating the base.
- [x] Ensure fork reuses the same base and clones only upper state.
- [x] Run sandbox base-root tests.
- [x] Commit: `feat(kernel): boot sandbox from read-only base root`

### Task 4: Security And Regression Coverage

**Files:**
- Modify: `packages/kernel/src/__tests__/security-adversarial.test.ts`
- Modify: `packages/kernel/src/vfs/__tests__/vfs.test.ts`
- Modify: `.github/workflows/guest-compat.yml`

- [x] Add root-owned base shadowing denial tests for `/bin` and `/etc`.
- [x] Add rename/unlink/chmod/chown overlay permission regressions.
- [x] Add base-root tests to CI.
- [x] Run VFS, sandbox base-root, fixture smoke, module cache, and adversarial tests.
- [x] Commit: `test(vfs): cover overlay base root security`
