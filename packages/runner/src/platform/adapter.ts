/**
 * Platform adapter interface for loading and instantiating WebAssembly modules.
 *
 * Abstracts the differences between Node.js (filesystem) and browser (fetch)
 * environments so the kernel can run in both without platform checks.
 */

export interface PlatformAdapter {
  /** Load a .wasm module from a path (Node: filesystem) or URL (Browser: fetch). */
  loadModule(pathOrUrl: string): Promise<WebAssembly.Module>;

  /**
   * Read raw bytes from a path (Node: filesystem) or URL (Browser: fetch).
   * Used to install host-side artifacts (e.g. the shell wasm) into the VFS.
   */
  readBytes(pathOrUrl: string): Promise<Uint8Array>;

  /** Instantiate a module with the given import object. */
  instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance>;

  /**
   * Scan a directory (Node) or URL base (browser) for .wasm tool binaries.
   * Returns a map of tool name → wasm path/URL.
   * Excludes shell parser and python binaries (registered separately).
   */
  scanTools(wasmDir: string): Promise<Map<string, string>>;

  /**
   * Read a binary asset from the same location scanTools resolves.  Used
   * to pre-populate the VFS with sidecar data files that ports need —
   * e.g. file/libmagic's `magic.mgc`.  Returns null if the file isn't
   * present (callers treat the data file as optional).
   */
  readDataFile?(wasmDir: string, name: string): Promise<Uint8Array | null>;

  /** Whether the platform supports Worker-based execution (hard kill). */
  supportsWorkerExecution?: boolean;
}
