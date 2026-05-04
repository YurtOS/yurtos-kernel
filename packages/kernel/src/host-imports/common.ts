/**
 * Buffer read/write helpers for WASM linear memory.
 *
 * These utilities are shared by host import modules.
 * They handle the low-level task of moving strings, JSON, and raw bytes
 * between the TypeScript host and the WASM guest's linear memory.
 */

/**
 * Read a UTF-8 string from WASM linear memory.
 */
export function readString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  const bytes = new Uint8Array(memory.buffer, ptr, len);
  return new TextDecoder().decode(bytes);
}

/**
 * Read raw bytes from WASM linear memory.
 * Returns a copy (not a view) so the data survives memory growth.
 */
export function readBytes(memory: WebAssembly.Memory, ptr: number, len: number): Uint8Array {
  return new Uint8Array(memory.buffer, ptr, len).slice();
}

/**
 * Write a JSON-serialized object into the WASM output buffer.
 * Returns bytes written on success, or the required size if the buffer
 * is too small (caller should allocate a larger buffer and retry).
 */
export function writeJson(memory: WebAssembly.Memory, ptr: number, cap: number, obj: unknown): number {
  const json = JSON.stringify(obj);
  const encoded = new TextEncoder().encode(json);
  if (encoded.length > cap) {
    return encoded.length; // signal "need more space"
  }
  new Uint8Array(memory.buffer, ptr, encoded.length).set(encoded);
  return encoded.length;
}

/**
 * Write a UTF-8 string into the WASM output buffer.
 * Returns bytes written on success, or the required size if the buffer
 * is too small.
 */
export function writeString(memory: WebAssembly.Memory, ptr: number, cap: number, s: string): number {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length > cap) {
    return encoded.length;
  }
  new Uint8Array(memory.buffer, ptr, encoded.length).set(encoded);
  return encoded.length;
}

/**
 * Write raw bytes into the WASM output buffer.
 * Returns bytes written on success, or the required size if the buffer
 * is too small.
 */
export function writeBytes(memory: WebAssembly.Memory, ptr: number, cap: number, data: Uint8Array): number {
  if (data.length > cap) {
    return data.length;
  }
  new Uint8Array(memory.buffer, ptr, data.length).set(data);
  return data.length;
}
