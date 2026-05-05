# BusyBox Upstream Testsuite on Yurt — 2026-05-04

**Runner**: `scripts/run-busybox-testsuite-in-sandbox.ts`
**Elapsed**: 5.1s
**BusyBox binary**: `test-fixtures/c-ports/busybox/build/busybox.wasm`
**Sandbox fixtures**: `packages/kernel/src/platform/__tests__/fixtures/`

## Infrastructure Gap: runtest "implemented" Detection

The upstream `runtest` script uses a shell pipeline pattern that doesn't work in the sandbox:
1. **Absolute-path subprocess spawning**: `/tmp/testsuite/busybox` (a VFS symlink to `/usr/bin/busybox`) fails when the sandbox process manager tries to resolve it — the host error "No such file or directory" occurs because VFS symlinks don't resolve to host filesystem paths.
2. **xargs-within-while-read pipeline**: `xargs` inside a `while read` loop piped from a subprocess doesn't receive stdin from the pipe correctly.

**Workaround**: This runner bypasses `runtest` and invokes each `.tests` file directly with the proper env. Uses a shell wrapper at `/tmp/testsuite/busybox` (not a symlink) to work around issue 1.

**Classification**: `runtime-gap` — tracked follow-up for shell subprocess stdin routing and VFS symlink resolution in absolute-path spawn context.

## Infrastructure Gap: bc/interactive stdin hang

Tests that run interactive programs (e.g., `bc.tests`) hang indefinitely because the program waits for stdin to close, but the sandbox shell doesn't send EOF after the pipe input. This is a sandbox shell pipe EOF delivery gap.

Each `.tests` file is run in a fresh sandbox with a 30s timeout to protect against this.

**Classification**: `runtime-gap` — shell pipe EOF not delivered to subprocess stdin when shell command completes.

## Summary

| Category | Count |
|---|---|
| PASS | 165 |
| FAIL | 7 |
| SKIP | 63 |
| UNTESTED | 16 |
| **Total** | **251** |
| Timed out / crashed | 0 |

### Failure breakdown

| Classification | Count |
|---|---|
| `needs-fork` | 0 |
| `runtime-gap` | 6 |
| `test-env` | 0 |
| `unknown` | 1 |

**Exit policy**: 7 upstream test failure(s) + 0 crash(es)/timeout(s). Exiting 1. Known-open items tracked in the acceptance ledger, not in runner-level tolerances.

## Classification Key

- **`needs-fork`**: Genuine §Non-Goals per spec lines 76–88 (`fork()`/`execve()`/job control). Legit skip.
- **`runtime-gap`**: Yurt should support this, currently doesn't. Tracked follow-up needed.
- **`test-env`**: Test expects specific env (TTY, root, /proc, network) not provided by sandbox. Usually harness-setup fix.
- **`unknown`**: Insufficient info; needs investigation.

## Per-Failure Details


### FAIL: tsort empty2

- **Source**: `tsort.tests`
- **Applet**: `tsort`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — runtime behavior differs from expected

```
FAIL: tsort empty2
============
echo "a a" | tsort >actual
ERROR: tsort exit 127, expected 0
ERROR: word a missing from output (a a)
ERROR: word a missing from output (a a)
ERROR: a appears after a (a a)
exit 127, actual:
FAIL: tsort singleton
============
echo "a b b c" | tsort >actual
ERROR: tsort exit 127, expected 0
```

---

### FAIL: tsort singleton

- **Source**: `tsort.tests`
- **Applet**: `tsort`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — runtime behavior differs from expected

```
FAIL: tsort singleton
============
echo "a b b c" | tsort >actual
ERROR: tsort exit 127, expected 0
ERROR: word a missing from output (a b b c)
ERROR: word b missing from output (a b b c)
ERROR: a appears after b (a b b c)
ERROR: word b missing from output (a b b c)
ERROR: word c missing from output (a b b c)
ERROR: b appears after c (a b b c)
exit 127, actual:
FAIL: tsort simple
```

---

### FAIL: tsort simple

- **Source**: `tsort.tests`
- **Applet**: `tsort`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — runtime behavior differs from expected

```
FAIL: tsort simple
============
echo "a a b b" | tsort >actual
ERROR: tsort exit 127, expected 0
ERROR: word a missing from output (a a b b)
ERROR: word a missing from output (a a b b)
ERROR: a appears after a (a a b b)
ERROR: word b missing from output (a a b b)
ERROR: word b missing from output (a a b b)
ERROR: b appears after b (a a b b)
exit 127, actual:
FAIL: tsort 2singleton
```

---

### FAIL: tsort 2singleton

- **Source**: `tsort.tests`
- **Applet**: `tsort`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — runtime behavior differs from expected

