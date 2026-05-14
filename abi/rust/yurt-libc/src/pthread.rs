#![no_std]

use core::ffi::{c_int, c_void};
use core::mem;
use core::ptr;

const EAGAIN: c_int = 6;
const EINVAL: c_int = 28;
const ESRCH: c_int = 71;
const PTHREAD_CREATE_JOINABLE: c_int = 0;
const PTHREAD_CREATE_DETACHED: c_int = 1;
const STACK_SIZE: usize = 1024 * 1024;

const ATTR_DETACHSTATE_SLOT: usize = 0;

#[repr(C)]
pub struct PthreadAttr {
    slots: [c_int; 9],
}

#[link(wasm_import_module = "yurt")]
extern "C" {
    #[link_name = "host_thread_spawn"]
    fn yurt_host_thread_spawn(fn_ptr: c_int, arg: c_int) -> c_int;
    #[link_name = "host_thread_join"]
    fn yurt_host_thread_join(tid: c_int) -> c_int;
    #[link_name = "host_thread_detach"]
    fn yurt_host_thread_detach(tid: c_int) -> c_int;
    #[link_name = "host_thread_exit"]
    fn yurt_host_thread_exit(retval: c_int) -> !;
    #[link_name = "host_thread_self"]
    fn yurt_host_thread_self() -> c_int;
}

fn thread_id_to_pthread(tid: c_int) -> *mut c_void {
    tid as usize as *mut c_void
}

fn pthread_to_thread_id(thread: *mut c_void) -> c_int {
    thread as usize as c_int
}

fn attr_detachstate(attr: *const PthreadAttr) -> Option<c_int> {
    if attr.is_null() {
        return None;
    }
    // SAFETY: `attr` was checked non-null and points to a caller-provided
    // pthread_attr_t-compatible object. We read only the first int slot, which
    // this shim owns through pthread_attr_init/setdetachstate.
    Some(unsafe { (*attr).slots[ATTR_DETACHSTATE_SLOT] })
}

fn attr_detachstate_mut(attr: *mut PthreadAttr) -> Option<&'static mut c_int> {
    if attr.is_null() {
        return None;
    }
    // SAFETY: `attr` was checked non-null and points to writable caller-owned
    // pthread_attr_t storage for the duration of this C ABI call.
    Some(unsafe { &mut (*attr).slots[ATTR_DETACHSTATE_SLOT] })
}

#[no_mangle]
pub extern "C" fn pthread_create(
    thread: *mut *mut c_void,
    attr: *const PthreadAttr,
    start_routine: usize,
    arg: *mut c_void,
) -> c_int {
    if thread.is_null() || start_routine == 0 {
        return EINVAL;
    }
    // SAFETY: imports are provided by the Yurt host for modules linked with
    // libyurt_abi; the integer arguments are wasm32 function/data pointers.
    let tid = unsafe { yurt_host_thread_spawn(start_routine as c_int, arg as usize as c_int) };
    if tid < 0 {
        return EAGAIN;
    }
    if attr_detachstate(attr) == Some(PTHREAD_CREATE_DETACHED) {
        // SAFETY: `tid` was returned by host_thread_spawn above.
        if unsafe { yurt_host_thread_detach(tid) } < 0 {
            return EAGAIN;
        }
    }
    // SAFETY: `thread` was checked non-null and points to caller-provided
    // storage for the newly-created pthread_t.
    unsafe {
        *thread = thread_id_to_pthread(tid);
    }
    0
}

