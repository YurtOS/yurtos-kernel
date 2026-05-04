/**
 * Worker-side VFS proxy that relays filesystem calls through a SharedArrayBuffer.
 *
 * Each method encodes a request into the SAB, signals the main thread,
 * and blocks (via Atomics.wait) until the response arrives.
 * In tests, a synchronous handler can be injected to avoid real Atomics.wait.
 */

import {
  STATUS_IDLE,
  STATUS_REQUEST,
  STATUS_RESPONSE,
  STATUS_ERROR,
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
} from './proxy-protocol.js';
import { VfsError } from '../vfs/inode.js';
import type { StatResult, DirEntry, Errno } from '../vfs/inode.js';

export interface TestHandlerResult {
  metadata: Record<string, unknown>;
  binary?: Uint8Array;
  isError?: boolean;
}

export type TestHandler = (
  metadata: Record<string, unknown>,
  binary: Uint8Array | null,
) => TestHandlerResult;

export interface VfsProxyOptions {
  /** Skip Atomics.wait — used in tests with a synchronous handler. */
  skipAtomicsWait?: boolean;
  /** Worker parentPort for signaling the main thread. */
  parentPort?: { postMessage(msg: unknown): void };
}

export class VfsProxy {
  private sab: SharedArrayBuffer;
  private int32: Int32Array;
  private skipAtomicsWait: boolean;
  private parentPort: { postMessage(msg: unknown): void } | undefined;
  private testHandler: TestHandler | null = null;

  constructor(sab: SharedArrayBuffer, options?: VfsProxyOptions) {
    this.sab = sab;
    this.int32 = new Int32Array(sab);
    this.skipAtomicsWait = options?.skipAtomicsWait ?? false;
    this.parentPort = options?.parentPort;
  }

  /** Install a synchronous handler for testing (bypasses Atomics.wait). */
  _setTestHandler(handler: TestHandler): void {
    this.testHandler = handler;
  }

  /**
   * Send a proxy call to the main thread and block until the response arrives.
   *
   * @param op     - The VFS operation name (e.g. 'readFile', 'stat')
   * @param params - Additional parameters for the operation
   * @param binary - Optional binary payload (e.g. file content for writeFile)
   * @returns The decoded response metadata and optional binary data
   */
  private call(
    op: string,
    params: Record<string, unknown>,
    binary?: Uint8Array,
  ): { metadata: Record<string, unknown>; binary: Uint8Array | null } {
    // Encode the request into the SAB
    encodeRequest(this.sab, { op, ...params }, binary);

    if (this.testHandler) {
      // In test mode: decode the request, invoke the handler, write response back
      const req = decodeRequest(this.sab);
      const result = this.testHandler(req.metadata, req.binary);

      if (result.isError) {
        encodeResponse(this.sab, result.metadata, result.binary);
        Atomics.store(this.int32, 0, STATUS_ERROR);
      } else {
        encodeResponse(this.sab, result.metadata, result.binary);
        Atomics.store(this.int32, 0, STATUS_RESPONSE);
      }
    } else {
      // Production mode: signal the main thread and block until response
      Atomics.store(this.int32, 0, STATUS_REQUEST);
      this.parentPort?.postMessage('proxy-request');

      if (!this.skipAtomicsWait) {
        // Block until status changes from STATUS_REQUEST
        Atomics.wait(this.int32, 0, STATUS_REQUEST);
      }
    }

    // Check the response status
    const status = Atomics.load(this.int32, 0);

    if (status === STATUS_ERROR) {
      const { metadata } = decodeResponse(this.sab);
      Atomics.store(this.int32, 0, STATUS_IDLE);
      const code = (metadata.code as string) || 'ENOENT';
      const message = (metadata.message as string) || 'unknown error';
      throw new VfsError(code as Errno, message);
    }

    const response = decodeResponse(this.sab);
    Atomics.store(this.int32, 0, STATUS_IDLE);
    return response;
  }

  // ---- VFS methods ----

  readFile(path: string): Uint8Array {
    const { binary } = this.call('readFile', { path });
    return binary ?? new Uint8Array(0);
  }

  writeFile(path: string, data: Uint8Array): void {
    this.call('writeFile', { path }, data);
  }

  stat(path: string): StatResult {
    const { metadata } = this.call('stat', { path });
    return {
      type: metadata.type as StatResult['type'],
      size: metadata.size as number,
      permissions: metadata.permissions as number,
      mtime: new Date(metadata.mtime as string),
      ctime: new Date(metadata.ctime as string),
      atime: new Date(metadata.atime as string),
    };
  }

  lstat(path: string): StatResult {
    const { metadata } = this.call('lstat', { path });
    return {
      type: metadata.type as StatResult['type'],
      size: metadata.size as number,
      permissions: metadata.permissions as number,
      mtime: new Date(metadata.mtime as string),
      ctime: new Date(metadata.ctime as string),
      atime: new Date(metadata.atime as string),
    };
  }

  readdir(path: string): DirEntry[] {
    const { metadata } = this.call('readdir', { path });
    return metadata.entries as DirEntry[];
  }

  mkdir(path: string): void {
    this.call('mkdir', { path });
  }

  mkdirp(path: string): void {
    this.call('mkdirp', { path });
  }

  unlink(path: string): void {
    this.call('unlink', { path });
  }

  rmdir(path: string): void {
    this.call('rmdir', { path });
  }

  rename(oldPath: string, newPath: string): void {
    this.call('rename', { oldPath, newPath });
  }

  chmod(path: string, mode: number): void {
    this.call('chmod', { path, mode });
  }

  symlink(target: string, path: string): void {
    this.call('symlink', { target, path });
  }

  readlink(path: string): string {
    const { metadata } = this.call('readlink', { path });
    return metadata.target as string;
  }

  /** Run a callback — on the proxy side this is a no-op pass-through. */
  withWriteAccess(fn: () => void): void {
    fn();
  }
}
