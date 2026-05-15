#![cfg_attr(not(test), no_std)]

use core::ffi::{c_int, c_void};
use core::mem;
use core::ptr;

type QsortRComparator = extern "C" fn(*const c_void, *const c_void, *mut c_void) -> c_int;

const ENOMEM: c_int = 48;

#[cfg(not(test))]
extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn __errno_location() -> *mut c_int;
}

#[cfg(not(test))]
fn set_errno(errno: c_int) {
    // SAFETY: wasi-libc provides a thread-local errno slot.
    unsafe {
        *__errno_location() = errno;
    }
}

#[cfg(test)]
static mut ERRNO_SLOT: c_int = 0;

#[cfg(test)]
fn set_errno(errno: c_int) {
    // SAFETY: unit tests run this helper serially enough for the errno smoke
    // test; production uses wasi-libc's thread-local errno.
    unsafe {
        ERRNO_SLOT = errno;
    }
}

fn elem(base: *mut u8, index: usize, size: usize) -> *mut u8 {
    base.wrapping_add(index.saturating_mul(size))
}

struct Allocation {
    ptr: *mut c_void,
    len: usize,
    #[cfg(test)]
    _buf: Vec<u8>,
}

impl Allocation {
    #[cfg(not(test))]
    fn new(len: usize) -> Option<Self> {
        let alloc_len = len.max(1);
        // SAFETY: `malloc` returns a block suitable for byte storage or null.
        let ptr = unsafe { malloc(alloc_len) };
        if ptr.is_null() {
            None
        } else {
            Some(Self { ptr, len })
        }
    }

    #[cfg(test)]
    fn new(len: usize) -> Option<Self> {
        let mut buf = vec![0u8; len.max(1)];
        let ptr = buf.as_mut_ptr().cast();
        Some(Self {
            ptr,
            len,
            _buf: buf,
        })
    }

    fn as_usize_slice(&mut self) -> &mut [usize] {
        let count = self.len / mem::size_of::<usize>();
        // SAFETY: The allocation was sized as `count * size_of::<usize>()`
        // and `malloc` returns storage aligned for any object type.
        unsafe { core::slice::from_raw_parts_mut(self.ptr.cast::<usize>(), count) }
    }
}

impl Drop for Allocation {
    #[cfg(not(test))]
    fn drop(&mut self) {
        // SAFETY: `ptr` came from malloc and is freed exactly once here.
        unsafe {
            free(self.ptr);
        }
    }

    #[cfg(test)]
    fn drop(&mut self) {}
}

fn sort_indices(
    indices: &mut [usize],
    base: *mut u8,
    size: usize,
    compar: QsortRComparator,
    arg: *mut c_void,
) {
    quicksort_indices(indices, base, size, compar, arg);
    insertion_sort_indices(indices, base, size, compar, arg);
}

const INSERTION_SORT_THRESHOLD: usize = 16;

fn compare_element_indices(
    left: usize,
    right: usize,
    base: *mut u8,
    size: usize,
    compar: QsortRComparator,
    arg: *mut c_void,
) -> c_int {
    compar(
        elem(base, left, size).cast_const().cast(),
        elem(base, right, size).cast_const().cast(),
        arg,
    )
}

fn index_at(indices: &[usize], pos: usize) -> usize {
    // SAFETY: all callers compute `pos` inside the active sort range.
    unsafe { *indices.as_ptr().add(pos) }
}

fn set_index(indices: &mut [usize], pos: usize, value: usize) {
    // SAFETY: all callers compute `pos` inside the active sort range.
    unsafe {
        *indices.as_mut_ptr().add(pos) = value;
    }
}

fn swap_indices(indices: &mut [usize], left: usize, right: usize) {
    if left == right {
        return;
    }
    let left_value = index_at(indices, left);
    let right_value = index_at(indices, right);
    set_index(indices, left, right_value);
    set_index(indices, right, left_value);
}

fn less_at(
    indices: &[usize],
    left: usize,
    right: usize,
    base: *mut u8,
    size: usize,
    compar: QsortRComparator,
    arg: *mut c_void,
) -> bool {
    compare_element_indices(
        index_at(indices, left),
        index_at(indices, right),
        base,
        size,
        compar,
        arg,
    ) < 0
}

