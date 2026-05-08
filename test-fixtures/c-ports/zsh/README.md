# zsh fixture port

This directory builds upstream zsh as a Yurt source-built fixture. The checked-in
inputs are the build recipe and local patches only; `src/`, `build/`, and copied
`.wasm` artifacts are generated.

The first target is the non-interactive shell core:

```sh
make -C test-fixtures/c-ports/zsh copy-fixtures
```

The build uses `yurt-cc` with continuation support so zsh can exercise the same
fork/exec/wait process path as other real shell fixtures. Terminal capability
support comes from the ncurses source fixture in `../ncurses`, not from local
termcap/curses stubs.
