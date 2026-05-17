// @yurt/runner — drives the Rust/WASM kernel through the thin h/k interface.
//
// Phase 1: re-exports the packaging / VFS-overlay / platform tooling extracted
// from the old TS-kernel package. `Runner` (the Sandbox replacement) and
// `YurtImageBuilder` are added in Phase 2.

export type { RunResult } from "./run-result.ts";
export { NodeAdapter } from "./platform/node-adapter.ts";
export type { PlatformAdapter } from "./platform/adapter.ts";
export { OverlayVFS } from "./vfs/overlay-vfs.ts";
export { NodeDirectoryRootProvider } from "./vfs/node-directory-root-provider.ts";
export {
  buildTarImageIndex,
  TarImageRootProvider,
} from "./vfs/tar-image-root-provider.ts";
export type {
  TarImageEntry,
  TarImageIndex,
  TarImageRootProviderOptions,
} from "./vfs/tar-image-root-provider.ts";
export type { RootProvider, RootProviderStat } from "./vfs/root-provider.ts";
export { loadYurtImage } from "./image-loader.ts";
export type { LoadedYurtImage, LoadYurtImageOptions } from "./image-loader.ts";
export { exportVfsToTar, exportVfsToYurtImage } from "./image-exporter.ts";
export type { ExportTarOptions } from "./image-exporter.ts";
export { installYurtPackage } from "./pkg-installer.ts";
export { buildBaseImage } from "./base-image/build-base-image.ts";
export type {
  BaseImageFile,
  BaseImageManifest,
  BaseImageSymlink,
  BaseImageTool,
  BuildBaseImageOptions,
} from "./base-image/build-base-image.ts";
