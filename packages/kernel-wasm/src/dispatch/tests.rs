use super::*;

/// Helper: pack a sys_open request (u32 flags + path bytes).
/// flags=0 means read-only (the previous default).
fn open_req(flags: u32, path: &[u8]) -> Vec<u8> {
    let mut req = flags.to_le_bytes().to_vec();
    req.extend_from_slice(path);
    req
}

fn make_root(pid: u32) {
    crate::kernel::with_kernel(|k| {
        let credentials = &mut k.process_mut(pid).credentials;
        credentials.uid = 0;
        credentials.euid = 0;
        credentials.suid = 0;
        credentials.gid = 0;
        credentials.egid = 0;
        credentials.sgid = 0;
    });
}

const O_WRITE: u32 = 0b001;
const O_CREAT: u32 = 0b010;
const O_TRUNC: u32 = 0b100;
const O_DIRECTORY: u32 = 0b1000;

const POLLIN: i16 = 0x0001;
const POLLOUT: i16 = 0x0002;
const POLLHUP: i16 = 0x0010;
const POLLNVAL: i16 = 0x0020;
const TEST_METHOD_SYS_TCGETPGRP: u32 = 0x1_0056;
const TEST_METHOD_SYS_TCSETPGRP: u32 = 0x1_0057;
const TEST_METHOD_SYS_TCGETATTR: u32 = 0x1_0058;
const TEST_METHOD_SYS_TCSETATTR: u32 = 0x1_0059;
const TEST_METHOD_SYS_WINSIZE: u32 = 0x1_005A;
const TEST_METHOD_SYS_TIOCSCTTY: u32 = 0x1_005B;
const TEST_METHOD_SYS_SCHED_GETAFFINITY: u32 = 0x1_005C;
const TEST_METHOD_SYS_SCHED_SETAFFINITY: u32 = 0x1_005D;
const TEST_METHOD_SYS_FCHOWN: u32 = 0x1_005E;
const TEST_METHOD_SYS_FCHDIR: u32 = 0x1_005F;
const TEST_ENOTTY: i32 = 25;

fn poll_req(timeout_ms: i32, fds: &[(i32, i16)]) -> Vec<u8> {
    let mut req = timeout_ms.to_le_bytes().to_vec();
    for (fd, events) in fds {
        req.extend_from_slice(&fd.to_le_bytes());
        req.extend_from_slice(&events.to_le_bytes());
        req.extend_from_slice(&0_i16.to_le_bytes());
    }
    req
}

fn poll_revents(response: &[u8], index: usize) -> i16 {
    let offset = index * 8 + 6;
    i16::from_le_bytes(response[offset..offset + 2].try_into().unwrap())
}

fn socket_open_req(family: u8, sock_type: u8, flags: u32) -> Vec<u8> {
    let mut req = vec![family, sock_type, 0, 0];
    req.extend_from_slice(&flags.to_le_bytes());
    req
}

fn socket_connect_req(fd: u32, addr: &[u8]) -> Vec<u8> {
    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(addr);
    req
}

fn socket_listen_req(fd: u32, backlog: u32) -> [u8; 8] {
    let mut req = [0u8; 8];
    req[0..4].copy_from_slice(&fd.to_le_bytes());
    req[4..8].copy_from_slice(&backlog.to_le_bytes());
    req
}

fn socket_fd_req(fd: u32) -> [u8; 4] {
    fd.to_le_bytes()
}

fn socket_option_req(fd: u32, option: u32, has_value: u32, value: i32) -> [u8; 16] {
    let mut req = [0u8; 16];
    req[0..4].copy_from_slice(&fd.to_le_bytes());
    req[4..8].copy_from_slice(&option.to_le_bytes());
    req[8..12].copy_from_slice(&has_value.to_le_bytes());
    req[12..16].copy_from_slice(&value.to_le_bytes());
    req
}

fn socket_addr_req(fd: u32, which: u32) -> [u8; 8] {
    let mut req = [0u8; 8];
    req[0..4].copy_from_slice(&fd.to_le_bytes());
    req[4..8].copy_from_slice(&which.to_le_bytes());
    req
}

fn socket_addr_record(host: [u8; 4], port: u16) -> [u8; 8] {
    let mut out = [0u8; 8];
    out[0..4].copy_from_slice(&host);
    out[4..6].copy_from_slice(&port.to_be_bytes());
    out
}

fn sockaddr_in(host: [u8; 4], port: u16) -> [u8; 16] {
    let mut addr = [0u8; 16];
    addr[0..2].copy_from_slice(&2u16.to_le_bytes());
    addr[2..4].copy_from_slice(&port.to_be_bytes());
    addr[4..8].copy_from_slice(&host);
    addr
}

/// 28-byte sockaddr_in6: family(2,LE)=10 + port(2,BE) + flowinfo(4) +
/// addr(16) + scope_id(4).
fn sockaddr_in6(host: [u8; 16], port: u16) -> [u8; 28] {
    let mut addr = [0u8; 28];
    addr[0..2].copy_from_slice(&10u16.to_le_bytes());
    addr[2..4].copy_from_slice(&port.to_be_bytes());
    addr[8..24].copy_from_slice(&host);
    addr
}

fn sockaddr_un(path: &[u8]) -> Vec<u8> {
    let mut addr = 1u16.to_le_bytes().to_vec();
    addr.extend_from_slice(path);
    addr
}

fn socket_connect_unix_req(fd: u32, path: &[u8]) -> Vec<u8> {
    socket_connect_req(fd, &sockaddr_un(path))
}

fn socket_bind_unix_req(fd: u32, path: &[u8]) -> Vec<u8> {
    socket_bind_req(fd, &sockaddr_un(path))
}

fn socket_accept_req(fd: u32, flags: u32) -> [u8; 8] {
    let mut req = [0u8; 8];
    req[0..4].copy_from_slice(&fd.to_le_bytes());
    req[4..8].copy_from_slice(&flags.to_le_bytes());
    req
}

fn socket_recv_req(fd: u32, flags: u32) -> [u8; 8] {
    socket_accept_req(fd, flags)
}

fn socket_recvfrom_req(fd: u32, flags: u32, data_cap: u32, path_cap: u32) -> [u8; 16] {
    let mut req = [0u8; 16];
    req[0..4].copy_from_slice(&fd.to_le_bytes());
    req[4..8].copy_from_slice(&flags.to_le_bytes());
    req[8..12].copy_from_slice(&data_cap.to_le_bytes());
    req[12..16].copy_from_slice(&path_cap.to_le_bytes());
    req
}

fn socket_send_req(fd: u32, data: &[u8]) -> Vec<u8> {
    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(data);
    req
}

fn socketpair_req(family: u8, sock_type: u8, flags: u32) -> [u8; 8] {
    let mut req = [0u8; 8];
    req[0] = family;
    req[1] = sock_type;
    req[4..8].copy_from_slice(&flags.to_le_bytes());
    req
}

fn socket_bind_req(fd: u32, addr: &[u8]) -> Vec<u8> {
    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(addr);
    req
}

fn socket_sendto_req(fd: u32, flags: u32, addr: &[u8], data: &[u8]) -> Vec<u8> {
    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(&flags.to_le_bytes());
    req.extend_from_slice(&(addr.len() as u32).to_le_bytes());
    req.extend_from_slice(addr);
    req.extend_from_slice(data);
    req
}

fn socket_sendmsg_req(fd: u32, data: &[u8], fds: &[u32]) -> Vec<u8> {
    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(&(data.len() as u32).to_le_bytes());
    req.extend_from_slice(&(fds.len() as u32).to_le_bytes());
    req.extend_from_slice(data);
    for fd in fds {
        req.extend_from_slice(&fd.to_le_bytes());
    }
    req
}

fn socket_recvmsg_req(fd: u32, flags: u32, data_cap: u32) -> [u8; 12] {
    let mut req = [0u8; 12];
    req[0..4].copy_from_slice(&fd.to_le_bytes());
    req[4..8].copy_from_slice(&flags.to_le_bytes());
    req[8..12].copy_from_slice(&data_cap.to_le_bytes());
    req
}

#[test]
fn echo_copies_min_of_request_and_response_lengths() {
    let mut out = [0u8; 4];
    assert_eq!(dispatch(METHOD_KERNEL_ECHO, 0, b"hello", &mut out), 4);
    assert_eq!(&out, b"hell");
}

#[test]
fn echo_handles_empty_request() {
    let mut out = [0u8; 8];
    assert_eq!(dispatch(METHOD_KERNEL_ECHO, 0, &[], &mut out), 0);
}

#[test]
fn credentials_syscalls_return_default_uid_gid() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_GETUID, 1, &[], &mut []), 1000);
    assert_eq!(dispatch(METHOD_SYS_GETEUID, 1, &[], &mut []), 1000);
    assert_eq!(dispatch(METHOD_SYS_GETGID, 1, &[], &mut []), 1000);
    assert_eq!(dispatch(METHOD_SYS_GETEGID, 1, &[], &mut []), 1000);
}

#[test]
fn getpid_returns_caller_pid() {
    assert_eq!(dispatch(METHOD_SYS_GETPID, 1, &[], &mut []), 1);
    assert_eq!(dispatch(METHOD_SYS_GETPID, 42, &[], &mut []), 42);
    assert_eq!(dispatch(METHOD_SYS_GETPID, 0, &[], &mut []), 0);
}

#[test]
fn getppid_returns_kernel_pid_until_process_tree_exists() {
    // Must hold the TestGuard: this asserts on auto-vivified
    // `process(1)`/`process(99)` ppid (default 0). Without the guard it
    // races any guarded test that legitimately creates a process at pid
    // 1 (e.g. a fork allocating host pid 1) and observes a non-zero
    // ppid. Pre-existing isolation gap surfaced by the fork RT test.
    let _g = crate::kernel::TestGuard::acquire();
    // Phase note: until host_spawn lands and the kernel tracks
    // parent/child relationships, every process is treated as a
    // direct child of the kernel.
    assert_eq!(dispatch(METHOD_SYS_GETPPID, 1, &[], &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_GETPPID, 99, &[], &mut []), 0);
}

#[test]
fn umask_round_trips_through_per_pid_state() {
    let _g = crate::kernel::TestGuard::acquire();
    // First call: returns the default 022, sets new mask 077.
    let req = 0o077_u32.to_le_bytes();
    assert_eq!(dispatch(METHOD_SYS_UMASK, 1, &req, &mut []), 0o022);
    // Second call from the same pid: previous = 077.
    let req2 = 0o007_u32.to_le_bytes();
    assert_eq!(dispatch(METHOD_SYS_UMASK, 1, &req2, &mut []), 0o077);
    // A different pid sees its own default.
    assert_eq!(dispatch(METHOD_SYS_UMASK, 2, &req, &mut []), 0o022);
}

#[test]
fn setresuid_writes_per_pid_credentials() {
    let _g = crate::kernel::TestGuard::acquire();
    make_root(1);
    let mut req = Vec::new();
    req.extend_from_slice(&500_u32.to_le_bytes()); // ruid
    req.extend_from_slice(&501_u32.to_le_bytes()); // euid
    req.extend_from_slice(&502_u32.to_le_bytes()); // suid
    assert_eq!(dispatch(METHOD_SYS_SETRESUID, 1, &req, &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_GETUID, 1, &[], &mut []), 500);
    assert_eq!(dispatch(METHOD_SYS_GETEUID, 1, &[], &mut []), 501);
    // Other pid still sees defaults.
    assert_eq!(dispatch(METHOD_SYS_GETUID, 2, &[], &mut []), 1000);
}

#[test]
fn setresuid_rejects_unprivileged_root_escalation() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&0_u32.to_le_bytes());
    req.extend_from_slice(&0_u32.to_le_bytes());
    req.extend_from_slice(&0_u32.to_le_bytes());

    assert_eq!(
        dispatch(METHOD_SYS_SETRESUID, 1, &req, &mut []),
        -(abi::EPERM as i64)
    );
    assert_eq!(dispatch(METHOD_SYS_GETUID, 1, &[], &mut []), 1000);
    assert_eq!(dispatch(METHOD_SYS_GETEUID, 1, &[], &mut []), 1000);
}

#[test]
fn setresuid_minus_one_keeps_current_ids() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&u32::MAX.to_le_bytes());
    req.extend_from_slice(&u32::MAX.to_le_bytes());
    req.extend_from_slice(&u32::MAX.to_le_bytes());

    assert_eq!(dispatch(METHOD_SYS_SETRESUID, 1, &req, &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_GETUID, 1, &[], &mut []), 1000);
    assert_eq!(dispatch(METHOD_SYS_GETEUID, 1, &[], &mut []), 1000);
}

#[test]
fn setresuid_rejects_short_request() {
    let req = [0u8; 4]; // only one u32 instead of three
    assert_eq!(
        dispatch(METHOD_SYS_SETRESUID, 1, &req, &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn setresgid_writes_per_pid_credentials() {
    let _g = crate::kernel::TestGuard::acquire();
    make_root(1);
    let mut req = Vec::new();
    req.extend_from_slice(&77_u32.to_le_bytes());
    req.extend_from_slice(&78_u32.to_le_bytes());
    req.extend_from_slice(&79_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_SETRESGID, 1, &req, &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_GETGID, 1, &[], &mut []), 77);
    assert_eq!(dispatch(METHOD_SYS_GETEGID, 1, &[], &mut []), 78);
}

#[test]
fn setresgid_rejects_unprivileged_root_escalation() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&0_u32.to_le_bytes());
    req.extend_from_slice(&0_u32.to_le_bytes());
    req.extend_from_slice(&0_u32.to_le_bytes());

    assert_eq!(
        dispatch(METHOD_SYS_SETRESGID, 1, &req, &mut []),
        -(abi::EPERM as i64)
    );
    assert_eq!(dispatch(METHOD_SYS_GETGID, 1, &[], &mut []), 1000);
    assert_eq!(dispatch(METHOD_SYS_GETEGID, 1, &[], &mut []), 1000);
}

#[test]
fn chdir_then_getcwd_round_trips() {
    let _g = crate::kernel::TestGuard::acquire();
    // Default cwd is "/", required size 2 bytes ("/" + NUL).
    let mut buf = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_GETCWD, 1, &[], &mut buf), 2);
    assert_eq!(&buf[..2], b"/\0");

    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/var", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/var/tmp", &mut []), 0);

    // chdir to "/var/tmp"
    assert_eq!(dispatch(METHOD_SYS_CHDIR, 1, b"/var/tmp", &mut []), 0);

    let mut buf = [0u8; 32];
    let n = dispatch(METHOD_SYS_GETCWD, 1, &[], &mut buf);
    assert_eq!(n, b"/var/tmp\0".len() as i64);
    assert_eq!(&buf[..n as usize], b"/var/tmp\0");
}

#[test]
fn getcwd_returns_required_size_when_buffer_too_small() {
    let _g = crate::kernel::TestGuard::acquire();
    // Default cwd "/" needs 2 bytes; pass a 1-byte buffer.
    let mut tiny = [0u8; 1];
    let n = dispatch(METHOD_SYS_GETCWD, 1, &[], &mut tiny);
    assert_eq!(n, 2, "returns required size on too-small buffer");
    // Verify the buffer wasn't written into when too small.
    assert_eq!(tiny, [0]);
}

#[test]
fn cwd_is_per_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/home", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/home/a", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 2, b"/home/b", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_CHDIR, 1, b"/home/a", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_CHDIR, 2, b"/home/b", &mut []), 0);
    let mut buf = [0u8; 32];
    let n = dispatch(METHOD_SYS_GETCWD, 1, &[], &mut buf);
    assert_eq!(&buf[..n as usize - 1], b"/home/a");
    let n = dispatch(METHOD_SYS_GETCWD, 2, &[], &mut buf);
    assert_eq!(&buf[..n as usize - 1], b"/home/b");
}

#[test]
fn chdir_rejects_empty_path() {
    assert_eq!(
        dispatch(METHOD_SYS_CHDIR, 1, &[], &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn chdir_rejects_missing_and_non_directory_paths() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_CHDIR, 1, b"/missing", &mut []),
        -(abi::ENOENT as i64)
    );

    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_CREAT | O_WRITE, b"/file.txt"),
        &mut [],
    );
    assert!(fd >= 3);
    assert_eq!(
        dispatch(METHOD_SYS_CHDIR, 1, b"/file.txt", &mut []),
        -(abi::ENOTDIR as i64)
    );
}

#[test]
fn fchdir_moves_cwd_to_open_directory_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/tmp", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/tmp/base", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/tmp/base/sub", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_CHDIR, 1, b"/tmp/base/sub", &mut []), 0);

    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_DIRECTORY, b"/tmp/base"),
        &mut [],
    );
    assert!(fd >= 3, "directory open should return fd, got {fd}");

    assert_eq!(
        dispatch(
            TEST_METHOD_SYS_FCHDIR,
            1,
            &(fd as u32).to_le_bytes(),
            &mut []
        ),
        0
    );

    let mut buf = [0u8; 32];
    let n = dispatch(METHOD_SYS_GETCWD, 1, &[], &mut buf);
    assert_eq!(&buf[..n as usize], b"/tmp/base\0");
}

#[test]
fn fchdir_rejects_invalid_and_non_directory_fds() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(TEST_METHOD_SYS_FCHDIR, 1, &99_u32.to_le_bytes(), &mut []),
        -(abi::EBADF as i64)
    );

    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_CREAT | O_WRITE, b"/file.txt"),
        &mut [],
    );
    assert!(fd >= 3);
    assert_eq!(
        dispatch(
            TEST_METHOD_SYS_FCHDIR,
            1,
            &(fd as u32).to_le_bytes(),
            &mut []
        ),
        -(abi::ENOTDIR as i64)
    );
}

#[test]
fn umask_rejects_short_request() {
    assert_eq!(
        dispatch(METHOD_SYS_UMASK, 1, &[1, 2], &mut []),
        -(abi::EINVAL as i64)
    );
}

fn priority_req(which: u32, who: u32) -> Vec<u8> {
    let mut req = which.to_le_bytes().to_vec();
    req.extend_from_slice(&who.to_le_bytes());
    req
}

fn setpriority_req(which: u32, who: u32, nice: i32) -> Vec<u8> {
    let mut req = priority_req(which, who);
    req.extend_from_slice(&nice.to_le_bytes());
    req
}

fn sched_target_req(pid: u32) -> Vec<u8> {
    pid.to_le_bytes().to_vec()
}

fn sched_setscheduler_req(pid: u32, policy: i32, priority: i32) -> Vec<u8> {
    let mut req = pid.to_le_bytes().to_vec();
    req.extend_from_slice(&policy.to_le_bytes());
    req.extend_from_slice(&priority.to_le_bytes());
    req
}

fn sched_setparam_req(pid: u32, priority: i32) -> Vec<u8> {
    let mut req = pid.to_le_bytes().to_vec();
    req.extend_from_slice(&priority.to_le_bytes());
    req
}

#[test]
fn priority_syscalls_are_kernel_owned_per_process_state() {
    let _g = crate::kernel::TestGuard::acquire();

    assert_eq!(
        dispatch(METHOD_SYS_GETPRIORITY, 7, &priority_req(0, 0), &mut []),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SETPRIORITY,
            7,
            &setpriority_req(0, 0, 10),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_GETPRIORITY, 7, &priority_req(0, 0), &mut []),
        10
    );
    assert_eq!(
        dispatch(METHOD_SYS_GETPRIORITY, 8, &priority_req(0, 0), &mut []),
        0
    );
}

#[test]
fn priority_syscalls_validate_target_and_permissions() {
    let _g = crate::kernel::TestGuard::acquire();

    assert_eq!(
        dispatch(METHOD_SYS_GETPRIORITY, 7, &priority_req(1, 0), &mut []),
        -(abi::EINVAL as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_GETPRIORITY, 7, &priority_req(0, 99), &mut []),
        -(abi::ESRCH as i64)
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SETPRIORITY,
            7,
            &setpriority_req(0, 0, -1),
            &mut []
        ),
        -(abi::EPERM as i64)
    );

    make_root(7);
    assert_eq!(
        dispatch(
            METHOD_SYS_SETPRIORITY,
            7,
            &setpriority_req(0, 0, -20),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_GETPRIORITY, 7, &priority_req(0, 0), &mut []),
        -20
    );
}

#[test]
fn setpriority_rejects_cross_user_targets() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        let credentials = &mut k.process_mut(8).credentials;
        credentials.uid = 2000;
        credentials.euid = 2000;
    });
    assert_eq!(
        dispatch(
            METHOD_SYS_SETPRIORITY,
            7,
            &setpriority_req(0, 8, 10),
            &mut []
        ),
        -(abi::EPERM as i64)
    );
    make_root(7);
    assert_eq!(
        dispatch(
            METHOD_SYS_SETPRIORITY,
            7,
            &setpriority_req(0, 8, 10),
            &mut []
        ),
        0
    );
}

#[test]
fn process_group_queries_do_not_create_unknown_target_pids() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_GETPGID, 1, &99_u32.to_le_bytes(), &mut []),
        -(abi::ESRCH as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_GETSID, 1, &99_u32.to_le_bytes(), &mut []),
        -(abi::ESRCH as i64)
    );
    let mut req = Vec::new();
    req.extend_from_slice(&99_u32.to_le_bytes());
    req.extend_from_slice(&99_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_SETPGID, 1, &req, &mut []),
        -(abi::ESRCH as i64)
    );
    assert!(!crate::kernel::with_kernel(|k| k.has_process(99)));
}

#[test]
fn scheduler_syscalls_are_kernel_owned_per_process_state() {
    let _g = crate::kernel::TestGuard::acquire();

    assert_eq!(
        dispatch(
            METHOD_SYS_SCHED_GETSCHEDULER,
            7,
            &sched_target_req(0),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_SCHED_GETPARAM, 7, &sched_target_req(0), &mut []),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SCHED_SETSCHEDULER,
            7,
            &sched_setscheduler_req(0, 0, 0),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SCHED_SETPARAM,
            7,
            &sched_setparam_req(0, 0),
            &mut []
        ),
        0
    );
}

#[test]
fn scheduler_syscalls_validate_target_policy_and_param() {
    let _g = crate::kernel::TestGuard::acquire();

    assert_eq!(
        dispatch(
            METHOD_SYS_SCHED_GETSCHEDULER,
            7,
            &sched_target_req(99),
            &mut []
        ),
        -(abi::ESRCH as i64)
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SCHED_SETSCHEDULER,
            7,
            &sched_setscheduler_req(0, 0, 1),
            &mut []
        ),
        -(abi::EINVAL as i64)
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SCHED_SETSCHEDULER,
            7,
            &sched_setscheduler_req(0, 1, 1),
            &mut []
        ),
        -(abi::EPERM as i64)
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SCHED_SETPARAM,
            7,
            &sched_setparam_req(0, 1),
            &mut []
        ),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn sched_getaffinity_reports_single_cpu_and_validates_target() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&0_u32.to_le_bytes());
    req.extend_from_slice(&4_u32.to_le_bytes());
    let mut out = [0xffu8; 4];
    assert_eq!(
        dispatch(TEST_METHOD_SYS_SCHED_GETAFFINITY, 7, &req, &mut out),
        4
    );
    assert_eq!(u32::from_le_bytes(out), 1);

    let mut short_req = Vec::new();
    short_req.extend_from_slice(&0_u32.to_le_bytes());
    short_req.extend_from_slice(&3_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_SCHED_GETAFFINITY, 7, &short_req, &mut out),
        -(abi::EINVAL as i64)
    );

    let mut missing_req = Vec::new();
    missing_req.extend_from_slice(&999_u32.to_le_bytes());
    missing_req.extend_from_slice(&4_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_SCHED_GETAFFINITY, 7, &missing_req, &mut out),
        -(abi::ESRCH as i64)
    );
}

#[test]
fn sched_setaffinity_accepts_only_cpu_zero_mask() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut ok_req = Vec::new();
    ok_req.extend_from_slice(&0_u32.to_le_bytes());
    ok_req.extend_from_slice(&4_u32.to_le_bytes());
    ok_req.extend_from_slice(&1_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_SCHED_SETAFFINITY, 7, &ok_req, &mut []),
        0
    );

    let mut cpu_one_req = Vec::new();
    cpu_one_req.extend_from_slice(&0_u32.to_le_bytes());
    cpu_one_req.extend_from_slice(&4_u32.to_le_bytes());
    cpu_one_req.extend_from_slice(&2_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_SCHED_SETAFFINITY, 7, &cpu_one_req, &mut []),
        -(abi::EINVAL as i64)
    );

    let mut short_req = Vec::new();
    short_req.extend_from_slice(&0_u32.to_le_bytes());
    short_req.extend_from_slice(&3_u32.to_le_bytes());
    short_req.extend_from_slice(&[1, 0, 0]);
    assert_eq!(
        dispatch(TEST_METHOD_SYS_SCHED_SETAFFINITY, 7, &short_req, &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn getrlimit_default_stack_is_one_megabyte() {
    let _g = crate::kernel::TestGuard::acquire();
    let req = 3_u32.to_le_bytes(); // RLIMIT_STACK
    let mut out = [0u8; 16];
    let n = dispatch(METHOD_SYS_GETRLIMIT, 1, &req, &mut out);
    assert_eq!(n, 16);
    let soft = u64::from_le_bytes(out[0..8].try_into().unwrap());
    let hard = u64::from_le_bytes(out[8..16].try_into().unwrap());
    assert_eq!(soft, 1024 * 1024);
    assert_eq!(hard, 1024 * 1024);
}

#[test]
fn getrlimit_default_cpu_is_infinity() {
    let _g = crate::kernel::TestGuard::acquire();
    let req = 0_u32.to_le_bytes(); // RLIMIT_CPU
    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_GETRLIMIT, 1, &req, &mut out), 16);
    let soft = u64::from_le_bytes(out[0..8].try_into().unwrap());
    assert_eq!(soft, u64::MAX, "RLIM_INFINITY");
}

#[test]
fn getrlimit_unknown_resource_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    let req = 99_u32.to_le_bytes();
    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_GETRLIMIT, 1, &req, &mut out),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn setrlimit_lowers_then_get_reflects() {
    let _g = crate::kernel::TestGuard::acquire();
    // Lower RLIMIT_NOFILE (id=7) from 1024/1024 to 256/512.
    let mut req = Vec::new();
    req.extend_from_slice(&7_u32.to_le_bytes());
    req.extend_from_slice(&256_u64.to_le_bytes());
    req.extend_from_slice(&512_u64.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_SETRLIMIT, 1, &req, &mut []), 0);

    let req_get = 7_u32.to_le_bytes();
    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_GETRLIMIT, 1, &req_get, &mut out), 16);
    assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 256);
    assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), 512);
}

#[test]
fn setrlimit_raising_hard_is_eperm() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&7_u32.to_le_bytes());
    req.extend_from_slice(&1024_u64.to_le_bytes());
    req.extend_from_slice(&(u64::MAX).to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_SETRLIMIT, 1, &req, &mut []),
        -(abi::EPERM as i64)
    );
}

#[test]
fn setrlimit_soft_above_hard_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&7_u32.to_le_bytes());
    req.extend_from_slice(&2048_u64.to_le_bytes()); // soft
    req.extend_from_slice(&512_u64.to_le_bytes()); // hard
    assert_eq!(
        dispatch(METHOD_SYS_SETRLIMIT, 1, &req, &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn rlimits_are_per_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&7_u32.to_le_bytes());
    req.extend_from_slice(&100_u64.to_le_bytes());
    req.extend_from_slice(&200_u64.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_SETRLIMIT, 1, &req, &mut []), 0);

    // Pid 2 still sees default (1024/1024).
    let req_get = 7_u32.to_le_bytes();
    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_GETRLIMIT, 2, &req_get, &mut out), 16);
    assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 1024);
}

#[test]
fn fd_table_starts_with_stdin_stdout_stderr() {
    let _g = crate::kernel::TestGuard::acquire();
    // close(0), close(1), close(2) all succeed; close(3) does not.
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &0_u32.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &1_u32.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &2_u32.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &3_u32.to_le_bytes(), &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn close_unknown_fd_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &99_u32.to_le_bytes(), &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn dup_returns_lowest_unused_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    // Default has 0/1/2; dup(1) should return 3.
    assert_eq!(
        dispatch(METHOD_SYS_DUP, 1, &1_u32.to_le_bytes(), &mut []),
        3
    );
    // Both 1 and 3 still close cleanly.
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &3_u32.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &1_u32.to_le_bytes(), &mut []),
        0
    );
}

#[test]
fn dup_fills_holes_in_the_table() {
    let _g = crate::kernel::TestGuard::acquire();
    // Close 0; next dup should put the duplicate at 0.
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &0_u32.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_DUP, 1, &1_u32.to_le_bytes(), &mut []),
        0
    );
}

#[test]
fn dup_of_unopened_fd_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_DUP, 1, &42_u32.to_le_bytes(), &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn dup2_overwrites_target_silently() {
    let _g = crate::kernel::TestGuard::acquire();
    // dup2(1, 2): fd 2 was stderr; now it's the same as fd 1.
    let mut req = Vec::new();
    req.extend_from_slice(&1_u32.to_le_bytes());
    req.extend_from_slice(&2_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_DUP2, 1, &req, &mut []), 2);
    // Closing 2 succeeds (it was open after the dup2).
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &2_u32.to_le_bytes(), &mut []),
        0
    );
}

#[test]
fn dup2_to_arbitrary_high_fd_works() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&1_u32.to_le_bytes());
    req.extend_from_slice(&100_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_DUP2, 1, &req, &mut []), 100);
    // dup() now skips both 0/1/2 and 100; should return 3.
    assert_eq!(
        dispatch(METHOD_SYS_DUP, 1, &1_u32.to_le_bytes(), &mut []),
        3
    );
}

#[test]
fn dup2_same_fd_is_noop_when_open() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&1_u32.to_le_bytes());
    req.extend_from_slice(&1_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_DUP2, 1, &req, &mut []), 1);
}

#[test]
fn dup2_oldfd_unopened_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&42_u32.to_le_bytes());
    req.extend_from_slice(&5_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_DUP2, 1, &req, &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn dup_min_returns_lowest_unused_fd_at_or_above_minimum() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&1_u32.to_le_bytes());
    req.extend_from_slice(&5_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_DUP_MIN, 1, &req, &mut []), 5);

    let mut req2 = Vec::new();
    req2.extend_from_slice(&1_u32.to_le_bytes());
    req2.extend_from_slice(&5_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_DUP_MIN, 1, &req2, &mut []), 6);
}

#[test]
fn dup_min_rejects_closed_source_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&42_u32.to_le_bytes());
    req.extend_from_slice(&5_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_DUP_MIN, 1, &req, &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn set_fd_descriptor_flags_rejects_closed_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&42_u32.to_le_bytes());
    req.extend_from_slice(&1_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_SET_FD_DESCRIPTOR_FLAGS, 1, &req, &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn sys_spawn_does_not_inherit_cloexec_fds() {
    let _g = crate::kernel::TestGuard::acquire();
    let parent_pid = 1;
    let mut image = vec![];
    image.extend_from_slice(b"\0asm");
    image.extend_from_slice(&[1, 0, 0, 0]);
    let mut reg = (b"/bin/child".len() as u32).to_le_bytes().to_vec();
    reg.extend_from_slice(b"/bin/child");
    reg.extend_from_slice(&image);
    assert_eq!(dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []), 0);

    let mut dup_min_req = Vec::new();
    dup_min_req.extend_from_slice(&1_u32.to_le_bytes());
    dup_min_req.extend_from_slice(&5_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_DUP_MIN, parent_pid, &dup_min_req, &mut []),
        5
    );

    let mut flags_req = Vec::new();
    flags_req.extend_from_slice(&5_u32.to_le_bytes());
    flags_req.extend_from_slice(&1_u32.to_le_bytes()); // FD_CLOEXEC
    assert_eq!(
        dispatch(
            METHOD_SYS_SET_FD_DESCRIPTOR_FLAGS,
            parent_pid,
            &flags_req,
            &mut []
        ),
        0
    );

    let mut spawn_req = Vec::new();
    spawn_req.extend_from_slice(&(b"/bin/child".len() as u32).to_le_bytes());
    spawn_req.extend_from_slice(b"/bin/child");
    spawn_req.extend_from_slice(&(b"child".len() as u32).to_le_bytes());
    spawn_req.extend_from_slice(b"child");
    let child_pid = dispatch(METHOD_SYS_SPAWN, parent_pid, &spawn_req, &mut []);
    assert!(child_pid >= 1000);

    let child_has_fd5 =
        crate::kernel::with_kernel(|k| k.process_mut(child_pid as u32).fd_table.entry(5).is_some());
    assert!(!child_has_fd5);
}

