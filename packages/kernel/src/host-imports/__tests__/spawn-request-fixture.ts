// Test-only helper that encodes a yurt_spawn_request_v1 record matching the
// layout decoded by decodeNativeSpawnRequest in kernel-imports.ts. Mirrors
// the encoder in yurt-process so tests can construct native requests without
// depending on the Rust crate.

const encoder = new TextEncoder();

export interface NativeSpawnRequestInput {
  prog: string;
  argv0?: string;
  args?: string[];
  env?: [string, string][];
  cwd?: string;
  stdin_fd?: number;
  stdout_fd?: number;
  stderr_fd?: number;
  pass_fds?: number[];
  fd_map?: [number, number][];
  stdin_data?: string;
  nice?: number;
}

export function buildNativeSpawnRequest(
  req: NativeSpawnRequestInput,
): Uint8Array {
  const spans = new Map<string, { off: number; len: number }>();
  const parts: Uint8Array[] = [new Uint8Array(88)];
  let size = 88;
  const align = () => {
    const padding = (4 - (size % 4)) % 4;
    if (padding > 0) {
      parts.push(new Uint8Array(padding));
      size += padding;
    }
  };
  const append = (bytes: Uint8Array) => {
    align();
    const off = size;
    parts.push(bytes);
    size += bytes.byteLength;
    return { off, len: bytes.byteLength };
  };
  const internString = (value: string | undefined) => {
    if (value === undefined) return { off: 0, len: 0 };
    const existing = spans.get(value);
    if (existing) return existing;
    const span = append(encoder.encode(value));
    spans.set(value, span);
    return span;
  };
  const appendSpans = (values: string[]) => {
    if (values.length === 0) return 0;
    const valueSpans = values.map((value) => internString(value));
    align();
    const off = size;
    const bytes = new Uint8Array(values.length * 8);
    const view = new DataView(bytes.buffer);
    valueSpans.forEach((span, index) => {
      view.setUint32(index * 8, span.off, true);
      view.setUint32(index * 8 + 4, span.len, true);
    });
    parts.push(bytes);
    size += bytes.byteLength;
    return off;
  };
  const appendEnv = (values: [string, string][]) => {
    if (values.length === 0) return 0;
    const valueSpans = values.map(([key, value]) =>
      [internString(key), internString(value)] as const
    );
    align();
    const off = size;
    const bytes = new Uint8Array(values.length * 16);
    const view = new DataView(bytes.buffer);
    valueSpans.forEach(([keySpan, valueSpan], index) => {
      const base = index * 16;
      view.setUint32(base, keySpan.off, true);
      view.setUint32(base + 4, keySpan.len, true);
      view.setUint32(base + 8, valueSpan.off, true);
      view.setUint32(base + 12, valueSpan.len, true);
    });
    parts.push(bytes);
    size += bytes.byteLength;
    return off;
  };
  const appendI32s = (values: number[]) => {
    if (values.length === 0) return 0;
    align();
    const off = size;
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt32(index * 4, value, true));
    parts.push(bytes);
    size += bytes.byteLength;
    return off;
  };
  const appendFdMap = (values: [number, number][]) => {
    if (values.length === 0) return 0;
    align();
    const off = size;
    const bytes = new Uint8Array(values.length * 8);
    const view = new DataView(bytes.buffer);
    values.forEach(([parentFd, childFd], index) => {
      const base = index * 8;
      view.setInt32(base, parentFd, true);
      view.setInt32(base + 4, childFd, true);
    });
    parts.push(bytes);
    size += bytes.byteLength;
    return off;
  };

  const prog = internString(req.prog);
  const argv0 = internString(req.argv0);
  const args = req.args ?? [];
  const env = req.env ?? [];
  const passFds = req.pass_fds ?? [];
  const fdMap = req.fd_map ?? [];
  const argsOff = appendSpans(args);
  const envOff = appendEnv(env);
  const cwd = internString(req.cwd ?? "");
  const passFdsOff = appendI32s(passFds);
  const fdMapOff = appendFdMap(fdMap);
  const stdinData = internString(req.stdin_data);
  align();

  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  const view = new DataView(out.buffer);
  view.setUint32(0, size, true);
  view.setUint16(4, 1, true);
  view.setUint32(8, prog.off, true);
  view.setUint32(12, prog.len, true);
  view.setUint32(16, argv0.off, true);
  view.setUint32(20, argv0.len, true);
  view.setUint32(24, argsOff, true);
  view.setUint32(28, args.length, true);
  view.setUint32(32, envOff, true);
  view.setUint32(36, env.length, true);
  view.setUint32(40, cwd.off, true);
  view.setUint32(44, cwd.len, true);
  view.setInt32(48, req.stdin_fd ?? 0, true);
  view.setInt32(52, req.stdout_fd ?? 1, true);
  view.setInt32(56, req.stderr_fd ?? 2, true);
  view.setUint32(60, passFdsOff, true);
  view.setUint32(64, passFds.length, true);
  view.setUint32(68, stdinData.off, true);
  view.setUint32(72, stdinData.len, true);
  view.setInt32(76, req.nice ?? 0, true);
  view.setUint32(80, fdMapOff, true);
  view.setUint32(84, fdMap.length, true);
  return out;
}
