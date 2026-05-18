// stdio helpers for the Runner.

const DEC = new TextDecoder();
const ENC = new TextEncoder();

export function decode(bytes: Uint8Array): string {
  return DEC.decode(bytes);
}

export function encode(text: string): Uint8Array {
  return ENC.encode(text);
}