```
FAIL: tsort 2singleton
============
echo "a b a b b c" | tsort >actual
ERROR: tsort exit 127, expected 0
ERROR: word a missing from output (a b a b b c)
ERROR: word b missing from output (a b a b b c)
ERROR: a appears after b (a b a b b c)
ERROR: word a missing from output (a b a b b c)
ERROR: word b missing from output (a b a b b c)
ERROR: a appears after b (a b a b b c)
ERROR: word b missing from output (a b a b b c)
ERROR: word c missing from output (a b a b b c)
```

---

### FAIL: tsort medium

- **Source**: `tsort.tests`
- **Applet**: `tsort`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — runtime behavior differs from expected

```
FAIL: tsort medium
============
echo "a b c c d e g g f g e f h h" | tsort >actual
ERROR: tsort exit 127, expected 0
ERROR: word a missing from output (a b c c d e g g f g e f h h)
ERROR: word b missing from output (a b c c d e g g f g e f h h)
ERROR: a appears after b (a b c c d e g g f g e f h h)
ERROR: word c missing from output (a b c c d e g g f g e f h h)
ERROR: word c missing from output (a b c c d e g g f g e f h h)
ERROR: c appears after c (a b c c d e g g f g e f h h)
ERROR: word d missing from output (a b c c d e g g f g e f h h)
ERROR: word e missing from output (a b c c d e g g f g e f h h)
```

---

### FAIL: tsort std.example

- **Source**: `tsort.tests`
- **Applet**: `tsort`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — runtime behavior differs from expected

```
FAIL: tsort std.example
============
echo "a aa aa aaa aaaa aaaaa a aaaaa" | tsort >actual
ERROR: tsort exit 127, expected 0
ERROR: word a missing from output (a aa aa aaa aaaa aaaaa a aaaaa)
ERROR: word aa missing from output (a aa aa aaa aaaa aaaaa a aaaaa)
ERROR: a appears after aa (a aa aa aaa aaaa aaaaa a aaaaa)
ERROR: word aa missing from output (a aa aa aaa aaaa aaaaa a aaaaa)
ERROR: word aaa missing from output (a aa aa aaa aaaa aaaaa a aaaaa)
ERROR: aa appears after aaa (a aa aa aaa aaaa aaaaa a aaaaa)
ERROR: word aaaa missing from output (a aa aa aaa aaaa aaaaa a aaaaa)
ERROR: word aaaaa missing from output (a aa aa aaa aaaa aaaaa a aaaaa)
```

---

### FAIL: tsort prefixes

- **Source**: `tsort.tests`
- **Applet**: `tsort`
- **Classification**: `unknown`
- **Reason**: Needs investigation — insufficient diagnostic output to classify

```
FAIL: tsort prefixes
PASS: tsort odd
PASS: tsort odd2
PASS: tsort cycle
```


## Test Result Summary

