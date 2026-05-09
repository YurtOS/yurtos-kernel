//! Kernel state.
//!
//! Phase 2 ports leaf syscalls that read pure-default state — no
//! process tree, no fd table. Credentials are the simplest such case:
//! the TS kernel returns `1000:1000` whenever the caller pid isn't
//! registered, and our test fixtures all rely on that fallback.
//! Subsequent phases replace [`Credentials::DEFAULT`] with a per-pid
//! lookup once the process kernel lands.

#[derive(Clone, Copy, Debug)]
pub struct Credentials {
    pub uid: u32,
    pub euid: u32,
    pub gid: u32,
    pub egid: u32,
    // suid / sgid are added when host_setresuid / host_setresgid get
    // ported (they're the only callers that distinguish them).
}

impl Credentials {
    /// Match the TS kernel's `USER_UID` / `USER_GID` fallback used when
    /// no caller-pid is registered. Mirrored across `vfs.ts`,
    /// `host-imports/kernel-imports.ts`, `persistence/serializer.ts`,
    /// and `process/kernel.ts` in the TS kernel.
    pub const DEFAULT: Credentials = Credentials {
        uid: 1000,
        euid: 1000,
        gid: 1000,
        egid: 1000,
    };
}