#[test]
fn fd_table_is_per_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    // Close fd 0 in pid 1.
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &0_u32.to_le_bytes(), &mut []),
        0
    );
    // Pid 2 still has fd 0.
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 2, &0_u32.to_le_bytes(), &mut []),
        0
    );
    // Closing again in pid 2 fails.
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 2, &0_u32.to_le_bytes(), &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn socket_connect_allocates_kernel_fd_and_close_closes_host_handle() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_connect_result(77);

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    let req = socket_connect_req(3, &sockaddr_in([127, 0, 0, 1], 1234));
    assert_eq!(dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &req, &mut []), 0);

    assert_eq!(
        crate::kh::test_support::socket_connect_calls(),
        vec![(sockaddr_in([127, 0, 0, 1], 1234).to_vec(), 0)]
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_CLOSE, 1, &socket_fd_req(3), &mut []),
        0
    );
    assert_eq!(crate::kh::test_support::socket_close_calls(), vec![77]);
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_CLOSE, 1, &socket_fd_req(3), &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn socket_dup_refcount_delays_host_close_until_last_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_connect_result(88);

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    let req = socket_connect_req(3, &sockaddr_in([127, 0, 0, 1], 1235));
    assert_eq!(dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &req, &mut []), 0);
    assert_eq!(
        dispatch(METHOD_SYS_DUP, 1, &3_u32.to_le_bytes(), &mut []),
        4
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &3_u32.to_le_bytes(), &mut []),
        0
    );
    assert!(crate::kh::test_support::socket_close_calls().is_empty());
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &4_u32.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(crate::kh::test_support::socket_close_calls(), vec![88]);
}

#[test]
fn socket_syscalls_resolve_kernel_fd_to_host_handle() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_connect_result(91);
    crate::kh::test_support::push_socket_recv_result(b"pong");
    crate::kh::test_support::push_socket_addr_result(&socket_addr_record([127, 0, 0, 1], 6000));

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    let req = socket_connect_req(3, &sockaddr_in([127, 0, 0, 1], 6000));
    assert_eq!(dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &req, &mut []), 0);
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(3, b"ping"),
            &mut []
        ),
        4
    );
    assert_eq!(
        crate::kh::test_support::socket_send_calls(),
        vec![(91, b"ping".to_vec())]
    );

    let mut recv = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(3, 2), &mut recv),
        4
    );
    assert_eq!(&recv[..4], b"pong");
    assert_eq!(
        crate::kh::test_support::socket_recv_calls(),
        vec![(91, 8, 2)]
    );

    let mut addr = [0u8; 32];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_fd_req(3), &mut addr),
        8
    );
    assert_eq!(&addr[..8], &socket_addr_record([127, 0, 0, 1], 6000));
    assert_eq!(crate::kh::test_support::socket_addr_calls(), vec![(91, 32)]);
}

#[test]
fn read_write_on_socket_fd_route_to_socket_recv_send() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_connect_result(95);
    crate::kh::test_support::push_socket_recv_result(b"read-reply");

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    let req = socket_connect_req(3, &sockaddr_in([127, 0, 0, 1], 6001));
    assert_eq!(dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &req, &mut []), 0);

    let mut write_req = 3_u32.to_le_bytes().to_vec();
    write_req.extend_from_slice(b"write-payload");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &write_req, &mut []),
        b"write-payload".len() as i64
    );
    assert_eq!(
        crate::kh::test_support::socket_send_calls(),
        vec![(95, b"write-payload".to_vec())]
    );

    let mut read_buf = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &3_u32.to_le_bytes(), &mut read_buf),
        b"read-reply".len() as i64
    );
    assert_eq!(&read_buf[..10], b"read-reply");
    assert_eq!(
        crate::kh::test_support::socket_recv_calls(),
        vec![(95, 16, 0)]
    );
}

#[test]
fn socket_accept_returns_kernel_fd_for_accepted_host_handle() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_listen_result(101);
    crate::kh::test_support::push_socket_accept_result(102);

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_req(3, &sockaddr_in([127, 0, 0, 1], 0)),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_LISTEN,
            1,
            &socket_listen_req(3, 16),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_ACCEPT,
            1,
            &socket_accept_req(3, 1),
            &mut []
        ),
        4
    );
    assert_eq!(
        crate::kh::test_support::socket_accept_calls(),
        vec![(101, 1)]
    );
}

#[test]
fn af_unix_path_stream_listen_connect_accept_round_trips_bytes() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/yurt.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_LISTEN,
            1,
            &socket_listen_req(3, 4),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        4
    );
    let connect_req = socket_connect_unix_req(4, b"/tmp/yurt.sock");
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &connect_req, &mut []),
        0
    );

    let poll_req = poll_req(0, &[(3, POLLIN)]);
    let mut poll_out = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_POLL, 1, &poll_req, &mut poll_out), 1);
    assert_eq!(poll_revents(&poll_out, 0), POLLIN);

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_ACCEPT,
            1,
            &socket_accept_req(3, 0),
            &mut []
        ),
        5
    );

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(4, b"client"),
            &mut []
        ),
        6
    );
    let mut buf = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(5, 0), &mut buf),
        6
    );
    assert_eq!(&buf[..6], b"client");

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(5, b"server"),
            &mut []
        ),
        6
    );
    let mut buf = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(4, 0), &mut buf),
        6
    );
    assert_eq!(&buf[..6], b"server");

    assert_eq!(
        crate::kh::test_support::socket_listen_calls(),
        Vec::<(Vec<u8>, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_connect_calls(),
        Vec::<(Vec<u8>, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_accept_calls(),
        Vec::<(i32, u32)>::new()
    );
}

#[test]
fn af_unix_path_stream_reports_local_and_peer_paths() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/yurt-name.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_LISTEN,
            1,
            &socket_listen_req(3, 4),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(4, b"/tmp/yurt-name.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_ACCEPT,
            1,
            &socket_accept_req(3, 0),
            &mut []
        ),
        5
    );

    let mut path = [0u8; 108];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_addr_req(3, 0), &mut path),
        19
    );
    assert_eq!(&path[..19], b"/tmp/yurt-name.sock");

    path.fill(0);
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_addr_req(4, 1), &mut path),
        19
    );
    assert_eq!(&path[..19], b"/tmp/yurt-name.sock");

    path.fill(0);
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_addr_req(5, 0), &mut path),
        19
    );
    assert_eq!(&path[..19], b"/tmp/yurt-name.sock");

    path.fill(0);
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_addr_req(4, 0), &mut path),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_addr_req(5, 1), &mut path),
        0
    );
}

#[test]
fn af_unix_addr_query_rejects_unconnected_ipv4_socket() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    let mut addr = [0u8; 108];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_addr_req(3, 0), &mut addr),
        -(abi::EAFNOSUPPORT as i64)
    );
}

#[test]
fn socket_info_reports_type_and_peer_credentials() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    let mut info = [0u8; 24];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 2, 0),
            &mut [0u8; 8]
        ),
        8
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_INFO, 1, &socket_fd_req(3), &mut info),
        24
    );
    assert_eq!(u32::from_le_bytes(info[0..4].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(info[4..8].try_into().unwrap()), 2);
    assert_eq!(i32::from_le_bytes(info[12..16].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(info[16..20].try_into().unwrap()), 1000);
    assert_eq!(u32::from_le_bytes(info[20..24].try_into().unwrap()), 1000);

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_INFO, 1, &socket_fd_req(404), &mut info),
        -(abi::EBADF as i64)
    );
}

#[test]
fn af_unix_path_stream_rejects_missing_listener_and_full_backlog() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        3
    );
    let missing = socket_connect_unix_req(3, b"/tmp/missing.sock");
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &missing, &mut []),
        -(abi::ECONNREFUSED as i64)
    );

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(4, b"/tmp/backlog.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_LISTEN,
            1,
            &socket_listen_req(4, 1),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        5
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(5, b"/tmp/backlog.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        6
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(6, b"/tmp/backlog.sock"),
            &mut []
        ),
        -(abi::ECONNREFUSED as i64)
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_ACCEPT,
            1,
            &socket_accept_req(4, 0),
            &mut []
        ),
        7
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        8
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(8, b"/tmp/backlog.sock"),
            &mut []
        ),
        0
    );
}

#[test]
fn af_unix_path_stream_close_listener_removes_route_and_hangs_pending_peer() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/close.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_LISTEN,
            1,
            &socket_listen_req(3, 4),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        4
    );
    let connect_req = socket_connect_unix_req(4, b"/tmp/close.sock");
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &connect_req, &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &3_u32.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(3, 6, 0),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(3, b"/tmp/close.sock"),
            &mut []
        ),
        -(abi::ECONNREFUSED as i64)
    );

    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(4, 0), &mut buf),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(4, b"x"),
            &mut []
        ),
        -(abi::EPIPE as i64)
    );
}

#[test]
fn socket_operations_reject_non_socket_fds_with_enotsock() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(1, b"x"),
            &mut []
        ),
        -(abi::ENOTSOCK as i64)
    );
    let mut buf = [0u8; 4];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(1, 0), &mut buf),
        -(abi::ENOTSOCK as i64)
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_ACCEPT,
            1,
            &socket_accept_req(1, 0),
            &mut []
        ),
        -(abi::ENOTSOCK as i64)
    );
    assert_eq!(
        crate::kh::test_support::socket_send_calls(),
        Vec::<(i32, Vec<u8>)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_recv_calls(),
        Vec::<(i32, usize, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_accept_calls(),
        Vec::<(i32, u32)>::new()
    );
}

#[test]
fn socket_ops_reject_bad_fds_without_backend_calls() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    for fd in [3_u32, 7, 255, u32::MAX] {
        let mut response = [0u8; 32];
        let cases: Vec<(u32, Vec<u8>, usize)> = vec![
            (
                METHOD_SYS_SOCKET_CONNECT,
                socket_connect_req(fd, &sockaddr_in([127, 0, 0, 1], 1)),
                0,
            ),
            (
                METHOD_SYS_SOCKET_BIND,
                socket_bind_req(fd, &sockaddr_in([127, 0, 0, 1], 0)),
                0,
            ),
            (
                METHOD_SYS_SOCKET_LISTEN,
                socket_listen_req(fd, 16).to_vec(),
                0,
            ),
            (METHOD_SYS_SOCKET_SEND, socket_send_req(fd, b"x"), 0),
            (METHOD_SYS_SOCKET_RECV, socket_recv_req(fd, 0).to_vec(), 8),
            (
                METHOD_SYS_SOCKET_ACCEPT,
                socket_accept_req(fd, 0).to_vec(),
                0,
            ),
            (METHOD_SYS_SOCKET_ADDR, socket_fd_req(fd).to_vec(), 32),
            (
                METHOD_SYS_SOCKET_SENDTO,
                socket_sendto_req(fd, 0, &sockaddr_un(b"/tmp/nope"), b"x"),
                0,
            ),
            (
                METHOD_SYS_SOCKET_SENDMSG,
                socket_sendmsg_req(fd, b"x", &[]),
                0,
            ),
            (
                METHOD_SYS_SOCKET_RECVMSG,
                socket_recvmsg_req(fd, 0, 8).to_vec(),
                12,
            ),
        ];

        for (method, req, response_len) in cases {
            assert_eq!(
                dispatch(method, 1, &req, &mut response[..response_len]),
                -(abi::EBADF as i64),
                "method {method:#x} should reject unopened fd {fd}"
            );
        }
    }

    assert_eq!(
        crate::kh::test_support::socket_connect_calls(),
        Vec::<(Vec<u8>, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_listen_calls(),
        Vec::<(Vec<u8>, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_send_calls(),
        Vec::<(i32, Vec<u8>)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_recv_calls(),
        Vec::<(i32, usize, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_addr_calls(),
        Vec::<(i32, usize)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_accept_calls(),
        Vec::<(i32, u32)>::new()
    );
}

#[test]
fn socket_ops_reject_file_fds_with_enotsock() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/dev/null"), &mut []);
    assert!(fd >= 0, "open /dev/null: fd = {fd}");
    let fd = fd as u32;
    let mut response = [0u8; 32];

    let cases: Vec<(u32, Vec<u8>, usize)> = vec![
        (
            METHOD_SYS_SOCKET_CONNECT,
            socket_connect_req(fd, &sockaddr_in([127, 0, 0, 1], 1)),
            0,
        ),
        (
            METHOD_SYS_SOCKET_BIND,
            socket_bind_req(fd, &sockaddr_in([127, 0, 0, 1], 0)),
            0,
        ),
        (
            METHOD_SYS_SOCKET_LISTEN,
            socket_listen_req(fd, 16).to_vec(),
            0,
        ),
        (METHOD_SYS_SOCKET_SEND, socket_send_req(fd, b"x"), 0),
        (METHOD_SYS_SOCKET_RECV, socket_recv_req(fd, 0).to_vec(), 8),
        (
            METHOD_SYS_SOCKET_ACCEPT,
            socket_accept_req(fd, 0).to_vec(),
            0,
        ),
        (METHOD_SYS_SOCKET_ADDR, socket_fd_req(fd).to_vec(), 32),
        (
            METHOD_SYS_SOCKET_SENDTO,
            socket_sendto_req(fd, 0, &sockaddr_un(b"/tmp/nope"), b"x"),
            0,
        ),
        (
            METHOD_SYS_SOCKET_SENDMSG,
            socket_sendmsg_req(fd, b"x", &[]),
            0,
        ),
        (
            METHOD_SYS_SOCKET_RECVMSG,
            socket_recvmsg_req(fd, 0, 8).to_vec(),
            12,
        ),
    ];

    for (method, req, response_len) in cases {
        assert_eq!(
            dispatch(method, 1, &req, &mut response[..response_len]),
            -(abi::ENOTSOCK as i64),
            "method {method:#x} should reject file fd {fd}"
        );
    }

    assert_eq!(
        crate::kh::test_support::socket_connect_calls(),
        Vec::<(Vec<u8>, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_listen_calls(),
        Vec::<(Vec<u8>, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_send_calls(),
        Vec::<(i32, Vec<u8>)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_recv_calls(),
        Vec::<(i32, usize, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_addr_calls(),
        Vec::<(i32, usize)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_accept_calls(),
        Vec::<(i32, u32)>::new()
    );
}

#[test]
fn socket_state_errors_match_posix_contract() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    let stream_fd = dispatch(
        METHOD_SYS_SOCKET_OPEN,
        1,
        &socket_open_req(2, 1, 0),
        &mut [],
    );
    assert!(stream_fd >= 0, "socket open stream: fd = {stream_fd}");
    let stream_fd = stream_fd as u32;
    let mut response = [0u8; 8];

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECV,
            1,
            &socket_recv_req(stream_fd, 0),
            &mut response
        ),
        -(abi::ENOTCONN as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &stream_fd.to_le_bytes(), &mut response),
        -(abi::ENOTCONN as i64)
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_ACCEPT,
            1,
            &socket_accept_req(stream_fd, 0),
            &mut []
        ),
        -(abi::EINVAL as i64)
    );

    let dgram_fd = dispatch(
        METHOD_SYS_SOCKET_OPEN,
        1,
        &socket_open_req(1, 5, 0),
        &mut [],
    );
    assert!(dgram_fd >= 0, "socket open datagram: fd = {dgram_fd}");
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_ACCEPT,
            1,
            &socket_accept_req(dgram_fd as u32, 0),
            &mut []
        ),
        -(abi::EOPNOTSUPP as i64)
    );

    assert_eq!(
        crate::kh::test_support::socket_recv_calls(),
        Vec::<(i32, usize, u32)>::new()
    );
    assert_eq!(
        crate::kh::test_support::socket_accept_calls(),
        Vec::<(i32, u32)>::new()
    );
}

#[test]
fn socketpair_creates_connected_af_unix_stream_fds() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 1, 0), &mut fds),
        8
    );
    let left = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    assert_eq!((left, right), (3, 4));

    let poll_before = poll_req(0, &[(left as i32, POLLIN | POLLOUT)]);
    let mut poll_out = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_POLL, 1, &poll_before, &mut poll_out), 1);
    assert_eq!(poll_revents(&poll_out, 0), POLLOUT);

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(left, b"hello"),
            &mut []
        ),
        5
    );

    let poll_after = poll_req(0, &[(right as i32, POLLIN | POLLOUT)]);
    let mut poll_out = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_POLL, 1, &poll_after, &mut poll_out), 1);
    assert_eq!(poll_revents(&poll_out, 0), POLLIN | POLLOUT);

    let mut buf = [0u8; 16];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECV,
            1,
            &socket_recv_req(right, 0),
            &mut buf
        ),
        5
    );
    assert_eq!(&buf[..5], b"hello");
}

#[test]
fn unix_stream_send_over_full_peer_buffer_is_eagain() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 1, 0), &mut fds),
        8
    );
    let left = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(fds[4..8].try_into().unwrap());

    let fill = vec![b'z'; crate::kernel::KERNEL_BUFFER_CAP];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(left, &fill),
            &mut []
        ),
        crate::kernel::KERNEL_BUFFER_CAP as i64
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(left, b"!"),
            &mut []
        ),
        -(abi::EAGAIN as i64)
    );

    let mut out = vec![0u8; crate::kernel::KERNEL_BUFFER_CAP + 1];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECV,
            1,
            &socket_recv_req(right, 0),
            &mut out
        ),
        crate::kernel::KERNEL_BUFFER_CAP as i64
    );
    assert_eq!(&out[..crate::kernel::KERNEL_BUFFER_CAP], fill.as_slice());
}

#[test]
fn socketpair_accepts_wasi_af_unix_stream_constants() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(3, 6, 0), &mut fds),
        8
    );
    let left = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    assert_eq!((left, right), (3, 4));
}

#[test]
fn socketpair_preserves_af_unix_datagram_message_boundaries() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(3, 5, 0), &mut fds),
        8
    );
    let left = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(fds[4..8].try_into().unwrap());

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(left, b"first"),
            &mut []
        ),
        5
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(left, b"second"),
            &mut []
        ),
        6
    );

    let mut small = [0u8; 3];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECV,
            1,
            &socket_recv_req(right, 0),
            &mut small
        ),
        3
    );
    assert_eq!(&small, b"fir");

    let mut next = [0u8; 16];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECV,
            1,
            &socket_recv_req(right, 0),
            &mut next
        ),
        6
    );
    assert_eq!(&next[..6], b"second");
}

#[test]
fn af_unix_path_datagram_sendto_delivers_one_message() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/dgram.sock"),
            &mut []
        ),
        0
    );

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDTO,
            1,
            &socket_sendto_req(4, 0, &sockaddr_un(b"/tmp/dgram.sock"), b"first"),
            &mut []
        ),
        5
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDTO,
            1,
            &socket_sendto_req(4, 0, &sockaddr_un(b"/tmp/dgram.sock"), b"second"),
            &mut []
        ),
        6
    );

    let poll_req = poll_req(0, &[(3, POLLIN | POLLOUT)]);
    let mut poll_out = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_POLL, 1, &poll_req, &mut poll_out), 1);
    assert_eq!(poll_revents(&poll_out, 0), POLLIN | POLLOUT);

    let mut small = [0u8; 3];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECV,
            1,
            &socket_recv_req(3, 0),
            &mut small
        ),
        3
    );
    assert_eq!(&small, b"fir");

    let mut next = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(3, 0), &mut next),
        6
    );
    assert_eq!(&next[..6], b"second");

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDTO,
            1,
            &socket_sendto_req(4, 0, &sockaddr_un(b"/tmp/missing.sock"), b"x"),
            &mut []
        ),
        -(abi::ECONNREFUSED as i64)
    );
    assert_eq!(
        crate::kh::test_support::socket_send_calls(),
        Vec::<(i32, Vec<u8>)>::new()
    );
}

#[test]
fn af_unix_datagram_recvfrom_reports_sender_path() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/dgram-recv.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(4, b"/tmp/dgram-sender.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDTO,
            1,
            &socket_sendto_req(4, 0, &sockaddr_un(b"/tmp/dgram-recv.sock"), b"ping"),
            &mut []
        ),
        4
    );

    let mut response = [0u8; 4 + 8 + 108];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVFROM,
            1,
            &socket_recvfrom_req(3, 0, 4, 108),
            &mut response
        ),
        4
    );
    assert_eq!(&response[..4], b"ping");
    let path_len = u32::from_le_bytes(response[4..8].try_into().unwrap()) as usize;
    let is_abstract = u32::from_le_bytes(response[8..12].try_into().unwrap());
    assert_eq!(path_len, b"/tmp/dgram-sender.sock".len());
    assert_eq!(is_abstract, 0);
    assert_eq!(&response[12..12 + path_len], b"/tmp/dgram-sender.sock");
}

#[test]
fn socket_recvfrom_rejects_wrapping_layout() {
    let _g = crate::kernel::TestGuard::acquire();
    let request = socket_recvfrom_req(3, 0, u32::MAX, 16);
    let mut response = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECVFROM, 1, &request, &mut response),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn socket_sendto_rejects_wrapping_addr_len() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut request = Vec::new();
    request.extend_from_slice(&3_u32.to_le_bytes());
    request.extend_from_slice(&0_u32.to_le_bytes());
    request.extend_from_slice(&0xffff_fff8_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SENDTO, 1, &request, &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn socket_option_tcp_nodelay_round_trips_on_kernel_socket() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = dispatch(
        METHOD_SYS_SOCKET_OPEN,
        1,
        &socket_open_req(2, 1, 0),
        &mut [],
    ) as u32;

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPTION,
            1,
            &socket_option_req(fd, 1, 0, 0),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPTION,
            1,
            &socket_option_req(fd, 1, 1, 1),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPTION,
            1,
            &socket_option_req(fd, 1, 0, 0),
            &mut []
        ),
        1
    );
}

#[test]
fn socket_option_accepts_advisory_sets_but_rejects_unknown_gets() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = dispatch(
        METHOD_SYS_SOCKET_OPEN,
        1,
        &socket_open_req(2, 1, 0),
        &mut [],
    ) as u32;

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPTION,
            1,
            &socket_option_req(fd, 13, 1, 0),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPTION,
            1,
            &socket_option_req(fd, 13, 0, 0),
            &mut []
        ),
        -(abi::EOPNOTSUPP as i64)
    );
}

#[test]
fn socket_option_rejects_non_socket_fds() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPTION,
            1,
            &socket_option_req(1, 1, 1, 1),
            &mut []
        ),
        -(abi::ENOTSOCK as i64)
    );
}

#[test]
fn socket_message_syscalls_reject_wrapping_lengths() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut pair = [0u8; 8];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 1, 0),
            &mut pair
        ),
        8
    );
    let fd = u32::from_le_bytes(pair[0..4].try_into().unwrap());

    let mut sendmsg = Vec::new();
    sendmsg.extend_from_slice(&fd.to_le_bytes());
    sendmsg.extend_from_slice(&u32::MAX.to_le_bytes());
    sendmsg.extend_from_slice(&1u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SENDMSG, 1, &sendmsg, &mut []),
        -(abi::EINVAL as i64)
    );

    let mut recvmsg = Vec::new();
    recvmsg.extend_from_slice(&fd.to_le_bytes());
    recvmsg.extend_from_slice(&0u32.to_le_bytes());
    recvmsg.extend_from_slice(&u32::MAX.to_le_bytes());
    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECVMSG, 1, &recvmsg, &mut out),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn abstract_unix_paths_ignore_trailing_padding_nuls() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(1, 1, 0),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"\0abstract-service\0\0\0"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_LISTEN,
            1,
            &socket_listen_req(3, 4),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(1, 1, 0),
            &mut []
        ),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(4, b"\0abstract-service"),
            &mut []
        ),
        0
    );
}

#[test]
fn af_unix_datagram_connect_allows_send_without_destination() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/dgram-connect-server.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(4, b"/tmp/dgram-connect-server.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(4, b"ping"),
            &mut []
        ),
        4
    );

    let mut response = [0u8; 16];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECV,
            1,
            &socket_recv_req(3, 0),
            &mut response
        ),
        4
    );
    assert_eq!(&response[..4], b"ping");
}

#[test]
fn af_unix_datagram_getpeername_reports_connected_path() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/dgram-peername-server.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(4, b"/tmp/dgram-peername-server.sock"),
            &mut []
        ),
        0
    );

    let mut path = [0u8; 108];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_addr_req(4, 1), &mut path),
        31
    );
    assert_eq!(&path[..31], b"/tmp/dgram-peername-server.sock");
}

#[test]
fn af_unix_getpeername_rejects_unconnected_socket() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    let mut path = [0u8; 108];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_addr_req(3, 1), &mut path),
        -(abi::ENOTCONN as i64)
    );
}

#[test]
fn af_unix_datagram_reconnect_after_old_peer_close_restores_writability() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(3, 5, 0), &mut fds),
        8
    );
    let left = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &right.to_le_bytes(), &mut []),
        0
    );

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(4, b"/tmp/dgram-reconnect.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(left, b"/tmp/dgram-reconnect.sock"),
            &mut []
        ),
        0
    );

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(left, b"ping"),
            &mut []
        ),
        4
    );
    let mut response = [0u8; 16];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECV,
            1,
            &socket_recv_req(4, 0),
            &mut response
        ),
        4
    );
    assert_eq!(&response[..4], b"ping");
}

#[test]
fn af_unix_datagram_sendmsg_preserves_sender_path_for_recvfrom() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/dgram-sendmsg-server.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(4, b"/tmp/dgram-sendmsg-client.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_unix_req(4, b"/tmp/dgram-sendmsg-server.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDMSG,
            1,
            &socket_sendmsg_req(4, b"ping", &[]),
            &mut []
        ),
        4
    );

    let mut response = [0u8; 4 + 8 + 108];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVFROM,
            1,
            &socket_recvfrom_req(3, 0, 4, 108),
            &mut response
        ),
        4
    );
    let path_len = u32::from_le_bytes(response[4..8].try_into().unwrap()) as usize;
    let is_abstract = u32::from_le_bytes(response[8..12].try_into().unwrap());
    assert_eq!(path_len, b"/tmp/dgram-sendmsg-client.sock".len());
    assert_eq!(is_abstract, 0);
    assert_eq!(
        &response[12..12 + path_len],
        b"/tmp/dgram-sendmsg-client.sock"
    );
}

#[test]
fn af_unix_path_datagram_unlink_removes_route_but_close_keeps_inode() {
    let _g = crate::kernel::TestGuard::acquire();

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/dgram-unlink.sock"),
            &mut []
        ),
        0
    );
    let mut stat = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/tmp/dgram-unlink.sock", &mut stat),
        16
    );
    assert_eq!(u32::from_le_bytes(stat[8..12].try_into().unwrap()), 6);
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &3u32.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/tmp/dgram-unlink.sock", &mut stat),
        16
    );

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDTO,
            1,
            &socket_sendto_req(3, 0, &sockaddr_un(b"/tmp/dgram-unlink.sock"), b"x"),
            &mut []
        ),
        -(abi::ECONNREFUSED as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_UNLINK, 1, b"/tmp/dgram-unlink.sock", &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/tmp/dgram-unlink.sock", &mut stat),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn socketpair_accepts_linux_af_unix_datagram_constants() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 2, 0), &mut fds),
        8
    );
    let left = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    assert_eq!((left, right), (3, 4));
}

#[test]
fn socket_sendmsg_recvmsg_transfers_fd_rights() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut socket_fds = [0u8; 8];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 1, 0),
            &mut socket_fds
        ),
        8
    );
    let left = u32::from_le_bytes(socket_fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(socket_fds[4..8].try_into().unwrap());

    let mut pipe_fds = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut pipe_fds), 8);
    let pipe_read = u32::from_le_bytes(pipe_fds[0..4].try_into().unwrap());
    let pipe_write = u32::from_le_bytes(pipe_fds[4..8].try_into().unwrap());

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDMSG,
            1,
            &socket_sendmsg_req(left, b"x", &[pipe_write]),
            &mut []
        ),
        1
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &pipe_write.to_le_bytes(), &mut []),
        0
    );

    let mut recv = [0u8; 1 + 4 + 4];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVMSG,
            1,
            &socket_recvmsg_req(right, 0, 1),
            &mut recv
        ),
        1
    );
    assert_eq!(recv[0], b'x');
    assert_eq!(u32::from_le_bytes(recv[1..5].try_into().unwrap()), 1);
    let received_write = u32::from_le_bytes(recv[5..9].try_into().unwrap());

    let mut write_req = received_write.to_le_bytes().to_vec();
    write_req.extend_from_slice(b"ok");
    assert_eq!(dispatch(METHOD_SYS_WRITE, 1, &write_req, &mut []), 2);
    let mut read_buf = [0u8; 2];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &pipe_read.to_le_bytes(), &mut read_buf),
        2
    );
    assert_eq!(&read_buf, b"ok");
}

#[test]
fn socket_recvmsg_with_tiny_rights_buffer_returns_data_and_truncates_rights() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut socket_fds = [0u8; 8];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 1, 0),
            &mut socket_fds
        ),
        8
    );
    let left = u32::from_le_bytes(socket_fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(socket_fds[4..8].try_into().unwrap());

    let mut pipe_fds = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut pipe_fds), 8);
    let pipe_write = u32::from_le_bytes(pipe_fds[4..8].try_into().unwrap());

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDMSG,
            1,
            &socket_sendmsg_req(left, b"x", &[pipe_write]),
            &mut []
        ),
        1
    );

    let mut recv = [0u8; 1 + 4];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVMSG,
            1,
            &socket_recvmsg_req(right, 0, 1),
            &mut recv
        ),
        1
    );
    assert_eq!(recv[0], b'x');
    assert_eq!(u32::from_le_bytes(recv[1..5].try_into().unwrap()), 1);

    let mut empty = [0u8; 12];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVMSG,
            1,
            &socket_recvmsg_req(right, 0, 8),
            &mut empty
        ),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn socket_recvmsg_peek_preserves_fd_rights_for_real_receive() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut socket_fds = [0u8; 8];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 1, 0),
            &mut socket_fds
        ),
        8
    );
    let left = u32::from_le_bytes(socket_fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(socket_fds[4..8].try_into().unwrap());

    let mut pipe_fds = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut pipe_fds), 8);
    let pipe_read = u32::from_le_bytes(pipe_fds[0..4].try_into().unwrap());
    let pipe_write = u32::from_le_bytes(pipe_fds[4..8].try_into().unwrap());

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDMSG,
            1,
            &socket_sendmsg_req(left, b"x", &[pipe_write]),
            &mut []
        ),
        1
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &pipe_write.to_le_bytes(), &mut []),
        0
    );

    let mut peek = [0u8; 1 + 4 + 4];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVMSG,
            1,
            &socket_recvmsg_req(right, MSG_PEEK, 1),
            &mut peek
        ),
        1
    );
    assert_eq!(peek[0], b'x');
    assert_eq!(u32::from_le_bytes(peek[1..5].try_into().unwrap()), 0);

    let mut recv = [0u8; 1 + 4 + 4];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVMSG,
            1,
            &socket_recvmsg_req(right, 0, 1),
            &mut recv
        ),
        1
    );
    assert_eq!(recv[0], b'x');
    assert_eq!(u32::from_le_bytes(recv[1..5].try_into().unwrap()), 1);
    let received_write = u32::from_le_bytes(recv[5..9].try_into().unwrap());

    let mut write_req = received_write.to_le_bytes().to_vec();
    write_req.extend_from_slice(b"ok");
    assert_eq!(dispatch(METHOD_SYS_WRITE, 1, &write_req, &mut []), 2);
    let mut read_buf = [0u8; 2];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &pipe_read.to_le_bytes(), &mut read_buf),
        2
    );
    assert_eq!(&read_buf, b"ok");
}

#[test]
fn socket_sendmsg_closes_cloned_rights_on_epipe() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut socket_fds = [0u8; 8];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 1, 0),
            &mut socket_fds
        ),
        8
    );
    let left = u32::from_le_bytes(socket_fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(socket_fds[4..8].try_into().unwrap());

    let mut pipe_fds = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut pipe_fds), 8);
    let pipe_read = u32::from_le_bytes(pipe_fds[0..4].try_into().unwrap());
    let pipe_write = u32::from_le_bytes(pipe_fds[4..8].try_into().unwrap());

    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &right.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDMSG,
            1,
            &socket_sendmsg_req(left, b"x", &[pipe_read]),
            &mut []
        ),
        -(abi::EPIPE as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &pipe_read.to_le_bytes(), &mut []),
        0
    );

    let mut write_req = pipe_write.to_le_bytes().to_vec();
    write_req.extend_from_slice(b"x");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &write_req, &mut []),
        -(abi::EPIPE as i64)
    );
}

