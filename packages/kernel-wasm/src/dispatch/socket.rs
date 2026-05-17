use crate::abi;
use crate::kernel::{
    with_kernel, FdEntry, Kernel, PeerCred, SocketEntry, SocketKind, UnixDatagramPacket,
};
use crate::kh;

use super::{
    close_entry, close_fd_number, has_buffer_capacity, inc_entry_ref, take_bytes, MSG_PEEK,
    RIGHTS_TRUNCATED,
};

const SOCKET_OPT_TCP_NODELAY: u32 = 1;
const SOCKET_ADVISORY_SET_OPTIONS: &[u32] = &[
    0x0004, // SO_REUSEADDR
    6,      // SO_BROADCAST
    7,      // SO_SNDBUF
    8,      // SO_RCVBUF
    9,      // SO_KEEPALIVE
    13,     // SO_LINGER
];

fn datagram_queue_bytes(rx: &std::collections::VecDeque<UnixDatagramPacket>) -> usize {
    rx.iter().map(|packet| packet.data.len()).sum()
}

fn rights_queue_full(rights: &Option<Vec<FdEntry>>, queue_len: usize) -> bool {
    !rights.as_ref().is_some_and(Vec::is_empty)
        && queue_len >= crate::kernel::KERNEL_RIGHTS_QUEUE_CAP
}

fn socket_handle_for_fd(k: &mut Kernel, caller_pid: u32, fd: u32) -> Result<i32, i64> {
    let entry = match k.process_mut(caller_pid).fd_table.entry(fd).cloned() {
        Some(entry) => entry,
        None => return Err(-(abi::EBADF as i64)),
    };
    let FdEntry::Socket { id } = entry else {
        return Err(-(abi::ENOTSOCK as i64));
    };
    match k.socket(id).map(|socket| &socket.kind) {
        Some(SocketKind::Host { handle }) => Ok(*handle),
        _ => Err(-(abi::EBADF as i64)),
    }
}

fn socket_id_for_fd(k: &mut Kernel, caller_pid: u32, fd: u32) -> Result<u64, i64> {
    let entry = match k.process_mut(caller_pid).fd_table.entry(fd).cloned() {
        Some(entry) => entry,
        None => return Err(-(abi::EBADF as i64)),
    };
    let FdEntry::Socket { id } = entry else {
        return Err(-(abi::ENOTSOCK as i64));
    };
    if k.socket(id).is_none() {
        return Err(-(abi::EBADF as i64));
    }
    Ok(id)
}

fn install_socket_fd(
    k: &mut Kernel,
    caller_pid: u32,
    handle: i32,
    domain: u8,
    sock_type: u8,
) -> Result<u32, i64> {
    let id = k.create_socket(handle, domain, sock_type);
    install_socket_id_fd(k, caller_pid, id)
}

/// Install `id` on the lowest free fd within the caller's
/// `RLIMIT_NOFILE` soft limit. On exhaustion the socket object is
/// released (closing its host handle if this was the last ref) so it
/// never leaks, and `Err(-EMFILE)` is returned.
fn install_socket_id_fd(k: &mut Kernel, caller_pid: u32, id: u64) -> Result<u32, i64> {
    let Some(fd) = k.process_mut(caller_pid).lowest_free_fd_in_limit() else {
        if let Some(handle) = k.socket_dec_ref(id) {
            kh::socket_close(handle);
        }
        return Err(-(abi::EMFILE as i64));
    };
    k.process_mut(caller_pid)
        .fd_table
        .install(fd, FdEntry::Socket { id });
    Ok(fd)
}

fn replace_socket_fd(k: &mut Kernel, caller_pid: u32, fd: u32, old_id: u64, new_id: u64) {
    k.process_mut(caller_pid)
        .fd_table
        .install(fd, FdEntry::Socket { id: new_id });
    if let Some(handle) = k.socket_dec_ref(old_id) {
        kh::socket_close(handle);
    }
}

fn sockaddr_family(addr: &[u8]) -> Option<u16> {
    Some(u16::from_le_bytes(addr.get(0..2)?.try_into().ok()?))
}

fn unix_path_from_addr(addr: &[u8]) -> Option<&[u8]> {
    if !matches!(sockaddr_family(addr), Some(1 | 3)) || addr.len() <= 2 {
        return None;
    }
    let path = &addr[2..];
    if path.first() == Some(&0) {
        let mut end = path.len();
        while end > 1 && path[end - 1] == 0 {
            end -= 1;
        }
        return path.get(..end).filter(|path| path.len() > 1);
    }
    let end = path.iter().position(|b| *b == 0).unwrap_or(path.len());
    path.get(..end).filter(|path| !path.is_empty())
}

fn is_ipv4_sockaddr(addr: &[u8]) -> bool {
    matches!(sockaddr_family(addr), Some(2)) && addr.len() >= 16
}

/// sockaddr_in6 is 28 bytes: family(2) + port(2) + flowinfo(4) +
/// addr(16) + scope_id(4). AF_INET6 = 10 (Linux).
fn is_ipv6_sockaddr(addr: &[u8]) -> bool {
    matches!(sockaddr_family(addr), Some(10)) && addr.len() >= 28
}

/// An inet sockaddr the kernel will forward to the host adapter: an
/// AF_INET socket with a v4 sockaddr, or an AF_INET6 socket with a v6
/// sockaddr. The family must match the socket domain — mismatches stay
/// EAFNOSUPPORT, so the v4 path is unchanged (additive).
fn inet_sockaddr_ok(domain: u8, addr: &[u8]) -> bool {
    (domain == 2 && is_ipv4_sockaddr(addr)) || (domain == 10 && is_ipv6_sockaddr(addr))
}

