# ncurses fixture port

This directory builds upstream ncurses as a Yurt source-built userspace fixture.
It is intentionally not part of the kernel ABI runtime: terminal capability and
curses libraries are userspace packages. Build failures here are useful POSIX
compatibility probes for the Yurt kernel/libc layer.

```sh
make -C test-fixtures/c-ports/ncurses install
```

The install tree is generated under `build/install` and is not checked in.
The recipe prefers Homebrew's newer ncurses host tools on macOS, and falls back
to `/usr/bin/tic` / `/usr/bin/infocmp` or `PATH` tools on Linux.
