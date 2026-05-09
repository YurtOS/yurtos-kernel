#![no_std]

use core::ffi::{c_char, c_int};
use core::ptr;
use core::slice;
use core::sync::atomic::{AtomicBool, AtomicU8, Ordering};

type SizeT = usize;
type WCharT = i32;
type LocaleT = *mut core::ffi::c_void;
type NlItem = c_int;

const LC_CTYPE: c_int = 0;
const LC_ALL: c_int = 6;
const CODESET: NlItem = 14;
const EILSEQ: c_int = 25;
const MB_ERR_INVALID: SizeT = SizeT::MAX;
const MB_ERR_INCOMPLETE: SizeT = SizeT::MAX - 1;

const LOCALE_C: u8 = 0;
const LOCALE_UTF8: u8 = 1;

static CURRENT_LOCALE: AtomicU8 = AtomicU8::new(LOCALE_UTF8);
static CTYPE_UTF8: AtomicBool = AtomicBool::new(true);
static mut INTERNAL_MBSTATE: [u8; 8] = [0; 8];

static C_LOCALE_NAME: &[u8] = b"C\0";
static UTF8_LOCALE_NAME: &[u8] = b"C.UTF-8\0";
static ASCII_CODESET: &[u8] = b"ASCII\0";
static UTF8_CODESET: &[u8] = b"UTF-8\0";
static EMPTY: &[u8] = b"\0";

extern "C" {
    fn getenv(name: *const c_char) -> *mut c_char;
    fn __errno_location() -> *mut c_int;
    fn __real_strftime(
        s: *mut c_char,
        max: SizeT,
        format: *const c_char,
        tm: *const core::ffi::c_void,
    ) -> SizeT;
}

fn cstr_bytes<'a>(ptr: *const c_char) -> Option<&'a [u8]> {
    if ptr.is_null() {
        return None;
    }
    let mut len = 0usize;
    // SAFETY: `ptr` is a caller-provided C string pointer. We only read one
    // byte at a time until the terminating NUL, matching C string semantics.
    unsafe {
        while *ptr.add(len) != 0 {
            len += 1;
        }
        Some(slice::from_raw_parts(ptr.cast::<u8>(), len))
    }
}

fn env(name: &[u8]) -> Option<&'static [u8]> {
    // SAFETY: all call sites pass static NUL-terminated environment variable
    // names, so `getenv` receives a valid C string pointer.
    let ptr = unsafe { getenv(name.as_ptr().cast::<c_char>()) };
    let value = cstr_bytes(ptr.cast::<c_char>())?;
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn requested_locale<'a>(locale: &'a [u8]) -> &'a [u8] {
    if !locale.is_empty() {
        return locale;
    }
    env(b"LC_ALL\0")
        .or_else(|| env(b"LC_CTYPE\0"))
        .or_else(|| env(b"LANG\0"))
        .unwrap_or(b"C.UTF-8")
}

fn is_c_locale(locale: &[u8]) -> bool {
    locale == b"C" || locale == b"POSIX"
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase())
    })
}

fn is_utf8_locale(locale: &[u8]) -> bool {
    contains_ascii_case_insensitive(locale, b"UTF-8")
        || contains_ascii_case_insensitive(locale, b"UTF8")
        || contains_ascii_case_insensitive(locale, b"utf8")
}

fn set_errno(value: c_int) {
    // SAFETY: wasi-libc exposes `__errno_location` as a valid pointer to the
    // calling thread's errno slot for the duration of this call.
    unsafe {
        *__errno_location() = value;
    }
}

fn locale_name_ptr() -> *mut c_char {
    if CURRENT_LOCALE.load(Ordering::Relaxed) == LOCALE_C {
        C_LOCALE_NAME.as_ptr() as *mut c_char
    } else {
        UTF8_LOCALE_NAME.as_ptr() as *mut c_char
    }
}