#[no_mangle]
pub extern "C" fn pthread_join(thread: *mut c_void, retval: *mut *mut c_void) -> c_int {
    // SAFETY: imports are provided by the Yurt host. Invalid thread ids are
    // reported as negative return values by the host backend.
    let rv = unsafe { yurt_host_thread_join(pthread_to_thread_id(thread)) };
    if rv == -EINVAL {
        return EINVAL;
    }
    if rv < 0 {
        return ESRCH;
    }
    if !retval.is_null() {
        // SAFETY: `retval` was checked non-null and points to caller-provided
        // storage for the joined thread's return pointer.
        unsafe {
            *retval = rv as usize as *mut c_void;
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn pthread_detach(thread: *mut c_void) -> c_int {
    // SAFETY: imports are provided by the Yurt host. Invalid thread ids are
    // reported as negative return values by the host backend.
    let rv = unsafe { yurt_host_thread_detach(pthread_to_thread_id(thread)) };
    if rv == -EINVAL {
        EINVAL
    } else if rv < 0 {
        ESRCH
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn pthread_exit(retval: *mut c_void) -> ! {
    // SAFETY: imports are provided by the Yurt host and do not return.
    unsafe { yurt_host_thread_exit(retval as usize as c_int) }
}

#[no_mangle]
pub extern "C" fn pthread_self() -> *mut c_void {
    // SAFETY: imports are provided by the Yurt host.
    thread_id_to_pthread(unsafe { yurt_host_thread_self() })
}

#[no_mangle]
pub extern "C" fn pthread_attr_init(attr: *mut PthreadAttr) -> c_int {
    if attr.is_null() {
        return EINVAL;
    }
    // SAFETY: `attr` was checked non-null and points to writable
    // pthread_attr_t storage. Zero initialization preserves the rest of the
    // opaque attr bytes while slot 0 is set explicitly below.
    unsafe {
        ptr::write_bytes(attr.cast::<u8>(), 0, mem::size_of::<PthreadAttr>());
    }
    *attr_detachstate_mut(attr).unwrap() = PTHREAD_CREATE_JOINABLE;
    0
}

#[no_mangle]
pub extern "C" fn pthread_attr_destroy(attr: *mut PthreadAttr) -> c_int {
    if attr.is_null() {
        EINVAL
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn pthread_attr_getdetachstate(
    attr: *const PthreadAttr,
    detachstate: *mut c_int,
) -> c_int {
    if detachstate.is_null() {
        return EINVAL;
    }
    let Some(value) = attr_detachstate(attr) else {
        return EINVAL;
    };
    // SAFETY: `detachstate` was checked non-null and points to caller-provided
    // storage for the returned detach state.
    unsafe {
        *detachstate = value;
    }
    0
}

#[no_mangle]
pub extern "C" fn pthread_attr_setdetachstate(attr: *mut PthreadAttr, detachstate: c_int) -> c_int {
    if detachstate != PTHREAD_CREATE_JOINABLE && detachstate != PTHREAD_CREATE_DETACHED {
        return EINVAL;
    }
    let Some(slot) = attr_detachstate_mut(attr) else {
        return EINVAL;
    };
    *slot = detachstate;
    0
}

#[no_mangle]
pub extern "C" fn pthread_attr_getstacksize(
    attr: *const PthreadAttr,
    stacksize: *mut usize,
) -> c_int {
    if attr.is_null() || stacksize.is_null() {
        return EINVAL;
    }
    // SAFETY: `stacksize` was checked non-null and points to caller-provided
    // storage for the returned stack size.
    unsafe {
        *stacksize = STACK_SIZE;
    }
    0
}

#[no_mangle]
pub extern "C" fn pthread_attr_setstacksize(attr: *mut PthreadAttr, _stacksize: usize) -> c_int {
    if attr.is_null() {
        EINVAL
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn pthread_attr_getstack(
    attr: *const PthreadAttr,
    stackaddr: *mut *mut c_void,
    stacksize: *mut usize,
) -> c_int {
    if attr.is_null() || stackaddr.is_null() || stacksize.is_null() {
        return EINVAL;
    }
    // SAFETY: output pointers were checked non-null and point to
    // caller-provided storage for this C ABI call.
    unsafe {
        *stackaddr = ptr::null_mut();
        *stacksize = STACK_SIZE;
    }
    0
}

#[no_mangle]
pub extern "C" fn pthread_attr_getguardsize(
    attr: *const PthreadAttr,
    guardsize: *mut usize,
) -> c_int {
    if attr.is_null() || guardsize.is_null() {
        return EINVAL;
    }
    // SAFETY: `guardsize` was checked non-null and points to caller-provided
    // storage for the returned guard size.
    unsafe {
        *guardsize = 0;
    }
    0
}

#[no_mangle]
pub extern "C" fn pthread_getattr_np(thread: *mut c_void, attr: *mut PthreadAttr) -> c_int {
    if attr.is_null() {
        return EINVAL;
    }
    // SAFETY: imports are provided by the Yurt host.
    if pthread_to_thread_id(thread) != unsafe { yurt_host_thread_self() } {
        return ESRCH;
    }
    pthread_attr_init(attr)
}
