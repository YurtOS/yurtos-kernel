import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fdErrorToWasi, vfsErrnoToWasi } from "../errors.js";
import {
  WASI_EACCES,
  WASI_EBADF,
  WASI_EEXIST,
  WASI_EIO,
  WASI_EISDIR,
  WASI_ENOENT,
  WASI_ENOSPC,
  WASI_ENOTDIR,
  WASI_ENOTEMPTY,
  WASI_EROFS,
} from "../types.js";

describe("vfsErrnoToWasi", () => {
  it("maps known VFS errnos to their WASI counterparts", () => {
    expect(vfsErrnoToWasi("ENOENT")).toBe(WASI_ENOENT);
    expect(vfsErrnoToWasi("EEXIST")).toBe(WASI_EEXIST);
    expect(vfsErrnoToWasi("ENOTDIR")).toBe(WASI_ENOTDIR);
    expect(vfsErrnoToWasi("EISDIR")).toBe(WASI_EISDIR);
    expect(vfsErrnoToWasi("ENOTEMPTY")).toBe(WASI_ENOTEMPTY);
    expect(vfsErrnoToWasi("EROFS")).toBe(WASI_EROFS);
    expect(vfsErrnoToWasi("EACCES")).toBe(WASI_EACCES);
    expect(vfsErrnoToWasi("ENOSPC")).toBe(WASI_ENOSPC);
  });

  it("falls back to EIO for unrecognized errnos", () => {
    // Cast intentional — exercise the default branch.
    expect(vfsErrnoToWasi("SOMETHING_NEW" as unknown as "ENOENT")).toBe(
      WASI_EIO,
    );
  });
});

describe("fdErrorToWasi", () => {
  it('maps Error messages starting with "EBADF" to WASI_EBADF', () => {
    expect(fdErrorToWasi(new Error("EBADF: bad fd 9"))).toBe(WASI_EBADF);
  });

  it("maps non-EBADF errors to WASI_EIO", () => {
    expect(fdErrorToWasi(new Error("something else"))).toBe(WASI_EIO);
  });

  it("does not match errors that merely contain EBADF mid-message", () => {
    expect(fdErrorToWasi(new Error("not EBADF something"))).toBe(WASI_EIO);
  });

  it("returns WASI_EIO for non-Error values", () => {
    expect(fdErrorToWasi("EBADF")).toBe(WASI_EIO);
    expect(fdErrorToWasi(undefined)).toBe(WASI_EIO);
    expect(fdErrorToWasi(null)).toBe(WASI_EIO);
    expect(fdErrorToWasi(42)).toBe(WASI_EIO);
  });
});