fn setlocale_impl(category: c_int, locale: *const c_char) -> *mut c_char {
    let Some(locale) = cstr_bytes(locale) else {
        return locale_name_ptr();
    };
    let requested = requested_locale(locale);

    if is_c_locale(requested) {
        CURRENT_LOCALE.store(LOCALE_C, Ordering::Relaxed);
        if category == LC_ALL || category == LC_CTYPE {
            CTYPE_UTF8.store(false, Ordering::Relaxed);
        }
        return locale_name_ptr();
    }

    if !is_utf8_locale(requested) {
        return ptr::null_mut();
    }

    CURRENT_LOCALE.store(LOCALE_UTF8, Ordering::Relaxed);
    if category == LC_ALL || category == LC_CTYPE {
        CTYPE_UTF8.store(true, Ordering::Relaxed);
    }
    locale_name_ptr()
}

#[no_mangle]
pub extern "C" fn setlocale(category: c_int, locale: *const c_char) -> *mut c_char {
    setlocale_impl(category, locale)
}

#[no_mangle]
pub extern "C" fn __wrap_setlocale(category: c_int, locale: *const c_char) -> *mut c_char {
    setlocale_impl(category, locale)
}

fn mb_cur_max_impl() -> SizeT {
    if CTYPE_UTF8.load(Ordering::Relaxed) { 4 } else { 1 }
}

#[no_mangle]
pub extern "C" fn __ctype_get_mb_cur_max() -> SizeT {
    mb_cur_max_impl()
}

#[no_mangle]
pub extern "C" fn __wrap___ctype_get_mb_cur_max() -> SizeT {
    mb_cur_max_impl()
}

fn nl_langinfo_impl(item: NlItem) -> *mut c_char {
    if item == CODESET {
        if CTYPE_UTF8.load(Ordering::Relaxed) {
            UTF8_CODESET.as_ptr() as *mut c_char
        } else {
            ASCII_CODESET.as_ptr() as *mut c_char
        }
    } else {
        EMPTY.as_ptr() as *mut c_char
    }
}

#[no_mangle]
pub extern "C" fn nl_langinfo(item: NlItem) -> *mut c_char {
    nl_langinfo_impl(item)
}

#[no_mangle]
pub extern "C" fn __wrap_nl_langinfo(item: NlItem) -> *mut c_char {
    nl_langinfo_impl(item)
}

fn nl_langinfo_l_impl(item: NlItem, _locale: LocaleT) -> *mut c_char {
    nl_langinfo_impl(item)
}

#[no_mangle]
pub extern "C" fn nl_langinfo_l(item: NlItem, locale: LocaleT) -> *mut c_char {
    nl_langinfo_l_impl(item, locale)
}

#[no_mangle]
pub extern "C" fn __wrap_nl_langinfo_l(item: NlItem, locale: LocaleT) -> *mut c_char {
    nl_langinfo_l_impl(item, locale)
}

fn utf8_width(first: u8) -> Option<usize> {
    if first < 0x80 {
        Some(1)
    } else if (0xc2..=0xdf).contains(&first) {
        Some(2)
    } else if (0xe0..=0xef).contains(&first) {
        Some(3)
    } else if (0xf0..=0xf4).contains(&first) {
        Some(4)
    } else {
        None
    }
}

fn decode_utf8_complete(pwc: *mut WCharT, bytes: *const u8, len: usize) -> SizeT {
    if len == 0 {
        return MB_ERR_INCOMPLETE;
    }
    // SAFETY: callers pass `len > 0` and a pointer to at least `len` bytes.
    let first = unsafe { *bytes };
    if first < 0x80 {
        if !pwc.is_null() {
            // SAFETY: POSIX permits `pwc` to be null; otherwise it must point
            // to writable storage for one wide character.
            unsafe { *pwc = first as WCharT };
        }
        return if first == 0 { 0 } else { 1 };
    }

    let Some(need) = utf8_width(first) else {
        set_errno(EILSEQ);
        return MB_ERR_INVALID;
    };
    if len < need {
        return MB_ERR_INCOMPLETE;
    }
    let mut value = match need {
        2 => (first & 0x1f) as u32,
        3 => (first & 0x0f) as u32,
        4 => (first & 0x07) as u32,
        _ => {
            set_errno(EILSEQ);
            return MB_ERR_INVALID;
        }
    };
    let mut index = 1usize;
    while index < need {
        // SAFETY: `need <= len` was checked above, and `index < need`.
        let byte = unsafe { *bytes.add(index) };
        if byte & 0xc0 != 0x80 {
            set_errno(EILSEQ);
            return MB_ERR_INVALID;
        }
        value = (value << 6) | (byte & 0x3f) as u32;
        index += 1;
    }
    if (need == 2 && value < 0x80)
        || (need == 3 && value < 0x800)
        || (need == 4 && value < 0x10000)
        || (0xd800..=0xdfff).contains(&value)
        || value > 0x10ffff
    {
        set_errno(EILSEQ);
        return MB_ERR_INVALID;
    }
    if !pwc.is_null() {
        // SAFETY: POSIX permits `pwc` to be null; otherwise it must point to
        // writable storage for one wide character.
        unsafe { *pwc = value as WCharT };
    }
    need
}