fn any_addr_ipv4_sockaddr() -> [u8; 16] {
    let mut addr = [0u8; 16];
    addr[0..2].copy_from_slice(&2u16.to_le_bytes());
    addr
}

fn any_addr_ipv6_sockaddr() -> [u8; 28] {
    let mut addr = [0u8; 28];
    addr[0..2].copy_from_slice(&10u16.to_le_bytes());
    addr
}

pub(super) fn socket_send_id(k: &mut Kernel, id: u64, data: &[u8]) -> i64 {
    // shutdown(SHUT_WR): the write half is closed → EPIPE. (B3.1)
    // No `socket(id).is_some()` existence guard is needed here (unlike
    // socket_recv_id): the shutdown side-map is cleared when the socket
    // id is truly destroyed (socket_dec_ref refs==0 + reset_for_tests)
    // and socket ids are monotonic / never reused, so a set bit always
    // implies a live socket. The send path below still returns EBADF
    // for a missing id regardless.
    if k.socket_shutdown_bits(id) & 0b10 != 0 {
        return -(abi::EPIPE as i64);
    }
    enum UnixPeer {
        Stream(u64, bool),
        Datagram(u64, bool),
    }
    let peer = match k.socket(id).map(|socket| &socket.kind) {
        Some(SocketKind::Open { .. }) => return -(abi::ENOTCONN as i64),
        Some(SocketKind::Host { handle }) => return kh::socket_send(*handle, data),
        Some(SocketKind::UnixStream {
            peer_id, peer_open, ..
        }) => UnixPeer::Stream(*peer_id, *peer_open),
        Some(SocketKind::UnixDatagram {
            peer_id, peer_open, ..
        }) => match peer_id {
            Some(peer_id) => UnixPeer::Datagram(*peer_id, *peer_open),
            None => return -(abi::EINVAL as i64),
        },
        Some(SocketKind::UnixListener { .. }) => return -(abi::EOPNOTSUPP as i64),
        None => return -(abi::EBADF as i64),
    };
    match peer {
        UnixPeer::Stream(peer_id, peer_open) => {
            if !peer_open {
                return -(abi::EPIPE as i64);
            }
            let Some(peer) = k.socket_mut(peer_id) else {
                return -(abi::EPIPE as i64);
            };
            let SocketKind::UnixStream { rx, .. } = &mut peer.kind else {
                return -(abi::EPIPE as i64);
            };
            if !has_buffer_capacity(rx.len(), data.len()) {
                return -(abi::EAGAIN as i64);
            }
            rx.extend(data);
            data.len() as i64
        }
        UnixPeer::Datagram(peer_id, peer_open) => {
            if !peer_open {
                return -(abi::EPIPE as i64);
            }
            let sender_path = k.socket(id).and_then(|socket| match &socket.kind {
                SocketKind::UnixDatagram { bound_path, .. } => bound_path.clone(),
                _ => None,
            });
            let Some(peer) = k.socket_mut(peer_id) else {
                return -(abi::EPIPE as i64);
            };
            let SocketKind::UnixDatagram { rx, .. } = &mut peer.kind else {
                return -(abi::EPIPE as i64);
            };
            if !has_buffer_capacity(datagram_queue_bytes(rx), data.len()) {
                return -(abi::EAGAIN as i64);
            }
            rx.push_back(UnixDatagramPacket {
                data: data.to_vec(),
                source_path: sender_path,
            });
            data.len() as i64
        }
    }
}

fn socket_sendto_id(k: &mut Kernel, id: u64, addr: &[u8], data: &[u8]) -> i64 {
    // shutdown(SHUT_WR): the write half is closed → EPIPE. (B3.1;
    // applied here too so sendto is consistent with send.)
    if k.socket_shutdown_bits(id) & 0b10 != 0 {
        return -(abi::EPIPE as i64);
    }
    let Some(path) = unix_path_from_addr(addr) else {
        return -(abi::EINVAL as i64);
    };
    match k.socket(id).map(|socket| &socket.kind) {
        Some(SocketKind::UnixDatagram { .. }) => {}
        Some(SocketKind::UnixStream { .. } | SocketKind::UnixListener { .. }) => {
            return -(abi::EOPNOTSUPP as i64);
        }
        Some(SocketKind::Open { .. }) | Some(SocketKind::Host { .. }) => {
            return -(abi::EOPNOTSUPP as i64);
        }
        None => return -(abi::EBADF as i64),
    }
    let Some(target_id) = k.unix_datagram_id_for_path(path) else {
        return -(abi::ECONNREFUSED as i64);
    };
    let sender_path = k.socket(id).and_then(|socket| match &socket.kind {
        SocketKind::UnixDatagram { bound_path, .. } => bound_path.clone(),
        _ => None,
    });
    let Some(target) = k.socket_mut(target_id) else {
        return -(abi::ECONNREFUSED as i64);
    };
    let SocketKind::UnixDatagram { rx, .. } = &mut target.kind else {
        return -(abi::ECONNREFUSED as i64);
    };
    if !has_buffer_capacity(datagram_queue_bytes(rx), data.len()) {
        return -(abi::EAGAIN as i64);
    }
    rx.push_back(UnixDatagramPacket {
        data: data.to_vec(),
        source_path: sender_path,
    });
    data.len() as i64
}

fn clone_fd_rights(k: &mut Kernel, caller_pid: u32, fds: &[u32]) -> Result<Vec<FdEntry>, i64> {
    let mut rights = Vec::with_capacity(fds.len());
    for fd in fds {
        let Some(entry) = k.process_mut(caller_pid).fd_table.entry(*fd).cloned() else {
            for entry in rights {
                close_entry(k, entry);
            }
            return Err(-(abi::EBADF as i64));
        };
        inc_entry_ref(k, &entry);
        rights.push(entry);
    }
    Ok(rights)
}

