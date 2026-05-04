/**
 * SharedArrayBuffer layout and encode/decode helpers for the VFS proxy protocol.
 *
 * Layout (32 MB total):
 *   [0-3]    Int32   status: IDLE=0, REQUEST=1, RESPONSE=2, ERROR=3
 *   [4-7]    Int32   metadata length (JSON bytes)
 *   [8-11]   Int32   binary data length (raw bytes)
 *   [12..]   Uint8   JSON metadata (UTF-8)
 *   [12+N..] Uint8   binary payload (raw file content, no base64)
 */

export const SAB_SIZE = 32 * 1024 * 1024; // 32 MB

export const STATUS_IDLE = 0;
export const STATUS_REQUEST = 1;
export const STATUS_RESPONSE = 2;
export const STATUS_ERROR = 3;

/** Byte offset where metadata/binary payload begins. */
export const METADATA_OFFSET = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Write a request (metadata JSON + optional binary) into the SAB. */
export function encodeRequest(
  sab: SharedArrayBuffer,
  metadata: Record<string, unknown>,
  binary?: Uint8Array,
): void {
  const int32 = new Int32Array(sab);
  const uint8 = new Uint8Array(sab);

  const jsonBytes = encoder.encode(JSON.stringify(metadata));
  const binLen = binary?.byteLength ?? 0;
  const totalNeeded = METADATA_OFFSET + jsonBytes.byteLength + binLen;
  if (totalNeeded > sab.byteLength) {
    throw new Error(`SAB overflow: need ${totalNeeded} bytes but buffer is ${sab.byteLength}`);
  }

  uint8.set(jsonBytes, METADATA_OFFSET);
  Atomics.store(int32, 1, jsonBytes.byteLength);

  if (binary && binary.byteLength > 0) {
    uint8.set(binary, METADATA_OFFSET + jsonBytes.byteLength);
    Atomics.store(int32, 2, binary.byteLength);
  } else {
    Atomics.store(int32, 2, 0);
  }
}

/** Read a request from the SAB. */
export function decodeRequest(sab: SharedArrayBuffer): {
  metadata: Record<string, unknown>;
  binary: Uint8Array | null;
} {
  const int32 = new Int32Array(sab);
  const uint8 = new Uint8Array(sab);

  const metaLen = Atomics.load(int32, 1);
  const binLen = Atomics.load(int32, 2);

  const totalNeeded = METADATA_OFFSET + metaLen + binLen;
  if (totalNeeded > sab.byteLength) {
    throw new Error(`SAB bounds exceeded: need ${totalNeeded} bytes but buffer is ${sab.byteLength}`);
  }

  const metaBytes = uint8.slice(METADATA_OFFSET, METADATA_OFFSET + metaLen);
  const metadata = JSON.parse(decoder.decode(metaBytes));

  const binary = binLen > 0
    ? uint8.slice(METADATA_OFFSET + metaLen, METADATA_OFFSET + metaLen + binLen)
    : null;

  return { metadata, binary };
}

/** Write a response (metadata JSON + optional binary) into the SAB. */
export function encodeResponse(
  sab: SharedArrayBuffer,
  metadata: Record<string, unknown>,
  binary?: Uint8Array,
): void {
  encodeRequest(sab, metadata, binary);
}

/** Read a response from the SAB. */
export function decodeResponse(sab: SharedArrayBuffer): {
  metadata: Record<string, unknown>;
  binary: Uint8Array | null;
} {
  return decodeRequest(sab);
}