#[test]
fn host_socket_addr_honors_peer_selector() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_connect_result(91);
    crate::kh::test_support::push_socket_addr_result(&socket_addr_record([127, 0, 0, 1], 6000));
    crate::kh::test_support::push_socket_peer_addr_result(&socket_addr_record(
        [127, 0, 0, 1],
        7000,
    ));

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    let req = socket_connect_req(3, &sockaddr_in([127, 0, 0, 1], 6000));
    assert_eq!(dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &req, &mut []), 0);

    let mut addr = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ADDR, 1, &socket_addr_req(3, 1), &mut addr),
        8
    );
    assert_eq!(&addr[..8], &socket_addr_record([127, 0, 0, 1], 7000));
    assert_eq!(
        crate::kh::test_support::socket_peer_addr_calls(),
        vec![(91, 16)]
    );
}

#[test]
fn socket_sendmsg_rights_queue_over_cap_is_eagain() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut socket_fds = [0u8; 8];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 1, 0),
            &mut socket_fds
        ),
        8
    );
    let left = u32::from_le_bytes(socket_fds[0..4].try_into().unwrap());

    let mut pipe_fds = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut pipe_fds), 8);
    let pipe_read = u32::from_le_bytes(pipe_fds[0..4].try_into().unwrap());

    for _ in 0..crate::kernel::KERNEL_RIGHTS_QUEUE_CAP {
        assert_eq!(
            dispatch(
                METHOD_SYS_SOCKET_SENDMSG,
                1,
                &socket_sendmsg_req(left, b"", &[pipe_read]),
                &mut []
            ),
            0
        );
    }
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDMSG,
            1,
            &socket_sendmsg_req(left, b"", &[pipe_read]),
            &mut []
        ),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn socketpair_close_reports_hangup_and_eof_to_peer() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 1, 0), &mut fds),
        8
    );
    let left = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(fds[4..8].try_into().unwrap());

    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &left.to_le_bytes(), &mut []),
        0
    );
    let poll_after = poll_req(0, &[(right as i32, POLLIN | POLLOUT)]);
    let mut poll_out = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_POLL, 1, &poll_after, &mut poll_out), 1);
    assert_eq!(poll_revents(&poll_out, 0), POLLHUP);

    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECV,
            1,
            &socket_recv_req(right, 0),
            &mut buf
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(right, b"x"),
            &mut []
        ),
        -(abi::EPIPE as i64)
    );
}

#[test]
fn poll_reports_socket_write_readiness_and_closed_fd_invalid() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_connect_result(111);

    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    let req = socket_connect_req(3, &sockaddr_in([127, 0, 0, 1], 7000));
    assert_eq!(dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &req, &mut []), 0);

    let req = poll_req(0, &[(3, POLLIN | POLLOUT)]);
    let mut out = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_POLL, 1, &req, &mut out), 1);
    assert_eq!(poll_revents(&out, 0), POLLOUT);

    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &3_u32.to_le_bytes(), &mut []),
        0
    );
    let req = poll_req(0, &[(3, POLLOUT)]);
    let mut out = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_POLL, 1, &req, &mut out), 1);
    assert_eq!(poll_revents(&out, 0), POLLNVAL);
}

#[test]
fn pipe_allocates_two_consecutive_fds_and_round_trips_bytes() {
    let _g = crate::kernel::TestGuard::acquire();
    // pipe() with default fd table {0,1,2} → read on 3, write on 4.
    let mut fds = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds), 8);
    let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    assert_eq!(read_fd, 3);
    assert_eq!(write_fd, 4);

    // Write "hello" to write_fd.
    let mut wreq = Vec::new();
    wreq.extend_from_slice(&write_fd.to_le_bytes());
    wreq.extend_from_slice(b"hello");
    assert_eq!(dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []), 5);

    // Read it back from read_fd.
    let mut buf = [0u8; 16];
    let n = dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf);
    assert_eq!(n, 5);
    assert_eq!(&buf[..5], b"hello");
}

#[test]
fn pipe_read_with_no_data_and_writers_attached_is_eagain() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
    let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let mut buf = [0u8; 16];
    // Empty buffer, writer still open → -EAGAIN.
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn pipe_read_from_write_end_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
    let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    let mut buf = [0u8; 16];

    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &write_fd.to_le_bytes(), &mut buf),
        -(abi::EBADF as i64)
    );
}

#[test]
fn pipe_read_after_writer_closed_and_drained_is_eof() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
    let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());

    // Close the writer (no data was written).
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &write_fd.to_le_bytes(), &mut []),
        0
    );
    let mut buf = [0u8; 16];
    // Drained + no writers → 0 (EOF), not EAGAIN.
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf),
        0
    );
}

#[test]
fn pipe_write_after_all_readers_closed_is_epipe() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
    let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());

    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &read_fd.to_le_bytes(), &mut []),
        0
    );
    let mut wreq = Vec::new();
    wreq.extend_from_slice(&write_fd.to_le_bytes());
    wreq.extend_from_slice(b"x");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
        -(abi::EPIPE as i64)
    );
}

#[test]
fn pipe_write_over_full_buffer_is_eagain_and_preserves_existing_bytes() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
    let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());

    let fill = vec![b'a'; crate::kernel::KERNEL_BUFFER_CAP];
    let mut wreq = write_fd.to_le_bytes().to_vec();
    wreq.extend_from_slice(&fill);
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
        crate::kernel::KERNEL_BUFFER_CAP as i64
    );

    let mut extra = write_fd.to_le_bytes().to_vec();
    extra.extend_from_slice(b"b");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &extra, &mut []),
        -(abi::EAGAIN as i64)
    );

    let mut out = vec![0u8; crate::kernel::KERNEL_BUFFER_CAP + 1];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut out),
        crate::kernel::KERNEL_BUFFER_CAP as i64
    );
    assert_eq!(&out[..crate::kernel::KERNEL_BUFFER_CAP], fill.as_slice());
}

#[test]
fn pipe_dup_increments_refcount_so_close_does_not_drop_buffer() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
    let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());

    // Dup the writer so we have two write-end fds.
    let dup_writer = dispatch(METHOD_SYS_DUP, 1, &write_fd.to_le_bytes(), &mut []);
    assert!(dup_writer > 0);
    let dup_writer = dup_writer as u32;

    // Close the original writer; the second one keeps the pipe open.
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &write_fd.to_le_bytes(), &mut []),
        0
    );

    // Reader should still see EAGAIN (writers attached), not EOF.
    let mut buf = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf),
        -(abi::EAGAIN as i64)
    );

    // Closing the dup_writer drops the last write-end → reader EOF.
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &dup_writer.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut buf),
        0
    );
}

#[test]
fn pipe_partial_read_returns_min_of_buffer_and_response() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
    let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());

    let mut wreq = Vec::new();
    wreq.extend_from_slice(&write_fd.to_le_bytes());
    wreq.extend_from_slice(b"abcdefghij");
    dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []);

    // Small response buffer → reads partial.
    let mut small = [0u8; 4];
    let n = dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut small);
    assert_eq!(n, 4);
    assert_eq!(&small, b"abcd");

    // Subsequent read drains the rest.
    let mut rest = [0u8; 16];
    let n = dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut rest);
    assert_eq!(n, 6);
    assert_eq!(&rest[..6], b"efghij");
}

#[test]
fn poll_reports_file_pipe_hangup_and_invalid_fd_readiness() {
    let _g = crate::kernel::TestGuard::acquire();

    let mut reg = 9_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(b"/poll.txt");
    reg.extend_from_slice(b"data");
    assert_eq!(dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []), 0);
    let file_fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/poll.txt"), &mut []);
    assert!(file_fd >= 0);
    let file_fd = file_fd as i32;

    let mut pipe_fds = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut pipe_fds), 8);
    let read_fd = u32::from_le_bytes(pipe_fds[0..4].try_into().unwrap());
    let write_fd = u32::from_le_bytes(pipe_fds[4..8].try_into().unwrap());

    let req = poll_req(
        0,
        &[
            (file_fd, POLLIN | POLLOUT),
            (read_fd as i32, POLLIN),
            (write_fd as i32, POLLOUT),
            (999, POLLIN),
            (-1, POLLIN),
        ],
    );
    let mut out = [0u8; 40];
    assert_eq!(dispatch(METHOD_SYS_POLL, 1, &req, &mut out), 3);
    assert_eq!(poll_revents(&out, 0), POLLIN | POLLOUT);
    assert_eq!(poll_revents(&out, 1), 0);
    assert_eq!(poll_revents(&out, 2), POLLOUT);
    assert_eq!(poll_revents(&out, 3), POLLNVAL);
    assert_eq!(poll_revents(&out, 4), 0);

    let mut wreq = write_fd.to_le_bytes().to_vec();
    wreq.extend_from_slice(b"x");
    assert_eq!(dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []), 1);
    assert_eq!(
        dispatch(
            METHOD_SYS_POLL,
            1,
            &poll_req(0, &[(read_fd as i32, POLLIN)]),
            &mut out[..8],
        ),
        1
    );
    assert_eq!(poll_revents(&out, 0), POLLIN);

    let mut byte = [0u8; 1];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &read_fd.to_le_bytes(), &mut byte),
        1
    );
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &write_fd.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_POLL,
            1,
            &poll_req(0, &[(read_fd as i32, POLLIN)]),
            &mut out[..8],
        ),
        1
    );
    assert_eq!(poll_revents(&out, 0), POLLHUP);
}

#[test]
fn write_to_stdout_buffers_in_per_pid_state() {
    // sys_write to fd 1 (Stdout) appends to Process.stdout_buffer;
    // METHOD_KERNEL_DRAIN_STDOUT reads it back.
    let _g = crate::kernel::TestGuard::acquire();
    let mut wreq = Vec::new();
    wreq.extend_from_slice(&1_u32.to_le_bytes());
    wreq.extend_from_slice(b"hello stdout");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
        "hello stdout".len() as i64
    );
    // Drain the buffer via METHOD_KERNEL_DRAIN_STDOUT and verify.
    let mut buf = [0u8; 64];
    let drain_req = 1_u32.to_le_bytes();
    let n = dispatch(METHOD_KERNEL_DRAIN_STDOUT, 0, &drain_req, &mut buf);
    assert_eq!(n, "hello stdout".len() as i64);
    assert_eq!(&buf[..n as usize], b"hello stdout");
    // Subsequent drain returns 0.
    assert_eq!(
        dispatch(METHOD_KERNEL_DRAIN_STDOUT, 0, &drain_req, &mut buf),
        0
    );
}

#[test]
fn stdout_buffer_over_cap_is_eagain() {
    let _g = crate::kernel::TestGuard::acquire();
    let fill = vec![b'x'; crate::kernel::KERNEL_BUFFER_CAP];
    let mut wreq = 1_u32.to_le_bytes().to_vec();
    wreq.extend_from_slice(&fill);
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
        crate::kernel::KERNEL_BUFFER_CAP as i64
    );

    let mut extra = 1_u32.to_le_bytes().to_vec();
    extra.extend_from_slice(b"y");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &extra, &mut []),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn provide_stdin_over_cap_is_eagain() {
    let _g = crate::kernel::TestGuard::acquire();
    let pid = 9_u32;
    crate::kernel::with_kernel(|k| {
        k.process_mut(pid);
    });

    let fill = vec![b'x'; crate::kernel::KERNEL_BUFFER_CAP];
    let mut req = pid.to_le_bytes().to_vec();
    req.extend_from_slice(&fill);
    assert_eq!(provide_stdin(&req), crate::kernel::KERNEL_BUFFER_CAP as i64);

    let mut extra = pid.to_le_bytes().to_vec();
    extra.extend_from_slice(b"y");
    assert_eq!(provide_stdin(&extra), -(abi::EAGAIN as i64));
}

#[test]
fn write_to_stderr_uses_separate_per_pid_buffer() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut w = Vec::new();
    w.extend_from_slice(&2_u32.to_le_bytes());
    w.extend_from_slice(b"err msg");
    dispatch(METHOD_SYS_WRITE, 1, &w, &mut []);

    // Stderr drains separately; stdout is empty.
    let drain_req = 1_u32.to_le_bytes();
    let mut buf = [0u8; 64];
    assert_eq!(
        dispatch(METHOD_KERNEL_DRAIN_STDOUT, 0, &drain_req, &mut buf),
        0
    );
    let n = dispatch(METHOD_KERNEL_DRAIN_STDERR, 0, &drain_req, &mut buf);
    assert_eq!(n, "err msg".len() as i64);
    assert_eq!(&buf[..n as usize], b"err msg");
}

#[test]
fn stdout_buffers_are_per_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    // Pid 1 writes "alpha"; pid 2 writes "beta".
    let mut w1 = Vec::new();
    w1.extend_from_slice(&1_u32.to_le_bytes());
    w1.extend_from_slice(b"alpha");
    dispatch(METHOD_SYS_WRITE, 1, &w1, &mut []);
    let mut w2 = Vec::new();
    w2.extend_from_slice(&1_u32.to_le_bytes());
    w2.extend_from_slice(b"beta");
    dispatch(METHOD_SYS_WRITE, 2, &w2, &mut []);

    let mut buf = [0u8; 64];
    let n = dispatch(
        METHOD_KERNEL_DRAIN_STDOUT,
        0,
        &1_u32.to_le_bytes(),
        &mut buf,
    );
    assert_eq!(&buf[..n as usize], b"alpha");
    let n = dispatch(
        METHOD_KERNEL_DRAIN_STDOUT,
        0,
        &2_u32.to_le_bytes(),
        &mut buf,
    );
    assert_eq!(&buf[..n as usize], b"beta");
}

#[test]
fn read_from_empty_stdin_without_eof_is_eagain() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn read_from_empty_stdin_with_eof_is_zero() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(1);
    });
    let close_req = 1_u32.to_le_bytes();
    assert_eq!(
        dispatch(METHOD_KERNEL_CLOSE_STDIN, 0, &close_req, &mut []),
        0
    );
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf),
        0
    );
}

#[test]
fn provided_stdin_drains_then_reaches_eof() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(1);
    });
    let mut req = Vec::new();
    req.extend_from_slice(&1_u32.to_le_bytes());
    req.extend_from_slice(b"abcdefg");
    assert_eq!(dispatch(METHOD_KERNEL_PROVIDE_STDIN, 0, &req, &mut []), 7);

    let mut buf = [0u8; 4];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf),
        4
    );
    assert_eq!(&buf, b"abcd");

    let mut buf2 = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf2),
        3
    );
    assert_eq!(&buf2[..3], b"efg");

    // Drained, no EOF yet → -EAGAIN.
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf2),
        -(abi::EAGAIN as i64)
    );

    // After EOF mark → 0.
    let close_req = 1_u32.to_le_bytes();
    dispatch(METHOD_KERNEL_CLOSE_STDIN, 0, &close_req, &mut []);
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf2),
        0
    );
}

#[test]
fn stdin_is_per_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(1);
        k.process_mut(2);
    });
    let mut r1 = Vec::new();
    r1.extend_from_slice(&1_u32.to_le_bytes());
    r1.extend_from_slice(b"alpha");
    dispatch(METHOD_KERNEL_PROVIDE_STDIN, 0, &r1, &mut []);
    let mut r2 = Vec::new();
    r2.extend_from_slice(&2_u32.to_le_bytes());
    r2.extend_from_slice(b"beta");
    dispatch(METHOD_KERNEL_PROVIDE_STDIN, 0, &r2, &mut []);

    let mut buf = [0u8; 16];
    let n = dispatch(METHOD_SYS_READ, 1, &0_u32.to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"alpha");
    let n = dispatch(METHOD_SYS_READ, 2, &0_u32.to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"beta");
}

#[test]
fn isatty_reports_one_for_stdio_and_zero_for_pipe_ends() {
    let _g = crate::kernel::TestGuard::acquire();
    // Default fd table has 0/1/2 → all three report 1.
    for fd in 0..=2u32 {
        assert_eq!(
            dispatch(METHOD_SYS_ISATTY, 1, &fd.to_le_bytes(), &mut []),
            1,
            "fd {fd} should be a tty"
        );
    }
    // Allocate a pipe; both ends report 0.
    let mut fds = [0u8; 8];
    dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
    let read_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let write_fd = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    assert_eq!(
        dispatch(METHOD_SYS_ISATTY, 1, &read_fd.to_le_bytes(), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_ISATTY, 1, &write_fd.to_le_bytes(), &mut []),
        0
    );
}

#[test]
fn isatty_on_closed_fd_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_ISATTY, 1, &99_u32.to_le_bytes(), &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn tty_foreground_pgrp_rejects_missing_and_cross_session_groups() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        let owner = k.process_mut(10);
        owner.sid = 10;
        owner.pgid = 10;
        let foreground = k.process_mut(11);
        foreground.sid = 10;
        foreground.pgid = 11;
        let other_session = k.process_mut(12);
        other_session.sid = 12;
        other_session.pgid = 12;
    });
    assert_eq!(
        dispatch(TEST_METHOD_SYS_TIOCSCTTY, 10, &0_u32.to_le_bytes(), &mut []),
        0
    );

    let mut set_req = Vec::new();
    set_req.extend_from_slice(&0_u32.to_le_bytes());
    set_req.extend_from_slice(&11_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_TCSETPGRP, 10, &set_req, &mut []),
        0
    );
    assert_eq!(
        dispatch(TEST_METHOD_SYS_TCGETPGRP, 10, &0_u32.to_le_bytes(), &mut []),
        11
    );

    let mut missing_req = Vec::new();
    missing_req.extend_from_slice(&0_u32.to_le_bytes());
    missing_req.extend_from_slice(&9999_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_TCSETPGRP, 10, &missing_req, &mut []),
        -(TEST_ENOTTY as i64)
    );
    assert_eq!(
        dispatch(TEST_METHOD_SYS_TCGETPGRP, 10, &0_u32.to_le_bytes(), &mut []),
        11
    );

    let mut cross_session_req = Vec::new();
    cross_session_req.extend_from_slice(&0_u32.to_le_bytes());
    cross_session_req.extend_from_slice(&12_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_TCSETPGRP, 10, &cross_session_req, &mut []),
        -(TEST_ENOTTY as i64)
    );
    assert_eq!(
        dispatch(TEST_METHOD_SYS_TCGETPGRP, 10, &0_u32.to_le_bytes(), &mut []),
        11
    );
}

#[test]
fn tiocsctty_requires_session_leader_on_tty_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(TEST_METHOD_SYS_TIOCSCTTY, 1, &0_u32.to_le_bytes(), &mut []),
        -(abi::EPERM as i64)
    );
    assert_eq!(dispatch(METHOD_SYS_SETSID, 1, &[], &mut []), 1);
    assert_eq!(
        dispatch(TEST_METHOD_SYS_TIOCSCTTY, 1, &0_u32.to_le_bytes(), &mut []),
        0
    );
}

#[test]
fn tty_attrs_and_winsize_are_available_for_stdio_only() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut termios = [0u8; 60];
    assert_eq!(
        dispatch(
            TEST_METHOD_SYS_TCGETATTR,
            1,
            &0_u32.to_le_bytes(),
            &mut termios
        ),
        60
    );
    assert_eq!(
        u32::from_le_bytes(termios[0..4].try_into().unwrap()),
        0x0600
    );
    assert_eq!(
        u32::from_le_bytes(termios[4..8].try_into().unwrap()),
        0x0005
    );
    assert_eq!(
        u32::from_le_bytes(termios[8..12].try_into().unwrap()),
        0x08BF
    );
    assert_eq!(
        u32::from_le_bytes(termios[12..16].try_into().unwrap()),
        0x8A3B
    );
    assert_eq!(&termios[17..24], &[3, 28, 127, 21, 4, 0, 1]);

    let mut set_req = Vec::new();
    set_req.extend_from_slice(&0_u32.to_le_bytes());
    set_req.extend_from_slice(&0_u32.to_le_bytes());
    assert_eq!(dispatch(TEST_METHOD_SYS_TCSETATTR, 1, &set_req, &mut []), 0);

    let mut winsize = [0u8; 8];
    assert_eq!(
        dispatch(
            TEST_METHOD_SYS_WINSIZE,
            1,
            &0_u32.to_le_bytes(),
            &mut winsize
        ),
        8
    );
    assert_eq!(u16::from_le_bytes(winsize[0..2].try_into().unwrap()), 24);
    assert_eq!(u16::from_le_bytes(winsize[2..4].try_into().unwrap()), 80);

    let mut fds = [0u8; 8];
    dispatch(METHOD_SYS_PIPE, 1, &[], &mut fds);
    let pipe_fd = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    assert_eq!(
        dispatch(
            TEST_METHOD_SYS_TCGETATTR,
            1,
            &pipe_fd.to_le_bytes(),
            &mut termios
        ),
        -(TEST_ENOTTY as i64)
    );
    assert_eq!(
        dispatch(
            TEST_METHOD_SYS_WINSIZE,
            1,
            &pipe_fd.to_le_bytes(),
            &mut winsize
        ),
        -(TEST_ENOTTY as i64)
    );
}

#[test]
fn clock_gettime_realtime_returns_kh_now_value() {
    // Native test stub for kh_now_realtime returns
    // 1_700_000_000_000_000_000 ns; check it round-trips.
    let mut buf = [0u8; 8];
    let n = dispatch(METHOD_SYS_CLOCK_GETTIME, 1, &0_u32.to_le_bytes(), &mut buf);
    assert_eq!(n, 8);
    assert_eq!(u64::from_le_bytes(buf), 1_700_000_000_000_000_000_u64);
}

#[test]
fn clock_gettime_unknown_clock_is_einval() {
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_CLOCK_GETTIME, 1, &99_u32.to_le_bytes(), &mut buf),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn getpgid_self_defaults_to_caller_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    // pid 7 with target 0 → "self"; default pgid lazily primes to pid.
    assert_eq!(
        dispatch(METHOD_SYS_GETPGID, 7, &0_u32.to_le_bytes(), &mut []),
        7
    );
}

#[test]
fn setpgid_then_getpgid_round_trips() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        let group = k.process_mut(5);
        group.sid = 1;
        group.pgid = 5;
    });
    let mut req = Vec::new();
    req.extend_from_slice(&0_u32.to_le_bytes()); // target = self
    req.extend_from_slice(&5_u32.to_le_bytes()); // existing same-session pgid
    assert_eq!(dispatch(METHOD_SYS_SETPGID, 1, &req, &mut []), 0);
    assert_eq!(
        dispatch(METHOD_SYS_GETPGID, 1, &0_u32.to_le_bytes(), &mut []),
        5
    );
}

#[test]
fn setpgid_pgid_zero_makes_target_a_group_leader() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(3);
    });
    let mut req = Vec::new();
    req.extend_from_slice(&3_u32.to_le_bytes());
    req.extend_from_slice(&0_u32.to_le_bytes()); // pgid 0 → target's pid
    assert_eq!(dispatch(METHOD_SYS_SETPGID, 1, &req, &mut []), 0);
    assert_eq!(
        dispatch(METHOD_SYS_GETPGID, 1, &3_u32.to_le_bytes(), &mut []),
        3
    );
}

#[test]
fn setpgid_rejects_session_leaders_and_cross_session_groups() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        let parent = k.process_mut(1);
        parent.sid = 1;
        parent.pgid = 1;

        let child = k.process_mut(2);
        child.sid = 1;
        child.pgid = 1;

        let other = k.process_mut(3);
        other.sid = 3;
        other.pgid = 3;
    });

    let mut session_leader_req = Vec::new();
    session_leader_req.extend_from_slice(&3_u32.to_le_bytes());
    session_leader_req.extend_from_slice(&3_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_SETPGID, 1, &session_leader_req, &mut []),
        -(abi::EPERM as i64)
    );

    let mut cross_session_req = Vec::new();
    cross_session_req.extend_from_slice(&2_u32.to_le_bytes());
    cross_session_req.extend_from_slice(&3_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_SETPGID, 1, &cross_session_req, &mut []),
        -(abi::EPERM as i64)
    );

    let mut missing_group_req = Vec::new();
    missing_group_req.extend_from_slice(&2_u32.to_le_bytes());
    missing_group_req.extend_from_slice(&99_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_SETPGID, 1, &missing_group_req, &mut []),
        -(abi::EPERM as i64)
    );
}

#[test]
fn setsid_rejects_process_group_leader_after_group_is_observed() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_GETPGID, 9, &0_u32.to_le_bytes(), &mut []),
        9
    );
    assert_eq!(
        dispatch(METHOD_SYS_SETSID, 9, &[], &mut []),
        -(abi::EPERM as i64)
    );
}

#[test]
fn pgid_is_per_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(2);
    });
    // pid 1 default sees pgid 1; setting pid 2's pgid doesn't move pid 1.
    let mut req = Vec::new();
    req.extend_from_slice(&2_u32.to_le_bytes());
    req.extend_from_slice(&0_u32.to_le_bytes());
    dispatch(METHOD_SYS_SETPGID, 1, &req, &mut []);
    assert_eq!(
        dispatch(METHOD_SYS_GETPGID, 1, &0_u32.to_le_bytes(), &mut []),
        1
    );
    assert_eq!(
        dispatch(METHOD_SYS_GETPGID, 1, &2_u32.to_le_bytes(), &mut []),
        2
    );
}

#[test]
fn setsid_first_call_creates_session_then_repeats_eperm() {
    let _g = crate::kernel::TestGuard::acquire();
    // First setsid from a fresh pid succeeds and returns the pid.
    assert_eq!(dispatch(METHOD_SYS_SETSID, 9, &[], &mut []), 9);
    // sid and pgid are now both 9.
    assert_eq!(
        dispatch(METHOD_SYS_GETSID, 9, &0_u32.to_le_bytes(), &mut []),
        9
    );
    assert_eq!(
        dispatch(METHOD_SYS_GETPGID, 9, &0_u32.to_le_bytes(), &mut []),
        9
    );
    // Second call → EPERM (already a session leader).
    assert_eq!(
        dispatch(METHOD_SYS_SETSID, 9, &[], &mut []),
        -(abi::EPERM as i64)
    );
}

#[test]
fn getsid_self_lazily_primes_to_caller_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_GETSID, 11, &0_u32.to_le_bytes(), &mut []),
        11
    );
}

#[test]
fn kill_sig_zero_is_alive_probe_and_succeeds() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(5);
    });
    let mut req = Vec::new();
    req.extend_from_slice(&5_u32.to_le_bytes()); // target
    req.extend_from_slice(&0_u32.to_le_bytes()); // sig 0 = probe
    assert_eq!(dispatch(METHOD_SYS_KILL, 1, &req, &mut []), 0);
}

#[test]
fn kill_records_signal_in_pending_mask() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(5);
    });
    let mut req = Vec::new();
    req.extend_from_slice(&5_u32.to_le_bytes()); // target pid
    req.extend_from_slice(&15_u32.to_le_bytes()); // SIGTERM
    assert_eq!(dispatch(METHOD_SYS_KILL, 1, &req, &mut []), 0);
    // Bit 14 (sig 15 - 1) should now be set on pid 5.
    let pending = crate::kernel::with_kernel(|k| k.process_mut(5).pending_signals);
    assert_eq!(pending, 1u64 << 14);
}

#[test]
fn kill_records_nonfatal_signal_without_exiting_process() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(5).host_instance_handle = Some(42);
    });

    assert_eq!(kill_pid(5, 17), 0); // SIGCHLD is not fatal.

    let (pending, handle, exit_status) = crate::kernel::with_kernel(|k| {
        let p = k.process_mut(5);
        (p.pending_signals, p.host_instance_handle, p.exit_status)
    });
    assert_eq!(pending, 1u64 << 16);
    assert_eq!(handle, Some(42));
    assert_eq!(exit_status, None);
}

#[test]
fn kill_leaves_host_instance_handle_until_signal_delivery() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(5).host_instance_handle = Some(42);
    });
    assert_eq!(kill_pid(5, 15), 0);
    let (handle, exit_status) = crate::kernel::with_kernel(|k| {
        let p = k.process_mut(5);
        (p.host_instance_handle, p.exit_status)
    });
    assert_eq!(handle, Some(42));
    assert_eq!(exit_status, None);
}

#[test]
fn kill_unknown_pid_is_esrch_and_does_not_create_process() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(kill_pid(999_999, 0), -(abi::ESRCH as i64));
    assert_eq!(kill_pid(999_999, 15), -(abi::ESRCH as i64));
    assert!(!crate::kernel::with_kernel(|k| k.has_process(999_999)));
}

#[test]
fn kill_out_of_range_sig_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&5_u32.to_le_bytes());
    req.extend_from_slice(&64_u32.to_le_bytes()); // 1..=63 only
    assert_eq!(
        dispatch(METHOD_SYS_KILL, 1, &req, &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn killpg_records_signal_for_live_group_members_only() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        let caller = k.process_mut(1);
        caller.pgid = 7;
        caller.sid = 1;

        let member = k.process_mut(2);
        member.pgid = 7;
        member.sid = 1;

        let exited_member = k.process_mut(3);
        exited_member.pgid = 7;
        exited_member.sid = 1;
        exited_member.exit_status = Some(0);

        let other_group = k.process_mut(4);
        other_group.pgid = 8;
        other_group.sid = 1;
    });

    let mut req = Vec::new();
    req.extend_from_slice(&7_u32.to_le_bytes());
    req.extend_from_slice(&15_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_KILLPG, 1, &req, &mut []), 0);

    let (caller_pending, member_pending, exited_pending, other_pending) =
        crate::kernel::with_kernel(|k| {
            (
                k.process_mut(1).pending_signals,
                k.process_mut(2).pending_signals,
                k.process_mut(3).pending_signals,
                k.process_mut(4).pending_signals,
            )
        });
    assert_eq!(caller_pending, 1u64 << 14);
    assert_eq!(member_pending, 1u64 << 14);
    assert_eq!(exited_pending, 0);
    assert_eq!(other_pending, 0);
}

#[test]
fn killpg_zero_uses_callers_process_group_as_alive_probe() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.process_mut(11);
    });

    let mut req = Vec::new();
    req.extend_from_slice(&0_u32.to_le_bytes()); // pgid 0 = caller's group
    req.extend_from_slice(&0_u32.to_le_bytes()); // sig 0 = probe
    assert_eq!(dispatch(METHOD_SYS_KILLPG, 11, &req, &mut []), 0);
    assert_eq!(crate::kernel::with_kernel(|k| k.process_mut(11).pgid), 11);
    assert_eq!(
        crate::kernel::with_kernel(|k| k.process_mut(11).pending_signals),
        0
    );
}

#[test]
fn killpg_missing_group_and_bad_signal_return_errors() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut missing = Vec::new();
    missing.extend_from_slice(&99_u32.to_le_bytes());
    missing.extend_from_slice(&0_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_KILLPG, 1, &missing, &mut []),
        -(abi::ESRCH as i64)
    );

    let mut bad_sig = Vec::new();
    bad_sig.extend_from_slice(&1_u32.to_le_bytes());
    bad_sig.extend_from_slice(&64_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_KILLPG, 1, &bad_sig, &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn sigaction_returns_previous_disposition_and_persists_new() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&15_u32.to_le_bytes()); // SIGTERM
    req.extend_from_slice(&0xCAFEBABE_u32.to_le_bytes()); // user handler
    assert_eq!(dispatch(METHOD_SYS_SIGACTION, 1, &req, &mut []), 0); // prev was SIG_DFL

    // Replace with SIG_IGN; should report 0xCAFEBABE as previous.
    let mut req2 = Vec::new();
    req2.extend_from_slice(&15_u32.to_le_bytes());
    req2.extend_from_slice(&1_u32.to_le_bytes()); // SIG_IGN
    assert_eq!(
        dispatch(METHOD_SYS_SIGACTION, 1, &req2, &mut []),
        0xCAFEBABE_i64
    );
}

#[test]
fn sigaction_is_per_pid_per_sig() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&15_u32.to_le_bytes());
    req.extend_from_slice(&7_u32.to_le_bytes());
    dispatch(METHOD_SYS_SIGACTION, 1, &req, &mut []);

    // pid 2, same sig: still SIG_DFL.
    let mut probe = Vec::new();
    probe.extend_from_slice(&15_u32.to_le_bytes());
    probe.extend_from_slice(&0_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_SIGACTION, 2, &probe, &mut []), 0);

    // pid 1, different sig: still SIG_DFL.
    let mut other = Vec::new();
    other.extend_from_slice(&9_u32.to_le_bytes()); // SIGKILL
    other.extend_from_slice(&0_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_SIGACTION, 1, &other, &mut []), 0);
}

#[test]
fn sched_yield_increments_per_pid_counter() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_SCHED_YIELD, 1, &[], &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_SCHED_YIELD, 1, &[], &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_SCHED_YIELD, 2, &[], &mut []), 0);
    let (y1, y2) = crate::kernel::with_kernel(|k| {
        (k.process_mut(1).yield_count, k.process_mut(2).yield_count)
    });
    assert_eq!(y1, 2);
    assert_eq!(y2, 1);
}