fn install_fd_rights_truncated(
    k: &mut Kernel,
    caller_pid: u32,
    rights: Vec<FdEntry>,
    out: &mut [u8],
) -> i64 {
    if out.len() < 4 {
        for entry in rights {
            close_entry(k, entry);
        }
        return -(abi::EINVAL as i64);
    }
    let count = rights.len() as u32;
    let fit = (out.len() - 4) / 4;
    let installed = count.min(fit as u32);
    // #104 (M2): POSIX recvmsg sets MSG_CTRUNC and discards (closes)
    // the overflow fds when the ancillary buffer is too small. The
    // header must report the *installed* count (not the phantom full
    // `count`) so the guest can build a correct cmsg, with bit 31
    // (RIGHTS_TRUNCATED) flagging the discard so hosts can raise
    // MSG_CTRUNC. Honors the af-unix spec's `truncated_ancillary`.
    let header = if count > fit as u32 {
        installed | RIGHTS_TRUNCATED
    } else {
        installed
    };
    out[0..4].copy_from_slice(&header.to_le_bytes());
    for (index, entry) in rights.into_iter().enumerate() {
        if index < fit {
            let p = k.process_mut(caller_pid);
            let fd = p.fd_table.lowest_free_fd();
            p.fd_table.install(fd, entry);
            let start = 4 + index * 4;
            out[start..start + 4].copy_from_slice(&fd.to_le_bytes());
        } else {
            close_entry(k, entry);
        }
    }
    (4 + installed as usize * 4) as i64
}

fn socket_sendmsg_id(k: &mut Kernel, id: u64, data: &[u8], rights: Vec<FdEntry>) -> i64 {
    // shutdown(SHUT_WR): the write half is closed → EPIPE. (B3.1;
    // applied here too so sendmsg is consistent with send/sendto.)
    if k.socket_shutdown_bits(id) & 0b10 != 0 {
        return -(abi::EPIPE as i64);
    }
    let mut rights = Some(rights);
    let rc = match k.socket(id).map(|socket| &socket.kind) {
        Some(SocketKind::UnixStream {
            peer_id, peer_open, ..
        }) => {
            if !*peer_open {
                -(abi::EPIPE as i64)
            } else {
                if let Some(peer) = k.socket_mut(*peer_id) {
                    if let SocketKind::UnixStream { rx, rights: q, .. } = &mut peer.kind {
                        if !has_buffer_capacity(rx.len(), data.len())
                            || rights_queue_full(&rights, q.len())
                        {
                            -(abi::EAGAIN as i64)
                        } else {
                            rx.extend(data);
                            if !rights.as_ref().is_some_and(Vec::is_empty) {
                                q.push_back(rights.take().expect("rights present"));
                            }
                            data.len() as i64
                        }
                    } else {
                        -(abi::EPIPE as i64)
                    }
                } else {
                    -(abi::EPIPE as i64)
                }
            }
        }
        Some(SocketKind::UnixDatagram {
            peer_id: Some(peer_id),
            peer_open,
            ..
        }) => {
            if !*peer_open {
                -(abi::EPIPE as i64)
            } else {
                let source_path = k.socket(id).and_then(|socket| match &socket.kind {
                    SocketKind::UnixDatagram { bound_path, .. } => bound_path.clone(),
                    _ => None,
                });
                if let Some(peer) = k.socket_mut(*peer_id) {
                    if let SocketKind::UnixDatagram { rx, rights: q, .. } = &mut peer.kind {
                        if !has_buffer_capacity(datagram_queue_bytes(rx), data.len())
                            || rights_queue_full(&rights, q.len())
                        {
                            -(abi::EAGAIN as i64)
                        } else {
                            rx.push_back(UnixDatagramPacket {
                                data: data.to_vec(),
                                source_path,
                            });
                            if !rights.as_ref().is_some_and(Vec::is_empty) {
                                q.push_back(rights.take().expect("rights present"));
                            }
                            data.len() as i64
                        }
                    } else {
                        -(abi::EPIPE as i64)
                    }
                } else {
                    -(abi::EPIPE as i64)
                }
            }
        }
        Some(SocketKind::Open { .. }) | Some(SocketKind::Host { .. }) => -(abi::EOPNOTSUPP as i64),
        Some(SocketKind::UnixDatagram { peer_id: None, .. }) => -(abi::EINVAL as i64),
        Some(SocketKind::UnixListener { .. }) => -(abi::EOPNOTSUPP as i64),
        None => -(abi::EBADF as i64),
    };
    if rc < 0 {
        if let Some(rights) = rights {
            for entry in rights {
                close_entry(k, entry);
            }
        }
    }
    rc
}

