import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.19";
import {
  analyzeYurtModule,
  moduleNeedsAsyncifyBridge,
  validateYurtModuleProfile,
} from "../module-profile.ts";

function encodeU32(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function bytes(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

function vec(items: number[][]): number[] {
  return [...encodeU32(items.length), ...items.flat()];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...encodeU32(payload.length), ...payload];
}

function customSection(name: string, payload: string): number[] {
  const body = [...encodeU32(name.length), ...bytes(name), ...bytes(payload)];
  return section(0, body);
}

function makeModule(opts: {
  imports?: string[];
  features?: string[];
  asyncify?: boolean;
}): WebAssembly.Module {
  const imports = opts.imports ?? [];
  const asyncifyExports = opts.asyncify
    ? [
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
      "asyncify_get_state",
    ]
    : [];

  const typeSection = section(1, vec([[0x60, 0x00, 0x00]]));
  const importSection = imports.length === 0 ? [] : section(
    2,
    vec(imports.map((name) => [
      ...encodeU32("yurt".length),
      ...bytes("yurt"),
      ...encodeU32(name.length),
      ...bytes(name),
      0x00,
      0x00,
    ])),
  );
  const functionSection = asyncifyExports.length === 0
    ? []
    : section(3, vec(asyncifyExports.map(() => [0x00])));
  const exportSection = asyncifyExports.length === 0 ? [] : section(
    7,
    vec(asyncifyExports.map((name, index) => [
      ...encodeU32(name.length),
      ...bytes(name),
      0x00,
      ...encodeU32(imports.length + index),
    ])),
  );
  const codeSection = asyncifyExports.length === 0
    ? []
    : section(10, vec(asyncifyExports.map(() => [0x02, 0x00, 0x0b])));
  const featureSection = opts.features
    ? customSection(
      "yurt.features",
      JSON.stringify({ async: "asyncify", features: opts.features }),
    )
    : [];

  return new WebAssembly.Module(
    new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      ...featureSection,
      ...typeSection,
      ...importSection,
      ...functionSection,
      ...exportSection,
      ...codeSection,
    ]),
  );
}

Deno.test("setjmp imports require explicit asyncify feature metadata", () => {
  const module = makeModule({
    imports: ["host_setjmp", "host_longjmp"],
    asyncify: true,
  });

  assertThrows(
    () => validateYurtModuleProfile(analyzeYurtModule(module)),
    Error,
    "module imports yurt continuation host calls but lacks yurt.features continuations marker",
  );
});

Deno.test("host_fork imports require asyncify feature metadata", () => {
  const module = makeModule({ imports: ["host_fork"], asyncify: true });

  assertThrows(
    () => validateYurtModuleProfile(analyzeYurtModule(module)),
    Error,
    "module imports yurt continuation host calls but lacks yurt.features continuations marker",
  );
});

Deno.test("continuation feature metadata requires asyncify exports", () => {
  const module = makeModule({ features: ["continuations"] });

  assertThrows(
    () => validateYurtModuleProfile(analyzeYurtModule(module)),
    Error,
    "module declares yurt.features continuations but is not asyncify-instrumented",
  );
});

Deno.test("legacy setjmp feature still chooses asyncify bridge", () => {
  const module = makeModule({
    imports: ["host_setjmp", "host_longjmp"],
    features: ["setjmp"],
    asyncify: true,
  });

  const profile = validateYurtModuleProfile(analyzeYurtModule(module, {
    jspiAvailable: true,
  }));

  assertEquals(profile.requiresAsyncify, true);
  assertEquals(profile.bridge, "asyncify");
  assertEquals(moduleNeedsAsyncifyBridge(profile), true);
});

Deno.test("continuation feature is accepted as asyncify metadata", () => {
  const module = makeModule({
    imports: ["host_fork"],
    features: ["continuations"],
    asyncify: true,
  });

  const profile = validateYurtModuleProfile(analyzeYurtModule(module, {
    jspiAvailable: true,
  }));

  assertEquals(profile.requiresAsyncify, true);
  assertEquals(profile.bridge, "asyncify");
});

Deno.test("plain modules choose JSPI when available", () => {
  const module = makeModule({});

  const profile = validateYurtModuleProfile(analyzeYurtModule(module, {
    jspiAvailable: true,
  }));

  assertEquals(profile.requiresAsyncify, false);
  assertEquals(profile.bridge, "jspi");
  assertEquals(moduleNeedsAsyncifyBridge(profile), false);
});
