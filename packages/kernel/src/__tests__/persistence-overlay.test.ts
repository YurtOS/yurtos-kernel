import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { VFS } from "../vfs/vfs.js";
import { OverlayVFS } from "../vfs/overlay-vfs.js";
import { MemoryRoot } from "../vfs/__tests__/helpers.js";
import { exportState, importState } from "../persistence/serializer.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function buildBase(id: string): MemoryRoot {
  const base = new MemoryRoot(id);
  base.addDir("/home/user", { uid: 1000, gid: 1000, permissions: 0o755 });
  base.addFile("/home/user/keep.txt", "base-keep", {
    uid: 1000,
    gid: 1000,
    permissions: 0o644,
  });
  base.addFile("/home/user/drop.txt", "base-drop", {
    uid: 1000,
    gid: 1000,
    permissions: 0o644,
  });
  return base;
}

/**
 * Behavioural tests for serializer ↔ overlay integration. The OverlayVFS
 * unit suite covers in-memory overlay operations; this file targets the
 * persistence serializer's overlay branch — round-trips, cross-base
 * rejection, and behaviour on VFS targets that don't support overlays.
 */
describe("Persistence serializer — OverlayVFS round-trip", () => {
  it("preserves whiteouts and upper writes across export/import", () => {
    const vfs = new OverlayVFS({
      base: buildBase("base:v1"),
      upper: new VFS(),
    });
    vfs.unlink("/home/user/drop.txt"); // creates whiteout
    vfs.writeFile("/home/user/new.txt", enc.encode("upper-new"));

    const blob = exportState(vfs);

    const restored = new OverlayVFS({
      base: buildBase("base:v1"),
      upper: new VFS(),
    });
    importState(restored, blob);

    expect(dec.decode(restored.readFile("/home/user/keep.txt"))).toBe(
      "base-keep",
    );
    expect(() => restored.readFile("/home/user/drop.txt")).toThrow(/ENOENT/);
    expect(dec.decode(restored.readFile("/home/user/new.txt"))).toBe(
      "upper-new",
    );
  });

  it("rejects an import whose baseId differs from the target overlay", () => {
    const vfs = new OverlayVFS({
      base: buildBase("base:v1"),
      upper: new VFS(),
    });
    vfs.writeFile("/home/user/upper.txt", enc.encode("hi"));
    const blob = exportState(vfs);

    const target = new OverlayVFS({
      base: buildBase("base:v2"),
      upper: new VFS(),
    });
    expect(() => importState(target, blob)).toThrow(/base id mismatch/);
  });

  it("rejects an overlay blob when the target VFS has no overlay support", () => {
    const vfs = new OverlayVFS({
      base: buildBase("base:v1"),
      upper: new VFS(),
    });
    vfs.writeFile("/home/user/upper.txt", enc.encode("hi"));
    const blob = exportState(vfs);

    const plain = new VFS();
    expect(() => importState(plain, blob)).toThrow(
      /target VFS does not support overlays/,
    );
  });

  it("non-overlay blob (includeBase) imports cleanly into a plain VFS", () => {
    const source = new OverlayVFS({
      base: buildBase("base:v1"),
      upper: new VFS(),
    });
    source.writeFile("/home/user/hi.txt", enc.encode("hello"));

    // includeBase: true elides the overlay metadata so the blob is just a
    // flat tree dump that any VfsLike target can absorb. /home/user is
    // already under SAFE_IMPORT_PREFIXES, so no allowSystemPaths needed.
    const blob = exportState(source, undefined, { includeBase: true });

    const target = new VFS();
    importState(target, blob);
    expect(dec.decode(target.readFile("/home/user/hi.txt"))).toBe("hello");
  });
});