fn median_of_three(
    indices: &mut [usize],
    lo: usize,
    mid: usize,
    hi: usize,
    base: *mut u8,
    size: usize,
    compar: QsortRComparator,
    arg: *mut c_void,
) {
    if less_at(indices, mid, lo, base, size, compar, arg) {
        swap_indices(indices, lo, mid);
    }
    if less_at(indices, hi, mid, base, size, compar, arg) {
        swap_indices(indices, mid, hi);
    }
    if less_at(indices, mid, lo, base, size, compar, arg) {
        swap_indices(indices, lo, mid);
    }
}

fn partition_indices(
    indices: &mut [usize],
    lo: usize,
    hi: usize,
    base: *mut u8,
    size: usize,
    compar: QsortRComparator,
    arg: *mut c_void,
) -> usize {
    let mid = lo + ((hi - lo) / 2);
    let last = hi - 1;
    median_of_three(indices, lo, mid, last, base, size, compar, arg);
    swap_indices(indices, mid, last);
    let pivot = index_at(indices, last);
    let mut store = lo;

    for scan in lo..last {
        if compare_element_indices(index_at(indices, scan), pivot, base, size, compar, arg) < 0 {
            swap_indices(indices, store, scan);
            store += 1;
        }
    }
    swap_indices(indices, store, last);
    store
}

fn quicksort_indices(
    indices: &mut [usize],
    base: *mut u8,
    size: usize,
    compar: QsortRComparator,
    arg: *mut c_void,
) {
    let mut stack = [(0usize, 0usize); 64];
    let mut depth = 0usize;
    let mut lo = 0usize;
    let mut hi = indices.len();

    loop {
        while hi.saturating_sub(lo) > INSERTION_SORT_THRESHOLD {
            let pivot = partition_indices(indices, lo, hi, base, size, compar, arg);
            let left_len = pivot - lo;
            let right_lo = pivot + 1;
            let right_len = hi - right_lo;

            if left_len < right_len {
                if right_len > INSERTION_SORT_THRESHOLD {
                    set_stack_range(&mut stack, depth, (right_lo, hi));
                    depth += 1;
                }
                hi = pivot;
            } else {
                if left_len > INSERTION_SORT_THRESHOLD {
                    set_stack_range(&mut stack, depth, (lo, pivot));
                    depth += 1;
                }
                lo = right_lo;
            }
        }

        if depth == 0 {
            break;
        }
        depth -= 1;
        let (next_lo, next_hi) = stack_range(&stack, depth);
        lo = next_lo;
        hi = next_hi;
    }
}

fn set_stack_range(stack: &mut [(usize, usize); 64], pos: usize, value: (usize, usize)) {
    debug_assert!(pos < stack.len());
    // SAFETY: quicksort always pushes the larger partition and continues with
    // the smaller one, so the stack depth is bounded by log2(usize::MAX) < 64.
    unsafe {
        *stack.as_mut_ptr().add(pos) = value;
    }
}

fn stack_range(stack: &[(usize, usize); 64], pos: usize) -> (usize, usize) {
    debug_assert!(pos < stack.len());
    // SAFETY: callers only pop ranges previously written by `set_stack_range`.
    unsafe { *stack.as_ptr().add(pos) }
}

fn insertion_sort_indices(
    indices: &mut [usize],
    base: *mut u8,
    size: usize,
    compar: QsortRComparator,
    arg: *mut c_void,
) {
    for pos in 1..indices.len() {
        let value = index_at(indices, pos);
        let mut insert = pos;
        while insert > 0
            && compare_element_indices(value, index_at(indices, insert - 1), base, size, compar, arg)
                < 0
        {
            let previous = index_at(indices, insert - 1);
            set_index(indices, insert, previous);
            insert -= 1;
        }
        set_index(indices, insert, value);
    }
}