pub(super) fn socket_recv_id(k: &mut Kernel, id: u64, response: &mut [u8], flags: u32) -> i64 {
    // shutdown(SHUT_RD): the read half is closed → EOF. (B3.1)
    if k.socket(id).is_some() && k.socket_shutdown_bits(id) & 0b01 != 0 {
        return 0;
    }
    // The connected peer did shutdown(SHUT_WR): deliver any queued
    // bytes, then EOF (POSIX). Unlike local SHUT_RD this does NOT
    // discard the rx — only an empty rx becomes EOF instead of EAGAIN.
    let peer_wr_closed = k.socket(id).is_some() && k.socket_peer_write_closed(id);
    let Some(socket) = k.socket_mut(id) else {
        return -(abi::EBADF as i64);
    };
    match &mut socket.kind {
        SocketKind::Open { .. } => -(abi::ENOTCONN as i64),
        SocketKind::Host { handle } => kh::socket_recv(*handle, response, flags),
        SocketKind::UnixListener { .. } => -(abi::EOPNOTSUPP as i64),
        SocketKind::UnixDatagram { rx, peer_open, .. } => {
            if flags != 0 && flags != MSG_PEEK {
                return -(abi::EOPNOTSUPP as i64);
            }
            let Some(packet) = rx.front() else {
                return if *peer_open && !peer_wr_closed {
                    -(abi::EAGAIN as i64)
                } else {
                    0
                };
            };
            let take = packet.data.len().min(response.len());
            response[..take].copy_from_slice(&packet.data[..take]);
            if flags != MSG_PEEK {
                rx.pop_front();
            }
            take as i64
        }
        SocketKind::UnixStream { rx, peer_open, .. } => {
            if flags != 0 && flags != MSG_PEEK {
                return -(abi::EOPNOTSUPP as i64);
            }
            if rx.is_empty() {
                return if *peer_open && !peer_wr_closed {
                    -(abi::EAGAIN as i64)
                } else {
                    0
                };
            }
            let take = rx.len().min(response.len());
            if flags == MSG_PEEK {
                for (out, byte) in response.iter_mut().zip(rx.iter()).take(take) {
                    *out = *byte;
                }
            } else {
                for (i, b) in rx.drain(..take).enumerate() {
                    response[i] = b;
                }
            }
            take as i64
        }
    }
}

/// `sys_socket_listen(fd, backlog) -> 0`. Request: u32 fd LE +
/// u32 backlog LE. The fd must already refer to an opened stream
/// socket; any bind address is stored on the socket entry.
pub(super) fn sys_socket_listen(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let backlog = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    with_kernel(|k| {
        let id = match socket_id_for_fd(k, caller_pid, fd) {
            Ok(id) => id,
            Err(rc) => return rc,
        };
        let Some(socket) = k.socket(id) else {
            return -(abi::EBADF as i64);
        };
        let (domain, sock_type, addr) = match &socket.kind {
            SocketKind::Open { bound_addr, .. } => {
                (socket.domain, socket.sock_type, bound_addr.clone())
            }
            SocketKind::UnixDatagram { .. } => return -(abi::EOPNOTSUPP as i64),
            SocketKind::UnixListener { .. } | SocketKind::UnixStream { .. } => {
                return -(abi::EOPNOTSUPP as i64);
            }
            SocketKind::Host { .. } => return -(abi::EOPNOTSUPP as i64),
        };
        if !matches!(sock_type, 1 | 6) {
            return -(abi::EOPNOTSUPP as i64);
        }
        let addr = match addr {
            Some(addr) => addr,
            None if matches!(domain, 2) => any_addr_ipv4_sockaddr().to_vec(),
            None if matches!(domain, 10) => any_addr_ipv6_sockaddr().to_vec(),
            None => return -(abi::EINVAL as i64),
        };
        if let Some(path) = unix_path_from_addr(&addr) {
            return match k.create_unix_listener(path, backlog) {
                Ok(new_id) => {
                    replace_socket_fd(k, caller_pid, fd, id, new_id);
                    0
                }
                Err(errno) => -(errno as i64),
            };
        }
        let handle = kh::socket_listen_at(&addr, backlog);
        if handle < 0 {
            return handle as i64;
        }
        match k.socket_mut(id) {
            Some(socket) => socket.kind = SocketKind::Host { handle },
            None => return -(abi::EBADF as i64),
        }
        // Open→Host: a freshly listening host socket has no half-close
        // state. Drop any bits a pre-listen shutdown() recorded on the
        // Open socket so a stale SHUT_* cannot poison the live Host
        // connection (recv→EOF / send→EPIPE). (PR #58 review P2)
        k.socket_shutdown_clear(id);
        0
    })
}

pub(super) fn sys_socket_accept(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let listener_id = with_kernel(|k| {
        let entry = k.process_mut(caller_pid).fd_table.entry(fd).cloned();
        match entry {
            Some(FdEntry::Socket { id })
                if matches!(
                    k.socket(id).map(|socket| &socket.kind),
                    Some(SocketKind::UnixListener { .. })
                ) =>
            {
                Ok(id)
            }
            Some(FdEntry::Socket { .. }) => Err(0),
            Some(_) => Err(-(abi::ENOTSOCK as i64)),
            None => Err(-(abi::EBADF as i64)),
        }
    });
    match listener_id {
        Ok(id) => {
            return with_kernel(|k| {
                // Check the RLIMIT_NOFILE budget *before* consuming the
                // pending connection: Linux leaves the connection
                // queued on EMFILE so a later accept (after the guest
                // frees an fd) still succeeds. `install_socket_id_fd`
                // keeps its own rollback as a second layer.
                if k.process_mut(caller_pid)
                    .lowest_free_fd_in_limit()
                    .is_none()
                {
                    return -(abi::EMFILE as i64);
                }
                match k.accept_unix_stream(id) {
                    Ok(accepted_id) => match install_socket_id_fd(k, caller_pid, accepted_id) {
                        Ok(fd) => fd as i64,
                        Err(rc) => rc,
                    },
                    Err(errno) => -(errno as i64),
                }
            });
        }
        Err(0) => {}
        Err(rc) => return rc,
    }
    let (handle, domain, sock_type) =
        match with_kernel(|k| socket_handle_domain_type_for_fd(k, caller_pid, fd)) {
            Ok(triple) => triple,
            Err(rc) => return rc,
        };
    // As with the unix path: refuse before the host accept so the
    // connection stays in the host listen queue on EMFILE rather than
    // being accepted then immediately closed.
    if with_kernel(|k| {
        k.process_mut(caller_pid)
            .lowest_free_fd_in_limit()
            .is_none()
    }) {
        return -(abi::EMFILE as i64);
    }
    let accepted = kh::socket_accept(handle, flags);
    if accepted < 0 {
        return accepted as i64;
    }
    with_kernel(
        |k| match install_socket_fd(k, caller_pid, accepted, domain, sock_type) {
            Ok(fd) => fd as i64,
            Err(rc) => rc,
        },
    )
}