/// # Safety
///
/// `ps`, when non-null, must point to writable `mbstate_t` storage compatible
/// with wasi-libc's 8-byte representation.
unsafe fn mbstate_ptr(ps: *mut core::ffi::c_void) -> *mut u8 {
    if ps.is_null() {
        // SAFETY: this function centralizes access to the process-global
        // fallback mbstate used when C callers pass a null state pointer.
        ptr::addr_of_mut!(INTERNAL_MBSTATE).cast::<u8>()
    } else {
        ps.cast::<u8>()
    }
}

/// # Safety
///
/// `state` must point to 8 bytes of writable multibyte conversion state.
unsafe fn clear_mbstate(state: *mut u8) {
    for offset in 0..8 {
        // SAFETY: callers pass either `INTERNAL_MBSTATE` or a C `mbstate_t`
        // object compatible with wasi-libc's 8-byte state storage.
        *state.add(offset) = 0;
    }
}

/// # Safety
///
/// `state` must point to an initialized 8-byte multibyte conversion state.
unsafe fn pending_width(state: *mut u8) -> usize {
    // SAFETY: callers pass a valid state pointer as described by
    // `mbstate_ptr`.
    *state as usize
}

/// # Safety
///
/// `state` must point to an initialized 8-byte multibyte conversion state.
unsafe fn pending_len(state: *mut u8) -> usize {
    // SAFETY: byte 1 is within the 8-byte state storage described by
    // `mbstate_ptr`.
    *state.add(1) as usize
}

/// # Safety
///
/// `state` must point to 8 writable bytes, `bytes` must point to `len` bytes,
/// and `len <= need <= 4`.
unsafe fn store_pending(state: *mut u8, need: usize, bytes: *const u8, len: usize) {
    // SAFETY: callers ensure `need <= 4`, `len <= need`, and `bytes` points to
    // at least `len` bytes; state points to 8 bytes of writable storage.
    *state = need as u8;
    *state.add(1) = len as u8;
    let mut index = 0usize;
    while index < len {
        *state.add(2 + index) = *bytes.add(index);
        index += 1;
    }
}

/// # Safety
///
/// `state` must point to an initialized 8-byte state previously written by
/// `store_pending`.
unsafe fn load_pending(state: *mut u8, out: &mut [u8; 4]) -> usize {
    // SAFETY: state points to 8 bytes initialized by `store_pending`; copying
    // is capped to the 4-byte UTF-8 staging buffer.
    let len = pending_len(state);
    for index in 0..len.min(out.len()) {
        out[index] = *state.add(2 + index);
    }
    len
}

