#![no_std]

use core::ffi::{c_int, c_void};
use core::mem;
use core::ptr;
use core::sync::atomic::{AtomicBool, Ordering};

const EAGAIN: c_int = 6;
const EINVAL: c_int = 28;
const ESRCH: c_int = 71;
const HOST_EINVAL: c_int = 22;
const PTHREAD_CREATE_JOINABLE: c_int = 0;
const PTHREAD_CREATE_DETACHED: c_int = 1;
const STACK_SIZE: usize = 1024 * 1024;
const TLS_KEYS_MAX: usize = 64;
const TLS_THREADS_MAX: usize = 128;

const ATTR_DETACHSTATE_SLOT: usize = 0;

#[repr(C)]
pub struct PthreadAttr {
    slots: [c_int; 9],
}

#[derive(Copy, Clone)]
struct TlsKey {
    in_use: bool,
    generation: u32,
    destructor: usize,
    values: [usize; TLS_THREADS_MAX],
    value_generations: [u32; TLS_THREADS_MAX],
}

impl TlsKey {
    const EMPTY: Self = Self {
        in_use: false,
        generation: 0,
        destructor: 0,
        values: [0; TLS_THREADS_MAX],
        value_generations: [0; TLS_THREADS_MAX],
    };

    fn activate(&mut self, destructor: usize) {
        self.in_use = true;
        self.generation = self.generation.wrapping_add(1).max(1);
        self.destructor = destructor;
        self.values = [0; TLS_THREADS_MAX];
        self.value_generations = [self.generation; TLS_THREADS_MAX];
    }

    fn deactivate(&mut self) {
        self.in_use = false;
        self.generation = self.generation.wrapping_add(1).max(1);
        self.destructor = 0;
        self.values = [0; TLS_THREADS_MAX];
        self.value_generations = [0; TLS_THREADS_MAX];
    }
}

struct TlsLockGuard;

static TLS_LOCK: AtomicBool = AtomicBool::new(false);
static mut TLS_KEYS: [TlsKey; TLS_KEYS_MAX] = [TlsKey::EMPTY; TLS_KEYS_MAX];

#[allow(non_upper_case_globals)]
#[no_mangle]
pub static _CLOCK_REALTIME: u8 = 0;
#[allow(non_upper_case_globals)]
#[no_mangle]
pub static _CLOCK_MONOTONIC: u8 = 0;

#[link(wasm_import_module = "yurt")]
extern "C" {
    #[link_name = "host_thread_spawn"]
    fn yurt_host_thread_spawn(fn_ptr: c_int, arg: c_int) -> c_int;
    #[link_name = "host_thread_join"]
    fn yurt_host_thread_join(tid: c_int, out_retval: *mut u32) -> c_int;
    #[link_name = "host_thread_detach"]
    fn yurt_host_thread_detach(tid: c_int) -> c_int;
    #[link_name = "host_thread_exit"]
    fn yurt_host_thread_exit(retval: c_int) -> !;
    #[link_name = "host_thread_self"]
    fn yurt_host_thread_self() -> c_int;
}

fn tls_lock() -> TlsLockGuard {
    while TLS_LOCK
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        core::hint::spin_loop();
    }
    TlsLockGuard
}

impl Drop for TlsLockGuard {
    fn drop(&mut self) {
        TLS_LOCK.store(false, Ordering::Release);
    }
}