pub(super) fn sys_socket_addr(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let which = if request.len() >= 8 {
        u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"))
    } else {
        0
    };
    if response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let unix_path = with_kernel(|k| {
        let entry = match k.process_mut(caller_pid).fd_table.entry(fd).cloned() {
            Some(entry) => entry,
            None => return Err(-(abi::EBADF as i64)),
        };
        let FdEntry::Socket { id } = entry else {
            return Err(-(abi::ENOTSOCK as i64));
        };
        match k.socket(id) {
            Some(SocketEntry {
                kind: SocketKind::UnixListener { path, .. },
                ..
            }) => {
                if which == 0 {
                    Ok(Some(path.clone()))
                } else {
                    Err(-(abi::ENOTCONN as i64))
                }
            }
            Some(SocketEntry {
                kind:
                    SocketKind::UnixStream {
                        local_path,
                        peer_path,
                        ..
                    },
                ..
            }) => {
                if which == 0 {
                    Ok(local_path.clone())
                } else {
                    Ok(peer_path.clone())
                }
            }
            Some(SocketEntry {
                kind:
                    SocketKind::UnixDatagram {
                        bound_path,
                        peer_id,
                        peer_path,
                        ..
                    },
                ..
            }) => {
                if which == 0 {
                    Ok(bound_path.clone())
                } else if peer_id.is_some() {
                    Ok(peer_path.clone())
                } else {
                    Err(-(abi::ENOTCONN as i64))
                }
            }
            Some(SocketEntry {
                domain,
                kind: SocketKind::Open { .. },
                ..
            }) if matches!(*domain, 1 | 3) => {
                if which == 0 {
                    Ok(None)
                } else {
                    Err(-(abi::ENOTCONN as i64))
                }
            }
            Some(SocketEntry {
                kind: SocketKind::Open { .. },
                ..
            }) => Err(-(abi::EAFNOSUPPORT as i64)),
            Some(SocketEntry {
                kind: SocketKind::Host { .. },
                ..
            }) => Err(0),
            None => Err(-(abi::EBADF as i64)),
        }
    });
    match unix_path {
        Ok(Some(path)) => {
            let n = path.len().min(response.len());
            response[..n].copy_from_slice(&path[..n]);
            return n as i64;
        }
        Ok(None) => return 0,
        Err(0) => {}
        Err(rc) => return rc,
    }
    let handle = match with_kernel(|k| socket_handle_for_fd(k, caller_pid, fd)) {
        Ok(handle) => handle,
        Err(rc) => return rc,
    };
    if which == 0 {
        kh::socket_local_addr(handle, response)
    } else {
        kh::socket_peer_addr(handle, response)
    }
}