#[test]
fn nanosleep_records_requested_duration() {
    let _g = crate::kernel::TestGuard::acquire();
    let req = 5_000_000_000_u64.to_le_bytes(); // 5 seconds
    assert_eq!(dispatch(METHOD_SYS_NANOSLEEP, 1, &req, &mut []), 0);
    let recorded = crate::kernel::with_kernel(|k| k.process_mut(1).last_nanosleep_ns);
    assert_eq!(recorded, 5_000_000_000);
}

#[test]
fn nanosleep_short_request_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_NANOSLEEP, 1, &[1, 2, 3], &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn register_file_then_open_then_read_round_trips_content() {
    let _g = crate::kernel::TestGuard::acquire();
    // Install /etc/hello with content "hi from ramfs".
    let mut req = Vec::new();
    let path: &[u8] = b"/etc/hello";
    req.extend_from_slice(&(path.len() as u32).to_le_bytes());
    req.extend_from_slice(path);
    req.extend_from_slice(b"hi from ramfs");
    assert_eq!(dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &req, &mut []), 0);

    // Open it; expect the lowest free fd (3, since 0/1/2 are stdio).
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, path), &mut []);
    assert_eq!(fd, 3);

    // Read all bytes.
    let mut buf = [0u8; 64];
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(n as usize, b"hi from ramfs".len());
    assert_eq!(&buf[..n as usize], b"hi from ramfs");

    // Subsequent read at EOF returns 0.
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(n, 0);

    // close the file fd.
    assert_eq!(
        dispatch(METHOD_SYS_CLOSE, 1, &(fd as u32).to_le_bytes(), &mut []),
        0
    );
}

#[test]
fn open_nonexistent_path_is_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/no/such"), &mut []),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn hostfs_open_propagates_host_errno() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_KERNEL_INSTALL_HOST_FS_MOUNT, 0, b"/host", &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/host/missing"), &mut []),
        -(abi::ENOSYS as i64)
    );
}

#[test]
fn write_to_ramfs_file_fd_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    reg.extend_from_slice(b"/zero");
    reg.extend_from_slice(b"abc");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/zero"), &mut []);
    assert!(fd >= 0);
    let mut wreq = Vec::new();
    wreq.extend_from_slice(&(fd as u32).to_le_bytes());
    wreq.extend_from_slice(b"NOPE");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
        -(abi::EBADF as i64),
        "ramfs is read-only in Phase 2"
    );
}

#[test]
fn ramfs_partial_read_advances_offset() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&7_u32.to_le_bytes());
    reg.extend_from_slice(b"/abcdef");
    reg.extend_from_slice(b"0123456789");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/abcdef"), &mut []) as u32;

    let mut small = [0u8; 4];
    let n = dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut small);
    assert_eq!(n, 4);
    assert_eq!(&small, b"0123");

    let mut rest = [0u8; 16];
    let n = dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut rest);
    assert_eq!(n, 6);
    assert_eq!(&rest[..6], b"456789");
}

#[test]
fn dup_of_file_fd_shares_ofd_cursor() {
    // POSIX: dup'd fds share the open-file-description cursor.
    // Read 4 bytes via fd, then read 4 more via duped fd — the
    // duped fd should pick up at offset 4, not start over at 0.
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&6_u32.to_le_bytes());
    reg.extend_from_slice(b"/abcde");
    reg.extend_from_slice(b"0123456789");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/abcde"), &mut []) as u32;

    let mut buf = [0u8; 4];
    assert_eq!(dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut buf), 4);
    assert_eq!(&buf, b"0123");

    let dupfd = dispatch(METHOD_SYS_DUP, 1, &fd.to_le_bytes(), &mut []) as u32;
    let mut buf2 = [0u8; 4];
    let n = dispatch(METHOD_SYS_READ, 1, &dupfd.to_le_bytes(), &mut buf2);
    assert_eq!(n, 4, "duped fd shares offset, sees bytes 4..8");
    assert_eq!(&buf2, b"4567");
}

#[test]
fn close_one_file_fd_keeps_ofd_alive_via_dup() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    reg.extend_from_slice(b"/keep");
    reg.extend_from_slice(b"abc");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/keep"), &mut []) as u32;
    let dup = dispatch(METHOD_SYS_DUP, 1, &fd.to_le_bytes(), &mut []) as u32;

    // Close the original — the duped fd should still read fine.
    assert_eq!(dispatch(METHOD_SYS_CLOSE, 1, &fd.to_le_bytes(), &mut []), 0);
    let mut buf = [0u8; 8];
    let n = dispatch(METHOD_SYS_READ, 1, &dup.to_le_bytes(), &mut buf);
    assert_eq!(n, 3);
    assert_eq!(&buf[..3], b"abc");
}

#[test]
fn lseek_set_then_read_picks_up_at_new_offset() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    reg.extend_from_slice(b"/seek");
    reg.extend_from_slice(b"0123456789");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/seek"), &mut []) as u32;

    // Seek to offset 4 (whence=SET).
    let mut req = Vec::new();
    req.extend_from_slice(&fd.to_le_bytes());
    req.extend_from_slice(&4_i64.to_le_bytes());
    req.extend_from_slice(&0_u32.to_le_bytes());
    let mut out = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_LSEEK, 1, &req, &mut out), 8);
    assert_eq!(i64::from_le_bytes(out), 4);

    // Read should now start at "4".
    let mut buf = [0u8; 4];
    assert_eq!(dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut buf), 4);
    assert_eq!(&buf, b"4567");
}

#[test]
fn lseek_end_then_cur_compose() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&4_u32.to_le_bytes());
    reg.extend_from_slice(b"/end");
    reg.extend_from_slice(b"abcdefgh"); // 8 bytes
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/end"), &mut []) as u32;

    // Seek to END - 2.
    let mut req = Vec::new();
    req.extend_from_slice(&fd.to_le_bytes());
    req.extend_from_slice(&(-2_i64).to_le_bytes());
    req.extend_from_slice(&2_u32.to_le_bytes());
    let mut out = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_LSEEK, 1, &req, &mut out), 8);
    assert_eq!(i64::from_le_bytes(out), 6);

    // Now CUR + 1.
    let mut req = Vec::new();
    req.extend_from_slice(&fd.to_le_bytes());
    req.extend_from_slice(&1_i64.to_le_bytes());
    req.extend_from_slice(&1_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_LSEEK, 1, &req, &mut out), 8);
    assert_eq!(i64::from_le_bytes(out), 7);
}

#[test]
fn lseek_negative_resulting_offset_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    reg.extend_from_slice(b"/ng");
    reg.extend_from_slice(b"hi");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/ng"), &mut []) as u32;

    let mut req = Vec::new();
    req.extend_from_slice(&fd.to_le_bytes());
    req.extend_from_slice(&(-5_i64).to_le_bytes());
    req.extend_from_slice(&0_u32.to_le_bytes()); // SET
    let mut out = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_LSEEK, 1, &req, &mut out),
        -(abi::EINVAL as i64),
    );
}

#[test]
fn fstat_reports_size_and_filetype() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&4_u32.to_le_bytes());
    reg.extend_from_slice(b"/sta");
    reg.extend_from_slice(b"hello"); // 5 bytes
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/sta"), &mut []) as u32;

    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_FSTAT, 1, &fd.to_le_bytes(), &mut out),
        16
    );
    assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 5);
    assert_eq!(u32::from_le_bytes(out[8..12].try_into().unwrap()), 4); // REGULAR_FILE

    // fstat on stdin (fd 0) reports filetype=2 CHARACTER_DEVICE.
    let mut out2 = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_FSTAT, 1, &0_u32.to_le_bytes(), &mut out2),
        16
    );
    assert_eq!(u32::from_le_bytes(out2[8..12].try_into().unwrap()), 2);
}

#[test]
fn open_with_create_installs_empty_file() {
    let _g = crate::kernel::TestGuard::acquire();
    // No prior register. Path doesn't exist; CREAT should make it.
    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_WRITE | O_CREAT, b"/new"),
        &mut [],
    );
    assert!(fd >= 0, "CREAT created /new, fd = {fd}");
    // Write some bytes.
    let mut wreq = Vec::new();
    wreq.extend_from_slice(&(fd as u32).to_le_bytes());
    wreq.extend_from_slice(b"hello world");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
        "hello world".len() as i64
    );
    // Reopen read-only and read it back.
    let rfd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/new"), &mut []);
    let mut buf = [0u8; 32];
    let n = dispatch(METHOD_SYS_READ, 1, &(rfd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"hello world");
}

#[test]
fn path_syscalls_normalize_parent_components_for_existing_paths() {
    let _g = crate::kernel::TestGuard::acquire();
    make_root(1);
    let mut reg = Vec::new();
    reg.extend_from_slice(&7_u32.to_le_bytes());
    reg.extend_from_slice(b"/target");
    reg.extend_from_slice(b"payload");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/tmp/../target"), &mut []);
    assert!(fd >= 0, "open through parent components failed: {fd}");

    let mut stat = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/tmp/../target", &mut stat),
        16
    );

    let mut chmod_req = 0o600_u32.to_le_bytes().to_vec();
    chmod_req.extend_from_slice(b"/tmp/../target");
    assert_eq!(dispatch(METHOD_SYS_CHMOD, 1, &chmod_req, &mut []), 0);

    assert_eq!(
        dispatch(METHOD_SYS_UNLINK, 1, b"/tmp/../target", &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/target"), &mut []),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn path_syscalls_normalize_parent_components_for_created_paths() {
    let _g = crate::kernel::TestGuard::acquire();

    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/tmp", &mut []), 0);
    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_WRITE | O_CREAT, b"/tmp/../made"),
        &mut [],
    );
    assert!(fd >= 0, "create through parent components failed: {fd}");
    assert!(
        dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/made"), &mut []) >= 0,
        "created file should live at normalized path"
    );

    let mut rename_req = (b"/made".len() as u32).to_le_bytes().to_vec();
    rename_req.extend_from_slice(b"/made");
    rename_req.extend_from_slice(b"/tmp/../renamed");
    assert_eq!(dispatch(METHOD_SYS_RENAME, 1, &rename_req, &mut []), 0);
    assert!(dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/renamed"), &mut []) >= 0);

    let mut link_req = (b"/renamed".len() as u32).to_le_bytes().to_vec();
    link_req.extend_from_slice(b"/renamed");
    link_req.extend_from_slice(b"/tmp/../linked");
    assert_eq!(dispatch(METHOD_SYS_LINK, 1, &link_req, &mut []), 0);
    assert!(dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/linked"), &mut []) >= 0);

    let mut symlink_req = (b"/renamed".len() as u32).to_le_bytes().to_vec();
    symlink_req.extend_from_slice(b"/renamed");
    symlink_req.extend_from_slice(b"/tmp/../alias");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &symlink_req, &mut []), 0);
    let mut out = [0u8; 32];
    let n = dispatch(METHOD_SYS_READLINK, 1, b"/alias", &mut out);
    assert_eq!(&out[..n as usize], b"/renamed");
}

#[test]
fn write_to_readonly_open_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    reg.extend_from_slice(b"/ro");
    reg.extend_from_slice(b"abc");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/ro"), &mut []);
    let mut wreq = Vec::new();
    wreq.extend_from_slice(&(fd as u32).to_le_bytes());
    wreq.extend_from_slice(b"NO");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn open_with_trunc_clears_existing_content() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    reg.extend_from_slice(b"/tr");
    reg.extend_from_slice(b"existing-data");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    // Open with WRITE | TRUNC → file becomes empty.
    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_WRITE | O_TRUNC, b"/tr"),
        &mut [],
    ) as u32;
    // fstat now reports size 0.
    let mut out = [0u8; 16];
    dispatch(METHOD_SYS_FSTAT, 1, &fd.to_le_bytes(), &mut out);
    assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 0);
}

#[test]
fn write_grows_file_and_advances_ofd_offset() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_WRITE | O_CREAT, b"/grow"),
        &mut [],
    ) as u32;
    // Write twice.
    for chunk in [b"abc".as_slice(), b"def"] {
        let mut w = Vec::new();
        w.extend_from_slice(&fd.to_le_bytes());
        w.extend_from_slice(chunk);
        assert_eq!(
            dispatch(METHOD_SYS_WRITE, 1, &w, &mut []),
            chunk.len() as i64
        );
    }
    // Open read-only and verify "abcdef".
    let rfd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/grow"), &mut []);
    let mut buf = [0u8; 16];
    let n = dispatch(METHOD_SYS_READ, 1, &(rfd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"abcdef");
}

#[test]
fn dev_null_open_read_write() {
    let _g = crate::kernel::TestGuard::acquire();
    // /dev is auto-mounted; /dev/null is read+writable.
    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_WRITE, b"/dev/null"),
        &mut [],
    );
    assert!(fd >= 0, "open /dev/null: fd = {fd}");
    // Read returns 0 (EOF immediately).
    let mut buf = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf),
        0
    );
    // Writes succeed and report payload.len() bytes consumed.
    let mut w = Vec::new();
    w.extend_from_slice(&(fd as u32).to_le_bytes());
    w.extend_from_slice(b"discard me");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &w, &mut []),
        "discard me".len() as i64
    );
}

#[test]
fn dev_zero_yields_zero_bytes() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/dev/zero"), &mut []);
    let mut buf = [0xffu8; 8];
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(n, 8);
    assert_eq!(&buf, &[0u8; 8]);
}

#[test]
fn socket_send_rejects_unknown_kernel_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = Vec::new();
    req.extend_from_slice(&7_u32.to_le_bytes());
    req.extend_from_slice(b"abc");
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SEND, 1, &req, &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn dev_namespace_refuses_create() {
    let _g = crate::kernel::TestGuard::acquire();
    // /dev is a fixed namespace; CREAT inside it returns -EPERM.
    assert_eq!(
        dispatch(
            METHOD_SYS_OPEN,
            1,
            &open_req(O_WRITE | O_CREAT, b"/dev/whatever"),
            &mut [],
        ),
        -(abi::EPERM as i64)
    );
}

#[test]
fn root_mount_owns_paths_that_only_share_a_prefix_with_dev() {
    // Regression: longest-prefix-match must respect component
    // boundaries — `/devil` belongs to root, not /dev.
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&6_u32.to_le_bytes());
    reg.extend_from_slice(b"/devil");
    reg.extend_from_slice(b"horns");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/devil"), &mut []);
    let mut buf = [0u8; 16];
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"horns");
}

#[test]
fn proc_self_status_routes_through_caller_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    // First touch a syscall that lazy-inserts pid 7 into the
    // kernel's process map. getpid is a pure caller_pid pass-
    // through so it doesn't qualify; getuid does (it reads from
    // process_mut, which lazy-creates).
    assert_eq!(dispatch(METHOD_SYS_GETUID, 7, &[], &mut []), 1000);

    // Open /proc/self/status as pid 7 → resolves to /proc/7/status.
    let fd = dispatch(
        METHOD_SYS_OPEN,
        7,
        &open_req(0, b"/proc/self/status"),
        &mut [],
    );
    assert!(fd >= 0, "open /proc/self/status: fd = {fd}");

    // Read content and verify the expected lines.
    let mut buf = [0u8; 256];
    let n = dispatch(METHOD_SYS_READ, 7, &(fd as u32).to_le_bytes(), &mut buf);
    assert!(n > 0);
    let text = std::str::from_utf8(&buf[..n as usize]).unwrap();
    assert!(text.contains("Pid:\t7\n"), "expected Pid:\\t7 in: {text}");
    assert!(
        text.contains("Uid:\t1000"),
        "expected default uid in: {text}"
    );
}

#[test]
fn proc_status_reflects_setresuid() {
    let _g = crate::kernel::TestGuard::acquire();
    // Touch pid 5 to register it, then change its uid.
    assert_eq!(dispatch(METHOD_SYS_GETUID, 5, &[], &mut []), 1000);
    make_root(5);
    let mut req = Vec::new();
    req.extend_from_slice(&500_u32.to_le_bytes());
    req.extend_from_slice(&501_u32.to_le_bytes());
    req.extend_from_slice(&502_u32.to_le_bytes());
    dispatch(METHOD_SYS_SETRESUID, 5, &req, &mut []);

    // Re-open /proc/5/status — open-time refresh picks up new uid.
    let fd = dispatch(METHOD_SYS_OPEN, 5, &open_req(0, b"/proc/5/status"), &mut []);
    let mut buf = [0u8; 256];
    let n = dispatch(METHOD_SYS_READ, 5, &(fd as u32).to_le_bytes(), &mut buf);
    let text = std::str::from_utf8(&buf[..n as usize]).unwrap();
    assert!(
        text.contains("Uid:\t500\t501"),
        "uid update missing: {text}"
    );
}

#[test]
fn proc_other_pid_requires_same_process_or_root() {
    let _g = crate::kernel::TestGuard::acquire();
    let argv = set_argv_req(2, &[b"/bin/other"]);
    set_argv(&argv);

    assert_eq!(
        dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/proc/2/status"), &mut []),
        -(abi::EPERM as i64)
    );
    assert!(dispatch(METHOD_SYS_OPEN, 2, &open_req(0, b"/proc/2/status"), &mut []) >= 0);

    make_root(1);
    assert!(dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/proc/2/status"), &mut []) >= 0);
}

#[test]
fn proc_other_pid_metadata_queries_are_gated() {
    let _g = crate::kernel::TestGuard::acquire();
    let argv = set_argv_req(2, &[b"/bin/other"]);
    set_argv(&argv);

    let mut stat = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/proc/2/status", &mut stat),
        -(abi::EPERM as i64)
    );

    let mut entries = [0u8; 128];
    assert_eq!(
        dispatch(METHOD_SYS_READDIR, 1, b"/proc/2", &mut entries),
        -(abi::EPERM as i64)
    );

    let mut target = [0u8; 64];
    assert_eq!(
        dispatch(METHOD_SYS_READLINK, 1, b"/proc/2/cwd", &mut target),
        -(abi::EPERM as i64)
    );

    assert_eq!(
        dispatch(METHOD_SYS_STAT, 2, b"/proc/2/status", &mut stat),
        16
    );
    make_root(1);
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/proc/2/status", &mut stat),
        16
    );
}

#[test]
fn proc_other_pid_open_gate_survives_symlink_resolution() {
    let _g = crate::kernel::TestGuard::acquire();
    let argv = set_argv_req(2, &[b"/bin/other"]);
    set_argv(&argv);

    let target = b"/proc/2/cmdline";
    let mut req = (target.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(target);
    req.extend_from_slice(b"/tmp/leak");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &req, &mut []), 0);

    assert_eq!(
        dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/tmp/leak"), &mut []),
        -(abi::EPERM as i64)
    );

    let fd = dispatch(METHOD_SYS_OPEN, 2, &open_req(0, b"/tmp/leak"), &mut []);
    assert!(
        fd >= 0,
        "target process should read its own proc link: {fd}"
    );
}

#[test]
fn proc_unknown_pid_returns_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    // No syscalls have populated pid 999, so no /proc/999/status.
    assert_eq!(
        dispatch(
            METHOD_SYS_OPEN,
            1,
            &open_req(0, b"/proc/999/status"),
            &mut [],
        ),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn proc_writes_are_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_GETUID, 3, &[], &mut []), 1000);
    // Open with WRITE bit set; the OFD is "writable" but the
    // backend refuses writes.
    let fd = dispatch(
        METHOD_SYS_OPEN,
        3,
        &open_req(O_WRITE, b"/proc/3/status"),
        &mut [],
    );
    let mut w = Vec::new();
    w.extend_from_slice(&(fd as u32).to_le_bytes());
    w.extend_from_slice(b"clobber");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 3, &w, &mut []),
        -(abi::EBADF as i64)
    );
}

/// Helper for the test-only argv patch format: pack pid +
/// (u32 len + bytes)*.
fn set_argv_req(pid: u32, args: &[&[u8]]) -> Vec<u8> {
    let mut req = pid.to_le_bytes().to_vec();
    for a in args {
        req.extend_from_slice(&(a.len() as u32).to_le_bytes());
        req.extend_from_slice(a);
    }
    req
}

#[test]
fn proc_cmdline_serves_null_separated_argv() {
    let _g = crate::kernel::TestGuard::acquire();
    // Touch pid 4 to register it, then push argv.
    assert_eq!(dispatch(METHOD_SYS_GETUID, 4, &[], &mut []), 1000);
    let req = set_argv_req(4, &[b"/usr/bin/zsh", b"-l", b"-c", b"echo hi"]);
    assert_eq!(set_argv(&req), 0);

    let fd = dispatch(
        METHOD_SYS_OPEN,
        4,
        &open_req(0, b"/proc/4/cmdline"),
        &mut [],
    );
    let mut buf = [0u8; 64];
    let n = dispatch(METHOD_SYS_READ, 4, &(fd as u32).to_le_bytes(), &mut buf);
    let bytes = &buf[..n as usize];
    // Linux convention: NUL-separated, no trailing NL.
    let expected: &[u8] = b"/usr/bin/zsh\0-l\0-c\0echo hi\0";
    assert_eq!(bytes, expected);
}

#[test]
fn proc_comm_is_basename_of_argv0() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_GETUID, 8, &[], &mut []), 1000);
    let req = set_argv_req(8, &[b"/bin/cat"]);
    set_argv(&req);

    let fd = dispatch(METHOD_SYS_OPEN, 8, &open_req(0, b"/proc/8/comm"), &mut []);
    let mut buf = [0u8; 32];
    let n = dispatch(METHOD_SYS_READ, 8, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"cat\n");
}

#[test]
fn proc_cwd_serves_chdir_path() {
    let _g = crate::kernel::TestGuard::acquire();
    // Set cwd via sys_chdir, then read /proc/<N>/cwd.
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 11, b"/var", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 11, b"/var/tmp", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_CHDIR, 11, b"/var/tmp", &mut []), 0);

    let fd = dispatch(METHOD_SYS_OPEN, 11, &open_req(0, b"/proc/11/cwd"), &mut []);
    let mut buf = [0u8; 64];
    let n = dispatch(METHOD_SYS_READ, 11, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"/var/tmp");
}

#[test]
fn proc_status_includes_name_when_argv_present() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_GETUID, 6, &[], &mut []), 1000);
    let req = set_argv_req(6, &[b"/usr/bin/ls"]);
    set_argv(&req);

    let fd = dispatch(METHOD_SYS_OPEN, 6, &open_req(0, b"/proc/6/status"), &mut []);
    let mut buf = [0u8; 256];
    let n = dispatch(METHOD_SYS_READ, 6, &(fd as u32).to_le_bytes(), &mut buf);
    let text = std::str::from_utf8(&buf[..n as usize]).unwrap();
    assert!(
        text.contains("Name:\tls\n"),
        "expected Name:\\tls in: {text}"
    );
}

/// Build a tiny in-memory tar with the given (path, content)
/// pairs. Used by the tar-layer tests.
#[cfg(test)]
fn build_tar_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut buf);
        for (path, content) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *content).unwrap();
        }
        builder.finish().unwrap();
    }
    buf
}

#[test]
fn tar_layer_serves_files_after_install() {
    let _g = crate::kernel::TestGuard::acquire();
    let tar_bytes = build_tar_archive(&[
        ("etc/motd", b"hello from tar layer\n"),
        ("usr/share/doc/readme.txt", b"docs"),
    ]);
    // Pack request: u32 prefix_len + prefix + tar bytes.
    let prefix: &[u8] = b"/img";
    let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(prefix);
    req.extend_from_slice(&tar_bytes);
    assert_eq!(
        dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []),
        0
    );

    // Open + read /img/etc/motd.
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/img/etc/motd"), &mut []);
    assert!(fd >= 0, "open succeeded: {fd}");
    let mut buf = [0u8; 64];
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"hello from tar layer\n");

    // fstat reports the real size from the tar header.
    let mut stat = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_FSTAT, 1, &(fd as u32).to_le_bytes(), &mut stat),
        16
    );
    assert_eq!(
        u64::from_le_bytes(stat[0..8].try_into().unwrap()),
        b"hello from tar layer\n".len() as u64
    );
}

#[test]
fn tar_layer_refuses_create_and_write() {
    let _g = crate::kernel::TestGuard::acquire();
    let tar_bytes = build_tar_archive(&[("readme", b"x")]);
    let prefix: &[u8] = b"/img2";
    let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(prefix);
    req.extend_from_slice(&tar_bytes);
    dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []);

    // CREAT against a tar mount → -EPERM (backend.create returns None).
    assert_eq!(
        dispatch(
            METHOD_SYS_OPEN,
            1,
            &open_req(O_WRITE | O_CREAT, b"/img2/new.txt"),
            &mut []
        ),
        -(abi::EPERM as i64)
    );

    // Write through a writable-OFD → -EBADF (backend.write rejects).
    // We can't easily get a writable OFD on a tar file (open with
    // WRITE bit returns the existing inode but not in CREAT path —
    // and the Phase 5 sys_open pre-CREAT semantics for read-only
    // backends mean WRITE succeeds at the kernel side but write()
    // hits the backend's refusal). Probe by opening read-only and
    // verifying writes are blocked at the OFD level too.
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/img2/readme"), &mut []);
    let mut wreq = (fd as u32).to_le_bytes().to_vec();
    wreq.extend_from_slice(b"NOPE");
    // Read-only OFD blocks writes at -EBADF (existing dispatch
    // semantics) — no need to reach the backend.
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &wreq, &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn tar_layer_partial_read_advances_offset() {
    let _g = crate::kernel::TestGuard::acquire();
    let payload: &[u8] = b"0123456789";
    let tar_bytes = build_tar_archive(&[("counts", payload)]);
    let prefix: &[u8] = b"/img3";
    let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(prefix);
    req.extend_from_slice(&tar_bytes);
    dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []);

    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/img3/counts"), &mut []) as u32;
    let mut small = [0u8; 4];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut small),
        4
    );
    assert_eq!(&small, b"0123");
    let mut rest = [0u8; 16];
    let n = dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut rest);
    assert_eq!(n, 6);
    assert_eq!(&rest[..6], b"456789");
}

#[test]
fn install_yurtfs_auto_decompresses_zstd_wrapped_tar() {
    let _g = crate::kernel::TestGuard::acquire();
    let tar = build_tar_archive(&[("etc/release", b"compressed")]);
    // Wrap in zstd. The dev-dep `zstd` crate pulls a C lib; fine
    // for tests, not for the wasm crate (which uses the pure-Rust
    // ruzstd decoder).
    let zstd_wrapped = zstd::stream::encode_all(&tar[..], 0).unwrap();
    // Sanity: the wrapper begins with the zstd magic.
    assert_eq!(&zstd_wrapped[0..4], &[0x28, 0xB5, 0x2F, 0xFD]);

    let prefix: &[u8] = b"/zimg";
    let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(prefix);
    req.extend_from_slice(&zstd_wrapped);
    assert_eq!(
        dispatch(METHOD_KERNEL_INSTALL_YURTFS, 0, &req, &mut []),
        0,
        "zstd-wrapped install_yurtfs succeeds"
    );

    // Open + read /zimg/etc/release verifies the auto-decompress
    // happened and the tar walked correctly afterward.
    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(0, b"/zimg/etc/release"),
        &mut [],
    );
    assert!(fd >= 0, "open under zstd-wrapped image: {fd}");
    let mut buf = [0u8; 32];
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"compressed");
}

#[test]
fn install_tar_layer_auto_decompresses_zstd() {
    let _g = crate::kernel::TestGuard::acquire();
    let tar = build_tar_archive(&[("info", b"v1")]);
    let zstd_wrapped = zstd::stream::encode_all(&tar[..], 0).unwrap();
    let prefix: &[u8] = b"/zlayer";
    let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(prefix);
    req.extend_from_slice(&zstd_wrapped);
    assert_eq!(
        dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []),
        0
    );
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/zlayer/info"), &mut []);
    let mut buf = [0u8; 8];
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"v1");
}

#[test]
fn fstat_returns_default_mode_from_backend() {
    // Ramfs default is 0o100644 (regular file, rw-r--r--).
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    reg.extend_from_slice(b"/m1");
    reg.extend_from_slice(b"hi");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/m1"), &mut []);
    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_FSTAT, 1, &(fd as u32).to_le_bytes(), &mut out),
        16
    );
    let mode = u32::from_le_bytes(out[12..16].try_into().unwrap());
    assert_eq!(mode, 0o100_644, "default mode from backend");
}

#[test]
fn chmod_writes_to_metadata_overlay_and_fstat_reflects_it() {
    let _g = crate::kernel::TestGuard::acquire();
    make_root(1);
    let mut reg = Vec::new();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    reg.extend_from_slice(b"/m2");
    reg.extend_from_slice(b"hi");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    // chmod 0o600 on /m2.
    let mut creq = 0o600_u32.to_le_bytes().to_vec();
    creq.extend_from_slice(b"/m2");
    assert_eq!(dispatch(METHOD_SYS_CHMOD, 1, &creq, &mut []), 0);

    // fstat sees the new perms; file type bits unchanged.
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/m2"), &mut []);
    let mut out = [0u8; 16];
    dispatch(METHOD_SYS_FSTAT, 1, &(fd as u32).to_le_bytes(), &mut out);
    let mode = u32::from_le_bytes(out[12..16].try_into().unwrap());
    assert_eq!(mode, 0o100_600, "chmod kept file-type bits, replaced perms");
}

#[test]
fn chmod_unknown_path_is_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut creq = 0o755_u32.to_le_bytes().to_vec();
    creq.extend_from_slice(b"/missing");
    assert_eq!(
        dispatch(METHOD_SYS_CHMOD, 1, &creq, &mut []),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn chmod_rejects_unprivileged_non_owner() {
    let _g = crate::kernel::TestGuard::acquire();
    let path = b"/root-mode";
    let mut reg = Vec::new();
    reg.extend_from_slice(&(path.len() as u32).to_le_bytes());
    reg.extend_from_slice(path);
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let mut req = 0o777_u32.to_le_bytes().to_vec();
    req.extend_from_slice(path);
    assert_eq!(
        dispatch(METHOD_SYS_CHMOD, 1, &req, &mut []),
        -(abi::EPERM as i64)
    );
}

#[test]
fn chown_writes_uid_gid_to_overlay() {
    let _g = crate::kernel::TestGuard::acquire();
    make_root(1);
    let mut reg = Vec::new();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    reg.extend_from_slice(b"/co");
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let mut req = Vec::new();
    req.extend_from_slice(&1234_u32.to_le_bytes()); // uid
    req.extend_from_slice(&5678_u32.to_le_bytes()); // gid
    req.extend_from_slice(b"/co");
    assert_eq!(dispatch(METHOD_SYS_CHOWN, 1, &req, &mut []), 0);

    // Verify via the kernel-side resolve_metadata helper.
    let meta = crate::kernel::with_kernel(|k| {
        let pair = k.vfs.open(b"/co", 0).unwrap();
        k.resolve_metadata(pair.0, pair.1)
    });
    assert_eq!(meta.uid, 1234);
    assert_eq!(meta.gid, 5678);
}

#[test]
fn chown_rejects_unprivileged_caller() {
    let _g = crate::kernel::TestGuard::acquire();
    let path = b"/root-owner";
    let mut reg = Vec::new();
    reg.extend_from_slice(&(path.len() as u32).to_le_bytes());
    reg.extend_from_slice(path);
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let mut req = Vec::new();
    req.extend_from_slice(&1234_u32.to_le_bytes());
    req.extend_from_slice(&5678_u32.to_le_bytes());
    req.extend_from_slice(path);
    assert_eq!(
        dispatch(METHOD_SYS_CHOWN, 1, &req, &mut []),
        -(abi::EPERM as i64)
    );
}

#[test]
fn fchown_updates_metadata_for_file_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    make_root(1);
    let mut reg = Vec::new();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    reg.extend_from_slice(b"/fco1");
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/fco1"), &mut []) as u32;
    let mut req = Vec::new();
    req.extend_from_slice(&fd.to_le_bytes());
    req.extend_from_slice(&123_u32.to_le_bytes());
    req.extend_from_slice(&456_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_FCHOWN, 1, &req, &mut []),
        0,
        "root can fchown an open file fd"
    );

    let meta = crate::kernel::with_kernel(|k| {
        let pair = k.vfs.open(b"/fco1", 0).unwrap();
        k.resolve_metadata(pair.0, pair.1)
    });
    assert_eq!(meta.uid, 123);
    assert_eq!(meta.gid, 456);
}