```
UNTESTED: all_sourcecode.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: ar.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: ash.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: hexdump.tests (applet not available — neither in BusyBox config nor standalone fixture)
PASS: 
PASS:  -c EMPTY
UNTESTED: mdev.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: mkfs.minix.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: mount.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: parse.tests (applet not available — neither in BusyBox config nor standalone fixture)
PASS: 
PASS:  -c EMPTY
UNTESTED: sha3sum.tests (applet not available — neither in BusyBox config nor standalone fixture)
PASS: 
PASS:  -c EMPTY
UNTESTED: start-stop-daemon.tests (applet not available — neither in BusyBox config nor standalone fixture)
FAIL: tsort empty2
FAIL: tsort singleton
FAIL: tsort simple
FAIL: tsort 2singleton
FAIL: tsort medium
FAIL: tsort std.example
FAIL: tsort prefixes
PASS: tsort odd
PASS: tsort odd2
PASS: tsort cycle
UNTESTED: uncompress.tests (applet not available — neither in BusyBox config nor standalone fixture)
PASS: basename-does-not-remove-identical-extension
PASS: basename-works
PASS: bunzip2-removes-compressed-file
PASS: bunzip2-reads-from-standard-input
PASS: bzcat-does-not-remove-compressed-file
PASS: cat-prints-a-file
PASS: cat-prints-a-file-and-standard-input
PASS: cmp-detects-difference
PASS: cp-copies-small-file
PASS: cp-a-files-to-dir
PASS: cp-follows-links
PASS: cp-preserves-source-file
PASS: cp-copies-large-file
PASS: cp-copies-empty-file
PASS: cp-dev-file
PASS: cp-does-not-copy-unreadable-file
PASS: cp-RHL-does_not_preserve-links
PASS: cp-dir-create-dir
PASS: cp-preserves-hard-links
PASS: cp-preserves-links
PASS: cp-parents
PASS: cp-files-to-dir
PASS: cp-a-preserves-links
PASS: cp-dir-existing-dir
PASS: cp-d-files-to-dir
PASS: cut-cuts-an-open-range
PASS: cut-cuts-an-unclosed-range
PASS: cut-cuts-a-closed-range
PASS: cut-cuts-a-field
PASS: cut-cuts-a-character
PASS: date-u-works
PASS: date-timezone
PASS: date-R-works
PASS: date-works-1
PASS: date-format-works
PASS: date-works
PASS: date-@-works
PASS: dd-accepts-of
PASS: dd-copies-from-standard-input-to-standard-output
PASS: dd-count-bytes
PASS: dd-reports-write-errors
PASS: dd-prints-count-to-standard-error
PASS: dd-accepts-if
PASS: dirname-handles-relative-path
PASS: dirname-handles-empty-path
PASS: dirname-handles-absolute-path
PASS: dirname-handles-root
PASS: dirname-works
PASS: dirname-handles-multiple-slashes
PASS: dirname-handles-single-component
PASS: du-s-works
PASS: du-h-works
PASS: du-works
PASS: du-l-works
PASS: du-k-works
PASS: du-m-works
PASS: echo-prints-arguments
PASS: echo-does-not-print-newline
PASS: echo-prints-slash_0041
PASS: echo-prints-slash-zero
PASS: echo-prints-slash_00041
PASS: echo-prints-slash_041
PASS: echo-prints-non-opts
PASS: echo-prints-newline
PASS: echo-prints-dash
PASS: echo-prints-slash_41
PASS: echo-prints-argument
PASS: expr-big
PASS: expr-works
PASS: false-is-silent
PASS: false-returns-failure
PASS: find-supports-minus-xdev
PASS: gunzip-reads-from-standard-input
PASS: gzip-accepts-multiple-files
PASS: gzip-compression-levels
PASS: gzip-removes-original-file
PASS: gzip-accepts-single-minus
UNTESTED: hostid/hostid-works (applet not available — neither in BusyBox config nor standalone fixture)
PASS: hostname-d-works
PASS: hostname-works
PASS: hostname-i-works
PASS: hostname-s-works
PASS: id-u-works
PASS: id-g-works
PASS: id-ur-works
PASS: id-un-works
PASS: ln-force-creates-hard-links
PASS: ln-preserves-soft-links
PASS: ln-creates-hard-links
PASS: ln-preserves-hard-links
PASS: ln-creates-soft-links
PASS: ln-force-creates-soft-links
PASS: ls-s-works
PASS: ls-h-works
PASS: ls-1-works
PASS: ls-l-works
PASS: md5sum-verifies-non-binary-file
PASS: mkdir-makes-a-directory
PASS: mkdir-makes-parent-directories
PASS: mv-moves-empty-file
PASS: mv-moves-large-file
PASS: mv-moves-small-file
PASS: mv-moves-file
PASS: mv-preserves-links
PASS: mv-refuses-mv-dir-to-subdir
PASS: mv-moves-symlinks
PASS: mv-files-to-dir-2
PASS: mv-removes-source-file
PASS: mv-preserves-hard-links
PASS: mv-follows-links
PASS: mv-moves-hardlinks
PASS: mv-files-to-dir
PASS: mv-moves-unreadable-files
PASS: paste-pairs
PASS: paste-separate
PASS: paste-multi-stdin
PASS: paste-back-cuted-lines
PASS: paste
PASS: pwd-prints-working-directory
PASS: rm-removes-file
PASS: rmdir-removes-parent-directories
PASS: strings-works-like-GNU
PASS: tail-works
PASS: tail-n-works
PASS: tar_with_prefix_fields
PASS: tar-handles-multiple-X-options
PASS: tar-handles-empty-include-and-non-empty-exclude-list
PASS: tar-demands-at-most-one-ctx
PASS: tar-handles-cz-options
PASS: tar-extracts-from-standard-input
PASS: tar-extracts-all-subdirs
PASS: tar-handles-exclude-and-extract-lists
PASS: tar-demands-at-least-one-ctx
PASS: tar-extracts-multiple-files
PASS: tar-archives-multiple-files
PASS: tar-handles-nested-exclude
PASS: tar_with_link_with_size
PASS: tar-extracts-to-standard-output
PASS: tar-extracts-file
PASS: tar-complains-about-missing-file
PASS: tee-appends-input
PASS: tee-tees-input
PASS: touch-creates-file
PASS: touch-touches-files-after-non-existent-file
PASS: touch-does-not-create-file
PASS: tr-d-works
PASS: tr-non-gnu
PASS: tr-d-alnum-works
PASS: tr-works
PASS: tr-rejects-wrong-class
PASS: true-is-silent
PASS: true-returns-success
PASS: uptime-works
PASS: wc-counts-all
PASS: wc-prints-longest-line-length
PASS: wc-counts-words
PASS: wc-counts-lines
PASS: wc-counts-characters
UNTESTED: wget/wget-supports--P (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: wget/wget-handles-empty-path (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: wget/wget--O-overrides--P (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: wget/wget-retrieves-google-index (applet not available — neither in BusyBox config nor standalone fixture)
PASS: which-uses-default-path
PASS: xargs-works
```
