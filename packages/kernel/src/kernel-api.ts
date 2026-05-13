import {
  readBytes,
  readString,
  writeBytes,
  writeString,
} from "./host-imports/common.js";
import type { VfsLike } from "./vfs/vfs-like.js";

export interface KernelApiProcessManager {
  registerTool(name: string, impl: unknown): void;
  registerAndLoadTool(name: string, path: string): Promise<void>;
  registerNativeModule(name: string, wasmBytes: Uint8Array): Promise<void>;
  hasTool(name: string): boolean;
}

export interface KernelApiTime {
  /** Wall clock seconds since epoch. */
  now(): number;
  /** Monotonic nanoseconds. */
  monotonic(): bigint;
}

export interface KernelApiMemory {
  readString(ptr: number, len: number): string;
  readBytes(ptr: number, len: number): Uint8Array;
  writeString(s: string, outPtr: number, outCap: number): number;
  writeBytes(b: Uint8Array, outPtr: number, outCap: number): number;
}

export interface KernelApi {
  vfs: VfsLike;
  processManager: KernelApiProcessManager;
  time: KernelApiTime;
  memory: KernelApiMemory;
}

export class MemoryProxy implements KernelApiMemory {
  current: WebAssembly.Memory | undefined;

  private require(): WebAssembly.Memory {
    if (!this.current) {
      throw new Error("KernelApi.memory not yet bound (memory not yet bound)");
    }
    return this.current;
  }

  readString(ptr: number, len: number): string {
    return readString(this.require(), ptr, len);
  }

  readBytes(ptr: number, len: number): Uint8Array {
    return readBytes(this.require(), ptr, len);
  }

  writeString(s: string, outPtr: number, outCap: number): number {
    return writeString(this.require(), outPtr, outCap, s);
  }

  writeBytes(b: Uint8Array, outPtr: number, outCap: number): number {
    return writeBytes(this.require(), outPtr, outCap, b);
  }
}