#[test]
fn fchown_rejects_invalid_fd_and_unprivileged_caller() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    reg.extend_from_slice(b"/fco2");
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/fco2"), &mut []) as u32;
    let mut req = Vec::new();
    req.extend_from_slice(&fd.to_le_bytes());
    req.extend_from_slice(&123_u32.to_le_bytes());
    req.extend_from_slice(&456_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_FCHOWN, 1, &req, &mut []),
        -(abi::EPERM as i64),
        "non-root cannot fchown"
    );

    let mut bad_fd_req = Vec::new();
    bad_fd_req.extend_from_slice(&999_u32.to_le_bytes());
    bad_fd_req.extend_from_slice(&123_u32.to_le_bytes());
    bad_fd_req.extend_from_slice(&456_u32.to_le_bytes());
    assert_eq!(
        dispatch(TEST_METHOD_SYS_FCHOWN, 1, &bad_fd_req, &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn utimens_writes_mtime_to_overlay() {
    let _g = crate::kernel::TestGuard::acquire();
    make_root(1);
    let mut reg = Vec::new();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    reg.extend_from_slice(b"/ut");
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let mut req = Vec::new();
    let want_ns: u64 = 1_700_000_000_000_000_000;
    req.extend_from_slice(&want_ns.to_le_bytes());
    req.extend_from_slice(b"/ut");
    assert_eq!(dispatch(METHOD_SYS_UTIMENS, 1, &req, &mut []), 0);

    let meta = crate::kernel::with_kernel(|k| {
        let pair = k.vfs.open(b"/ut", 0).unwrap();
        k.resolve_metadata(pair.0, pair.1)
    });
    assert_eq!(meta.mtime_ns, want_ns);
}

#[test]
fn utimens_rejects_unprivileged_non_owner() {
    let _g = crate::kernel::TestGuard::acquire();
    let path = b"/root-time";
    let mut reg = Vec::new();
    reg.extend_from_slice(&(path.len() as u32).to_le_bytes());
    reg.extend_from_slice(path);
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let mut req = Vec::new();
    req.extend_from_slice(&1_700_000_000_000_000_000_u64.to_le_bytes());
    req.extend_from_slice(path);
    assert_eq!(
        dispatch(METHOD_SYS_UTIMENS, 1, &req, &mut []),
        -(abi::EPERM as i64)
    );
}

#[test]
fn tar_layer_default_metadata_comes_from_header() {
    // Build a tar with a custom mode + uid + gid in the header.
    let _g = crate::kernel::TestGuard::acquire();
    let archive = {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut buf);
            let content: &[u8] = b"sh-script";
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_uid(2000);
            header.set_gid(3000);
            header.set_mtime(1_500_000_000);
            header.set_cksum();
            builder.append_data(&mut header, "bin/sh", content).unwrap();
            builder.finish().unwrap();
        }
        buf
    };
    let prefix: &[u8] = b"/tmeta";
    let mut req = (prefix.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(prefix);
    req.extend_from_slice(&archive);
    dispatch(METHOD_KERNEL_INSTALL_TAR_LAYER, 0, &req, &mut []);

    // fstat /tmeta/bin/sh — mode/uid/gid come from tar header.
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/tmeta/bin/sh"), &mut []);
    let mut out = [0u8; 16];
    dispatch(METHOD_SYS_FSTAT, 1, &(fd as u32).to_le_bytes(), &mut out);
    let mode = u32::from_le_bytes(out[12..16].try_into().unwrap());
    assert_eq!(mode, 0o100_755, "tar mode bits surface via fstat");

    // Direct resolve_metadata check for uid/gid (not in fstat
    // wire format yet).
    let meta = crate::kernel::with_kernel(|k| {
        let pair = k.vfs.open(b"/tmeta/bin/sh", 0).unwrap();
        k.resolve_metadata(pair.0, pair.1)
    });
    assert_eq!(meta.uid, 2000);
    assert_eq!(meta.gid, 3000);
    assert_eq!(meta.mtime_ns, 1_500_000_000_000_000_000);
}

#[test]
fn unlink_removes_ramfs_path() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    reg.extend_from_slice(b"/un");
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    // Sanity: path opens before unlink.
    assert!(dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/un"), &mut []) >= 0);

    assert_eq!(dispatch(METHOD_SYS_UNLINK, 1, b"/un", &mut []), 0);
    // After unlink, open returns -ENOENT.
    assert_eq!(
        dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/un"), &mut []),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn link_creates_second_path_to_same_inode_and_survives_first_unlink() {
    let _g = crate::kernel::TestGuard::acquire();
    // Register a regular file with content "first".
    let mut reg = Vec::new();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    reg.extend_from_slice(b"/orig");
    reg.extend_from_slice(b"first");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    // sys_link(target="/orig", link="/dup")
    let target: &[u8] = b"/orig";
    let link_path: &[u8] = b"/dup";
    let mut req = (target.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(target);
    req.extend_from_slice(link_path);
    assert_eq!(dispatch(METHOD_SYS_LINK, 1, &req, &mut []), 0);

    // Unlinking /orig must NOT erase the file — /dup still points
    // at the same inode.
    assert_eq!(dispatch(METHOD_SYS_UNLINK, 1, b"/orig", &mut []), 0);
    let dup_fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/dup"), &mut []);
    assert!(dup_fd >= 0, "/dup must still open after unlinking /orig");
    let mut buf = [0u8; 16];
    let read_req = (dup_fd as u32).to_le_bytes().to_vec();
    let n = dispatch(METHOD_SYS_READ, 1, &read_req, &mut buf);
    assert_eq!(n, 5);
    assert_eq!(&buf[..5], b"first");

    // Unlinking the last path drops the inode; subsequent open
    // returns ENOENT.
    assert_eq!(dispatch(METHOD_SYS_UNLINK, 1, b"/dup", &mut []), 0);
    assert_eq!(
        dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/dup"), &mut []),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn link_to_existing_link_path_is_eexist() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&2_u32.to_le_bytes());
    reg.extend_from_slice(b"/a");
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let mut reg2 = Vec::new();
    reg2.extend_from_slice(&2_u32.to_le_bytes());
    reg2.extend_from_slice(b"/b");
    reg2.extend_from_slice(b"y");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg2, &mut []);

    let target: &[u8] = b"/a";
    let link_path: &[u8] = b"/b";
    let mut req = (target.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(target);
    req.extend_from_slice(link_path);
    assert_eq!(
        dispatch(METHOD_SYS_LINK, 1, &req, &mut []),
        -(abi::EEXIST as i64),
    );
}

#[test]
fn proc_selfish_path_is_not_rewritten() {
    // "/proc/selfish" must not match the /proc/self prefix —
    // the rewrite requires the next byte to be '/' or end.
    // Resolves through the regular VFS as a missing path.
    let _g = crate::kernel::TestGuard::acquire();
    let rc = dispatch(METHOD_SYS_OPEN, 7, &open_req(0, b"/proc/selfish"), &mut []);
    assert!(rc < 0, "/proc/selfish should miss, got rc={rc}");
}

#[test]
fn proc_self_unlink_attempts_proc_caller_path() {
    // Even non-/proc-aware syscalls (unlink) must apply the
    // rewrite. /proc is read-only, so this returns -EROFS or
    // similar negative — the assertion is just that the path
    // gets rewritten (the error code reflects ProcBackend's
    // refusal, not a missing /proc/self mount).
    let _g = crate::kernel::TestGuard::acquire();
    let rc = dispatch(METHOD_SYS_UNLINK, 7, b"/proc/self/status", &mut []);
    assert!(rc < 0, "unlink under /proc must fail (got {rc})");
}

#[test]
fn sys_spawn_reads_vfs_then_drains_and_reaps() {
    // End-to-end (kernel-side only — host instantiation is a
    // separate slice). Steps:
    //   1. Register a "wasm" file at /bin/echo with synthetic
    //      bytes so we can verify drain returns them verbatim.
    //   2. sys_spawn("/bin/echo", ["echo","hi"]) returns a fresh
    //      child pid >= 1000.
    //   3. drain_spawn returns the staged record.
    //   4. record_exit(child, 7) makes parent's sys_wait reap.
    let _g = crate::kernel::TestGuard::acquire();
    let body: &[u8] = b"\0asm\x01\x00\x00\x00fake-wasm-bytes";
    let path: &[u8] = b"/spawn-drain-reap-echo";
    let mut reg = (path.len() as u32).to_le_bytes().to_vec();
    reg.extend_from_slice(path);
    reg.extend_from_slice(body);
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    // sys_spawn request: u32 path_len + path + (u32 alen + arg)*
    let mut sreq = (path.len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(path);
    for arg in [b"echo".as_slice(), b"hi".as_slice()] {
        sreq.extend_from_slice(&(arg.len() as u32).to_le_bytes());
        sreq.extend_from_slice(arg);
    }
    let parent_pid: u32 = 1;
    let child_pid = dispatch(METHOD_SYS_SPAWN, parent_pid, &sreq, &mut []);
    assert!(
        child_pid >= 1000,
        "spawn pid must come from kernel range >= 1000: got {child_pid}",
    );
    let child_pid_u32 = child_pid as u32;
    let child_command = with_kernel(|k| {
        k.list_processes()
            .into_iter()
            .find(|p| p.pid == child_pid_u32)
            .map(|p| p.command)
    });
    assert_eq!(child_command.as_deref(), Some(b"echo".as_slice()));

    // Drain the queued spawn.
    let mut buf = vec![0u8; 1024];
    let n = drain_spawn(&mut buf);
    assert!(n > 0, "drain_spawn returned {n}");
    let used = n as usize;
    assert_eq!(
        u32::from_le_bytes(buf[0..4].try_into().unwrap()),
        child_pid_u32,
    );
    let wasm_len = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    assert_eq!(wasm_len, body.len());
    assert_eq!(&buf[8..8 + wasm_len], body);
    let argc_off = 8 + wasm_len;
    let argc = u32::from_le_bytes(buf[argc_off..argc_off + 4].try_into().unwrap());
    assert_eq!(argc, 2);
    assert!(argc_off + 4 <= used);

    // After draining, queue is empty.
    let n2 = drain_spawn(&mut buf);
    assert_eq!(n2, -(abi::ENOENT as i64));

    // Host pretends it ran the child and exited with code 7.
    let mut rex = child_pid_u32.to_le_bytes().to_vec();
    rex.extend_from_slice(&7_i32.to_le_bytes());
    assert_eq!(record_exit(&rex), 0);

    // Parent's sys_wait reaps the spawned child.
    let mut wreq = 0_u32.to_le_bytes().to_vec(); // wait for any
    wreq.extend_from_slice(&0_u32.to_le_bytes()); // no flags
    let mut wresp = [0u8; 8];
    let wn = dispatch(METHOD_SYS_WAIT, parent_pid, &wreq, &mut wresp);
    assert_eq!(wn, 8);
    assert_eq!(
        u32::from_le_bytes(wresp[0..4].try_into().unwrap()),
        child_pid_u32,
    );
    assert_eq!(i32::from_le_bytes(wresp[4..8].try_into().unwrap()), 7);
}

#[test]
fn drain_spawn_reports_required_size_and_preserves_queue_when_buffer_is_small() {
    let _g = crate::kernel::TestGuard::acquire();
    let body = vec![0xCC; 1024];
    let child_pid = 1001;
    crate::kernel::with_kernel(|k| {
        k.enqueue_spawn(crate::kernel::PendingSpawn {
            child_pid,
            wasm: body.clone(),
            argv: vec![b"big".to_vec()],
        });
    });

    let mut small = vec![0u8; 16];
    let required = drain_spawn(&mut small);
    assert!(required > small.len() as i64);

    let mut enough = vec![0u8; required as usize];
    let written = drain_spawn(&mut enough);
    assert_eq!(written, required);
    assert_eq!(
        u32::from_le_bytes(enough[0..4].try_into().unwrap()),
        child_pid,
    );
}

#[test]
fn sys_spawn_follows_executable_symlink_without_rewriting_argv0() {
    let _g = crate::kernel::TestGuard::acquire();
    let body: &[u8] = b"\0asm\x01\x00\x00\x00fake-wasm-through-symlink";
    let target: &[u8] = b"/usr/bin/hello";
    let link_path: &[u8] = b"/bin/hello-link";
    let argv0: &[u8] = b"/bin/hello-link";

    let mut reg = (target.len() as u32).to_le_bytes().to_vec();
    reg.extend_from_slice(target);
    reg.extend_from_slice(body);
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let mut symlink_req = (target.len() as u32).to_le_bytes().to_vec();
    symlink_req.extend_from_slice(target);
    symlink_req.extend_from_slice(link_path);
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &symlink_req, &mut []), 0);

    let mut sreq = (link_path.len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(link_path);
    for arg in [argv0, b"world".as_slice()] {
        sreq.extend_from_slice(&(arg.len() as u32).to_le_bytes());
        sreq.extend_from_slice(arg);
    }

    let child_pid = dispatch(METHOD_SYS_SPAWN, 1, &sreq, &mut []);
    assert!(
        child_pid >= 1000,
        "spawn pid must come from kernel range >= 1000: got {child_pid}",
    );

    let mut buf = vec![0u8; 1024];
    let n = drain_spawn(&mut buf);
    assert!(n > 0, "drain_spawn returned {n}");
    let wasm_len = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    assert_eq!(&buf[8..8 + wasm_len], body);
    let argc_off = 8 + wasm_len;
    assert_eq!(
        u32::from_le_bytes(buf[argc_off..argc_off + 4].try_into().unwrap()),
        2,
    );
    let argv0_len_off = argc_off + 4;
    let argv0_len =
        u32::from_le_bytes(buf[argv0_len_off..argv0_len_off + 4].try_into().unwrap()) as usize;
    let argv0_off = argv0_len_off + 4;
    assert_eq!(&buf[argv0_off..argv0_off + argv0_len], argv0);
}

#[test]
fn sys_spawn_inherits_parent_cwd_and_fd_table() {
    let _g = crate::kernel::TestGuard::acquire();
    let body: &[u8] = b"\0asm\x01\x00\x00\x00fake-wasm";
    let exe: &[u8] = b"/spawn-inherit-child";
    let mut reg = (exe.len() as u32).to_le_bytes().to_vec();
    reg.extend_from_slice(exe);
    reg.extend_from_slice(body);
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let parent_pid = 7;
    assert_eq!(dispatch(METHOD_SYS_MKDIR, parent_pid, b"/tmp", &mut []), 0);
    assert_eq!(
        dispatch(METHOD_SYS_MKDIR, parent_pid, b"/tmp/work", &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_CHDIR, parent_pid, b"/tmp/work", &mut []),
        0
    );

    let out_fd = dispatch(
        METHOD_SYS_OPEN,
        parent_pid,
        &open_req(O_WRITE | O_CREAT | O_TRUNC, b"/tmp/out"),
        &mut [],
    );
    assert_eq!(out_fd, 3);
    let mut dup2_req = (out_fd as u32).to_le_bytes().to_vec();
    dup2_req.extend_from_slice(&1_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_DUP2, parent_pid, &dup2_req, &mut []), 1);
    assert_eq!(
        dispatch(
            METHOD_SYS_CLOSE,
            parent_pid,
            &(out_fd as u32).to_le_bytes(),
            &mut []
        ),
        0
    );

    let mut sreq = (exe.len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(exe);
    sreq.extend_from_slice(&5_u32.to_le_bytes());
    sreq.extend_from_slice(b"child");
    let child_pid = dispatch(METHOD_SYS_SPAWN, parent_pid, &sreq, &mut []);
    assert!(child_pid >= 1000, "spawn pid got {child_pid}");
    let child_pid = child_pid as u32;

    let child_cwd = with_kernel(|k| k.process(child_pid).cwd.clone());
    assert_eq!(child_cwd, b"/tmp/work");

    assert_eq!(
        dispatch(
            METHOD_SYS_WRITE,
            child_pid,
            &socket_send_req(1, b"child\n"),
            &mut []
        ),
        6
    );

    let read_fd = dispatch(
        METHOD_SYS_OPEN,
        parent_pid,
        &open_req(0, b"/tmp/out"),
        &mut [],
    );
    assert_eq!(read_fd, 3);
    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(
            METHOD_SYS_READ,
            parent_pid,
            &(read_fd as u32).to_le_bytes(),
            &mut out
        ),
        6
    );
    assert_eq!(&out[..6], b"child\n");
}

#[test]
fn sys_spawn_missing_path_is_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    let path: &[u8] = b"/no-such-binary";
    let mut sreq = (path.len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(path);
    assert_eq!(
        dispatch(METHOD_SYS_SPAWN, 1, &sreq, &mut []),
        -(abi::ENOENT as i64),
    );
}

#[test]
fn sys_spawn_rejects_wrapping_lengths() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = u32::MAX.to_le_bytes().to_vec();
    req.extend_from_slice(b"/bin/tool");
    assert_eq!(
        dispatch(METHOD_SYS_SPAWN, 1, &req, &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn rename_moves_regular_file_to_new_path() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = 5_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(b"/old0");
    reg.extend_from_slice(b"data!");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let old: &[u8] = b"/old0";
    let new: &[u8] = b"/new0";
    let mut req = (old.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(old);
    req.extend_from_slice(new);
    assert_eq!(dispatch(METHOD_SYS_RENAME, 1, &req, &mut []), 0);

    // /old0 is gone.
    assert_eq!(
        dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/old0"), &mut []),
        -(abi::ENOENT as i64),
    );
    // /new0 has the original content.
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/new0"), &mut []);
    assert!(fd >= 0);
    let mut buf = [0u8; 8];
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"data!");
}

#[test]
fn rename_replaces_existing_destination_file() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut a = 3_u32.to_le_bytes().to_vec();
    a.extend_from_slice(b"/aa");
    a.extend_from_slice(b"AAA");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &a, &mut []);
    let mut b = 3_u32.to_le_bytes().to_vec();
    b.extend_from_slice(b"/bb");
    b.extend_from_slice(b"BBB");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &b, &mut []);

    let old: &[u8] = b"/aa";
    let new: &[u8] = b"/bb";
    let mut req = (old.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(old);
    req.extend_from_slice(new);
    assert_eq!(dispatch(METHOD_SYS_RENAME, 1, &req, &mut []), 0);

    // /bb now reads "AAA".
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/bb"), &mut []);
    let mut buf = [0u8; 8];
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"AAA");
}

#[test]
fn rename_missing_source_is_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    let old: &[u8] = b"/no";
    let new: &[u8] = b"/yes";
    let mut req = (old.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(old);
    req.extend_from_slice(new);
    assert_eq!(
        dispatch(METHOD_SYS_RENAME, 1, &req, &mut []),
        -(abi::ENOENT as i64),
    );
}

#[test]
fn link_with_missing_target_is_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    let target: &[u8] = b"/no-such-target";
    let link_path: &[u8] = b"/wherever";
    let mut req = (target.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(target);
    req.extend_from_slice(link_path);
    assert_eq!(
        dispatch(METHOD_SYS_LINK, 1, &req, &mut []),
        -(abi::ENOENT as i64),
    );
}

#[test]
fn unlink_unknown_path_is_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_UNLINK, 1, b"/none", &mut []),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn stat_path_returns_size_and_mode_without_an_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    reg.extend_from_slice(b"/info");
    reg.extend_from_slice(b"hello"); // 5 bytes
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_STAT, 1, b"/info", &mut out), 16);
    assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 5);
    let mode = u32::from_le_bytes(out[12..16].try_into().unwrap());
    // Ramfs default — regular file, 0o644.
    assert_eq!(mode, 0o100_644);
}

#[test]
fn stat_path_reports_directory_filetype() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/dir", &mut []), 0);

    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_STAT, 1, b"/dir", &mut out), 16);
    assert_eq!(u32::from_le_bytes(out[8..12].try_into().unwrap()), 3);
}

#[test]
fn stat_unknown_path_is_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/missing", &mut out),
        -(abi::ENOENT as i64)
    );
}

// #67 — stat() must follow symlinks (POSIX), unlike lstat.

#[test]
fn stat_follows_symlink_to_directory() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/d", &mut []), 0);
    let mut sreq = 2_u32.to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/d");
    sreq.extend_from_slice(b"/l");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_STAT, 1, b"/l", &mut out), 16);
    assert_eq!(
        u32::from_le_bytes(out[8..12].try_into().unwrap()),
        3,
        "stat() must follow the symlink and report S_IFDIR, not S_IFLNK"
    );
}

#[test]
fn stat_follows_symlink_to_regular_file() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = 2_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(b"/f");
    reg.extend_from_slice(b"hi");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let mut sreq = 2_u32.to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/f");
    sreq.extend_from_slice(b"/lf");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_STAT, 1, b"/lf", &mut out), 16);
    assert_eq!(
        u32::from_le_bytes(out[8..12].try_into().unwrap()),
        4,
        "S_IFREG via the followed symlink"
    );
    assert_eq!(
        u64::from_le_bytes(out[0..8].try_into().unwrap()),
        2,
        "size is the target's, not the link's"
    );
}

#[test]
fn stat_on_dangling_symlink_is_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut sreq = 5_u32.to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/gone");
    sreq.extend_from_slice(b"/dang");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);
    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/dang", &mut out),
        -(abi::ENOENT as i64),
        "stat() follows the link; a dangling target is ENOENT"
    );
}

#[test]
fn stat_follows_multi_hop_symlink_chain() {
    // Locks the chained-resolution semantics at the stat() entry
    // point (sys_open's suite covers the shared helper's loop, but a
    // future refactor could re-split it — this guards stat directly).
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/d", &mut []), 0);
    // /a -> /b -> /d (a directory): two readlink hops.
    let mut sreq = 2_u32.to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/d");
    sreq.extend_from_slice(b"/b");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);
    let mut sreq = 2_u32.to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/b");
    sreq.extend_from_slice(b"/a");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_STAT, 1, b"/a", &mut out), 16);
    assert_eq!(
        u32::from_le_bytes(out[8..12].try_into().unwrap()),
        3,
        "stat() must follow the whole /a->/b->/d chain and report S_IFDIR"
    );
}

#[test]
fn symlink_creates_link_and_readlink_returns_target() {
    let _g = crate::kernel::TestGuard::acquire();
    // Register a target file so we can verify the open follows.
    let mut reg = Vec::new();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    reg.extend_from_slice(b"/real");
    reg.extend_from_slice(b"contents");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    // sys_symlink(target="/real", link="/alias")
    let target: &[u8] = b"/real";
    let link_path: &[u8] = b"/alias";
    let mut req = (target.len() as u32).to_le_bytes().to_vec();
    req.extend_from_slice(target);
    req.extend_from_slice(link_path);
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &req, &mut []), 0);

    // readlink returns the target verbatim.
    let mut buf = [0u8; 16];
    let n = dispatch(METHOD_SYS_READLINK, 1, b"/alias", &mut buf);
    assert_eq!(&buf[..n as usize], b"/real");
}

#[test]
fn open_follows_symlink_to_target() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    reg.extend_from_slice(b"/real");
    reg.extend_from_slice(b"contents");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    // Create alias → real.
    let mut sreq = 5_u32.to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/real");
    sreq.extend_from_slice(b"/alias");
    dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []);

    // sys_open /alias should follow the symlink and read /real.
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/alias"), &mut []);
    let mut buf = [0u8; 32];
    let n = dispatch(METHOD_SYS_READ, 1, &(fd as u32).to_le_bytes(), &mut buf);
    assert_eq!(&buf[..n as usize], b"contents");
}

#[test]
fn open_eloops_on_circular_symlinks() {
    let _g = crate::kernel::TestGuard::acquire();
    // a -> b -> a — open should bail with -EINVAL after the
    // hop limit (SYMLOOP_MAX 40).
    let mut sreq = 2_u32.to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/b");
    sreq.extend_from_slice(b"/a");
    dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []);
    let mut sreq = 2_u32.to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/a");
    sreq.extend_from_slice(b"/b");
    dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []);

    let rc = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/a"), &mut []);
    assert!(rc < 0, "circular symlink should error: rc = {rc}");
}

#[test]
fn readlink_on_regular_file_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = Vec::new();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    reg.extend_from_slice(b"/rg");
    reg.extend_from_slice(b"hi");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_READLINK, 1, b"/rg", &mut buf),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn realpath_canonicalizes_relative_path_from_cwd() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/work", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_CHDIR, 1, b"/work", &mut []), 0);
    let mut reg = Vec::new();
    reg.extend_from_slice(&14_u32.to_le_bytes());
    reg.extend_from_slice(b"/work/file.txt");
    reg.extend_from_slice(b"hello");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);

    let mut out = [0u8; 64];
    let n = dispatch(METHOD_SYS_REALPATH, 1, b"./file.txt", &mut out);

    assert_eq!(n, "/work/file.txt".len() as i64 + 1);
    assert_eq!(&out[..n as usize], b"/work/file.txt\0");
}

#[test]
fn realpath_follows_symlink_components_and_parent_traversal() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/tmp", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/tmp/real", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/tmp/sub", &mut []), 0);
    let mut reg = Vec::new();
    reg.extend_from_slice(&14_u32.to_le_bytes());
    reg.extend_from_slice(b"/tmp/real/file");
    reg.extend_from_slice(b"hello");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let mut sreq = 9_u32.to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/tmp/real");
    sreq.extend_from_slice(b"/tmp/sub/link");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

    let mut out = [0u8; 64];
    let n = dispatch(
        METHOD_SYS_REALPATH,
        1,
        b"/tmp/sub/link/../real/file",
        &mut out,
    );

    assert_eq!(n, "/tmp/real/file".len() as i64 + 1);
    assert_eq!(&out[..n as usize], b"/tmp/real/file\0");
}

#[test]
fn mkdir_creates_directory_and_readdir_lists_children() {
    let _g = crate::kernel::TestGuard::acquire();
    // mkdir /etc
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/etc", &mut []), 0);
    // Register two files under /etc and verify readdir lists them.
    for name in ["motd", "hostname"] {
        let path = format!("/etc/{}", name);
        let mut reg = (path.len() as u32).to_le_bytes().to_vec();
        reg.extend_from_slice(path.as_bytes());
        reg.extend_from_slice(b"x");
        dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    }
    let mut buf = [0u8; 256];
    let n = dispatch(METHOD_SYS_READDIR, 1, b"/etc", &mut buf) as usize;
    assert!(n >= 4);
    let count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    assert_eq!(count, 2);
    // Parse names: (u32 len, u8 type, bytes), repeated. Files
    // registered via register_file are regular files (type 4).
    let mut cursor = 4usize;
    let mut entries: Vec<(Vec<u8>, u8)> = Vec::new();
    for _ in 0..count {
        let len = u32::from_le_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
        cursor += 4;
        let ty = buf[cursor];
        cursor += 1;
        entries.push((buf[cursor..cursor + len].to_vec(), ty));
        cursor += len;
    }
    assert!(entries.iter().any(|(n, t)| n == b"motd" && *t == 4));
    assert!(entries.iter().any(|(n, t)| n == b"hostname" && *t == 4));
}

#[test]
fn mkdir_existing_path_is_eexist() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/d", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/d", &mut []), -17);
}

#[test]
fn rmdir_empty_directory_succeeds() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/empty", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_RMDIR, 1, b"/empty", &mut []), 0);
    // After rmdir, readdir should miss.
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_READDIR, 1, b"/empty", &mut buf),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn rmdir_nonempty_is_enotempty() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/full", &mut []), 0);
    let mut reg = 9_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(b"/full/foo");
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    assert_eq!(dispatch(METHOD_SYS_RMDIR, 1, b"/full", &mut []), -39); // -ENOTEMPTY
}

#[test]
fn readdir_distinguishes_files_dirs_and_symlinks_via_type_byte() {
    let _g = crate::kernel::TestGuard::acquire();
    // /etc/file (regular), /etc/sub (dir), /etc/link (symlink).
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/etc", &mut []), 0);
    let mut reg = 9_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(b"/etc/file");
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/etc/sub", &mut []), 0);
    let target: &[u8] = b"/etc/file";
    let link: &[u8] = b"/etc/link";
    let mut sreq = (target.len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(target);
    sreq.extend_from_slice(link);
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

    let mut buf = [0u8; 256];
    let n = dispatch(METHOD_SYS_READDIR, 1, b"/etc", &mut buf) as usize;
    assert!(n >= 4);
    let count = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    assert_eq!(count, 3);
    let mut cursor = 4usize;
    let mut by_name: std::collections::BTreeMap<Vec<u8>, u8> = std::collections::BTreeMap::new();
    for _ in 0..count {
        let len = u32::from_le_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
        cursor += 4;
        let ty = buf[cursor];
        cursor += 1;
        by_name.insert(buf[cursor..cursor + len].to_vec(), ty);
        cursor += len;
    }
    assert_eq!(by_name.get(b"file".as_slice()), Some(&4));
    assert_eq!(by_name.get(b"sub".as_slice()), Some(&3));
    assert_eq!(by_name.get(b"link".as_slice()), Some(&7));
}

#[test]
fn readdir_root_lists_top_level_entries() {
    let _g = crate::kernel::TestGuard::acquire();
    // Stash a top-level file.
    let mut reg = 5_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(b"/root");
    reg.extend_from_slice(b"x");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let mut buf = [0u8; 64];
    let n = dispatch(METHOD_SYS_READDIR, 1, b"/", &mut buf) as usize;
    assert!(n >= 4);
    let count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    assert!(count >= 1, "root contains at least /root");
}

#[test]
fn register_child_then_getppid_returns_parent() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = 1_u32.to_le_bytes().to_vec();
    req.extend_from_slice(&7_u32.to_le_bytes());
    assert_eq!(register_child(&req), 0);

    // Child (pid 7) sees its ppid (1) via getppid.
    assert_eq!(dispatch(METHOD_SYS_GETPPID, 7, &[], &mut []), 1);
}

#[test]
fn sys_wait_returns_exited_child() {
    let _g = crate::kernel::TestGuard::acquire();
    // Register child 5 under parent 1, then record its exit.
    let mut reg = 1_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(&5_u32.to_le_bytes());
    register_child(&reg);

    let mut exit = 5_u32.to_le_bytes().to_vec();
    exit.extend_from_slice(&42_i32.to_le_bytes());
    record_exit(&exit);

    // Parent's sys_wait reaps the child. Request: child_pid=0 (any) + flags=0.
    let mut wreq = 0_u32.to_le_bytes().to_vec();
    wreq.extend_from_slice(&0_u32.to_le_bytes());
    let mut wresp = [0u8; 8];
    let n = dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp);
    assert_eq!(n, 8);
    assert_eq!(u32::from_le_bytes(wresp[0..4].try_into().unwrap()), 5);
    assert_eq!(i32::from_le_bytes(wresp[4..8].try_into().unwrap()), 42);

    // After reaping, no more children → next wait is -ECHILD.
    let mut wresp2 = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp2),
        -(abi::ECHILD as i64)
    );
}

#[test]
fn sys_wait_with_no_children_is_echild() {
    let _g = crate::kernel::TestGuard::acquire();
    // pid 1 has no children — wait returns -ECHILD.
    let mut wreq = 0_u32.to_le_bytes().to_vec();
    wreq.extend_from_slice(&0_u32.to_le_bytes());
    let mut wresp = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp),
        -(abi::ECHILD as i64)
    );
}

#[test]
fn host_control_stream_ops_reject_unknown_pid_without_creating_it() {
    let _g = crate::kernel::TestGuard::acquire();
    let pid = 77_u32;
    let mut provide = pid.to_le_bytes().to_vec();
    provide.extend_from_slice(b"input");

    assert_eq!(provide_stdin(&provide), -(abi::ESRCH as i64));
    assert_eq!(close_stdin(&pid.to_le_bytes()), -(abi::ESRCH as i64));
    let mut out = [0u8; 8];
    assert_eq!(
        drain_stream(&pid.to_le_bytes(), &mut out, true),
        -(abi::ESRCH as i64)
    );
    assert!(!crate::kernel::with_kernel(|k| k.has_process(pid)));
}

#[test]
fn record_exit_unknown_pid_is_esrch_and_does_not_create_process() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut exit = 1234_u32.to_le_bytes().to_vec();
    exit.extend_from_slice(&9_i32.to_le_bytes());

    assert_eq!(record_exit(&exit), -(abi::ESRCH as i64));
    assert!(!crate::kernel::with_kernel(|k| k.has_process(1234)));
}

#[test]
fn sys_wait_running_child_is_eagain_with_wnohang() {
    let _g = crate::kernel::TestGuard::acquire();
    // Register child but don't record exit — wait returns -EAGAIN
    // (and continues to with WNOHANG; blocking semantics will
    // wait via AsyncBridge once it lands).
    let mut reg = 1_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    register_child(&reg);

    let mut wreq = 0_u32.to_le_bytes().to_vec();
    wreq.extend_from_slice(&1_u32.to_le_bytes()); // WNOHANG
    let mut wresp = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn sys_wait_running_child_without_wnohang_is_documented_eagain_for_now() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = 1_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    register_child(&reg);

    let mut wreq = 0_u32.to_le_bytes().to_vec();
    wreq.extend_from_slice(&0_u32.to_le_bytes());
    let mut wresp = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn killed_child_is_not_waitable_until_signal_delivery_records_exit() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut reg = 1_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(&3_u32.to_le_bytes());
    register_child(&reg);

    let mut kill = 3_u32.to_le_bytes().to_vec();
    kill.extend_from_slice(&15_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_KILL, 1, &kill, &mut []), 0);

    let mut wreq = 0_u32.to_le_bytes().to_vec();
    wreq.extend_from_slice(&1_u32.to_le_bytes()); // WNOHANG
    let mut wresp = [0u8; 8];
    let n = dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp);
    assert_eq!(n, -(abi::EAGAIN as i64));
}

