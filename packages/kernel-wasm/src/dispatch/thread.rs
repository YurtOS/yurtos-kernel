use super::DispatchContext;
use crate::{abi, kernel, kh};

fn read_u32_request(request: &[u8]) -> Result<u32, i64> {
    if request.len() != 4 {
        return Err(-(abi::EINVAL as i64));
    }
    Ok(u32::from_le_bytes(request.try_into().expect("len checked")))
}

fn release_drained_thread_handles(handles: Vec<i32>) {
    for handle in handles {
        let _ = kh::thread_release(handle);
    }
}

pub fn sys_thread_self(ctx: DispatchContext, request: &[u8]) -> i64 {
    if !request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if ctx.caller_tid == kernel::MAIN_THREAD_TID {
        kernel::GUEST_MAIN_PTHREAD_ID as i64
    } else {
        ctx.caller_tid as i64
    }
}

pub fn sys_thread_spawn(ctx: DispatchContext, request: &[u8]) -> i64 {
    if request.len() != 8 {
        return -(abi::EINVAL as i64);
    }
    let fn_ptr = u32::from_le_bytes(request[0..4].try_into().expect("len checked"));
    let arg = u32::from_le_bytes(request[4..8].try_into().expect("len checked"));
    let tid = match kernel::with_kernel(|k| k.reserve_thread_id(ctx.caller_pid)) {
        Ok(tid) => tid,
        Err(errno) => return -(errno as i64),
    };

    let host_thread_handle = kh::thread_spawn(ctx.caller_pid, tid, fn_ptr, arg);
    if host_thread_handle < 0 {
        let _ = kernel::with_kernel(|k| k.rollback_reserved_thread(ctx.caller_pid, tid));
        return host_thread_handle as i64;
    }

    match kernel::with_kernel(|k| {
        k.bind_thread_handle(ctx.caller_pid, tid, Some(host_thread_handle))
    }) {
        Ok(()) => tid as i64,
        Err(errno) => {
            // Cancel the running host thread, then RELEASE its handle
            // — cancel alone leaks the host-side resource (#110).
            let _ = kh::thread_cancel(host_thread_handle);
            let _ = kh::thread_release(host_thread_handle);
            let _ = kernel::with_kernel(|k| k.rollback_reserved_thread(ctx.caller_pid, tid));
            -(errno as i64)
        }
    }
}

pub fn sys_thread_join(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    let target_tid = match read_u32_request(request) {
        Ok(tid) => tid,
        Err(rc) => return rc,
    };
    if response.len() < 4 {
        return -(abi::EINVAL as i64);
    }
    let (result, release_handles) = kernel::with_kernel(|k| {
        let result = k.begin_thread_join(ctx.caller_pid, ctx.caller_tid, target_tid, response);
        let release_handles = k.drain_thread_releases();
        (result, release_handles)
    });
    release_drained_thread_handles(release_handles);
    result.map_or_else(|errno| -(errno as i64), |_| 0)
}

pub fn sys_thread_detach(ctx: DispatchContext, request: &[u8]) -> i64 {
    let target_tid = match read_u32_request(request) {
        Ok(tid) => tid,
        Err(rc) => return rc,
    };
    let (result, release_handles) = kernel::with_kernel(|k| {
        let result = k.detach_thread(ctx.caller_pid, target_tid);
        let release_handles = k.drain_thread_releases();
        (result, release_handles)
    });
    release_drained_thread_handles(release_handles);
    result.map_or_else(|errno| -(errno as i64), |_| 0)
}

pub fn sys_thread_exit(ctx: DispatchContext, request: &[u8]) -> i64 {
    let retval = match read_u32_request(request) {
        Ok(retval) => retval,
        Err(rc) => return rc,
    };
    let (result, release_handles) = kernel::with_kernel(|k| {
        let result = k.exit_thread_authenticated(ctx.caller_pid, ctx.caller_tid, retval);
        let release_handles = k.drain_thread_releases();
        (result, release_handles)
    });
    release_drained_thread_handles(release_handles);
    result.map_or_else(|errno| -(errno as i64), |_| 0)
}

pub fn sys_thread_yield(_ctx: DispatchContext, request: &[u8]) -> i64 {
    if request.is_empty() {
        0
    } else {
        -(abi::EINVAL as i64)
    }
}

pub fn sys_thread_cancel(ctx: DispatchContext, request: &[u8]) -> i64 {
    let target_tid = match read_u32_request(request) {
        Ok(tid) => tid,
        Err(rc) => return rc,
    };
    // `sys_thread_self` presents the main thread to guests as
    // GUEST_MAIN_PTHREAD_ID (0), but the thread table stores it under
    // MAIN_THREAD_TID. Map the guest-facing id back before lookup so
    // pthread_cancel(pthread_self()) from the main thread works
    // (PR #54 review P2). (join/detach of the main thread is undefined
    // in POSIX, so only the cancel path needs this.)
    let target_tid = if target_tid == kernel::GUEST_MAIN_PTHREAD_ID {
        kernel::MAIN_THREAD_TID
    } else {
        target_tid
    };
    kernel::with_kernel(|k| k.request_thread_cancel(ctx.caller_pid, target_tid))
        .map_or_else(|errno| -(errno as i64), |_| 0)
}

pub fn sys_thread_testcancel(ctx: DispatchContext, request: &[u8]) -> i64 {
    if !request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if kernel::with_kernel(|k| k.thread_cancel_pending(ctx.caller_pid, ctx.caller_tid)) {
        1
    } else {
        0
    }
}
