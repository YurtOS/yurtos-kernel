# BusyBox Upstream Testsuite on Yurt — 2026-05-06

**Runner**: `scripts/run-busybox-testsuite-in-sandbox.ts`
**Runtime backend**: `deno-cooperative`
**Elapsed**: 268.3s
**BusyBox binary**: `test-fixtures/c-ports/busybox/build/busybox.wasm`
**Sandbox fixtures**: `packages/kernel/src/platform/__tests__/fixtures/`

## Important Context: BusyBox Build Scope

The BusyBox binary in the yurt fixtures is built from upstream BusyBox with Yurt's .config. The runner treats enabled BusyBox applets and standalone Yurt fixtures as available test targets; tests for applets that neither source provides are reported as UNTESTED, matching the upstream testsuite's "applet not available" behavior.

Host-baseline failures are checked against a pristine BusyBox 1.37.0 build on arm64 Linux and reported as XFAIL rather than Yurt regressions.

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
| PASS | 527 |
| FAIL | 0 |
| XFAIL | 4 |
| SKIP | 68 |
| UNTESTED | 6 |
| **Total** | **605** |
| Timed out / crashed | 1 |
| Unexpected timed out / crashed | 0 |

### Failure breakdown

| Classification | Count |
|---|---|
| `host-baseline` | 3 |
| `needs-fork` | 0 |
| `preemptive-backend` | 1 |
| `runtime-gap` | 0 |
| `test-env` | 0 |
| `unknown` | 0 |

**Exit policy**: no Yurt-only failures. 4 expected failure(s) are reported as XFAIL. Exiting 0.

## Classification Key

- **`host-baseline`**: Reproduces on pristine BusyBox 1.37.0 on Linux. Not counted as a Yurt-only regression.
- **`needs-fork`**: Genuine §Non-Goals per spec lines 76–88 (`fork()`/`execve()`/job control). Legit skip.
- **`preemptive-backend`**: Requires an engine that can interrupt guest wasm while it is not calling host imports. The current cooperative Deno runner cannot prove this; a Wasmtime epoch-interruption runner should require it to pass.
- **`runtime-gap`**: Yurt should support this, currently doesn't. Tracked follow-up needed.
- **`test-env`**: Test expects specific env (TTY, root, /proc, network) not provided by sandbox. Usually harness-setup fix.
- **`unknown`**: Insufficient info; needs investigation.

## Per-Failure Details


### XFAIL: ash ash-heredoc/heredoc_backslash1.tests

- **Source**: `ash/ash-heredoc/heredoc_backslash1.tests`
- **Applet**: `ash`
- **Classification**: `host-baseline`
- **Reason**: Reproduces on pristine BusyBox 1.37.0 ash on arm64 Linux; not a Yurt-only regression.

```
FAIL: ash ash-heredoc/heredoc_backslash1.tests
expected:
Quoted heredoc:
a\
	b
a\\
	b
 123456 -$a-\t-\\-\"-\'-\`-\--\z-\*-\?-
	-$a-\t-\\-\"-\'-\`-\--\z-\*-\?-
 123456 `echo  v'-$a-\t-\\-\"-\'-\`-\--\z-\*-\?-'`
 123456 $(echo v'-$a-\t-\\-\"-\'-\`-\--\z-\*-\?-')
c\
```

---

### XFAIL: ash ash-heredoc/heredoc_bkslash_newline2.tests

- **Source**: `ash/ash-heredoc/heredoc_bkslash_newline2.tests`
- **Applet**: `ash`
- **Classification**: `host-baseline`
- **Reason**: Reproduces on pristine BusyBox 1.37.0 ash on arm64 Linux; not a Yurt-only regression.

```
FAIL: ash ash-heredoc/heredoc_bkslash_newline2.tests
expected:
Ok1
actual:
Ok1
EOF
```

---

### XFAIL: ash ash-quoting/bkslash_in_varexp.tests

- **Source**: `ash/ash-quoting/bkslash_in_varexp.tests`
- **Applet**: `ash`
- **Classification**: `host-baseline`
- **Reason**: Reproduces on BusyBox ash on arm64 Linux: libc fnmatch("[a\]]") matches "]" and "a", not "a]". Not a Yurt-only regression.

```
FAIL: ash ash-quoting/bkslash_in_varexp.tests
expected:
Nothing:
Nothing:
Nothing:
Nothing:
Ok:0
actual:
Nothing:]
Nothing:]
Nothing:a
Nothing:a
```

---