#[test]
fn sys_wait_for_specific_pid_returns_just_that_one() {
    let _g = crate::kernel::TestGuard::acquire();
    // Two children; only one has exited.
    for c in [10u32, 11u32] {
        let mut reg = 1_u32.to_le_bytes().to_vec();
        reg.extend_from_slice(&c.to_le_bytes());
        register_child(&reg);
    }
    let mut exit = 11_u32.to_le_bytes().to_vec();
    exit.extend_from_slice(&7_i32.to_le_bytes());
    record_exit(&exit);

    // Wait specifically on pid 10 — running, not 11 (exited).
    // Should return -EAGAIN (would block) since 10 hasn't exited.
    let mut wreq = 10_u32.to_le_bytes().to_vec();
    wreq.extend_from_slice(&1_u32.to_le_bytes()); // WNOHANG
    let mut wresp = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp),
        -(abi::EAGAIN as i64)
    );

    // Now wait on pid 11 — that one exited.
    let mut wreq = 11_u32.to_le_bytes().to_vec();
    wreq.extend_from_slice(&0_u32.to_le_bytes());
    let n = dispatch(METHOD_SYS_WAIT, 1, &wreq, &mut wresp);
    assert_eq!(n, 8);
    assert_eq!(u32::from_le_bytes(wresp[0..4].try_into().unwrap()), 11);
    assert_eq!(i32::from_le_bytes(wresp[4..8].try_into().unwrap()), 7);
}

#[test]
fn kernel_list_processes_serializes_kernel_owned_snapshot() {
    let _g = crate::kernel::TestGuard::acquire();

    let argv = set_argv_req(7, &[b"/bin/wc", b"-l"]);
    set_argv(&argv);

    let mut reg = 1_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(&7_u32.to_le_bytes());
    register_child(&reg);

    let mut exit = 7_u32.to_le_bytes().to_vec();
    exit.extend_from_slice(&2_i32.to_le_bytes());
    record_exit(&exit);

    let mut out = [0u8; 128];
    let n = dispatch(METHOD_KERNEL_LIST_PROCESSES, 0, &[], &mut out);
    assert!(n > 0, "list_processes returned {n}");

    let mut offset = 0usize;
    let count = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
    offset += 4;
    assert_eq!(count, 2);

    let mut found_child = false;
    for _ in 0..count {
        let pid = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
        offset += 4;
        let ppid = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
        offset += 4;
        let pgid = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
        offset += 4;
        let sid = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
        offset += 4;
        let state = out[offset];
        offset += 1;
        let exit_status = i32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
        offset += 4;
        let command_len = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        let command = &out[offset..offset + command_len];
        offset += command_len;
        let fd_count = u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
        offset += 4;
        let mut fds = Vec::new();
        for _ in 0..fd_count {
            fds.push(u32::from_le_bytes(
                out[offset..offset + 4].try_into().unwrap(),
            ));
            offset += 4;
        }

        if pid == 7 {
            found_child = true;
            assert_eq!(ppid, 1);
            assert_eq!(pgid, 7);
            assert_eq!(sid, 7);
            assert_eq!(state, 2);
            assert_eq!(exit_status, 2);
            assert_eq!(command, b"/bin/wc");
            assert_eq!(fds, vec![0, 1, 2]);
        }
    }
    assert!(found_child, "snapshot did not include child pid 7");
    assert_eq!(offset, n as usize);
}

#[test]
fn kernel_list_threads_serializes_kernel_owned_thread_snapshot() {
    let _g = crate::kernel::TestGuard::acquire();
    let (pid, tid) = crate::kernel::with_kernel(|k| {
        let pid = k.alloc_host_pid();
        k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(70));
        let tid = k.spawn_thread(pid, Some(71)).expect("thread spawn");
        k.block_thread(pid, tid).expect("thread block");
        (pid, tid)
    });

    let mut out = [0u8; 64];
    let n = dispatch(METHOD_KERNEL_LIST_THREADS, 0, &pid.to_le_bytes(), &mut out);
    assert_eq!(n, 36);

    let count = u32::from_le_bytes(out[0..4].try_into().unwrap());
    assert_eq!(count, 2);

    let main_tid = u32::from_le_bytes(out[4..8].try_into().unwrap());
    let main_state = out[8];
    let main_detached = out[9];
    let main_exit = i32::from_le_bytes(out[12..16].try_into().unwrap());
    assert_eq!(main_tid, 1);
    assert_eq!(main_state, 1);
    assert_eq!(main_detached, 0);
    assert_eq!(main_exit, -1);

    let main_handle = i32::from_le_bytes(out[16..20].try_into().unwrap());
    assert_eq!(main_handle, 70);

    let worker_tid = u32::from_le_bytes(out[20..24].try_into().unwrap());
    let worker_state = out[24];
    let worker_detached = out[25];
    let worker_exit = i32::from_le_bytes(out[28..32].try_into().unwrap());
    let worker_handle = i32::from_le_bytes(out[32..36].try_into().unwrap());
    assert_eq!(worker_tid, tid);
    assert_eq!(worker_state, 2);
    assert_eq!(worker_detached, 0);
    assert_eq!(worker_exit, -1);
    assert_eq!(worker_handle, 71);
}

#[test]
fn kernel_schedule_next_returns_runnable_thread_with_abstract_budget() {
    let _g = crate::kernel::TestGuard::acquire();
    let pid = crate::kernel::with_kernel(|k| {
        let pid = k.alloc_host_pid();
        k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(80));
        k.process_mut(pid).nice = -5;
        let tid = k.spawn_thread(pid, Some(81)).expect("thread spawn");
        k.block_thread(pid, tid).expect("thread block");
        pid
    });

    let mut out = [0u8; 24];
    let n = dispatch(METHOD_KERNEL_SCHEDULE_NEXT, 0, &[], &mut out);
    assert_eq!(n, 24);
    assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), pid);
    assert_eq!(u32::from_le_bytes(out[4..8].try_into().unwrap()), 1);
    assert_eq!(i32::from_le_bytes(out[8..12].try_into().unwrap()), 80);
    assert_eq!(u32::from_le_bytes(out[12..16].try_into().unwrap()), 0);
    assert_eq!(
        u64::from_le_bytes(out[16..24].try_into().unwrap()),
        crate::kernel::scheduler_budget_ns(-5)
    );
}

#[test]
fn kernel_schedule_next_rotates_and_reports_no_runnable_threads() {
    let _g = crate::kernel::TestGuard::acquire();
    let (pid, tid) = crate::kernel::with_kernel(|k| {
        let pid = k.alloc_host_pid();
        k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(90));
        let tid = k.spawn_thread(pid, Some(91)).expect("thread spawn");
        (pid, tid)
    });

    let mut out = [0u8; 24];
    assert_eq!(dispatch(METHOD_KERNEL_SCHEDULE_NEXT, 0, &[], &mut out), 24);
    assert_eq!(u32::from_le_bytes(out[4..8].try_into().unwrap()), 1);
    assert_eq!(dispatch(METHOD_KERNEL_SCHEDULE_NEXT, 0, &[], &mut out), 24);
    assert_eq!(u32::from_le_bytes(out[4..8].try_into().unwrap()), tid);

    crate::kernel::with_kernel(|k| {
        k.block_thread(pid, tid).expect("block worker");
        k.exit_thread(pid, 1, 0).expect("exit main");
    });
    assert_eq!(
        dispatch(METHOD_KERNEL_SCHEDULE_NEXT, 0, &[], &mut out),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn kernel_snapshot_serializes_versioned_process_and_thread_sections() {
    let _g = crate::kernel::TestGuard::acquire();
    let (pid, tid) = crate::kernel::with_kernel(|k| {
        let pid = k.alloc_host_pid();
        k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(80));
        let tid = k.spawn_thread(pid, Some(81)).expect("thread spawn");
        k.block_thread(pid, tid).expect("thread block");
        (pid, tid)
    });

    let mut out = [0u8; 256];
    let n = snapshot_response(&mut out);
    assert!(n > 0, "kernel snapshot returned {n}");
    let bytes = &out[..n as usize];
    assert_eq!(&bytes[0..8], b"YURTSNP\0");
    assert_eq!(u16::from_le_bytes(bytes[8..10].try_into().unwrap()), 1);
    assert_eq!(u16::from_le_bytes(bytes[10..12].try_into().unwrap()), 4);
    assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 0);

    let mut offset = 16usize;
    let first_type = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    offset += 4;
    let first_len = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    offset += 4;
    assert_eq!(first_type, SNAPSHOT_SECTION_PROCESSES);
    assert!(first_len > 4);
    offset += first_len;

    let second_type = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    offset += 4;
    let second_len = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    offset += 4;
    assert_eq!(second_type, SNAPSHOT_SECTION_THREAD_GROUPS);
    let second = &bytes[offset..offset + second_len];
    let group_count = u32::from_le_bytes(second[0..4].try_into().unwrap());
    assert!(group_count >= 1);

    let mut group_offset = 4usize;
    let mut found_child_thread = false;
    for _ in 0..group_count {
        let group_pid =
            u32::from_le_bytes(second[group_offset..group_offset + 4].try_into().unwrap());
        group_offset += 4;
        let thread_len =
            u32::from_le_bytes(second[group_offset..group_offset + 4].try_into().unwrap()) as usize;
        group_offset += 4;
        let threads = &second[group_offset..group_offset + thread_len];
        group_offset += thread_len;
        if group_pid == pid {
            assert_eq!(u32::from_le_bytes(threads[0..4].try_into().unwrap()), 2);
            assert_eq!(u32::from_le_bytes(threads[20..24].try_into().unwrap()), tid);
            assert_eq!(threads[24], 2);
            found_child_thread = true;
        }
    }
    assert!(found_child_thread, "snapshot did not include child thread");
    offset += second_len;

    let third_type = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    offset += 4;
    let third_len = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    offset += 4;
    assert_eq!(third_type, SNAPSHOT_SECTION_WAITS);
    let third = &bytes[offset..offset + third_len];
    assert_eq!(u32::from_le_bytes(third[0..4].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(third[4..8].try_into().unwrap()), pid);
    assert_eq!(u32::from_le_bytes(third[8..12].try_into().unwrap()), tid);
    assert_eq!(u32::from_le_bytes(third[12..16].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(third[16..20].try_into().unwrap()), 0);
    offset += third_len;

    let fourth_type = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    offset += 4;
    let fourth_len = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    offset += 4;
    assert_eq!(fourth_type, SNAPSHOT_SECTION_RUNNABLE_THREADS);
    let fourth = &bytes[offset..offset + fourth_len];
    let runnable_count = u32::from_le_bytes(fourth[0..4].try_into().unwrap());
    let mut found_main_thread = false;
    for i in 0..runnable_count as usize {
        let entry_offset = 4 + i * 8;
        let runnable_pid =
            u32::from_le_bytes(fourth[entry_offset..entry_offset + 4].try_into().unwrap());
        let runnable_tid = u32::from_le_bytes(
            fourth[entry_offset + 4..entry_offset + 8]
                .try_into()
                .unwrap(),
        );
        if runnable_pid == pid && runnable_tid == 1 {
            found_main_thread = true;
        }
    }
    assert!(
        found_main_thread,
        "snapshot did not include runnable main thread"
    );
    offset += fourth_len;
    assert_eq!(offset, bytes.len());
}

#[test]
fn known_methods_table_includes_credentials_family() {
    let names: Vec<&str> = KNOWN_METHODS.iter().map(|(n, _)| *n).collect();
    for required in [
        "kernel_echo",
        "kernel_now_realtime",
        "sys_getuid",
        "sys_geteuid",
        "sys_getgid",
        "sys_getegid",
        "sys_getpid",
        "sys_getppid",
    ] {
        assert!(
            names.contains(&required),
            "expected {required} in KNOWN_METHODS"
        );
    }
}

#[test]
fn lifecycle_host_control_is_not_available_through_generic_dispatch() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut exit = 7_u32.to_le_bytes().to_vec();
    exit.extend_from_slice(&0_i32.to_le_bytes());
    assert_eq!(dispatch(14, 0, &exit, &mut []), -(abi::ENOSYS as i64));
    assert_eq!(dispatch(15, 0, &[], &mut [0u8; 32]), -(abi::ENOSYS as i64));
}

#[test]
fn sys_thread_self_maps_main_to_zero_and_worker_to_tid() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_THREAD_SELF, 9, &[], &mut []), 0);

    let ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: 2,
    };
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_SELF, ctx, &[], &mut []),
        2
    );
}

#[test]
fn sys_thread_spawn_allocates_tid_and_calls_host() {
    let _g = crate::kernel::TestGuard::acquire();
    kh::test_support::reset_thread_mock();
    kh::test_support::push_thread_spawn_result(77);
    crate::kernel::with_kernel(|k| {
        k.insert_host_process(9, 0, vec![b"/bin/threaded".to_vec()], Some(10));
    });

    let mut req = 0x1234_u32.to_le_bytes().to_vec();
    req.extend_from_slice(&0x5678_u32.to_le_bytes());
    assert_eq!(dispatch(METHOD_SYS_THREAD_SPAWN, 9, &req, &mut []), 2);
    assert_eq!(
        kh::test_support::thread_spawn_calls(),
        vec![(9, 2, 0x1234, 0x5678)]
    );
    let worker = crate::kernel::with_kernel(|k| {
        k.process(9)
            .threads
            .get(&2)
            .expect("spawned thread")
            .clone()
    });
    assert_eq!(worker.host_thread_handle, Some(77));
}

#[test]
fn sys_thread_join_preserves_high_bit_retval() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.insert_host_process(9, 0, vec![b"/bin/threaded".to_vec()], Some(10));
        let tid = k.spawn_thread(9, Some(77)).expect("thread spawn");
        assert_eq!(tid, 2);
        k.exit_thread_authenticated(9, tid, 0x8000_0001)
            .expect("thread exit");
    });

    let ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: crate::kernel::MAIN_THREAD_TID,
    };
    let mut out = [0; 4];
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_JOIN, ctx, &2_u32.to_le_bytes(), &mut out),
        0
    );
    assert_eq!(u32::from_le_bytes(out), 0x8000_0001);
}

#[test]
fn sys_thread_join_running_thread_suspends_without_spinning() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        k.insert_host_process(9, 0, vec![b"/bin/threaded".to_vec()], Some(10));
        let tid = k.spawn_thread(9, Some(77)).expect("thread spawn");
        assert_eq!(tid, 2);
    });

    let ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: crate::kernel::MAIN_THREAD_TID,
    };
    let mut out = [0; 4];
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_JOIN, ctx, &2_u32.to_le_bytes(), &mut out),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn process_scaffolding_is_not_available_through_generic_dispatch() {
    let _g = crate::kernel::TestGuard::acquire();
    let argv = set_argv_req(7, &[b"/bin/wc"]);
    assert_eq!(dispatch(9, 0, &argv, &mut []), -(abi::ENOSYS as i64));

    let mut reg = 1_u32.to_le_bytes().to_vec();
    reg.extend_from_slice(&7_u32.to_le_bytes());
    assert_eq!(dispatch(13, 0, &reg, &mut []), -(abi::ENOSYS as i64));
}

#[test]
fn failed_cached_spawn_releases_reserved_host_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut argv = Vec::new();
    argv.extend_from_slice(&7_u32.to_le_bytes());
    argv.extend_from_slice(b"/bin/wc");

    assert_eq!(
        spawn_cached_process(0, b"module", &argv),
        -(abi::ENOSYS as i64)
    );
    let next_pid = crate::kernel::with_kernel(|k| k.try_alloc_host_pid());
    assert_eq!(next_pid, Some(1));
}

#[test]
fn user_processes_cannot_call_kernel_only_methods() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut response = [0u8; 64];
    let methods = [
        METHOD_KERNEL_PROVIDE_STDIN,
        METHOD_KERNEL_CLOSE_STDIN,
        METHOD_KERNEL_DRAIN_STDOUT,
        METHOD_KERNEL_DRAIN_STDERR,
        METHOD_KERNEL_REGISTER_FILE,
        METHOD_KERNEL_INSTALL_TAR_LAYER,
        METHOD_KERNEL_INSTALL_HOST_FS_MOUNT,
        METHOD_KERNEL_INSTALL_YURTFS,
        METHOD_KERNEL_LIST_PROCESSES,
        METHOD_KERNEL_LIST_THREADS,
        METHOD_KERNEL_SCHEDULE_NEXT,
    ];

    for method in methods {
        assert_eq!(
            dispatch(method, 1, &[], &mut response),
            -(abi::EPERM as i64),
            "method {method} should be kernel-only"
        );
    }
}

// --- Slice B2.1: POSIX pread/pwrite (positional, no cursor move) ---

fn write_req(fd: u32, data: &[u8]) -> Vec<u8> {
    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(data);
    req
}

fn p_req(fd: u32, offset: u64, data: &[u8]) -> Vec<u8> {
    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(&offset.to_le_bytes());
    req.extend_from_slice(data);
    req
}

fn gr_req(len: u32, flags: u32) -> Vec<u8> {
    let mut v = Vec::with_capacity(8);
    v.extend_from_slice(&len.to_le_bytes());
    v.extend_from_slice(&flags.to_le_bytes());
    v
}

#[test]
fn getrandom_fills_response_and_validates_args() {
    let _g = crate::kernel::TestGuard::acquire();

    // Happy path: 32 bytes, no flags.
    let mut a = [0u8; 32];
    let mut b = [0u8; 32];
    assert_eq!(dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(32, 0), &mut a), 32);
    assert_eq!(dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(32, 0), &mut b), 32);
    assert!(a.iter().any(|&x| x != 0));
    assert_ne!(a, b);

    // GRND_NONBLOCK|GRND_RANDOM accepted (no-ops).
    let mut c = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(16, 0b11), &mut c), 16);

    // Unknown flag bit -> -EINVAL.
    assert_eq!(
        dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(8, 0b100), &mut [0u8; 8]),
        -(crate::abi::EINVAL as i64)
    );

    // Short request (<8 bytes) -> -EINVAL.
    assert_eq!(
        dispatch(METHOD_SYS_GETRANDOM, 1, &[0u8; 4], &mut [0u8; 8]),
        -(crate::abi::EINVAL as i64)
    );

    // Response smaller than len -> -EINVAL (subtraction-form guard; #65).
    assert_eq!(
        dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(64, 0), &mut [0u8; 8]),
        -(crate::abi::EINVAL as i64)
    );

    // Width-aware C1 (#65): u32::MAX len must not wrap/panic; clean -EINVAL.
    assert_eq!(
        dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(u32::MAX, 0), &mut [0u8; 8]),
        -(crate::abi::EINVAL as i64)
    );
}

fn open_rw(path: &[u8]) -> u32 {
    let fd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_CREAT | O_WRITE, path),
        &mut [],
    );
    assert!(fd >= 3, "open returned {fd}");
    fd as u32
}

#[test]
fn pread_reads_at_offset_without_consuming_the_cursor() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/pread.txt");
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &write_req(fd, b"0123456789"), &mut []),
        10
    );

    let mut buf = [0u8; 8];
    let n = dispatch(METHOD_SYS_PREAD, 1, &p_req(fd, 3, &[]), &mut buf);
    assert_eq!(n, 7, "reads from offset 3 to EOF");
    assert_eq!(&buf[..7], b"3456789");

    // Idempotent: a second pread at the same offset returns the same
    // bytes — proving the OFD cursor was not advanced.
    let mut buf2 = [0u8; 8];
    let n2 = dispatch(METHOD_SYS_PREAD, 1, &p_req(fd, 3, &[]), &mut buf2);
    assert_eq!(n2, 7);
    assert_eq!(&buf2[..7], b"3456789");
}

#[test]
fn pwrite_writes_at_offset_without_moving_the_cursor() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/pwrite.txt");
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd, 0, b"hello"), &mut []),
        5
    );
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd, 5, b"world"), &mut []),
        5
    );

    // Read it back from the start; pwrite never touched the cursor.
    let mut buf = [0u8; 16];
    let n = dispatch(METHOD_SYS_PREAD, 1, &p_req(fd, 0, &[]), &mut buf);
    assert_eq!(&buf[..n as usize], b"helloworld");
}

#[test]
fn pwrite_past_eof_zero_fills_the_sparse_gap() {
    // PR #55 review #4: pwrite is a new one-call path to the
    // past-EOF case; POSIX requires the gap to read back as zeros.
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/sparse.txt");
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd, 0, b"hi"), &mut []),
        2
    );
    // Write one byte at offset 10, leaving a [2, 10) hole.
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd, 10, b"X"), &mut []),
        1
    );
    let mut buf = [0xFFu8; 16];
    let n = dispatch(METHOD_SYS_PREAD, 1, &p_req(fd, 0, &[]), &mut buf);
    assert_eq!(n, 11, "length is the farthest write end (11)");
    let mut expected = [0u8; 11];
    expected[0] = b'h';
    expected[1] = b'i';
    expected[10] = b'X';
    assert_eq!(
        &buf[..n as usize],
        &expected[..],
        "the [2,10) gap must read back as zero bytes"
    );
}

#[test]
fn pwrite_zero_length_past_eof_does_not_change_file_size() {
    // PR #55 review P2: a 0-byte pwrite past EOF must return 0 and NOT
    // resize the file (no sparse extension), per POSIX.
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/zlpw.txt");
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd, 0, b"abc"), &mut []),
        3
    );
    // Zero-length pwrite far past EOF must be a true no-op.
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd, 100, b""), &mut []),
        0
    );
    // The file is still exactly 3 bytes — not extended to 100.
    let mut buf = [0xFFu8; 64];
    let n = dispatch(METHOD_SYS_PREAD, 1, &p_req(fd, 0, &[]), &mut buf);
    assert_eq!(n, 3, "0-byte pwrite must not extend the file");
    assert_eq!(&buf[..3], b"abc");
}

#[test]
fn pread_pwrite_espipe_on_non_seekable_fds() {
    let _g = crate::kernel::TestGuard::acquire();
    // stdin (fd 0) / stdout (fd 1) are streams → ESPIPE.
    let mut buf = [0u8; 4];
    assert_eq!(
        dispatch(METHOD_SYS_PREAD, 1, &p_req(0, 0, &[]), &mut buf),
        -(abi::ESPIPE as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(1, 0, b"x"), &mut []),
        -(abi::ESPIPE as i64)
    );
}

#[test]
fn pread_pwrite_guards() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut buf = [0u8; 4];
    // Unknown fd.
    assert_eq!(
        dispatch(METHOD_SYS_PREAD, 1, &p_req(99, 0, &[]), &mut buf),
        -(abi::EBADF as i64)
    );
    // Short request (< 12 bytes header).
    assert_eq!(
        dispatch(METHOD_SYS_PREAD, 1, &[0u8; 8], &mut buf),
        -(abi::EINVAL as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &[0u8; 8], &mut []),
        -(abi::EINVAL as i64)
    );
    // Directory fd: pread → EISDIR, pwrite → EBADF.
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/d", &mut []), 0);
    let dfd = dispatch(METHOD_SYS_OPEN, 1, &open_req(O_DIRECTORY, b"/d"), &mut []);
    assert!(dfd >= 3);
    assert_eq!(
        dispatch(METHOD_SYS_PREAD, 1, &p_req(dfd as u32, 0, &[]), &mut buf),
        -(abi::EISDIR as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(dfd as u32, 0, b"x"), &mut []),
        -(abi::EBADF as i64)
    );
    // Read-only file fd: pwrite → EBADF (not writable).
    let _ = open_rw(b"/ro.txt");
    let rofd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/ro.txt"), &mut []);
    assert!(rofd >= 3);
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(rofd as u32, 0, b"x"), &mut []),
        -(abi::EBADF as i64)
    );
}

// --- Slice B2.2: POSIX dup3 ---

fn dup3_req(oldfd: u32, newfd: u32, flags: u32) -> Vec<u8> {
    let mut req = oldfd.to_le_bytes().to_vec();
    req.extend_from_slice(&newfd.to_le_bytes());
    req.extend_from_slice(&flags.to_le_bytes());
    req
}

fn fd_is_inheritable(pid: u32, fd: u32) -> bool {
    crate::kernel::with_kernel(|k| {
        k.process_mut(pid)
            .fd_table
            .inheritable_entries()
            .iter()
            .any(|(f, _)| *f == fd)
    })
}

#[test]
fn dup3_aliases_oldfd_to_newfd() {
    let _g = crate::kernel::TestGuard::acquire();
    let oldfd = open_rw(b"/dup3.txt");
    assert_eq!(
        dispatch(METHOD_SYS_DUP3, 1, &dup3_req(oldfd, 20, 0), &mut []),
        20
    );
    // newfd shares the OFD: write via 20, read it back via the alias.
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(20, 0, b"aliased"), &mut []),
        7
    );
    let mut buf = [0u8; 16];
    let n = dispatch(METHOD_SYS_PREAD, 1, &p_req(oldfd, 0, &[]), &mut buf);
    assert_eq!(&buf[..n as usize], b"aliased");
}

#[test]
fn dup3_same_fd_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/dup3b.txt");
    assert_eq!(
        dispatch(METHOD_SYS_DUP3, 1, &dup3_req(fd, fd, 0), &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn dup3_unknown_oldfd_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_DUP3, 1, &dup3_req(99, 20, 0), &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn dup3_unknown_flag_bits_are_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/dup3c.txt");
    assert_eq!(
        dispatch(METHOD_SYS_DUP3, 1, &dup3_req(fd, 20, 0b10), &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn dup3_clears_cloexec_on_a_recycled_newfd() {
    // PR #55 review #3: dup3 onto a newfd that ALREADY has FD_CLOEXEC,
    // with flags=0, must clear the stale bit (deterministic, unlike
    // dup2). Locks the recycled-fd path the other tests didn't cover.
    let _g = crate::kernel::TestGuard::acquire();
    let oldfd = open_rw(b"/dup3-old.txt");
    let newfd = open_rw(b"/dup3-new.txt");
    let mut set = newfd.to_le_bytes().to_vec();
    set.extend_from_slice(&1u32.to_le_bytes()); // FD_CLOEXEC
    assert_eq!(
        dispatch(METHOD_SYS_SET_FD_DESCRIPTOR_FLAGS, 1, &set, &mut []),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_GET_FD_DESCRIPTOR_FLAGS,
            1,
            &newfd.to_le_bytes(),
            &mut []
        ),
        1,
        "precondition: newfd has FD_CLOEXEC set"
    );
    assert_eq!(
        dispatch(METHOD_SYS_DUP3, 1, &dup3_req(oldfd, newfd, 0), &mut []),
        newfd as i64
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_GET_FD_DESCRIPTOR_FLAGS,
            1,
            &newfd.to_le_bytes(),
            &mut []
        ),
        0,
        "dup3 flags=0 must clear the recycled fd's stale FD_CLOEXEC"
    );
}

#[test]
fn dup3_cloexec_flag_controls_newfd_inheritance() {
    let _g = crate::kernel::TestGuard::acquire();
    let oldfd = open_rw(b"/dup3d.txt");

    // flags=1 (FD_CLOEXEC): newfd must NOT be inheritable across exec.
    assert_eq!(
        dispatch(METHOD_SYS_DUP3, 1, &dup3_req(oldfd, 21, 1), &mut []),
        21
    );
    assert!(!fd_is_inheritable(1, 21), "cloexec fd must be excluded");

    // flags=0: newfd inherits normally.
    assert_eq!(
        dispatch(METHOD_SYS_DUP3, 1, &dup3_req(oldfd, 22, 0), &mut []),
        22
    );
    assert!(fd_is_inheritable(1, 22), "non-cloexec fd inherits");
}

// --- Slice B2.3: POSIX fcntl(F_GETFD) ---

fn setfd_req(fd: u32, flags: u32) -> Vec<u8> {
    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(&flags.to_le_bytes());
    req
}

#[test]
fn fcntl_getfd_defaults_to_zero_and_reflects_setfd() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/getfd.txt");
    assert_eq!(
        dispatch(
            METHOD_SYS_GET_FD_DESCRIPTOR_FLAGS,
            1,
            &fd.to_le_bytes(),
            &mut []
        ),
        0,
        "FD_CLOEXEC defaults clear"
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SET_FD_DESCRIPTOR_FLAGS,
            1,
            &setfd_req(fd, 1),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_GET_FD_DESCRIPTOR_FLAGS,
            1,
            &fd.to_le_bytes(),
            &mut []
        ),
        1,
        "F_GETFD reflects the FD_CLOEXEC set via F_SETFD"
    );
    // Clearing it round-trips back to 0.
    assert_eq!(
        dispatch(
            METHOD_SYS_SET_FD_DESCRIPTOR_FLAGS,
            1,
            &setfd_req(fd, 0),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_GET_FD_DESCRIPTOR_FLAGS,
            1,
            &fd.to_le_bytes(),
            &mut []
        ),
        0
    );
}

#[test]
fn fcntl_getfd_unknown_fd_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(
            METHOD_SYS_GET_FD_DESCRIPTOR_FLAGS,
            1,
            &99u32.to_le_bytes(),
            &mut []
        ),
        -(abi::EBADF as i64)
    );
}

#[test]
fn fcntl_getfd_short_request_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_GET_FD_DESCRIPTOR_FLAGS, 1, &[1, 2], &mut []),
        -(abi::EINVAL as i64)
    );
}

// --- Slice B2.4: POSIX openat ---

const AT_FDCWD: u32 = u32::MAX;

fn openat_req(dirfd: u32, flags: u32, path: &[u8]) -> Vec<u8> {
    let mut req = dirfd.to_le_bytes().to_vec();
    req.extend_from_slice(&flags.to_le_bytes());
    req.extend_from_slice(path);
    req
}

fn open_dir(path: &[u8]) -> u32 {
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(O_DIRECTORY, path), &mut []);
    assert!(fd >= 3, "open dir returned {fd}");
    fd as u32
}

fn read_abs(path: &[u8]) -> Vec<u8> {
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, path), &mut []);
    assert!(fd >= 3, "open {path:?} returned {fd}");
    let mut buf = [0u8; 64];
    let n = dispatch(METHOD_SYS_PREAD, 1, &p_req(fd as u32, 0, &[]), &mut buf);
    assert!(n >= 0, "pread returned {n}");
    buf[..n as usize].to_vec()
}

#[test]
fn openat_resolves_relative_to_the_directory_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/base", &mut []), 0);
    let dfd = open_dir(b"/base");

    let fd = dispatch(
        METHOD_SYS_OPENAT,
        1,
        &openat_req(dfd, O_CREAT | O_WRITE, b"rel.txt"),
        &mut [],
    );
    assert!(fd >= 3, "openat returned {fd}");
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd as u32, 0, b"hi"), &mut []),
        2
    );
    // It really landed at /base/rel.txt.
    assert_eq!(read_abs(b"/base/rel.txt"), b"hi");
}

#[test]
fn openat_absolute_path_ignores_dirfd() {
    let _g = crate::kernel::TestGuard::acquire();
    // dirfd is garbage, but an absolute path must still work.
    let fd = dispatch(
        METHOD_SYS_OPENAT,
        1,
        &openat_req(999, O_CREAT | O_WRITE, b"/abs.txt"),
        &mut [],
    );
    assert!(fd >= 3, "openat abs returned {fd}");
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd as u32, 0, b"A"), &mut []),
        1
    );
    assert_eq!(read_abs(b"/abs.txt"), b"A");
}

#[test]
fn openat_at_fdcwd_is_cwd_relative() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/cwd", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_CHDIR, 1, b"/cwd", &mut []), 0);
    let fd = dispatch(
        METHOD_SYS_OPENAT,
        1,
        &openat_req(AT_FDCWD, O_CREAT | O_WRITE, b"c.txt"),
        &mut [],
    );
    assert!(fd >= 3);
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd as u32, 0, b"Z"), &mut []),
        1
    );
    assert_eq!(read_abs(b"/cwd/c.txt"), b"Z");
}

#[test]
fn openat_dirfd_not_a_directory_is_enotdir() {
    let _g = crate::kernel::TestGuard::acquire();
    let ffd = open_rw(b"/notadir.txt");
    assert_eq!(
        dispatch(
            METHOD_SYS_OPENAT,
            1,
            &openat_req(ffd, O_CREAT | O_WRITE, b"x"),
            &mut []
        ),
        -(abi::ENOTDIR as i64)
    );
}

