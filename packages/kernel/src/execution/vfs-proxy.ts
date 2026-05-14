/**
 * Worker-side VFS proxy that relays filesystem calls through a SharedArrayBuffer.
 *
 * Each method encodes a request into the SAB and signals the main thread.
 * Synchronous VfsLike methods keep the legacy blocking path; explicit *Async
 * methods use Atomics.waitAsync so threaded guest workers can keep pumping
 * dispatcher messages while WASI path imports are suspended.
 * In tests, a synchronous handler can be injected to avoid real Atomics.wait.
 */

import {
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  STATUS_ERROR,
  STATUS_IDLE,
  STATUS_REQUEST,
  STATUS_RESPONSE,
} from "./proxy-protocol.js";
import { VfsError } from "../vfs/inode.js";
import type { DirEntry, Errno, StatResult } from "../vfs/inode.js";

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
  readonly isAsyncVfs = true;
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
   * Send a proxy call to the main thread and wait until the response arrives.
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
    this.sendCall(op, params, binary);
    if (!this.testHandler && !this.skipAtomicsWait) {
      Atomics.wait(this.int32, 0, STATUS_REQUEST);
    }
    return this.decodeCallResponse();
  }

  private async callAsync(
    op: string,
    params: Record<string, unknown>,
    binary?: Uint8Array,
  ): Promise<{ metadata: Record<string, unknown>; binary: Uint8Array | null }> {
    this.sendCall(op, params, binary);
    if (!this.testHandler && !this.skipAtomicsWait) {
      await this.waitForResponse();
    }
    return this.decodeCallResponse();
  }

  private sendCall(
    op: string,
    params: Record<string, unknown>,
    binary?: Uint8Array,
  ): void {
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
      // Production mode: signal the main thread and yield until response.
      Atomics.store(this.int32, 0, STATUS_REQUEST);
      this.parentPort?.postMessage("proxy-request");
    }
  }

  private async waitForResponse(): Promise<void> {
    const wait = Atomics.waitAsync(this.int32, 0, STATUS_REQUEST);
    if (wait.async) {
      await wait.value;
    }
  }

  private decodeCallResponse(): {
    metadata: Record<string, unknown>;
    binary: Uint8Array | null;
  } {
    // Check the response status
    const status = Atomics.load(this.int32, 0);

    if (status === STATUS_ERROR) {
      const { metadata } = decodeResponse(this.sab);
      Atomics.store(this.int32, 0, STATUS_IDLE);
      const code = (metadata.code as string) || "ENOENT";
      const message = (metadata.message as string) || "unknown error";
      throw new VfsError(code as Errno, message);
    }

    const response = decodeResponse(this.sab);
    Atomics.store(this.int32, 0, STATUS_IDLE);
    return response;
  }

  // ---- VFS methods ----

  readFile(path: string): Uint8Array {
    const response = this.call("readFile", { path });
    return response.binary ?? new Uint8Array(0);
  }

  async readFileAsync(path: string): Promise<Uint8Array> {
    const { binary } = await this.callAsync("readFile", { path });
    return binary ?? new Uint8Array(0);
  }

  writeFile(path: string, data: Uint8Array): void {
    this.call("writeFile", { path }, data);
  }

  async writeFileAsync(path: string, data: Uint8Array): Promise<void> {
    await this.callAsync("writeFile", { path }, data);
  }

  stat(path: string): StatResult {
    const response = this.call("stat", { path });
    return this.statFromMetadata(response.metadata);
  }

  async statAsync(path: string): Promise<StatResult> {
    const { metadata } = await this.callAsync("stat", { path });
    return this.statFromMetadata(metadata);
  }

  private statFromMetadata(metadata: Record<string, unknown>): StatResult {
    return {
      type: metadata.type as StatResult["type"],
      size: metadata.size as number,
      permissions: metadata.permissions as number,
      uid: metadata.uid as number,
      gid: metadata.gid as number,
      mtime: new Date(metadata.mtime as string),
      ctime: new Date(metadata.ctime as string),
      atime: new Date(metadata.atime as string),
    };
  }

  lstat(path: string): StatResult {
    const response = this.call("lstat", { path });
    return this.statFromMetadata(response.metadata);
  }

  async lstatAsync(path: string): Promise<StatResult> {
    const { metadata } = await this.callAsync("lstat", { path });
    return this.statFromMetadata(metadata);
  }

  readdir(path: string): DirEntry[] {
    const response = this.call("readdir", { path });
    return response.metadata.entries as DirEntry[];
  }

  async readdirAsync(path: string): Promise<DirEntry[]> {
    const { metadata } = await this.callAsync("readdir", { path });
    return metadata.entries as DirEntry[];
  }

  mkdir(path: string): void {
    this.call("mkdir", { path });
  }

  async mkdirAsync(path: string): Promise<void> {
    await this.callAsync("mkdir", { path });
  }

  mkdirp(path: string): void {
    this.call("mkdirp", { path });
  }

  async mkdirpAsync(path: string): Promise<void> {
    await this.callAsync("mkdirp", { path });
  }

  unlink(path: string): void {
    this.call("unlink", { path });
  }

  async unlinkAsync(path: string): Promise<void> {
    await this.callAsync("unlink", { path });
  }

  rmdir(path: string): void {
    this.call("rmdir", { path });
  }

  async rmdirAsync(path: string): Promise<void> {
    await this.callAsync("rmdir", { path });
  }

  rename(oldPath: string, newPath: string): void {
    this.call("rename", { oldPath, newPath });
  }

  async renameAsync(oldPath: string, newPath: string): Promise<void> {
    await this.callAsync("rename", { oldPath, newPath });
  }

  chmod(path: string, mode: number): void {
    this.call("chmod", { path, mode });
  }

  async chmodAsync(path: string, mode: number): Promise<void> {
    await this.callAsync("chmod", { path, mode });
  }

  chown(
    path: string,
    uid: number,
    gid: number,
    followSymlinks = true,
  ): void {
    this.call("chown", { path, uid, gid, followSymlinks });
  }

  async chownAsync(
    path: string,
    uid: number,
    gid: number,
    followSymlinks = true,
  ): Promise<void> {
    await this.callAsync("chown", { path, uid, gid, followSymlinks });
  }

  symlink(target: string, path: string): void {
    this.call("symlink", { target, path });
  }

  async symlinkAsync(target: string, path: string): Promise<void> {
    await this.callAsync("symlink", { target, path });
  }

  readlink(path: string): string {
    const response = this.call("readlink", { path });
    return response.metadata.target as string;
  }

  async readlinkAsync(path: string): Promise<string> {
    const { metadata } = await this.callAsync("readlink", { path });
    return metadata.target as string;
  }

  /** Run a callback — on the proxy side this is a no-op pass-through. */
  withWriteAccess(fn: () => void): void {
    fn();
  }
}
