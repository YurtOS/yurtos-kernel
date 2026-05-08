# ncurses Core Fixture Design

## Goal

Port a real terminal capability library for the source-built userspace fixture set, then link zsh against it instead of the current zsh-local termcap stubs.

## Boundary

`termcap`, `terminfo`, and `curses` are userspace libraries. They should not live in the Yurt kernel or ABI runtime unless they uncover missing POSIX primitives that programs need from the kernel. The kernel remains responsible for terminal and process primitives such as file descriptors, `ioctl(TIOCGWINSZ)`, signals, process groups, and tty behavior.

## Approach

Add an ncurses source port under `test-fixtures/c-ports/ncurses`. Build upstream ncurses with `yurt-cc` for `wasm32-wasi`, install headers and static libraries into a fixture-local sysroot under `test-fixtures/c-ports/ncurses/build/install`, and update the zsh fixture to use those headers and libraries.

Prefer building the real ncurses `tinfo`/termcap/terminfo surface first. Full screen/window curses behavior can be enabled as the port supports it, but the first compatibility target is the API surface zsh and shell tests use: `setupterm`, `tiget*`, `tget*`, `tparm`, `tgoto`, `tputs`, `putp`, and related headers.

## Failure Policy

When ncurses fails to configure or build, treat it as a POSIX compatibility probe. Fix Yurt libc/kernel gaps when the failure points at a missing or incorrect primitive. Only patch ncurses fixture build files for cross-compilation mechanics, path wiring, or unsupported optional ncurses features that are outside the kernel goal.

## Tests

Add a small ncurses/termcap canary built against the installed fixture library. Keep zsh smoke tests linked against ncurses rather than fixture stubs. Generated wasm artifacts remain ignored and are copied into kernel test fixtures only by the fixture build targets.