#[test]
fn openat_unknown_dirfd_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(
            METHOD_SYS_OPENAT,
            1,
            &openat_req(99, O_CREAT | O_WRITE, b"x"),
            &mut []
        ),
        -(abi::EBADF as i64)
    );
}

#[test]
fn openat_short_or_empty_request_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_OPENAT, 1, &[0u8; 4], &mut []),
        -(abi::EINVAL as i64)
    );
    // 8-byte header but no path.
    assert_eq!(
        dispatch(METHOD_SYS_OPENAT, 1, &openat_req(AT_FDCWD, 0, b""), &mut []),
        -(abi::EINVAL as i64)
    );
}

// --- Slice B2.3b: POSIX fcntl(F_GETFL/F_SETFL) — storage only ---

const O_APPEND: u32 = 0x400;
const O_NONBLOCK: u32 = 0x800;
// Linux/musl access-mode bits (B2.8 / issue #60).
const O_RDONLY: u32 = 0;
const O_RDWR: u32 = 2;
const O_ACCMODE: u32 = 3;

fn setfl_req(fd: u32, flags: u32) -> Vec<u8> {
    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(&flags.to_le_bytes());
    req
}

fn getfl(fd: u32) -> i64 {
    dispatch(
        METHOD_SYS_GET_FILE_STATUS_FLAGS,
        1,
        &fd.to_le_bytes(),
        &mut [],
    )
}

#[test]
fn fgetfl_surfaces_access_mode_bits_issue_60() {
    let _g = crate::kernel::TestGuard::acquire();
    // Writable fd (open_rw uses O_WRITE) → F_GETFL must report a
    // non-O_RDONLY access mode. Before the #60 fix this was always
    // O_RDONLY (0), breaking musl/CPython/libuv `(flags & O_ACCMODE)`.
    let wfd = open_rw(b"/accmode_w.txt");
    let w = getfl(wfd);
    assert!(w >= 0, "getfl ok");
    assert_eq!(
        (w as u32) & O_ACCMODE,
        O_RDWR,
        "writable fd → O_RDWR access mode (ABI has only a writable bit; \
         O_WRONLY is indistinguishable, O_RDWR is the correct non-RDONLY report)"
    );
    assert_ne!((w as u32) & O_ACCMODE, O_RDONLY);

    // Read-only reopen of the same file → O_RDONLY.
    let rfd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/accmode_w.txt"), &mut []);
    assert!(rfd >= 3, "read-only open ok");
    assert_eq!(
        (getfl(rfd as u32) as u32) & O_ACCMODE,
        O_RDONLY,
        "read-only fd → O_RDONLY"
    );
}

#[test]
fn fcntl_setfl_getfl_roundtrip_and_masking_on_file() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/setfl.txt");
    assert_eq!(
        getfl(fd),
        O_RDWR as i64,
        "writable fd: access mode O_RDWR, no status flags yet (#60)"
    );

    assert_eq!(
        dispatch(
            METHOD_SYS_SET_FILE_STATUS_FLAGS,
            1,
            &setfl_req(fd, O_NONBLOCK),
            &mut []
        ),
        0
    );
    assert_eq!(getfl(fd), (O_RDWR | O_NONBLOCK) as i64);

    assert_eq!(
        dispatch(
            METHOD_SYS_SET_FILE_STATUS_FLAGS,
            1,
            &setfl_req(fd, O_APPEND | O_NONBLOCK),
            &mut [],
        ),
        0
    );
    assert_eq!(getfl(fd), (O_RDWR | O_APPEND | O_NONBLOCK) as i64);

    // Non-settable bits (access mode / creation) are stripped.
    assert_eq!(
        dispatch(
            METHOD_SYS_SET_FILE_STATUS_FLAGS,
            1,
            &setfl_req(fd, 0xFFFF_FFFF),
            &mut []
        ),
        0
    );
    assert_eq!(
        getfl(fd),
        (O_RDWR | O_APPEND | O_NONBLOCK) as i64,
        "only settable subset kept; access mode (O_RDWR) always present"
    );
}

#[test]
fn fcntl_setfl_is_shared_across_dup_via_the_ofd() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/setfl_dup.txt");
    assert_eq!(
        dispatch(METHOD_SYS_DUP3, 1, &dup3_req(fd, 30, 0), &mut []),
        30
    );
    // Set via the original fd; observe via the dup (same OFD).
    assert_eq!(
        dispatch(
            METHOD_SYS_SET_FILE_STATUS_FLAGS,
            1,
            &setfl_req(fd, O_NONBLOCK),
            &mut []
        ),
        0
    );
    assert_eq!(
        getfl(30),
        (O_RDWR | O_NONBLOCK) as i64,
        "status flags live on the shared OFD; access mode (O_RDWR) too"
    );
}

#[test]
fn fcntl_getfl_is_zero_for_non_file_fds() {
    let _g = crate::kernel::TestGuard::acquire();
    // stdout (fd 1) is valid but has no per-OFD status tracked.
    assert_eq!(getfl(1), 0);
}

#[test]
fn fcntl_getfl_setfl_unknown_fd_is_ebadf() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(getfl(99), -(abi::EBADF as i64));
    assert_eq!(
        dispatch(
            METHOD_SYS_SET_FILE_STATUS_FLAGS,
            1,
            &setfl_req(99, O_NONBLOCK),
            &mut []
        ),
        -(abi::EBADF as i64)
    );
}

#[test]
fn fcntl_getfl_setfl_short_request_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(
        dispatch(METHOD_SYS_GET_FILE_STATUS_FLAGS, 1, &[1, 2], &mut []),
        -(abi::EINVAL as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_SET_FILE_STATUS_FLAGS, 1, &[1, 2, 3, 4], &mut []),
        -(abi::EINVAL as i64)
    );
}

// --- Slice B2.5: POSIX ioctl (FIONBIO / FIONREAD whitelist) ---

const FIONBIO: u32 = 0x5421;
const FIONREAD: u32 = 0x541B;

fn ioctl_req(fd: u32, req: u32, arg: u32) -> Vec<u8> {
    let mut r = fd.to_le_bytes().to_vec();
    r.extend_from_slice(&req.to_le_bytes());
    r.extend_from_slice(&arg.to_le_bytes());
    r
}

#[test]
fn ioctl_fionbio_toggles_o_nonblock_in_status_flags() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/fionbio.txt");
    assert_eq!(getfl(fd), O_RDWR as i64);
    assert_eq!(
        dispatch(METHOD_SYS_IOCTL, 1, &ioctl_req(fd, FIONBIO, 1), &mut []),
        0
    );
    assert_eq!(
        getfl(fd),
        (O_RDWR | O_NONBLOCK) as i64,
        "FIONBIO set O_NONBLOCK"
    );
    assert_eq!(
        dispatch(METHOD_SYS_IOCTL, 1, &ioctl_req(fd, FIONBIO, 0), &mut []),
        0
    );
    assert_eq!(getfl(fd), O_RDWR as i64, "FIONBIO arg=0 cleared O_NONBLOCK");
}

#[test]
fn ioctl_fionread_file_reports_size_minus_offset() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/fionread.txt");
    assert_eq!(
        dispatch(METHOD_SYS_PWRITE, 1, &p_req(fd, 0, b"0123456789"), &mut []),
        10
    );
    let mut buf = [0u8; 4];
    assert_eq!(
        dispatch(METHOD_SYS_IOCTL, 1, &ioctl_req(fd, FIONREAD, 0), &mut buf),
        4
    );
    assert_eq!(u32::from_le_bytes(buf), 10);

    // A regular read advances the OFD cursor; FIONREAD tracks remaining.
    let mut rbuf = [0u8; 4];
    assert_eq!(
        dispatch(METHOD_SYS_READ, 1, &fd.to_le_bytes(), &mut rbuf),
        4
    );
    assert_eq!(
        dispatch(METHOD_SYS_IOCTL, 1, &ioctl_req(fd, FIONREAD, 0), &mut buf),
        4
    );
    assert_eq!(u32::from_le_bytes(buf), 6, "10 - 4 consumed");
}

#[test]
fn ioctl_fionread_pipe_reports_buffered_bytes() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut pbuf = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut pbuf), 8);
    let read_fd = u32::from_le_bytes(pbuf[0..4].try_into().unwrap());
    let write_fd = u32::from_le_bytes(pbuf[4..8].try_into().unwrap());
    assert_eq!(
        dispatch(METHOD_SYS_WRITE, 1, &write_req(write_fd, b"hello"), &mut []),
        5
    );
    let mut buf = [0u8; 4];
    assert_eq!(
        dispatch(
            METHOD_SYS_IOCTL,
            1,
            &ioctl_req(read_fd, FIONREAD, 0),
            &mut buf
        ),
        4
    );
    assert_eq!(u32::from_le_bytes(buf), 5);
}

#[test]
fn ioctl_unknown_request_is_enotty() {
    let _g = crate::kernel::TestGuard::acquire();
    let fd = open_rw(b"/ioctl_x.txt");
    assert_eq!(
        dispatch(METHOD_SYS_IOCTL, 1, &ioctl_req(fd, 0x9999, 0), &mut []),
        -(abi::ENOTTY as i64)
    );
}

#[test]
fn ioctl_guards() {
    let _g = crate::kernel::TestGuard::acquire();
    // Unknown fd.
    assert_eq!(
        dispatch(METHOD_SYS_IOCTL, 1, &ioctl_req(99, FIONBIO, 1), &mut []),
        -(abi::EBADF as i64)
    );
    // Short request.
    assert_eq!(
        dispatch(METHOD_SYS_IOCTL, 1, &[0u8; 8], &mut []),
        -(abi::EINVAL as i64)
    );
    // FIONREAD with too-small response.
    let fd = open_rw(b"/ioctl_g.txt");
    assert_eq!(
        dispatch(
            METHOD_SYS_IOCTL,
            1,
            &ioctl_req(fd, FIONREAD, 0),
            &mut [0u8; 2]
        ),
        -(abi::EINVAL as i64)
    );
}
// --- Slice B1.1: SIGCHLD delivered to the parent on child exit ---
// POSIX: a process receives SIGCHLD when a child terminates. record_exit
// must OR SIGCHLD into the parent's pending_signals (same bit convention
// as kill_pid: 1 << (sig - 1)), and be a no-op when there is no parent.

const SIGCHLD: u32 = 17;

fn record_exit_req(pid: u32, status: i32) -> Vec<u8> {
    let mut req = pid.to_le_bytes().to_vec();
    req.extend_from_slice(&status.to_le_bytes());
    req
}

#[test]
fn record_exit_sets_sigchld_pending_on_parent() {
    let _g = crate::kernel::TestGuard::acquire();
    // parent = 1, child = 7
    let mut reg = 1u32.to_le_bytes().to_vec();
    reg.extend_from_slice(&7u32.to_le_bytes());
    assert_eq!(register_child(&reg), 0);

    assert_eq!(record_exit(&record_exit_req(7, 23)), 0);

    let parent_pending = crate::kernel::with_kernel(|k| k.process_mut(1).pending_signals);
    assert_ne!(
        parent_pending & (1u64 << (SIGCHLD - 1)),
        0,
        "parent must have SIGCHLD pending after a child exits"
    );
}

#[test]
fn record_exit_without_parent_does_not_panic_or_signal() {
    let _g = crate::kernel::TestGuard::acquire();
    // child 8 exists but has no parent (ppid defaults to 0).
    crate::kernel::with_kernel(|k| {
        let _ = k.process_mut(8);
    });
    assert_eq!(record_exit(&record_exit_req(8, 0)), 0);
    // No parent (pid 0) is ever materialised or signalled.
    let phantom = crate::kernel::with_kernel(|k| k.has_process(0));
    assert!(!phantom, "pid 0 must never be created as a signal target");
}

// --- Slice B1.4: POSIX getpgrp()/setpgrp() ---
// Guest libc maps getpgrp() -> host_getpgid(0) and
// setpgrp() -> host_setpgid(0,0); host_getpgid(0) (yurt_process.c).
// There is no distinct getpgrp/setpgrp import, so B1.4 is a contract
// lock over the target==0 path of getpgid/setpgid: a regression there
// would silently break getpgrp()/setpgrp() for every guest.

#[test]
fn getpgrp_returns_callers_group_defaulting_to_pid() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        let _ = k.process_mut(1234);
    });
    // getpgrp() == getpgid(0): a fresh process leads its own group.
    let req_self = 0u32.to_le_bytes().to_vec();
    assert_eq!(
        getpgid(1234, &req_self),
        1234,
        "getpgrp() must return the caller's pgid (defaults to its pid)"
    );
}

#[test]
fn setpgrp_makes_caller_a_group_leader_and_getpgrp_is_stable() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kernel::with_kernel(|k| {
        let _ = k.process_mut(1234);
    });
    // setpgrp() == setpgid(0, 0): target=caller, new_pgid=caller pid.
    let mut setpgrp_req = 0u32.to_le_bytes().to_vec();
    setpgrp_req.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(setpgid(1234, &setpgrp_req), 0);

    // Subsequent getpgrp() reflects it and is stable.
    let req_self = 0u32.to_le_bytes().to_vec();
    assert_eq!(getpgid(1234, &req_self), 1234);
    assert_eq!(
        getpgid(1234, &req_self),
        1234,
        "getpgrp() must be stable after setpgrp()"
    );
}

// --- Slice B1.3: POSIX waitid(idtype, id, infop, options) ---

const WAITID_P_PID: u32 = 1;
const WAITID_P_PGID: u32 = 2;
const WAITID_WNOHANG: u32 = 1;
const WAITID_WEXITED: u32 = 4;
const WAITID_WNOWAIT: u32 = 0x0100_0000;

fn waitid_req(idtype: u32, id: u32, options: u32) -> Vec<u8> {
    let mut req = idtype.to_le_bytes().to_vec();
    req.extend_from_slice(&id.to_le_bytes());
    req.extend_from_slice(&options.to_le_bytes());
    req
}

fn link_child(parent: u32, child: u32) {
    let mut reg = parent.to_le_bytes().to_vec();
    reg.extend_from_slice(&child.to_le_bytes());
    assert_eq!(register_child(&reg), 0);
}

fn decode_siginfo(buf: &[u8]) -> (i32, i32, u32, u32, i32) {
    (
        i32::from_le_bytes(buf[0..4].try_into().unwrap()),
        i32::from_le_bytes(buf[4..8].try_into().unwrap()),
        u32::from_le_bytes(buf[8..12].try_into().unwrap()),
        u32::from_le_bytes(buf[12..16].try_into().unwrap()),
        i32::from_le_bytes(buf[16..20].try_into().unwrap()),
    )
}

#[test]
fn waitid_p_pid_reports_terminated_child_siginfo_then_reaps() {
    let _g = crate::kernel::TestGuard::acquire();
    link_child(1, 7);
    crate::kernel::with_kernel(|k| {
        k.process_mut(7).credentials.uid = 4321;
    });
    assert_eq!(record_exit(&record_exit_req(7, 23)), 0);

    let mut buf = [0u8; 20];
    let rc = dispatch(
        METHOD_SYS_WAITID,
        1,
        &waitid_req(WAITID_P_PID, 7, WAITID_WEXITED),
        &mut buf,
    );
    assert_eq!(rc, 20);
    let (signo, code, pid, uid, status) = decode_siginfo(&buf);
    assert_eq!(signo, SIGCHLD as i32);
    assert_eq!(code, 1, "CLD_EXITED");
    assert_eq!(pid, 7);
    assert_eq!(uid, 4321, "si_uid must be the child's real uid");
    assert_eq!(status, 23);

    // Reaped: no longer a waitable child.
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 7, WAITID_WEXITED),
            &mut buf,
        ),
        -(abi::ECHILD as i64)
    );
}

#[test]
fn waitid_wnowait_leaves_child_reapable() {
    let _g = crate::kernel::TestGuard::acquire();
    link_child(1, 8);
    assert_eq!(record_exit(&record_exit_req(8, 5)), 0);
    let mut buf = [0u8; 20];

    for _ in 0..2 {
        assert_eq!(
            dispatch(
                METHOD_SYS_WAITID,
                1,
                &waitid_req(WAITID_P_PID, 8, WAITID_WEXITED | WAITID_WNOWAIT),
                &mut buf,
            ),
            20,
            "WNOWAIT must not consume the child"
        );
    }
    // A normal waitid then reaps it.
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 8, WAITID_WEXITED),
            &mut buf,
        ),
        20
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 8, WAITID_WEXITED),
            &mut buf,
        ),
        -(abi::ECHILD as i64)
    );
}

#[test]
fn waitid_eagain_when_no_matching_child_has_exited() {
    let _g = crate::kernel::TestGuard::acquire();
    link_child(1, 9);
    let mut buf = [0u8; 20];
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 9, WAITID_WEXITED),
            &mut buf,
        ),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn waitid_wnohang_no_terminated_child_returns_zeroed_siginfo() {
    let _g = crate::kernel::TestGuard::acquire();
    link_child(1, 9);
    let mut buf = [0xFFu8; 20];
    // POSIX: WNOHANG + no child in a waitable state → success (20)
    // with a zeroed siginfo (si_signo == 0), NOT -EAGAIN.
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 9, WAITID_WEXITED | WAITID_WNOHANG),
            &mut buf,
        ),
        20
    );
    assert_eq!(buf, [0u8; 20], "WNOHANG no-child must zero the siginfo");
    // WNOHANG must not have reaped/disturbed the child: it can still
    // exit and be waited normally.
    assert_eq!(record_exit(&record_exit_req(9, 3)), 0);
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 9, WAITID_WEXITED),
            &mut buf,
        ),
        20
    );
}

#[test]
fn waitid_input_guards() {
    let _g = crate::kernel::TestGuard::acquire();
    link_child(1, 12);
    assert_eq!(record_exit(&record_exit_req(12, 0)), 0);
    let mut buf = [0u8; 20];

    // Unknown idtype (>P_PGID).
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(3, 12, WAITID_WEXITED),
            &mut buf
        ),
        -(abi::EINVAL as i64)
    );
    // No wait-type bit (missing WEXITED).
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 12, 0),
            &mut buf
        ),
        -(abi::EINVAL as i64)
    );
    // Response buffer too small.
    let mut tiny = [0u8; 8];
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 12, WAITID_WEXITED),
            &mut tiny,
        ),
        -(abi::EINVAL as i64)
    );
    // Caller with no children at all.
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            999,
            &waitid_req(WAITID_P_PID, 12, WAITID_WEXITED),
            &mut buf,
        ),
        -(abi::ECHILD as i64)
    );
}

#[test]
fn waitid_rejects_unsupported_option_bits_without_reaping() {
    let _g = crate::kernel::TestGuard::acquire();
    // PR #54 review P2. Child 14 has exited and is waitable.
    link_child(1, 14);
    assert_eq!(record_exit(&record_exit_req(14, 5)), 0);
    let mut buf = [0u8; 20];
    // WEXITED | WSTOPPED(2): WSTOPPED is a real POSIX option we don't
    // implement; the contract promises -EINVAL for bad options. It must
    // be rejected BEFORE mutating `children` (no reap).
    const WSTOPPED: u32 = 2;
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 14, WAITID_WEXITED | WSTOPPED),
            &mut buf,
        ),
        -(abi::EINVAL as i64)
    );
    // Stale-adapter-garbage high bit is likewise rejected.
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 14, WAITID_WEXITED | 0x8000_0000),
            &mut buf,
        ),
        -(abi::EINVAL as i64)
    );
    // The child was NOT reaped by the rejected calls — a valid waitid
    // still finds and reaps it.
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PID, 14, WAITID_WEXITED),
            &mut buf,
        ),
        20
    );
}

#[test]
fn waitid_p_pgid_matches_childs_group() {
    let _g = crate::kernel::TestGuard::acquire();
    link_child(1, 10);
    link_child(1, 11);
    crate::kernel::with_kernel(|k| {
        k.process_mut(11).pgid = 555;
    });
    assert_eq!(record_exit(&record_exit_req(11, 9)), 0);

    let mut buf = [0u8; 20];
    let rc = dispatch(
        METHOD_SYS_WAITID,
        1,
        &waitid_req(WAITID_P_PGID, 555, WAITID_WEXITED),
        &mut buf,
    );
    assert_eq!(rc, 20);
    let (_, _, pid, _, status) = decode_siginfo(&buf);
    assert_eq!(pid, 11);
    assert_eq!(status, 9);
}

/// Regression for the PR #54 review bug: waitid(P_PGID, 0) must mean
/// "the caller's own process group", not the literal pgid 0.
#[test]
fn waitid_p_pgid_zero_resolves_to_callers_group() {
    let _g = crate::kernel::TestGuard::acquire();
    // Parent 1 leads its own group (pgid defaults to its pid = 1).
    link_child(1, 12);
    // Child 12 is in the caller's process group.
    crate::kernel::with_kernel(|k| {
        k.process_mut(12).pgid = 1;
    });
    assert_eq!(record_exit(&record_exit_req(12, 4)), 0);

    let mut buf = [0u8; 20];
    let rc = dispatch(
        METHOD_SYS_WAITID,
        1,
        &waitid_req(WAITID_P_PGID, 0, WAITID_WEXITED),
        &mut buf,
    );
    assert_eq!(rc, 20, "P_PGID id=0 must match the caller's pgrp child");
    let (_, _, pid, _, status) = decode_siginfo(&buf);
    assert_eq!(pid, 12);
    assert_eq!(status, 4);
}

#[test]
fn waitid_p_pgid_zero_matches_default_inherited_child_group() {
    let _g = crate::kernel::TestGuard::acquire();
    // PR #54 review P2 regression. Parent 1 has the lazy-zero default
    // process group; child 13 is registered and inherits pgid == 0 —
    // NOT materialized via setpgid (unlike the test above, which sets
    // pgid=1 explicitly). POSIX: an inherited default-0 child is still
    // in the parent's (the caller's) group, so waitid(P_PGID, id=0)
    // MUST find it instead of returning -ECHILD.
    link_child(1, 13);
    assert_eq!(
        crate::kernel::with_kernel(|k| k.process_mut(13).pgid),
        0,
        "precondition: child pgid is the inherited default 0"
    );
    assert_eq!(record_exit(&record_exit_req(13, 9)), 0);
    let mut buf = [0u8; 20];
    assert_eq!(
        dispatch(
            METHOD_SYS_WAITID,
            1,
            &waitid_req(WAITID_P_PGID, 0, WAITID_WEXITED),
            &mut buf,
        ),
        20,
        "default-inherited child must match the caller's pgrp"
    );
    let (_, _, pid, _, status) = decode_siginfo(&buf);
    assert_eq!(pid, 13);
    assert_eq!(status, 9);
}

// --- Slice B1.7: POSIX pthread_cancel / pthread_testcancel (kernel) ---

fn spawn_worker(pid: u32) -> u32 {
    crate::kernel::with_kernel(|k| {
        k.insert_host_process(pid, 0, vec![b"/bin/threaded".to_vec()], Some(10));
        k.spawn_thread(pid, Some(77)).expect("thread spawn")
    })
}

#[test]
fn thread_cancel_marks_target_and_testcancel_observes_it() {
    let _g = crate::kernel::TestGuard::acquire();
    let tid = spawn_worker(9);

    let main_ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: crate::kernel::MAIN_THREAD_TID,
    };
    assert_eq!(
        dispatch_with_context(
            METHOD_SYS_THREAD_CANCEL,
            main_ctx,
            &tid.to_le_bytes(),
            &mut [],
        ),
        0
    );
    assert!(crate::kernel::with_kernel(|k| k
        .process(9)
        .threads
        .get(&tid)
        .expect("worker")
        .cancel_requested));

    let worker_ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: tid,
    };
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_TESTCANCEL, worker_ctx, &[], &mut []),
        1
    );
}

#[test]
fn testcancel_is_zero_without_a_pending_cancel() {
    let _g = crate::kernel::TestGuard::acquire();
    let tid = spawn_worker(9);
    let worker_ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: tid,
    };
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_TESTCANCEL, worker_ctx, &[], &mut []),
        0
    );
}

#[test]
fn thread_cancel_unknown_or_exited_thread_is_esrch() {
    let _g = crate::kernel::TestGuard::acquire();
    let tid = spawn_worker(9);
    let main_ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: crate::kernel::MAIN_THREAD_TID,
    };

    assert_eq!(
        dispatch_with_context(
            METHOD_SYS_THREAD_CANCEL,
            main_ctx,
            &999u32.to_le_bytes(),
            &mut [],
        ),
        -(abi::ESRCH as i64)
    );

    crate::kernel::with_kernel(|k| {
        k.exit_thread_authenticated(9, tid, 0).expect("thread exit");
    });
    assert_eq!(
        dispatch_with_context(
            METHOD_SYS_THREAD_CANCEL,
            main_ctx,
            &tid.to_le_bytes(),
            &mut [],
        ),
        -(abi::ESRCH as i64)
    );
    let worker_ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: tid,
    };
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_TESTCANCEL, worker_ctx, &[], &mut []),
        0
    );
}

#[test]
fn thread_cancel_input_guards() {
    let _g = crate::kernel::TestGuard::acquire();
    let _ = spawn_worker(9);
    let main_ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: crate::kernel::MAIN_THREAD_TID,
    };
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_CANCEL, main_ctx, &[], &mut []),
        -(abi::EINVAL as i64)
    );
    assert_eq!(
        dispatch_with_context(METHOD_SYS_THREAD_TESTCANCEL, main_ctx, &[1, 2, 3], &mut [],),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn pthread_cancel_self_from_main_thread_normalizes_guest_id() {
    let _g = crate::kernel::TestGuard::acquire();
    // spawn_worker(9) also creates process 9 with a MAIN_THREAD_TID
    // record. PR #54 review P2: pthread_self() on main returns the
    // guest main id (0); pthread_cancel(pthread_self()) must normalize
    // 0 → MAIN_THREAD_TID and succeed, not -ESRCH.
    spawn_worker(9);
    let main_ctx = DispatchContext {
        caller_pid: 9,
        caller_tid: crate::kernel::MAIN_THREAD_TID,
    };
    let self_id = dispatch_with_context(METHOD_SYS_THREAD_SELF, main_ctx, &[], &mut []);
    assert_eq!(self_id, crate::kernel::GUEST_MAIN_PTHREAD_ID as i64);
    assert_eq!(
        dispatch_with_context(
            METHOD_SYS_THREAD_CANCEL,
            main_ctx,
            &(self_id as u32).to_le_bytes(),
            &mut [],
        ),
        0,
        "self-cancel of the main thread must succeed"
    );
    assert!(crate::kernel::with_kernel(|k| k
        .process(9)
        .threads
        .get(&crate::kernel::MAIN_THREAD_TID)
        .expect("main thread record")
        .cancel_requested));
}

// --- Slice B1.8-a: POSIX sigqueue (additive RT-signal queue) ---

fn sigqueue_req(target: u32, sig: u32, value: i32) -> Vec<u8> {
    let mut req = target.to_le_bytes().to_vec();
    req.extend_from_slice(&sig.to_le_bytes());
    req.extend_from_slice(&value.to_le_bytes());
    req
}

fn materialize(pid: u32) {
    crate::kernel::with_kernel(|k| {
        let _ = k.process_mut(pid);
    });
}

#[test]
fn sigqueue_enqueues_rt_signal_with_payload_and_sender() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    // caller (sender) = 1, target = 7, RT signal 40, value 99
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 40, 99), &mut []),
        0
    );

    let (queue, bitmask) = crate::kernel::with_kernel(|k| {
        let p = k.process_mut(7);
        (p.pending_rt.clone(), p.pending_signals)
    });
    assert_eq!(queue.len(), 1);
    assert_eq!(
        queue[0],
        crate::kernel::RtSignal {
            signo: 40,
            value: 99,
            sender_pid: 1
        }
    );
    // sigqueue does NOT mutate the kill/SIGCHLD bitmask (separate
    // producer) — but sigpending() reports the union, so signo 40
    // shows as pending there.
    assert_eq!(
        bitmask & (1u64 << (40 - 1)),
        0,
        "RT must not touch the bitmask"
    );
    let mut buf = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SIGPENDING, 7, &[], &mut buf), 8);
    assert_ne!(
        u64::from_le_bytes(buf) & (1u64 << (40 - 1)),
        0,
        "sigpending unions the RT queue"
    );
}

#[test]
fn sigqueue_queues_with_multiplicity_unlike_the_bitmask() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 41, 1), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 2, &sigqueue_req(7, 41, 2), &mut []),
        0
    );
    let queue = crate::kernel::with_kernel(|k| k.process_mut(7).pending_rt.clone());
    assert_eq!(queue.len(), 2, "RT signals queue with multiplicity");
    assert_eq!(queue[0].value, 1);
    assert_eq!(queue[0].sender_pid, 1);
    assert_eq!(queue[1].value, 2);
    assert_eq!(queue[1].sender_pid, 2);
}

#[test]
fn sigqueue_sig_zero_is_probe_without_enqueue() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 0, 0), &mut []),
        0
    );
    assert!(crate::kernel::with_kernel(|k| k
        .process_mut(7)
        .pending_rt
        .is_empty()));
    // Probe on a missing process is ESRCH.
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(424242, 0, 0), &mut []),
        -(abi::ESRCH as i64)
    );
}

#[test]
fn sigqueue_input_guards() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    // sig out of range.
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 64, 0), &mut []),
        -(abi::EINVAL as i64)
    );
    // short request (<12 bytes).
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &[0u8; 8], &mut []),
        -(abi::EINVAL as i64)
    );
    // unknown target, real signal.
    assert_eq!(
        dispatch(
            METHOD_SYS_SIGQUEUE,
            1,
            &sigqueue_req(424242, 40, 0),
            &mut []
        ),
        -(abi::ESRCH as i64)
    );
}

#[test]
fn sigqueue_caps_the_rt_queue_returning_eagain() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    // Fill the per-process RT queue to its sanity cap; every push succeeds.
    for _ in 0..crate::kernel::KERNEL_RT_SIGNAL_QUEUE_CAP {
        assert_eq!(
            dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 40, 0), &mut []),
            0
        );
    }
    // The next enqueue is refused with -EAGAIN (Linux RLIMIT_SIGPENDING
    // semantics) instead of growing kernel memory without bound while
    // the consumer (sigwaitinfo/delivery) is gate-deferred.
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 40, 0), &mut []),
        -(abi::EAGAIN as i64)
    );
}

// --- Slice B1.8-b: POSIX sigwaitinfo (non-blocking RT dequeue) ---

fn sigset_mask(sig: u32) -> Vec<u8> {
    (1u64 << (sig - 1)).to_le_bytes().to_vec()
}

fn decode_rt_siginfo(buf: &[u8]) -> (i32, i32, u32, i32) {
    (
        i32::from_le_bytes(buf[0..4].try_into().unwrap()),
        i32::from_le_bytes(buf[4..8].try_into().unwrap()),
        u32::from_le_bytes(buf[8..12].try_into().unwrap()),
        i32::from_le_bytes(buf[12..16].try_into().unwrap()),
    )
}

#[test]
fn sigwaitinfo_dequeues_oldest_matching_and_returns_siginfo() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 40, 99), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 2, &sigqueue_req(7, 40, 100), &mut []),
        0
    );

    let mut info = [0u8; 16];
    let rc = dispatch(METHOD_SYS_SIGWAITINFO, 7, &sigset_mask(40), &mut info);
    assert_eq!(rc, 16);
    let (signo, code, pid, value) = decode_rt_siginfo(&info);
    assert_eq!(signo, 40);
    assert_eq!(code, -1, "SI_QUEUE");
    assert_eq!(pid, 1, "oldest queued → sender 1");
    assert_eq!(value, 99);

    // Second still queued; sigpending still reports signo 40 (union
    // derives it from the remaining RT entry — bitmask untouched).
    let (len, bit) = crate::kernel::with_kernel(|k| {
        let p = k.process_mut(7);
        (p.pending_rt.len(), p.pending_signals & (1u64 << (40 - 1)))
    });
    assert_eq!(len, 1);
    assert_eq!(bit, 0, "RT never set the kill bitmask");
    let mut buf = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SIGPENDING, 7, &[], &mut buf), 8);
    assert_ne!(u64::from_le_bytes(buf) & (1u64 << (40 - 1)), 0);
}

#[test]
fn sigwaitinfo_drain_makes_sigpending_drop_the_signo() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 3, &sigqueue_req(7, 41, 7), &mut []),
        0
    );
    let mut info = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_SIGWAITINFO, 7, &sigset_mask(41), &mut info),
        16
    );
    // RT queue empty and no kill bit → sigpending no longer reports 41.
    assert!(crate::kernel::with_kernel(|k| k
        .process_mut(7)
        .pending_rt
        .is_empty()));
    let mut buf = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SIGPENDING, 7, &[], &mut buf), 8);
    assert_eq!(
        u64::from_le_bytes(buf) & (1u64 << (41 - 1)),
        0,
        "no producer left for signo 41"
    );
}

