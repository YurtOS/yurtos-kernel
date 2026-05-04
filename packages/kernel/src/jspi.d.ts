/**
 * JSPI (JavaScript Promise Integration) type declarations.
 *
 * W3C Phase 4 standard — available in Node 25+ (unflagged), Chrome 137+.
 * Allows WASM to suspend/resume when host imports return Promises.
 */
declare namespace WebAssembly {
  /**
   * Wraps an async host function so that returning a Promise suspends the
   * WASM stack. The engine resumes the WASM stack when the Promise resolves.
   */
  class Suspending {
    constructor(fn: Function);
  }

  /**
   * Wraps a WASM export so that it returns a Promise when the WASM stack
   * has been suspended by a Suspending import.
   */
  function promising(fn: Function): (...args: unknown[]) => Promise<unknown>;
}