fn mbrtowc_impl(
    pwc: *mut WCharT,
    s: *const c_char,
    n: SizeT,
    ps: *mut core::ffi::c_void,
) -> SizeT {
    // SAFETY: `mbstate_ptr` returns either the internal state or the caller's
    // provided state pointer; subsequent helpers validate access widths.
    let state = unsafe { mbstate_ptr(ps) };
    if s.is_null() {
        // SAFETY: `state` is the valid state pointer selected above.
        unsafe { clear_mbstate(state) };
        return 0;
    }
    let bytes = s.cast::<u8>();
    if !CTYPE_UTF8.load(Ordering::Relaxed) {
        // SAFETY: `state` is the valid state pointer selected above.
        unsafe { clear_mbstate(state) };
        if n == 0 {
            return MB_ERR_INCOMPLETE;
        }
        // SAFETY: `n > 0`, so the C input buffer has at least one byte.
        let byte = unsafe { *bytes };
        if byte >= 0x80 {
            set_errno(EILSEQ);
            return MB_ERR_INVALID;
        }
        if !pwc.is_null() {
            // SAFETY: POSIX permits `pwc` to be null; otherwise it must point
            // to writable storage for one wide character.
            unsafe { *pwc = byte as WCharT };
        }
        return if byte == 0 { 0 } else { 1 };
    }
    if n == 0 {
        return MB_ERR_INCOMPLETE;
    }

    // SAFETY: all state access goes through helpers bounded to the 8-byte
    // mbstate representation; reads from `bytes` are bounded by `n`.
    unsafe {
        let need = pending_width(state);
        if need != 0 {
            let mut buffer = [0u8; 4];
            let mut have = load_pending(state, &mut buffer);
            let mut consumed = 0usize;
            while have < need && consumed < n {
                *buffer.as_mut_ptr().add(have) = *bytes.add(consumed);
                have += 1;
                consumed += 1;
            }
            if have < need {
                store_pending(state, need, buffer.as_ptr(), have);
                return MB_ERR_INCOMPLETE;
            }
            let decoded = decode_utf8_complete(pwc, buffer.as_ptr(), need);
            clear_mbstate(state);
            if decoded == MB_ERR_INVALID {
                return MB_ERR_INVALID;
            }
            return consumed;
        }
    }

    // SAFETY: `n > 0`, so the C input buffer has at least one byte.
    let first = unsafe { *bytes };
    let Some(need) = utf8_width(first) else {
        set_errno(EILSEQ);
        return MB_ERR_INVALID;
    };
    if n < need {
        // SAFETY: `bytes` points to `n` bytes from the caller, and `n < need`
        // with `need <= 4`, so the pending state has enough storage.
        unsafe { store_pending(state, need, bytes, n) };
        return MB_ERR_INCOMPLETE;
    }
    let decoded = decode_utf8_complete(pwc, bytes, n);
    if decoded == MB_ERR_INVALID {
        // SAFETY: `state` is the valid state pointer selected above.
        unsafe { clear_mbstate(state) };
    }
    decoded
}

#[no_mangle]
pub extern "C" fn mbrtowc(
    pwc: *mut WCharT,
    s: *const c_char,
    n: SizeT,
    ps: *mut core::ffi::c_void,
) -> SizeT {
    mbrtowc_impl(pwc, s, n, ps)
}

#[no_mangle]
pub extern "C" fn __wrap_mbrtowc(
    pwc: *mut WCharT,
    s: *const c_char,
    n: SizeT,
    ps: *mut core::ffi::c_void,
) -> SizeT {
    mbrtowc_impl(pwc, s, n, ps)
}

fn mbtowc_impl(pwc: *mut WCharT, s: *const c_char, n: SizeT) -> c_int {
    if s.is_null() {
        return 0;
    }
    match mbrtowc_impl(pwc, s, n, ptr::null_mut()) {
        MB_ERR_INVALID | MB_ERR_INCOMPLETE => -1,
        value => value as c_int,
    }
}

#[no_mangle]
pub extern "C" fn mbtowc(pwc: *mut WCharT, s: *const c_char, n: SizeT) -> c_int {
    mbtowc_impl(pwc, s, n)
}

#[no_mangle]
pub extern "C" fn __wrap_mbtowc(pwc: *mut WCharT, s: *const c_char, n: SizeT) -> c_int {
    mbtowc_impl(pwc, s, n)
}