fn with_tls_keys<R>(f: impl FnOnce(&mut [TlsKey; TLS_KEYS_MAX]) -> R) -> R {
    let _guard = tls_lock();
    // SAFETY: TLS_KEYS is only accessed while TLS_LOCK is held. The raw
    // pointer avoids creating an implicit reference to a mutable static before
    // the lock has been acquired.
    unsafe { f(&mut *core::ptr::addr_of_mut!(TLS_KEYS)) }
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

fn realtime_clock_id() -> usize {
    core::ptr::addr_of!(_CLOCK_REALTIME) as usize
}

fn monotonic_clock_id() -> usize {
    core::ptr::addr_of!(_CLOCK_MONOTONIC) as usize
}

fn join_status_to_pthread_result(
    status: c_int,
    raw_retval: u32,
    retval: *mut *mut c_void,
) -> c_int {
    if status == -HOST_EINVAL || status == -EINVAL {
        return EINVAL;
    }
    if status < 0 {
        return ESRCH;
    }
    if !retval.is_null() {
        // SAFETY: `retval` was checked non-null and points to caller-provided
        // storage for the joined thread's raw wasm32 return pointer bits.
        unsafe {
            *retval = raw_retval as usize as *mut c_void;
        }
    }
    0
}

fn store_clock(attr: *mut c_void, value: usize) -> c_int {
    if attr.is_null() {
        return EINVAL;
    }
    // SAFETY: `attr` was checked non-null and points to caller-owned
    // pthread_condattr_t storage for this C ABI call. Condattr is opaque to C;
    // wasi-libc clockid_t is pointer-typed, so store a pointer-sized value.
    unsafe {
        ptr::write_unaligned(attr.cast::<usize>(), value);
    }
    0
}

fn load_clock(attr: *const c_void, value: *mut usize) -> c_int {
    if attr.is_null() || value.is_null() {
        return EINVAL;
    }
    // SAFETY: pointers were checked non-null and refer to C ABI storage for
    // this call. The clock id is stored unaligned in the first pointer-sized slot.
    unsafe {
        *value = ptr::read_unaligned(attr.cast::<usize>());
    }
    0
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
    let mut raw_retval = 0_u32;
    let status = unsafe { yurt_host_thread_join(pthread_to_thread_id(thread), &mut raw_retval) };
    join_status_to_pthread_result(status, raw_retval, retval)
}

#[no_mangle]
pub extern "C" fn pthread_detach(thread: *mut c_void) -> c_int {
    // SAFETY: imports are provided by the Yurt host. Invalid thread ids are
    // reported as negative return values by the host backend.
    let rv = unsafe { yurt_host_thread_detach(pthread_to_thread_id(thread)) };
    if rv == -HOST_EINVAL || rv == -EINVAL {
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
pub extern "C" fn yurt_rs_pthread_key_create(
    key: *mut u32,
    destructor: Option<extern "C" fn(*mut c_void)>,
) -> c_int {
    if key.is_null() {
        return EINVAL;
    }
    with_tls_keys(|keys| {
        for (index, slot) in keys.iter_mut().enumerate() {
            if !slot.in_use {
                slot.activate(destructor.map_or(0, |f| f as usize));
                // SAFETY: `key` was checked non-null and points to
                // caller-provided pthread_key_t storage for this C ABI call.
                unsafe {
                    *key = index as u32;
                }
                return 0;
            }
        }
        EAGAIN
    })
}

#[no_mangle]
pub extern "C" fn yurt_rs_pthread_key_delete(key: u32) -> c_int {
    with_tls_keys(|keys| {
        let Some(slot) = keys.get_mut(key as usize) else {
            return EINVAL;
        };
        if !slot.in_use {
            return EINVAL;
        }
        slot.deactivate();
        0
    })
}

#[no_mangle]
pub extern "C" fn yurt_rs_pthread_setspecific(key: u32, value: *const c_void) -> c_int {
    // SAFETY: imports are provided by the Yurt host.
    let tid = unsafe { yurt_host_thread_self() };
    if tid < 0 || tid as usize >= TLS_THREADS_MAX {
        return EINVAL;
    }
    with_tls_keys(|keys| {
        let Some(slot) = keys.get_mut(key as usize) else {
            return EINVAL;
        };
        if !slot.in_use {
            return EINVAL;
        }
        let tid = tid as usize;
        slot.values[tid] = value as usize;
        slot.value_generations[tid] = slot.generation;
        0
    })
}

#[no_mangle]
pub extern "C" fn yurt_rs_pthread_getspecific(key: u32) -> *mut c_void {
    // SAFETY: imports are provided by the Yurt host.
    let tid = unsafe { yurt_host_thread_self() };
    if tid < 0 || tid as usize >= TLS_THREADS_MAX {
        return ptr::null_mut();
    }
    with_tls_keys(|keys| {
        let Some(slot) = keys.get(key as usize) else {
            return ptr::null_mut();
        };
        if !slot.in_use {
            return ptr::null_mut();
        }
        let tid = tid as usize;
        if slot.value_generations[tid] != slot.generation {
            return ptr::null_mut();
        }
        slot.values[tid] as *mut c_void
    })
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

#[no_mangle]
pub extern "C" fn pthread_condattr_init(attr: *mut c_void) -> c_int {
    store_clock(attr, realtime_clock_id())
}

#[no_mangle]
pub extern "C" fn pthread_condattr_destroy(attr: *mut c_void) -> c_int {
    if attr.is_null() {
        EINVAL
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn pthread_condattr_setclock(attr: *mut c_void, clock_id: usize) -> c_int {
    if clock_id != realtime_clock_id() && clock_id != monotonic_clock_id() {
        return EINVAL;
    }
    store_clock(attr, clock_id)
}

#[no_mangle]
pub extern "C" fn pthread_condattr_getclock(attr: *const c_void, clock_id: *mut usize) -> c_int {
    load_clock(attr, clock_id)
}
