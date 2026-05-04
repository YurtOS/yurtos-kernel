/**
 * NativeModuleRegistry — loads standalone WASM modules (native Python
 * extensions like numpy) and dispatches JSON-based RPC calls to them.
 *
 * Each module is fully self-contained with its own linear memory. The host
 * copies UTF-8 strings in via `__alloc` and reads results back from a
 * caller-provided output buffer.
 *
 * Expected WASM exports:
 *   __alloc(size: i32) -> i32          — allocate `size` bytes, return ptr
 *   __dealloc(ptr: i32, size: i32)     — optional, free previously allocated memory
 *   invoke(method_ptr, method_len, args_ptr, args_len, out_ptr, out_cap) -> i32
 *       positive return = bytes written to out_ptr
 *       negative return = negated required capacity (caller must retry with larger buffer)
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Initial output buffer capacity for invoke calls. */
const INITIAL_OUT_CAP = 4096;

interface LoadedModule {
  instance: WebAssembly.Instance;
  memory: WebAssembly.Memory;
}

export class NativeModuleRegistry {
  private modules: Map<string, LoadedModule> = new Map();

  /** Compile and instantiate a standalone WASM module with minimal WASI stubs. */
  async loadModule(name: string, wasmBytes: Uint8Array): Promise<void> {
    const compiled = await WebAssembly.compile(wasmBytes as BufferSource);

    // Determine whether the module imports memory from `env` or defines its own.
    const imports = WebAssembly.Module.imports(compiled);
    const needsMemory = imports.some(
      (i) => i.module === 'env' && i.name === 'memory' && i.kind === 'memory',
    );

    const memory = needsMemory ? new WebAssembly.Memory({ initial: 256 }) : undefined;

    const importObject = buildImportObject(imports, memory);
    const instance = await WebAssembly.instantiate(compiled, importObject);

    // Resolve the memory: either provided by host or exported by module.
    const resolvedMemory = memory ?? (instance.exports.memory as WebAssembly.Memory);
    if (!resolvedMemory) {
      throw new Error(
        `NativeModuleRegistry: module "${name}" neither imports nor exports memory`,
      );
    }

    this.modules.set(name, { instance, memory: resolvedMemory });
  }

  /** Check whether a module with the given name is loaded. */
  has(name: string): boolean {
    return this.modules.has(name);
  }

  /**
   * Invoke a method on a loaded module via JSON RPC.
   *
   * @returns The JSON response string from the module.
   * @throws If the module is not loaded or the invoke export is missing.
   */
  invoke(name: string, method: string, argsJson: string): string {
    const mod = this.modules.get(name);
    if (!mod) {
      throw new Error(`NativeModuleRegistry: module "${name}" not loaded`);
    }

    const exports = mod.instance.exports;
    const alloc = exports.__alloc as ((size: number) => number) | undefined;
    const dealloc = exports.__dealloc as ((ptr: number, size: number) => void) | undefined;
    const invokeFn = exports.invoke as (
      methodPtr: number,
      methodLen: number,
      argsPtr: number,
      argsLen: number,
      outPtr: number,
      outCap: number,
    ) => number;

    if (!alloc) {
      throw new Error(`NativeModuleRegistry: module "${name}" does not export __alloc`);
    }
    if (!invokeFn) {
      throw new Error(`NativeModuleRegistry: module "${name}" does not export invoke`);
    }

    // Encode method and args into module memory.
    const methodBytes = encoder.encode(method);
    const argsBytes = encoder.encode(argsJson);

    const methodPtr = alloc(methodBytes.byteLength);
    const argsPtr = alloc(argsBytes.byteLength);

    const heap = () => new Uint8Array(mod.memory.buffer);

    heap().set(methodBytes, methodPtr);
    heap().set(argsBytes, argsPtr);

    // Allocate an output buffer inside module memory.
    let outCap = INITIAL_OUT_CAP;
    let outPtr = alloc(outCap);

    let result = invokeFn(
      methodPtr,
      methodBytes.byteLength,
      argsPtr,
      argsBytes.byteLength,
      outPtr,
      outCap,
    );

    // Negative result means the buffer was too small; -result is the required capacity.
    if (result < 0) {
      const required = -result;
      if (dealloc) dealloc(outPtr, outCap);
      outCap = required;
      outPtr = alloc(outCap);
      result = invokeFn(
        methodPtr,
        methodBytes.byteLength,
        argsPtr,
        argsBytes.byteLength,
        outPtr,
        outCap,
      );
      if (result < 0) {
        throw new Error(
          `NativeModuleRegistry: module "${name}" invoke retry still insufficient ` +
          `(needed ${-result}, provided ${outCap})`,
        );
      }
    }

    // Free input buffers if dealloc is available.
    if (dealloc) {
      dealloc(methodPtr, methodBytes.byteLength);
      dealloc(argsPtr, argsBytes.byteLength);
    }

    const responseBytes = heap().slice(outPtr, outPtr + result);
    if (dealloc) dealloc(outPtr, outCap);

    return decoder.decode(responseBytes);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a complete import object for the module, providing WASI stubs and
 * optional env.memory. Only namespaces actually required by the module are
 * included.
 */
function buildImportObject(
  moduleImports: WebAssembly.ModuleImportDescriptor[],
  memory?: WebAssembly.Memory,
): WebAssembly.Imports {
  // Collect which namespaces the module actually needs.
  const namespaces = new Set(moduleImports.map((i) => i.module));

  const result: WebAssembly.Imports = {};

  if (namespaces.has('wasi_snapshot_preview1')) {
    result['wasi_snapshot_preview1'] = wasiStubs();
  }

  if (namespaces.has('env')) {
    const env: Record<string, WebAssembly.ImportValue> = {};
    if (memory) env.memory = memory;
    result['env'] = env;
  }

  return result;
}

/** Minimal WASI stubs — enough to let standalone WASM modules start up. */
function wasiStubs(): Record<string, (...args: number[]) => number | void> {
  return {
    proc_exit(_code: number): void {
      // no-op in sandbox context
    },

    fd_write(
      _fd: number,
      _iovs: number,
      _iovsLen: number,
      _nwritten: number,
    ): number {
      // Return ENOSYS (52) — not supported
      return 52;
    },

    fd_close(_fd: number): number {
      return 0;
    },

    fd_seek(
      _fd: number,
      _offsetLo: number,
      _offsetHi: number,
      _whence: number,
      _newOffset: number,
    ): number {
      return 52; // ENOSYS
    },

    fd_read(
      _fd: number,
      _iovs: number,
      _iovsLen: number,
      _nread: number,
    ): number {
      return 52; // ENOSYS
    },

    environ_get(_environ: number, _environBuf: number): number {
      return 0;
    },

    environ_sizes_get(_environCount: number, _environBufSize: number): number {
      return 0;
    },

    args_get(_argv: number, _argvBuf: number): number {
      return 0;
    },

    args_sizes_get(_argc: number, _argvBufSize: number): number {
      return 0;
    },

    clock_time_get(
      _clockId: number,
      _precision: number,
      _time: number,
    ): number {
      return 0;
    },

    random_get(_buf: number, _bufLen: number): number {
      return 0;
    },
  };
}