pub(super) fn sys_socket_info(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    const SOCKET_INFO_SIZE: usize = 24;
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    if response.len() < SOCKET_INFO_SIZE {
        return SOCKET_INFO_SIZE as i64;
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let info = with_kernel(|k| {
        let process = k.process_mut(caller_pid);
        let entry = match process.fd_table.entry(fd).cloned() {
            Some(entry) => entry,
            None => return Err(-(abi::EBADF as i64)),
        };
        let credentials = process.credentials;
        let FdEntry::Socket { id } = entry else {
            return Err(-(abi::ENOTSOCK as i64));
        };
        let Some(socket) = k.socket(id) else {
            return Err(-(abi::EBADF as i64));
        };
        let flags = match &socket.kind {
            SocketKind::Open { flags, .. } => *flags,
            _ => 0,
        };
        Ok([
            socket.domain as u32,
            socket.sock_type as u32,
            flags,
            caller_pid,
            credentials.uid,
            credentials.gid,
        ])
    });
    let info = match info {
        Ok(info) => info,
        Err(rc) => return rc,
    };
    for (index, value) in info.iter().enumerate() {
        response[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    SOCKET_INFO_SIZE as i64
}

/// SO_PEERCRED. Request: u32 fd LE. Response: 12 bytes —
/// i32 pid + i32 uid + i32 gid (LE). Mirrors the TS
/// `host_socket_peercred`: any socket fd succeeds with `0`; sockets
/// with no captured peer (non-UnixStream) report zeros (TS `?? 0`).
pub(super) fn sys_socket_peercred(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    const UCRED_SIZE: usize = 12;
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    if response.len() < UCRED_SIZE {
        return UCRED_SIZE as i64;
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let cred = with_kernel(|k| {
        let id = socket_id_for_fd(k, caller_pid, fd)?;
        Ok(match k.socket(id).map(|socket| &socket.kind) {
            Some(SocketKind::UnixStream { peer_cred, .. }) => *peer_cred,
            _ => PeerCred::default(),
        })
    });
    let cred = match cred {
        Ok(cred) => cred,
        Err(rc) => return rc,
    };
    response[0..4].copy_from_slice(&(cred.pid as i32).to_le_bytes());
    response[4..8].copy_from_slice(&(cred.uid as i32).to_le_bytes());
    response[8..12].copy_from_slice(&(cred.gid as i32).to_le_bytes());
    UCRED_SIZE as i64
}

/// `sys_socket_connect(fd, addr_bytes) -> 0`. Request layout:
/// u32 fd LE + POSIX sockaddr bytes.
pub(super) fn sys_socket_connect(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let addr = &request[4..];
    if addr.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let peer_cred = k.peer_cred_for(caller_pid);
        let id = match socket_id_for_fd(k, caller_pid, fd) {
            Ok(id) => id,
            Err(rc) => return rc,
        };
        let Some(socket) = k.socket(id) else {
            return -(abi::EBADF as i64);
        };
        let (domain, sock_type, flags) = match &socket.kind {
            SocketKind::Open { flags, .. } => (socket.domain, socket.sock_type, *flags),
            SocketKind::UnixDatagram { .. } => {
                if let Some(path) = unix_path_from_addr(addr) {
                    return match k.connect_unix_datagram(id, path) {
                        Ok(()) => 0,
                        Err(errno) => -(errno as i64),
                    };
                }
                return -(abi::EAFNOSUPPORT as i64);
            }
            SocketKind::UnixStream { .. }
            | SocketKind::UnixListener { .. }
            | SocketKind::Host { .. } => return -(abi::EOPNOTSUPP as i64),
        };
        if matches!(domain, 1 | 3) && matches!(sock_type, 1 | 6) {
            if let Some(path) = unix_path_from_addr(addr) {
                return match k.connect_unix_stream(path, peer_cred) {
                    Ok(new_id) => {
                        replace_socket_fd(k, caller_pid, fd, id, new_id);
                        0
                    }
                    Err(errno) => -(errno as i64),
                };
            }
        }
        if unix_path_from_addr(addr).is_some() {
            return -(abi::EAFNOSUPPORT as i64);
        }
        if !inet_sockaddr_ok(domain, addr) {
            return -(abi::EAFNOSUPPORT as i64);
        }
        let handle = kh::socket_connect(addr, flags);
        if handle < 0 {
            return handle as i64;
        }
        match k.socket_mut(id) {
            Some(socket) => socket.kind = SocketKind::Host { handle },
            None => return -(abi::EBADF as i64),
        }
        // Open→Host: a freshly connected host socket has no half-close
        // state. Drop any bits a pre-connect shutdown() recorded on the
        // Open socket so a stale SHUT_* cannot poison the live Host
        // connection (recv→EOF / send→EPIPE). (PR #58 review P2)
        k.socket_shutdown_clear(id);
        0
    })
}

fn socket_handle_domain_type_for_fd(
    k: &mut Kernel,
    caller_pid: u32,
    fd: u32,
) -> Result<(i32, u8, u8), i64> {
    let entry = match k.process_mut(caller_pid).fd_table.entry(fd).cloned() {
        Some(entry) => entry,
        None => return Err(-(abi::EBADF as i64)),
    };
    let FdEntry::Socket { id } = entry else {
        return Err(-(abi::ENOTSOCK as i64));
    };
    let Some(socket) = k.socket(id) else {
        return Err(-(abi::EBADF as i64));
    };
    match &socket.kind {
        SocketKind::Host { handle } => Ok((*handle, socket.domain, socket.sock_type)),
        _ if matches!(socket.sock_type, 1 | 6) => Err(-(abi::EINVAL as i64)),
        _ => Err(-(abi::EOPNOTSUPP as i64)),
    }
}

pub(super) fn sys_socket_send(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let data = &request[4..];
    with_kernel(|k| match socket_id_for_fd(k, caller_pid, fd) {
        Ok(id) => socket_send_id(k, id, data),
        Err(rc) => rc,
    })
}

pub(super) fn sys_socket_recv(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    if response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| match socket_id_for_fd(k, caller_pid, fd) {
        Ok(id) => socket_recv_id(k, id, response, flags),
        Err(rc) => rc,
    })
}

pub(super) fn sys_socket_recvfrom(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let data_cap = u32::from_le_bytes(request[8..12].try_into().expect("4 bytes")) as usize;
    let path_cap = u32::from_le_bytes(request[12..16].try_into().expect("4 bytes")) as usize;
    let meta_offset = data_cap;
    let Some(path_offset) = meta_offset.checked_add(8) else {
        return -(abi::EINVAL as i64);
    };
    if response.len() < path_offset {
        return -(abi::EINVAL as i64);
    }
    let path_fit = response.len().saturating_sub(path_offset).min(path_cap);
    with_kernel(|k| {
        let id = match socket_id_for_fd(k, caller_pid, fd) {
            Ok(id) => id,
            Err(rc) => return rc,
        };
        // shutdown(SHUT_RD): the read half is closed → EOF. (B3.1;
        // applied here too so recvfrom is consistent with recv.)
        if k.socket(id).is_some() && k.socket_shutdown_bits(id) & 0b01 != 0 {
            return 0;
        }
        // Connected datagram peer did shutdown(SHUT_WR): drain queued
        // packets, then EOF — same as socket_recv_id, so recvfrom is
        // consistent with recv for peer half-close. (PR #58 review P2.)
        let peer_wr_closed = k.socket(id).is_some() && k.socket_peer_write_closed(id);
        let Some(socket) = k.socket_mut(id) else {
            return -(abi::EBADF as i64);
        };
        let SocketKind::UnixDatagram { rx, peer_open, .. } = &mut socket.kind else {
            return -(abi::EOPNOTSUPP as i64);
        };
        if flags != 0 && flags != MSG_PEEK {
            return -(abi::EOPNOTSUPP as i64);
        }
        let Some(packet) = rx.front() else {
            return if *peer_open && !peer_wr_closed {
                -(abi::EAGAIN as i64)
            } else {
                0
            };
        };
        let take = packet.data.len().min(data_cap);
        response[..take].copy_from_slice(&packet.data[..take]);
        let (path, is_abstract) = packet
            .source_path
            .as_deref()
            .map(|path| match path.strip_prefix(&[0]) {
                Some(name) => (name, 1_u32),
                None => (path, 0_u32),
            })
            .unwrap_or((&[][..], 0_u32));
        response[meta_offset..meta_offset + 4].copy_from_slice(&(path.len() as u32).to_le_bytes());
        response[meta_offset + 4..meta_offset + 8].copy_from_slice(&is_abstract.to_le_bytes());
        let copy_len = path.len().min(path_fit);
        response[path_offset..path_offset + copy_len].copy_from_slice(&path[..copy_len]);
        if flags != MSG_PEEK {
            rx.pop_front();
        }
        take as i64
    })
}

pub(super) fn sys_socket_open(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let family = request[0];
    let sock_type = request[1];
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    // 1..=3 AF_UNIX/AF_INET, 10 AF_INET6. Parity: TS host_socket_open
    // does not validate the domain — anything that is not an AF_UNIX
    // SOCK_DGRAM allocates an inet stream socket.
    if !matches!(family, 1..=3 | 10) {
        return -(abi::EAFNOSUPPORT as i64);
    }
    if !matches!(sock_type, 1 | 2 | 5 | 6) {
        return -(abi::EPROTOTYPE as i64);
    }
    with_kernel(|k| {
        let id = if matches!(sock_type, 2 | 5) {
            if !matches!(family, 1 | 3) {
                return -(abi::EAFNOSUPPORT as i64);
            }
            k.create_unix_datagram_socket()
        } else {
            k.create_open_socket(family, sock_type, flags)
        };
        match install_socket_id_fd(k, caller_pid, id) {
            Ok(fd) => fd as i64,
            Err(rc) => rc,
        }
    })
}

pub(super) fn sys_socket_bind(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let addr = &request[4..];
    with_kernel(|k| match socket_id_for_fd(k, caller_pid, fd) {
        Ok(id) => {
            if let Some(path) = unix_path_from_addr(addr) {
                let Some(socket) = k.socket(id) else {
                    return -(abi::EBADF as i64);
                };
                if matches!(socket.kind, SocketKind::UnixDatagram { .. }) {
                    return match k.bind_unix_datagram(id, path) {
                        Ok(()) => 0,
                        Err(errno) => -(errno as i64),
                    };
                }
                if !matches!(socket.domain, 1 | 3) {
                    return -(abi::EAFNOSUPPORT as i64);
                }
            }
            match k.socket_mut(id) {
                Some(socket) => match &mut socket.kind {
                    SocketKind::Open { bound_addr, .. } => {
                        if unix_path_from_addr(addr).is_none()
                            && !inet_sockaddr_ok(socket.domain, addr)
                        {
                            return -(abi::EAFNOSUPPORT as i64);
                        }
                        *bound_addr = Some(addr.to_vec());
                        0
                    }
                    SocketKind::UnixDatagram { .. } => -(abi::EINVAL as i64),
                    _ => -(abi::EOPNOTSUPP as i64),
                },
                None => -(abi::EBADF as i64),
            }
        }
        Err(rc) => rc,
    })
}

pub(super) fn sys_socket_option(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let option = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let has_value = u32::from_le_bytes(request[8..12].try_into().expect("4 bytes")) != 0;
    let value = i32::from_le_bytes(request[12..16].try_into().expect("4 bytes"));
    with_kernel(|k| {
        let id = match socket_id_for_fd(k, caller_pid, fd) {
            Ok(id) => id,
            Err(rc) => return rc,
        };
        let Some(socket) = k.socket_mut(id) else {
            return -(abi::EBADF as i64);
        };
        if option == SOCKET_OPT_TCP_NODELAY {
            if has_value {
                socket.no_delay = value != 0;
                0
            } else {
                i64::from(socket.no_delay)
            }
        } else if has_value && SOCKET_ADVISORY_SET_OPTIONS.contains(&option) {
            0
        } else {
            -(abi::EOPNOTSUPP as i64)
        }
    })
}

pub(super) fn sys_socket_sendto(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 12 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let addr_len = u32::from_le_bytes(request[8..12].try_into().expect("4 bytes")) as usize;
    let (addr, data) = match take_bytes(request, 12, addr_len) {
        Ok(parts) => parts,
        Err(rc) => return rc,
    };
    if flags != 0 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| match socket_id_for_fd(k, caller_pid, fd) {
        Ok(id) => socket_sendto_id(k, id, addr, data),
        Err(rc) => rc,
    })
}