fn wcrtomb_impl(s: *mut c_char, wc: WCharT, _ps: *mut core::ffi::c_void) -> SizeT {
    if s.is_null() {
        return 1;
    }
    let value = wc as u32;
    if !CTYPE_UTF8.load(Ordering::Relaxed) {
        if value > 0x7f {
            set_errno(EILSEQ);
            return MB_ERR_INVALID;
        }
        // SAFETY: `s` is non-null and the C caller must provide space for at
        // least one output byte.
        unsafe { *s = value as c_char };
        return 1;
    }

    let out = s.cast::<u8>();
    if value < 0x80 {
        // SAFETY: `s` is non-null and the C caller must provide space for at
        // least one output byte.
        unsafe { *out = value as u8 };
        return 1;
    }
    if value < 0x800 {
        // SAFETY: `s` is non-null and the C caller must provide enough output
        // space for the encoded wide character.
        unsafe {
            *out = 0xc0 | (value >> 6) as u8;
            *out.add(1) = 0x80 | (value & 0x3f) as u8;
        }
        return 2;
    }
    if value < 0x10000 {
        // SAFETY: `s` is non-null and the C caller must provide enough output
        // space for the encoded wide character.
        unsafe {
            *out = 0xe0 | (value >> 12) as u8;
            *out.add(1) = 0x80 | ((value >> 6) & 0x3f) as u8;
            *out.add(2) = 0x80 | (value & 0x3f) as u8;
        }
        return 3;
    }
    if value <= 0x10ffff {
        // SAFETY: `s` is non-null and the C caller must provide enough output
        // space for the encoded wide character.
        unsafe {
            *out = 0xf0 | (value >> 18) as u8;
            *out.add(1) = 0x80 | ((value >> 12) & 0x3f) as u8;
            *out.add(2) = 0x80 | ((value >> 6) & 0x3f) as u8;
            *out.add(3) = 0x80 | (value & 0x3f) as u8;
        }
        return 4;
    }
    set_errno(EILSEQ);
    MB_ERR_INVALID
}

#[no_mangle]
pub extern "C" fn wcrtomb(s: *mut c_char, wc: WCharT, ps: *mut core::ffi::c_void) -> SizeT {
    wcrtomb_impl(s, wc, ps)
}

#[no_mangle]
pub extern "C" fn __wrap_wcrtomb(
    s: *mut c_char,
    wc: WCharT,
    ps: *mut core::ffi::c_void,
) -> SizeT {
    wcrtomb_impl(s, wc, ps)
}

fn wctomb_impl(s: *mut c_char, wc: WCharT) -> c_int {
    if s.is_null() {
        return 0;
    }
    match wcrtomb_impl(s, wc, ptr::null_mut()) {
        MB_ERR_INVALID => -1,
        value => value as c_int,
    }
}

#[no_mangle]
pub extern "C" fn wctomb(s: *mut c_char, wc: WCharT) -> c_int {
    wctomb_impl(s, wc)
}

#[no_mangle]
pub extern "C" fn __wrap_wctomb(s: *mut c_char, wc: WCharT) -> c_int {
    wctomb_impl(s, wc)
}

fn strftime_has_invalid_at(format: *const c_char) -> bool {
    let Some(format) = cstr_bytes(format) else {
        return false;
    };
    let mut index = 0usize;
    while index < format.len() {
        if format[index] != b'%' {
            index += 1;
            continue;
        }

        index += 1;
        if index >= format.len() {
            return false;
        }
        if format[index] == b'%' {
            index += 1;
            continue;
        }

        while index < format.len()
            && matches!(
                format[index],
                b'E' | b'O' | b'^' | b'#' | b'_' | b'-' | b'0'..=b'9'
            )
        {
            index += 1;
        }
        if index < format.len() && format[index] == b'@' {
            return true;
        }
        index += 1;
    }
    false
}

fn strftime_impl(
    s: *mut c_char,
    max: SizeT,
    format: *const c_char,
    tm: *const core::ffi::c_void,
) -> SizeT {
    if strftime_has_invalid_at(format) {
        return 0;
    }
    // SAFETY: this wrapper forwards the caller's original `strftime`
    // arguments to wasi-libc after filtering the unsupported `%@` extension.
    unsafe { __real_strftime(s, max, format, tm) }
}

#[no_mangle]
pub extern "C" fn __wrap_strftime(
    s: *mut c_char,
    max: SizeT,
    format: *const c_char,
    tm: *const core::ffi::c_void,
) -> SizeT {
    strftime_impl(s, max, format, tm)
}
