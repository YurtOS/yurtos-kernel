/* libyurt_dlcanary.c — Phase 1 shared-library smoke side module.
 *
 * Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md.
 *
 * The side-module half of dlopen-canary's "happy path" case: a tiny
 * standalone .wasm that the runtime loader resolves at dlopen time and
 * whose only export, `yurt_dlcanary_double`, is what `dlsym` looks up.
 *
 * This source is exposed exclusively as a side module — never as a
 * main module — and is built with `yurt-cc -fPIC -c` followed by
 * `yurt-cc -shared` (which routes through wasm-ld
 * --shared --experimental-pic and produces a `dylink.0`-bearing wasm).
 *
 * `__attribute__((visibility("default")))` is what makes the symbol
 * actually appear in the side module's export section under the
 * default `-fvisibility=hidden` regime that wasm-ld --shared imposes.
 * Without it, dlsym would not find the function at run time.
 */

#include <stdint.h>

__attribute__((visibility("default"))) int32_t yurt_dlcanary_double(int32_t x) {
  return x * 2;
}