pub(super) fn sys_socket_sendmsg(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 12 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let data_len = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes")) as usize;
    let fd_count = u32::from_le_bytes(request[8..12].try_into().expect("4 bytes")) as usize;
    let data_start = 12usize;
    // The trailing fd-word segment needs checked multiplication, so keep this
    // parser's three-segment layout explicit instead of forcing `take_bytes`.
    let Some(fds_start) = data_start.checked_add(data_len) else {
        return -(abi::EINVAL as i64);
    };
    let Some(fds_bytes) = fd_count.checked_mul(4) else {
        return -(abi::EINVAL as i64);
    };
    let Some(required) = fds_start.checked_add(fds_bytes) else {
        return -(abi::EINVAL as i64);
    };
    if request.len() < required {
        return -(abi::EINVAL as i64);
    }
    let data = &request[data_start..fds_start];
    with_kernel(|k| {
        let mut fds = Vec::with_capacity(fd_count);
        for chunk in request[fds_start..required].chunks_exact(4) {
            fds.push(u32::from_le_bytes(chunk.try_into().expect("4 bytes")));
        }
        let rights = match clone_fd_rights(k, caller_pid, &fds) {
            Ok(rights) => rights,
            Err(rc) => return rc,
        };
        match socket_id_for_fd(k, caller_pid, fd) {
            Ok(id) => socket_sendmsg_id(k, id, data, rights),
            Err(rc) => {
                for entry in rights {
                    close_entry(k, entry);
                }
                rc
            }
        }
    })
}