fn write_sorted_copy(base: *mut u8, indices: &[usize], size: usize, sorted: *mut u8) {
    for (target, source) in indices.iter().copied().enumerate() {
        // SAFETY: `sorted` has `indices.len() * size` bytes, and each source
        // index refers to one complete element in the caller-provided array.
        unsafe {
            ptr::copy_nonoverlapping(elem(base, source, size), elem(sorted, target, size), size);
        }
    }
    // SAFETY: The sorted scratch buffer contains exactly the replacement array
    // bytes and does not overlap the caller-provided base.
    unsafe {
        ptr::copy_nonoverlapping(sorted, base, indices.len() * size);
    }
}

#[no_mangle]
pub extern "C" fn yurt_rs_qsort_r(
    base: *mut c_void,
    nmemb: usize,
    size: usize,
    compar: Option<QsortRComparator>,
    arg: *mut c_void,
) {
    let Some(compar) = compar else {
        return;
    };
    if base.is_null() || nmemb < 2 || size == 0 {
        return;
    }

    let Some(index_bytes) = nmemb.checked_mul(mem::size_of::<usize>()) else {
        set_errno(ENOMEM);
        return;
    };
    let Some(total_bytes) = nmemb.checked_mul(size) else {
        set_errno(ENOMEM);
        return;
    };
    let Some(mut indices_alloc) = Allocation::new(index_bytes) else {
        set_errno(ENOMEM);
        return;
    };
    let Some(sorted_alloc) = Allocation::new(total_bytes) else {
        set_errno(ENOMEM);
        return;
    };

    let indices = indices_alloc.as_usize_slice();
    for (index, slot) in indices.iter_mut().enumerate() {
        *slot = index;
    }
    let base = base.cast::<u8>();
    sort_indices(indices, base, size, compar, arg);
    write_sorted_copy(base, indices, size, sorted_alloc.ptr.cast());
}

#[cfg(test)]
mod tests {
    use super::*;

    extern "C" fn compare_i32_with_direction(
        left: *const c_void,
        right: *const c_void,
        arg: *mut c_void,
    ) -> c_int {
        // SAFETY: The test passes valid i32 elements and an i32 direction
        // argument for the duration of the qsort call.
        unsafe {
            let direction = *(arg.cast::<i32>());
            let a = *(left.cast::<i32>());
            let b = *(right.cast::<i32>());
            direction * a.cmp(&b) as c_int
        }
    }

    #[test]
    fn qsort_r_sorts_with_caller_arg() {
        let mut values = [3_i32, 1, 4, 1, 5, 9, 2];
        let mut direction = 1_i32;

        yurt_rs_qsort_r(
            values.as_mut_ptr().cast(),
            values.len(),
            core::mem::size_of::<i32>(),
            Some(compare_i32_with_direction),
            (&mut direction as *mut i32).cast(),
        );

        assert_eq!(values, [1, 1, 2, 3, 4, 5, 9]);
    }

    #[test]
    fn qsort_r_does_not_retain_comparator_arg_between_calls() {
        let mut ascending = [2_i32, 1, 3];
        let mut descending = [2_i32, 1, 3];
        let mut asc = 1_i32;
        let mut desc = -1_i32;

        yurt_rs_qsort_r(
            ascending.as_mut_ptr().cast(),
            ascending.len(),
            core::mem::size_of::<i32>(),
            Some(compare_i32_with_direction),
            (&mut asc as *mut i32).cast(),
        );
        yurt_rs_qsort_r(
            descending.as_mut_ptr().cast(),
            descending.len(),
            core::mem::size_of::<i32>(),
            Some(compare_i32_with_direction),
            (&mut desc as *mut i32).cast(),
        );

        assert_eq!(ascending, [1, 2, 3]);
        assert_eq!(descending, [3, 2, 1]);
    }

    #[test]
    fn qsort_r_avoids_core_slice_sort_runtime_symbols() {
        let source = include_str!("sort.rs");
        let forbidden = ["sort", "_", "unstable", "_", "by"].concat();
        assert!(!source.contains(&forbidden));
    }

    #[test]
    fn errno_location_test_stub_is_writeable() {
        set_errno(ENOMEM);
        // SAFETY: unit test reads the test-only errno slot after writing it.
        assert_eq!(unsafe { ERRNO_SLOT }, ENOMEM);
    }
}