/// Regression for the PR #54 review bug: kill() and sigqueue() are
/// independent producers; draining the RT entry must NOT clear a bit
/// kill() set for the same signo.
#[test]
fn sigpending_preserves_kill_bit_after_rt_drain() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    // kill() sets the bitmask bit for signo 40 (no RT entry).
    assert_eq!(kill_pid(7, 40), 0);
    // sigqueue() adds an RT entry for the same signo.
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 40, 5), &mut []),
        0
    );
    // Drain the single RT entry.
    let mut info = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_SIGWAITINFO, 7, &sigset_mask(40), &mut info),
        16
    );
    // signo 40 is STILL pending — the kill() bit was not clobbered.
    let mut buf = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SIGPENDING, 7, &[], &mut buf), 8);
    assert_ne!(
        u64::from_le_bytes(buf) & (1u64 << (40 - 1)),
        0,
        "kill()-set pending must survive RT drain"
    );
}

#[test]
fn sigwaitinfo_eagain_when_no_selected_signal_pending() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    let mut info = [0u8; 16];
    // Empty queue.
    assert_eq!(
        dispatch(METHOD_SYS_SIGWAITINFO, 7, &sigset_mask(40), &mut info),
        -(abi::EAGAIN as i64)
    );
    // Queued sig 40 but the set selects only sig 5.
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 40, 1), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_SIGWAITINFO, 7, &sigset_mask(5), &mut info),
        -(abi::EAGAIN as i64)
    );
}

#[test]
fn sigwaitinfo_input_guards() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    let mut info = [0u8; 16];
    // Short request (<8 bytes).
    assert_eq!(
        dispatch(METHOD_SYS_SIGWAITINFO, 7, &[0u8; 4], &mut info),
        -(abi::EINVAL as i64)
    );
    // Response buffer too small.
    let mut tiny = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SIGWAITINFO, 7, &sigset_mask(40), &mut tiny),
        -(abi::EINVAL as i64)
    );
}

// --- Slice B1.9: POSIX sigpending ---

#[test]
fn sigpending_reports_the_pending_set() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    // sigqueue sets the compat bitmask bit for sig 40 on proc 7.
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 40, 0), &mut []),
        0
    );

    let mut buf = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SIGPENDING, 7, &[], &mut buf), 8);
    let mask = u64::from_le_bytes(buf);
    assert_ne!(mask & (1u64 << (40 - 1)), 0, "sig 40 must show pending");
    assert_eq!(mask & (1u64 << (5 - 1)), 0, "unrelated sig must not");
}

#[test]
fn fork_child_does_not_inherit_parent_pending_rt() {
    let _g = crate::kernel::TestGuard::acquire();
    // PR #54 review P2. Parent 7 has a queued RT signal before fork.
    materialize(7);
    assert_eq!(
        dispatch(METHOD_SYS_SIGQUEUE, 1, &sigqueue_req(7, 42, 9), &mut []),
        0
    );
    let mut buf = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SIGPENDING, 7, &[], &mut buf), 8);
    assert_ne!(
        u64::from_le_bytes(buf) & (1u64 << (42 - 1)),
        0,
        "sanity: parent has the queued RT signal"
    );
    // Fork: POSIX says the child starts with an EMPTY pending set
    // (standard AND real-time).
    let child = crate::kernel::with_kernel(|k| k.prepare_fork(7)).expect("prepare_fork");
    crate::kernel::with_kernel(|k| k.commit_fork(7, child)).expect("commit_fork");
    // sigpending() in the child must NOT show the parent's RT signal.
    let mut cbuf = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SIGPENDING, child, &[], &mut cbuf), 8);
    assert_eq!(
        u64::from_le_bytes(cbuf) & (1u64 << (42 - 1)),
        0,
        "forked child must not inherit the parent's pending_rt"
    );
    // …and sigwaitinfo() in the child finds nothing to dequeue.
    assert_eq!(
        dispatch(
            METHOD_SYS_SIGWAITINFO,
            child,
            &sigset_mask(42),
            &mut [0u8; 16]
        ),
        -(abi::EAGAIN as i64)
    );
    // The parent still has its signal (fork didn't disturb it).
    assert_eq!(dispatch(METHOD_SYS_SIGPENDING, 7, &[], &mut buf), 8);
    assert_ne!(u64::from_le_bytes(buf) & (1u64 << (42 - 1)), 0);
}

#[test]
fn sigpending_is_empty_when_nothing_queued() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    let mut buf = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SIGPENDING, 7, &[], &mut buf), 8);
    assert_eq!(u64::from_le_bytes(buf), 0);
}

#[test]
fn sigpending_buffer_too_small_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    materialize(7);
    let mut tiny = [0u8; 4];
    assert_eq!(
        dispatch(METHOD_SYS_SIGPENDING, 7, &[], &mut tiny),
        -(abi::EINVAL as i64)
    );
}

// --- Slice B4a: durable KV (sys_idb_*) round-trip over native emulation ---

fn idb_kv_req(store: &[u8], tail: &[u8]) -> Vec<u8> {
    // get / delete / list share: u8 store_len + store + tail(key|prefix).
    let mut r = vec![store.len() as u8];
    r.extend_from_slice(store);
    r.extend_from_slice(tail);
    r
}

fn idb_put_req(store: &[u8], key: &[u8], value: &[u8]) -> Vec<u8> {
    let mut r = vec![store.len() as u8];
    r.extend_from_slice(store);
    r.extend_from_slice(&(key.len() as u32).to_le_bytes());
    r.extend_from_slice(key);
    r.extend_from_slice(value);
    r
}

/// Decode the sys_idb_list response: u32 count + (u32 klen + key)*.
fn idb_decode_list(buf: &[u8], n: usize) -> Vec<Vec<u8>> {
    let body = &buf[..n];
    let count = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
    let mut keys = Vec::with_capacity(count);
    let mut off = 4;
    for _ in 0..count {
        let klen = u32::from_le_bytes(body[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        keys.push(body[off..off + klen].to_vec());
        off += klen;
    }
    keys
}

#[test]
fn idb_put_get_roundtrip_and_missing_is_enoent() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_idb_mock();
    assert_eq!(
        dispatch(
            METHOD_SYS_IDB_PUT,
            1,
            &idb_put_req(b"s", b"k", b"hello"),
            &mut []
        ),
        0
    );
    let mut buf = [0u8; 16];
    let n = dispatch(METHOD_SYS_IDB_GET, 1, &idb_kv_req(b"s", b"k"), &mut buf);
    assert_eq!(n, 5);
    assert_eq!(&buf[..5], b"hello");
    // Missing key → -ENOENT.
    assert_eq!(
        dispatch(METHOD_SYS_IDB_GET, 1, &idb_kv_req(b"s", b"nope"), &mut buf),
        -(abi::ENOENT as i64)
    );
}

#[test]
fn idb_delete_removes_and_missing_delete_is_ok() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_idb_mock();
    assert_eq!(
        dispatch(
            METHOD_SYS_IDB_PUT,
            1,
            &idb_put_req(b"s", b"k", b"v"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_IDB_DELETE, 1, &idb_kv_req(b"s", b"k"), &mut []),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_IDB_GET,
            1,
            &idb_kv_req(b"s", b"k"),
            &mut [0u8; 8]
        ),
        -(abi::ENOENT as i64)
    );
    // Deleting an absent key is still 0 (POSIX-ish idempotent contract).
    assert_eq!(
        dispatch(METHOD_SYS_IDB_DELETE, 1, &idb_kv_req(b"s", b"k"), &mut []),
        0
    );
}

#[test]
fn idb_list_prefix_order_and_store_isolation() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_idb_mock();
    for (k, v) in [(&b"ab"[..], &b"1"[..]), (b"a", b"2"), (b"b", b"3")] {
        assert_eq!(
            dispatch(METHOD_SYS_IDB_PUT, 1, &idb_put_req(b"s1", k, v), &mut []),
            0
        );
    }
    // Same key in a different store is independent.
    assert_eq!(
        dispatch(
            METHOD_SYS_IDB_PUT,
            1,
            &idb_put_req(b"s2", b"a", b"X"),
            &mut []
        ),
        0
    );
    let mut buf = [0u8; 64];
    // Prefix "a" → ["a","ab"] (BTreeMap-ordered), not "b", not s2's "a".
    let n = dispatch(METHOD_SYS_IDB_LIST, 1, &idb_kv_req(b"s1", b"a"), &mut buf);
    assert!(n > 0);
    assert_eq!(
        idb_decode_list(&buf, n as usize),
        vec![b"a".to_vec(), b"ab".to_vec()]
    );
    // Empty prefix → all of s1's keys, ordered.
    let n = dispatch(METHOD_SYS_IDB_LIST, 1, &idb_kv_req(b"s1", b""), &mut buf);
    assert_eq!(
        idb_decode_list(&buf, n as usize),
        vec![b"a".to_vec(), b"ab".to_vec(), b"b".to_vec()]
    );
    // s2 only has its own "a".
    let n = dispatch(METHOD_SYS_IDB_LIST, 1, &idb_kv_req(b"s2", b""), &mut buf);
    assert_eq!(idb_decode_list(&buf, n as usize), vec![b"a".to_vec()]);
}

#[test]
fn idb_list_truncates_to_capacity_without_partial_entry() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_idb_mock();
    for k in [&b"k1"[..], b"k2", b"k3"] {
        assert_eq!(
            dispatch(METHOD_SYS_IDB_PUT, 1, &idb_put_req(b"s", k, b"v"), &mut []),
            0
        );
    }
    // 4 (count) + one entry (4 + 2) = 10 bytes fits exactly one key.
    let mut small = [0u8; 10];
    let n = dispatch(METHOD_SYS_IDB_LIST, 1, &idb_kv_req(b"s", b""), &mut small);
    assert!(n > 0 && (n as usize) <= 10);
    let keys = idb_decode_list(&small, n as usize);
    assert_eq!(keys.len(), 1, "count must reflect only what fit");
    assert_eq!(keys[0], b"k1");
}

#[test]
fn idb_get_too_small_buffer_is_e2big_not_required_size() {
    // PR #61 review P2: kh_idb_get's ABI contract returns -E2BIG when
    // the output buffer is smaller than the stored value (Wasmtime and
    // JS hosts both do this). The native test emulation must match, or
    // unit tests would validate behavior real hosts never produce.
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_idb_mock();
    assert_eq!(
        dispatch(
            METHOD_SYS_IDB_PUT,
            1,
            &idb_put_req(b"s", b"k", b"hello"),
            &mut []
        ),
        0
    );
    // 2-byte buffer for a 5-byte value → -E2BIG, nothing written.
    let mut tiny = [0xAAu8; 2];
    assert_eq!(
        dispatch(METHOD_SYS_IDB_GET, 1, &idb_kv_req(b"s", b"k"), &mut tiny),
        -(abi::E2BIG as i64),
        "too-small idb_get must be -E2BIG, not a positive required size"
    );
    assert_eq!(tiny, [0xAAu8; 2], "nothing written on E2BIG");
}

#[test]
fn idb_list_buffer_too_small_for_header_matches_host_count_size() {
    // PR #61 review P3: pin the get/list asymmetry as DELIBERATE.
    // kh_idb_list (unlike kh_idb_get/-E2BIG) returns the positive byte
    // count it would write — the 4-byte count header at minimum — on
    // both real hosts (JS + wasmtime). The emulation must match that,
    // NOT return -E2BIG, so this is locked here.
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_idb_mock();
    assert_eq!(
        dispatch(
            METHOD_SYS_IDB_PUT,
            1,
            &idb_put_req(b"s", b"k", b"v"),
            &mut []
        ),
        0
    );
    // 2-byte buffer can't fit the 4-byte count header → host-faithful
    // positive count-header size (4), nothing written; NOT -E2BIG.
    let mut tiny = [0xAAu8; 2];
    assert_eq!(
        dispatch(METHOD_SYS_IDB_LIST, 1, &idb_kv_req(b"s", b""), &mut tiny),
        4,
        "idb_list too-small header must match the real hosts (positive 4), not -E2BIG"
    );
    assert_eq!(
        tiny, [0xAAu8; 2],
        "nothing written when the header does not fit"
    );
}

// --- Slice B3.1: POSIX shutdown(fd, how) ---

fn shutdown_req(fd: u32, how: u32) -> Vec<u8> {
    let mut r = fd.to_le_bytes().to_vec();
    r.extend_from_slice(&how.to_le_bytes());
    r
}

/// AF_UNIX SOCK_DGRAM socketpair (`socketpair_req(1, 2, 0)`) → connected
/// fds 3 and 4. The caller already holds the `TestGuard`; do NOT
/// re-acquire it here — the test lock is a non-reentrant Mutex, so a
/// second acquire on this thread deadlocks (and would also reset kernel
/// state mid-test).
fn unix_dgram_pair() {
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 2, 0),
            &mut [0u8; 8]
        ),
        8
    );
}

#[test]
fn shutdown_wr_makes_send_epipe() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    unix_dgram_pair();
    // Pre-shutdown send works.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(3, b"hi"),
            &mut []
        ),
        2
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 1), &mut []),
        0
    );
    // SHUT_WR → subsequent send is EPIPE.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(3, b"x"),
            &mut []
        ),
        -(abi::EPIPE as i64)
    );
}

#[test]
fn shutdown_rd_makes_recv_eof_even_with_queued_data() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    unix_dgram_pair();
    // Peer (fd 4) sends to fd 3's rx queue.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(4, b"data"),
            &mut []
        ),
        4
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 0), &mut []),
        0
    );
    // SHUT_RD → recv returns 0 (EOF) despite queued bytes.
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(3, 0), &mut buf),
        0
    );
}

#[test]
fn shutdown_rdwr_blocks_both_directions() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    unix_dgram_pair();
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 2), &mut []),
        0
    );
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(3, 0), &mut buf),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(3, b"x"),
            &mut []
        ),
        -(abi::EPIPE as i64)
    );
}

#[test]
fn shutdown_is_idempotent_and_accumulates() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    unix_dgram_pair();
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 0), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 0), &mut []),
        0
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 1), &mut []),
        0
    );
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(3, 0), &mut buf),
        0,
        "SHUT_RD still in effect after also SHUT_WR"
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(3, b"x"),
            &mut []
        ),
        -(abi::EPIPE as i64)
    );
}

#[test]
fn shutdown_guards() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    unix_dgram_pair();
    // how out of range.
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 3), &mut []),
        -(abi::EINVAL as i64)
    );
    // short request.
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &[0u8; 4], &mut []),
        -(abi::EINVAL as i64)
    );
    // unknown fd.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SHUTDOWN,
            1,
            &shutdown_req(404, 0),
            &mut []
        ),
        -(abi::EBADF as i64)
    );
    // not a socket (a regular file fd).
    let ffd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_CREAT | O_WRITE, b"/sd.txt"),
        &mut [],
    );
    assert!(ffd >= 3);
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SHUTDOWN,
            1,
            &shutdown_req(ffd as u32, 0),
            &mut []
        ),
        -(abi::ENOTSOCK as i64)
    );
}

// --- Slice B3.1 (review P2): shutdown consistency across all I/O ---

#[test]
fn shutdown_wr_makes_sendto_epipe() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/sd-to-rx.sock"),
            &mut []
        ),
        0
    );
    // Pre-shutdown sendto works.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDTO,
            1,
            &socket_sendto_req(4, 0, &sockaddr_un(b"/tmp/sd-to-rx.sock"), b"hi"),
            &mut []
        ),
        2
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(4, 1), &mut []),
        0
    );
    // SHUT_WR must also stop sendto, not just send.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDTO,
            1,
            &socket_sendto_req(4, 0, &sockaddr_un(b"/tmp/sd-to-rx.sock"), b"x"),
            &mut []
        ),
        -(abi::EPIPE as i64)
    );
}

#[test]
fn shutdown_rd_makes_recvfrom_eof_even_with_queued_data() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        3
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socketpair_req(3, 5, 0), &mut []),
        4
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_BIND,
            1,
            &socket_bind_unix_req(3, b"/tmp/sd-from-rx.sock"),
            &mut []
        ),
        0
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDTO,
            1,
            &socket_sendto_req(4, 0, &sockaddr_un(b"/tmp/sd-from-rx.sock"), b"ping"),
            &mut []
        ),
        4
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 0), &mut []),
        0
    );
    // SHUT_RD must also make recvfrom EOF (0), despite queued bytes.
    let mut response = [0u8; 4 + 8 + 108];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVFROM,
            1,
            &socket_recvfrom_req(3, 0, 4, 108),
            &mut response
        ),
        0
    );
}

#[test]
fn shutdown_wr_makes_sendmsg_epipe() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    // AF_UNIX SOCK_STREAM pair on fds 3 and 4.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 1, 0),
            &mut [0u8; 8]
        ),
        8
    );
    // Pre-shutdown sendmsg works.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDMSG,
            1,
            &socket_sendmsg_req(3, b"hi", &[]),
            &mut []
        ),
        2
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 1), &mut []),
        0
    );
    // SHUT_WR must also stop sendmsg.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDMSG,
            1,
            &socket_sendmsg_req(3, b"x", &[]),
            &mut []
        ),
        -(abi::EPIPE as i64)
    );
}

// --- Slice B3.2: SO_PEERCRED (sys_socket_peercred) ---

/// Decode the 12-byte ucred response: (pid, uid, gid) as i32 LE.
fn peercred(buf: &[u8]) -> (i32, i32, i32) {
    (
        i32::from_le_bytes(buf[0..4].try_into().unwrap()),
        i32::from_le_bytes(buf[4..8].try_into().unwrap()),
        i32::from_le_bytes(buf[8..12].try_into().unwrap()),
    )
}

#[test]
fn peercred_socketpair_reports_creating_process() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    // AF_UNIX SOCK_STREAM (sock_type 1) pair on fds 3 and 4, created by
    // pid 1. peer_cred only lives on UnixStream — a SOCK_DGRAM pair
    // (sock_type 2, what unix_dgram_pair() builds) has no captured peer.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 1, 0),
            &mut [0u8; 8]
        ),
        8
    );
    let mut buf = [0u8; 12];
    // fixed_out convention (cf. sys_socket_info / sys_socket_addr):
    // success returns the byte count written, not 0. The host adapter
    // maps any >=0 to the libc-level 0 the TS host_socket_peercred returns.
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_PEERCRED, 1, &socket_fd_req(3), &mut buf),
        12
    );
    // Default credentials (Credentials::DEFAULT) are uid/gid 1000; the
    // creating process is pid 1. Both ends see the creator.
    assert_eq!(peercred(&buf), (1, 1000, 1000));
    let mut buf2 = [0u8; 12];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_PEERCRED, 1, &socket_fd_req(4), &mut buf2),
        12
    );
    assert_eq!(peercred(&buf2), (1, 1000, 1000));
}

#[test]
fn peercred_non_unix_stream_socket_returns_zeros() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    // AF_UNIX SOCK_DGRAM pair: a socket fd, but not a UnixStream — no
    // captured peer creds, so zeros (mirrors TS host_socket_peercred `?? 0`).
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 2, 0),
            &mut [0u8; 8]
        ),
        8
    );
    let mut buf = [0xFFu8; 12];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_PEERCRED, 1, &socket_fd_req(3), &mut buf),
        12
    );
    assert_eq!(peercred(&buf), (0, 0, 0));
}

#[test]
fn peercred_guards() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    unix_dgram_pair();
    // Short request.
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_PEERCRED, 1, &[], &mut [0u8; 12]),
        -(abi::EINVAL as i64)
    );
    // Too-small response → required size (12), nothing written.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_PEERCRED,
            1,
            &socket_fd_req(3),
            &mut [0u8; 4]
        ),
        12
    );
    // Deliberate ordering (PR #58 review): the response-size check
    // short-circuits BEFORE fd validation, matching the fixed_out
    // convention of sys_socket_info / sys_socket_addr. So small buffer
    // + bad fd returns the required size (12), NOT -EBADF — pinned here
    // so the ordering is an asserted choice, not an accident.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_PEERCRED,
            1,
            &socket_fd_req(404),
            &mut [0u8; 4]
        ),
        12
    );
    // Unknown fd.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_PEERCRED,
            1,
            &socket_fd_req(404),
            &mut [0u8; 12]
        ),
        -(abi::EBADF as i64)
    );
    // Not a socket (a regular file fd).
    let ffd = dispatch(
        METHOD_SYS_OPEN,
        1,
        &open_req(O_CREAT | O_WRITE, b"/pc.txt"),
        &mut [],
    );
    assert!(ffd >= 3);
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_PEERCRED,
            1,
            &socket_fd_req(ffd as u32),
            &mut [0u8; 12]
        ),
        -(abi::ENOTSOCK as i64)
    );
}

// --- Slice B3.4a: AF_INET6 socket() / sockaddr_in6 acceptance ---

#[test]
fn socket_open_af_inet6_succeeds() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    // Parity: TS host_socket_open does not validate the domain — any
    // non-(AF_UNIX SOCK_DGRAM) allocates an inet stream socket. AF_INET6
    // must not be rejected with EAFNOSUPPORT at the kernel boundary.
    // NOTE: this slice only closes the AF_INET6 case. Rust intentionally
    // remains stricter than TS for other families (e.g. AF_PACKET still
    // → EAFNOSUPPORT); full domain-permissive parity is out of scope.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(10, 1, 0),
            &mut []
        ),
        3
    );
}

#[test]
fn connect_af_inet6_reaches_host_seam() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_connect_result(55);
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(10, 1, 0),
            &mut []
        ),
        3
    );
    let v6 = sockaddr_in6([0u8; 16], 8080); // ::, port 8080
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_req(3, &v6),
            &mut []
        ),
        0
    );
    // The sockaddr_in6 bytes are forwarded verbatim to the host adapter
    // (same seam as IPv4) — not rejected as an unsupported family.
    assert_eq!(
        crate::kh::test_support::socket_connect_calls(),
        vec![(v6.to_vec(), 0)]
    );
}

#[test]
fn bind_af_inet6_sockaddr_accepted() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(10, 1, 0),
            &mut []
        ),
        3
    );
    let v6 = sockaddr_in6([0u8; 16], 9000);
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_BIND, 1, &socket_bind_req(3, &v6), &mut []),
        0
    );
}

#[test]
fn af_inet_socket_still_rejects_inet6_sockaddr_family_mismatch() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    // Additivity guard: an AF_INET (domain 2) socket given a v6
    // sockaddr is still EAFNOSUPPORT — v6 acceptance must not loosen
    // the v4 path's family/addr match.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_CONNECT,
            1,
            &socket_connect_req(3, &sockaddr_in6([0u8; 16], 80)),
            &mut []
        ),
        -(abi::EAFNOSUPPORT as i64)
    );
}

#[test]
fn listen_af_inet6_unbound_uses_v6_wildcard() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_listen_result(123);
    // AF_INET6 stream socket, never bound → listen() must synthesize
    // the v6 wildcard (any_addr_ipv6_sockaddr) and forward it to the
    // host listen seam (PR #58 review: this branch was uncovered).
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(10, 1, 0),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_LISTEN,
            1,
            &socket_listen_req(3, 8),
            &mut []
        ),
        0
    );
    let calls = crate::kh::test_support::socket_listen_calls();
    assert_eq!(calls.len(), 1);
    let (addr, backlog) = &calls[0];
    assert_eq!(*backlog, 8);
    assert_eq!(addr.len(), 28, "sockaddr_in6 is 28 bytes");
    assert_eq!(
        u16::from_le_bytes([addr[0], addr[1]]),
        10,
        "AF_INET6 family"
    );
}

// --- Slice B3.1 (review P2): shutdown must not corrupt socket state ---

#[test]
fn shutdown_rd_does_not_transfer_or_drain_scm_rights() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    // AF_UNIX SOCK_STREAM pair.
    let mut socket_fds = [0u8; 8];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKETPAIR,
            1,
            &socketpair_req(1, 1, 0),
            &mut socket_fds
        ),
        8
    );
    let left = u32::from_le_bytes(socket_fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(socket_fds[4..8].try_into().unwrap());
    // Queue a message carrying an SCM_RIGHTS fd on `right`'s rx queue.
    let mut pipe_fds = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut pipe_fds), 8);
    let pipe_write = u32::from_le_bytes(pipe_fds[4..8].try_into().unwrap());
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SENDMSG,
            1,
            &socket_sendmsg_req(left, b"x", &[pipe_write]),
            &mut []
        ),
        1
    );
    // Close the read half of `right` BEFORE receiving.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SHUTDOWN,
            1,
            &shutdown_req(right, 0),
            &mut []
        ),
        0
    );
    // recvmsg now reports EOF (0 bytes) and must NOT install the queued
    // fd nor drain the ancillary queue — a shutdown EOF is not a
    // zero-length message. Pre-fix this returned 0 yet still transferred
    // the fd (rights count == 1). (PR #58 review P2)
    let mut recv = [0u8; 1 + 4 + 4];
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVMSG,
            1,
            &socket_recvmsg_req(right, 0, 1),
            &mut recv
        ),
        0
    );
    assert_eq!(
        u32::from_le_bytes(recv[1..5].try_into().unwrap()),
        0,
        "SHUT_RD EOF must not transfer SCM_RIGHTS fds"
    );
}

#[test]
fn shutdown_before_connect_does_not_poison_host_socket() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_connect_result(91);
    crate::kh::test_support::push_socket_recv_result(b"pong");
    // AF_INET stream socket — still SocketKind::Open (unconnected).
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_OPEN,
            1,
            &socket_open_req(2, 1, 0),
            &mut []
        ),
        3
    );
    // shutdown() on the unconnected Open socket records half-close bits
    // (SHUT_RDWR). This must not survive the Open→Host conversion.
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(3, 2), &mut []),
        0
    );
    // connect() reuses the same socket id, converting Open→Host.
    let req = socket_connect_req(3, &sockaddr_in([127, 0, 0, 1], 6000));
    assert_eq!(dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &req, &mut []), 0);
    // send must reach the live host socket, NOT return EPIPE from the
    // stale pre-connect SHUT_WR bit. (PR #58 review P2)
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(3, b"ping"),
            &mut []
        ),
        4
    );
    assert_eq!(
        crate::kh::test_support::socket_send_calls(),
        vec![(91, b"ping".to_vec())]
    );
    // recv must reach the host socket, NOT return 0 from a stale SHUT_RD.
    let mut recv = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(3, 0), &mut recv),
        4
    );
    assert_eq!(&recv[..4], b"pong");
}

// --- Slice B3.1 (review): shutdown(SHUT_WR) gives the AF_UNIX peer EOF ---

#[test]
fn shutdown_wr_gives_unix_stream_peer_eof_after_drain_but_peer_can_still_send() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    // AF_UNIX SOCK_STREAM pair: fd 3 (A) <-> fd 4 (B).
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 1, 0), &mut fds),
        8
    );
    let a = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let b = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    // A queues "hi" to B, then shuts its write half.
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(a, b"hi"),
            &mut []
        ),
        2
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(a, 1), &mut []),
        0
    );
    // POSIX: B drains the already-queued bytes first...
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(b, 0), &mut buf),
        2
    );
    assert_eq!(&buf[..2], b"hi");
    // ...then sees EOF (0), NOT EAGAIN — A's SHUT_WR reached the peer.
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(b, 0), &mut buf),
        0,
        "peer must observe EOF after draining following peer SHUT_WR"
    );
    // Asymmetry guard: B's write half is still open — B can still send
    // to A, and A (only its write half shut) can still recv. This is
    // why the fix is a distinct peer-write-closed bit, NOT peer_open
    // = false (which would wrongly EPIPE B's send).
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(b, b"yo"),
            &mut []
        ),
        2,
        "peer SHUT_WR must not close the peer's own write half"
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(a, 0), &mut buf),
        2,
        "the SHUT_WR socket can still read (only its write half closed)"
    );
    assert_eq!(&buf[..2], b"yo");
}

#[test]
fn shutdown_wr_gives_unix_datagram_peer_eof_after_drain() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    // AF_UNIX SOCK_DGRAM pair (sock_type 2): fd 3 (A) <-> fd 4 (B).
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 2, 0), &mut fds),
        8
    );
    let a = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let b = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(a, b"pkt"),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(a, 1), &mut []),
        0
    );
    let mut buf = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(b, 0), &mut buf),
        3
    );
    assert_eq!(&buf[..3], b"pkt");
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(b, 0), &mut buf),
        0,
        "datagram peer must observe EOF after draining following peer SHUT_WR"
    );
}

#[test]
fn shutdown_wr_gives_unix_datagram_peer_recvfrom_eof_after_drain() {
    // PR #58 review P2: recvfrom must honor the peer-write-closed bit
    // exactly like recv, or callers using recvfrom never see EOF after
    // a connected datagram peer's shutdown(SHUT_WR).
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 2, 0), &mut fds),
        8
    );
    let a = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let b = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_SEND,
            1,
            &socket_send_req(a, b"pkt"),
            &mut []
        ),
        3
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SHUTDOWN, 1, &shutdown_req(a, 1), &mut []),
        0
    );
    let mut resp = [0u8; 8 + 8 + 8]; // data_cap=8 + meta(8) + path_cap=8
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVFROM,
            1,
            &socket_recvfrom_req(b, 0, 8, 8),
            &mut resp
        ),
        3
    );
    assert_eq!(&resp[..3], b"pkt");
    // Empty queue + peer SHUT_WR → EOF (0), NOT -EAGAIN (recv-consistent).
    assert_eq!(
        dispatch(
            METHOD_SYS_SOCKET_RECVFROM,
            1,
            &socket_recvfrom_req(b, 0, 8, 8),
            &mut resp
        ),
        0,
        "recvfrom must observe EOF after peer SHUT_WR (consistent with recv)"
    );
}

// --- Issue #65: wrap-safe caller-length guards (take_bytes) ---

#[test]
fn take_bytes_rejects_wrapping_length_without_panicking() {
    // The whole bug class: a hostile declared length that, added to the
    // header offset, wraps `usize`. usize::MAX reproduces the wasm32
    // u32::MAX wrap on ANY pointer width (a naive `at + len` overflows
    // to a tiny value on 64-bit too), so this is a width-independent
    // red→green for the root-cause primitive. Must be Err(-EINVAL),
    // never a panic / reversed slice range.
    let req = [0u8; 8];
    assert_eq!(take_bytes(&req, 4, usize::MAX), Err(-(abi::EINVAL as i64)));
    // The realistic wasm32 attack value (u32::MAX from the wire).
    assert_eq!(take_bytes(&req, 4, 0xFFFF_FFFF), Err(-(abi::EINVAL as i64)));
    // `at` itself past the end must not panic either.
    assert_eq!(take_bytes(&req, 9, 0), Err(-(abi::EINVAL as i64)));
    // Declared length one past the request → rejected.
    assert_eq!(take_bytes(&req, 4, 5), Err(-(abi::EINVAL as i64)));
}

#[test]
fn take_bytes_valid_splits_are_exact() {
    let req = [1u8, 2, 3, 4, 5, 6];
    assert_eq!(take_bytes(&req, 2, 2), Ok((&[3u8, 4][..], &[5u8, 6][..])));
    // Exact fit: head consumes the whole request, tail empty.
    assert_eq!(take_bytes(&req, 0, 6), Ok((&req[..], &[][..])));
    // Zero-length field at the end.
    assert_eq!(take_bytes(&req, 6, 0), Ok((&[][..], &[][..])));
}

#[test]
fn symlink_rejects_hostile_length_without_aborting_kernel() {
    // [u32 target_len = 0xFFFFFFFF][1 byte]. On wasm32 the old
    // `request.len() < 4 + target_len` wrapped and panicked the whole
    // kernel; now it is a clean -EINVAL on every pointer width.
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = 0xFFFF_FFFFu32.to_le_bytes().to_vec();
    req.push(b'x');
    assert_eq!(
        dispatch(METHOD_SYS_SYMLINK, 1, &req, &mut []),
        -(abi::EINVAL as i64)
    );
}

#[test]
fn idb_put_rejects_hostile_key_len_without_aborting_kernel() {
    // [u8 store_len=1]['s'][u32 key_len=0xFFFFFFFF][...]. The vulnerable
    // `body_start + key_len` wrap is now bounded in u64 → -EINVAL.
    let _g = crate::kernel::TestGuard::acquire();
    let mut req = vec![1u8, b's'];
    req.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
    req.push(b'k');
    assert_eq!(
        dispatch(METHOD_SYS_IDB_PUT, 1, &req, &mut []),
        -(abi::EINVAL as i64)
    );
}