pub(super) fn sys_socket_recvmsg(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 12 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    let data_cap = u32::from_le_bytes(request[8..12].try_into().expect("4 bytes")) as usize;
    let Some(rights_start) = data_cap.checked_add(4) else {
        return -(abi::EINVAL as i64);
    };
    if response.len() < rights_start {
        return -(abi::EINVAL as i64);
    }
    let n = with_kernel(|k| match socket_id_for_fd(k, caller_pid, fd) {
        Ok(id) => socket_recv_id(k, id, &mut response[..data_cap], flags),
        Err(rc) => rc,
    });
    if n < 0 {
        return n;
    }
    if flags == MSG_PEEK {
        response[data_cap..data_cap + 4].copy_from_slice(&0u32.to_le_bytes());
        return n;
    }
    let rights = with_kernel(|k| match socket_id_for_fd(k, caller_pid, fd) {
        Ok(id) => {
            // shutdown(SHUT_RD): socket_recv_id returned 0 as EOF, not
            // as a zero-length message. A shutdown EOF must neither
            // transfer queued SCM_RIGHTS fds nor drain the ancillary
            // queue, so do not pop_front here. (PR #58 review P2)
            if k.socket(id).is_some() && k.socket_shutdown_bits(id) & 0b01 != 0 {
                Vec::new()
            } else {
                match k.socket_mut(id).map(|socket| &mut socket.kind) {
                    Some(SocketKind::UnixStream { rights, .. })
                    | Some(SocketKind::UnixDatagram { rights, .. }) => {
                        rights.pop_front().unwrap_or_default()
                    }
                    _ => Vec::new(),
                }
            }
        }
        Err(_) => Vec::new(),
    });
    let install_rc = with_kernel(|k| {
        install_fd_rights_truncated(k, caller_pid, rights, &mut response[data_cap..])
    });
    if install_rc < 0 {
        return install_rc;
    }
    n
}

pub(super) fn sys_socket_close(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let is_socket = with_kernel(|k| {
        matches!(
            k.process_mut(caller_pid).fd_table.entry(fd),
            Some(FdEntry::Socket { .. })
        )
    });
    if !is_socket {
        return -(abi::EBADF as i64);
    }
    close_fd_number(caller_pid, fd)
}

/// `shutdown(fd, how)` — POSIX half-close (B3.1). how: 0=SHUT_RD,
/// 1=SHUT_WR, 2=SHUT_RDWR. Marks the socket's shutdown bits
/// (idempotent); SHUT_RD makes later recv return EOF, SHUT_WR makes
/// send return -EPIPE. -ENOTSOCK for a non-socket fd, -EBADF unknown,
/// -EINVAL for how>2 or a short request.
pub(super) fn sys_socket_shutdown(caller_pid: u32, request: &[u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let fd = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes"));
    let how = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    if how > 2 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let id = match k.process_mut(caller_pid).fd_table.entry(fd) {
            Some(FdEntry::Socket { id }) => *id,
            Some(_) => return -(abi::ENOTSOCK as i64),
            None => return -(abi::EBADF as i64),
        };
        k.socket_shutdown_apply(id, how);
        0
    })
}

pub(super) fn sys_socketpair(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 8 || response.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let family = request[0];
    let sock_type = request[1];
    let _flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    if !matches!(family, 1 | 3) {
        return -(abi::EAFNOSUPPORT as i64);
    }
    if !matches!(sock_type, 1 | 2 | 5 | 6) {
        return -(abi::EPROTOTYPE as i64);
    }
    with_kernel(|k| {
        let (left_id, right_id) = if matches!(sock_type, 2 | 5) {
            k.create_unix_datagram_pair()
        } else {
            let peer_cred = k.peer_cred_for(caller_pid);
            k.create_unix_stream_pair(peer_cred)
        };
        // Both fds are bounded by RLIMIT_NOFILE. On exhaustion both
        // socket objects must be released so the pair never leaks: if
        // the left fd never installed, drop both ids; if it did, undo
        // it before dropping the right id.
        let Some(left_fd) = k.process_mut(caller_pid).lowest_free_fd_in_limit() else {
            let _ = k.socket_dec_ref(left_id);
            let _ = k.socket_dec_ref(right_id);
            return -(abi::EMFILE as i64);
        };
        k.process_mut(caller_pid)
            .fd_table
            .install(left_fd, FdEntry::Socket { id: left_id });
        let Some(right_fd) = k.process_mut(caller_pid).lowest_free_fd_in_limit() else {
            if let Some(entry) = k.process_mut(caller_pid).fd_table.remove(left_fd) {
                close_entry(k, entry);
            }
            let _ = k.socket_dec_ref(right_id);
            return -(abi::EMFILE as i64);
        };
        k.process_mut(caller_pid)
            .fd_table
            .install(right_fd, FdEntry::Socket { id: right_id });
        response[0..4].copy_from_slice(&left_fd.to_le_bytes());
        response[4..8].copy_from_slice(&right_fd.to_le_bytes());
        8
    })
}