### XFAIL: ash/ash-signals/continue_and_trap1.tests (TIMEOUT/CRASH)

- **Source**: `ash/ash-signals/continue_and_trap1.tests`
- **Applet**: `ash`
- **Classification**: `preemptive-backend`
- **Reason**: Requires a backend that can preempt guest wasm without cooperative host imports. Expected to pass on a Wasmtime epoch-interruption backend.

```
FAIL: ash/ash-signals/continue_and_trap1.tests (TIMEOUT/CRASH)

```


## Test Result Summary

```
UNTESTED: all_sourcecode.tests (applet not available — neither in BusyBox config nor standalone fixture)
SKIPPED: awk -F '[#]' '{ print NF }'
SKIPPED: awk -F '[#]' '{ print NF }'
SKIPPED: awk -F '[#]' '{ print NF }'
SKIPPED: awk -F '[#]' '{ print NF }'
SKIPPED: awk -F '[#]' '{ print NF }'
SKIPPED: awk -F '[#]' '{ print NF }'
SKIPPED: awk -F '[#]' '{ print NF }'
SKIPPED: awk -F '[#]' '{ print NF }'
SKIPPED: awk 'BEGIN{if(23==23) print "foo"}'
SKIPPED: awk 'BEGIN{if(23!=23) print "bar"}'
SKIPPED: awk 'BEGIN{if(23>=23) print "foo"}'
SKIPPED: awk 'BEGIN{if(2 < 13) print "foo"}'
SKIPPED: awk 'BEGIN{if("a"=="ab") print "bar"}'
SKIPPED: awk ' print or(4294967295' SKIPPED: awk '1) '
SKIPPED: cal 1 2000
SKIPPED: comm input -
SKIPPED: comm - input
SKIPPED: comm input -
SKIPPED: comm - input
SKIPPED: comm input -
SKIPPED: comm - input
SKIPPED: comm input -
SKIPPED: comm - input
SKIPPED: cp
SKIPPED: \
SKIPPED: \
SKIPPED: \
SKIPPED: \
SKIPPED: \
SKIPPED: \
SKIPPED: \
SKIPPED: \
UNTESTED: makedevs.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: mdev.tests (applet not available — neither in BusyBox config nor standalone fixture)
SKIPPED: mkfs.minix.tests (filesystem image construction is not a YurtOS kernel/runtime compatibility target)
UNTESTED: mount.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: parse.tests (applet not available — neither in BusyBox config nor standalone fixture)
SKIPPED: readlink ./readlink_testdir/testfile
SKIPPED: readlink ./testlink
SKIPPED: readlink -f ./readlink_testdir/testfile
SKIPPED: readlink -f ./testlink
SKIPPED: readlink -f ./readlink_testdir/readlink_testdir/testlink
SKIPPED: readlink -f readlink_testdir/../readlink_testdir/testfile
SKIPPED: realpath /not_file
SKIPPED: realpath /not_file/
SKIPPED: realpath //not_file
SKIPPED: realpath /not_dir/not_file 2>&1
SKIPPED: realpath realpath_testdir/not_file
SKIPPED: realpath realpath_testdir/not_dir/not_file 2>&1
SKIPPED: realpath link1
SKIPPED: realpath link2 2>&1
SKIPPED: realpath ./link1
SKIPPED: realpath ./link2 2>&1
UNTESTED: rx.tests (applet not available — neither in BusyBox config nor standalone fixture)
SKIPPED: sed ""
SKIPPED: sed "" -
SKIPPED: sed -e 's/$/@/'
SKIPPED: sed "" - -
SKIPPED: sed -e '1 d'
SKIPPED: sed -e 'i\
SKIPPED: seq 2> /dev/null || echo yes
SKIPPED: sort
SKIPPED: sort input
SKIPPED: sort
SKIPPED: sort -n input
SKIPPED: taskset -p 1 >/dev/null;echo $?
SKIPPED: taskset -p 0 >/dev/null 2>&1;echo $?
SKIPPED: 
SKIPPED: 
SKIPPED: 
SKIPPED: tsort input
SKIPPED: 
SKIPPED: tsort
SKIPPED: tsort
SKIPPED: tsort
SKIPPED: tsort
SKIPPED: tsort
PASS: tsort empty2
PASS: tsort singleton
PASS: tsort simple
PASS: tsort 2singleton
PASS: tsort medium
PASS: tsort std.example
PASS: tsort prefixes
PASS: tsort odd
PASS: tsort odd2
PASS: tsort cycle
SKIPPED: 
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
PASS: hostid-works
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
```
