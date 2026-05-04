/** Policy governing WASI binary package installation. */
export interface PackagePolicy {
  /** Whether package installation is enabled. */
  enabled: boolean;
  /** Allowed source hosts for packages. If set, only these hosts are accepted. */
  allowedHosts?: string[];
  /** Maximum size in bytes for a single package. */
  maxPackageBytes?: number;
  /** Maximum number of installed packages. */
  maxInstalledPackages?: number;
  /** If true, require a SHA-256 hash for each installed package. */
  requireIntegrity?: boolean;
}

/** Policy governing pip install from the yurt package registry. */
export interface PipPolicy {
  /** Whether pip install is enabled. Default false. */
  enabled: boolean;
  /** Allowed package names. If set, only these packages can be installed. */
  allowedPackages?: string[];
  /** Blocked package names. If set, these packages are denied. */
  blockedPackages?: string[];
  /** Maximum number of pip-installed packages. */
  maxPackages?: number;
}

/** Security configuration for sandbox instances. */
export interface SecurityOptions {
  /** Tool allowlist. If set, only these tools can be spawned. */
  toolAllowlist?: string[];
  /** Resource limits. */
  limits?: SecurityLimits;
  /** Audit event handler. */
  onAuditEvent?: AuditEventHandler;
  /** Enable worker thread execution for hard-kill preemption. Node.js only. */
  hardKill?: boolean;
  /** Package installation policy (WASM binary packages via pkg install). */
  packagePolicy?: PackagePolicy;
  /** Pip install policy (Python packages from yurt registry). */
  pipPolicy?: PipPolicy;
}

export interface SecurityLimits {
  /** Per-command wall-clock timeout in ms. Overrides SandboxOptions.timeoutMs. */
  timeoutMs?: number;
  /** Max stdout bytes per command. Truncated with marker. Default 1MB. */
  stdoutBytes?: number;
  /** Max stderr bytes per command. Truncated with marker. Default 1MB. */
  stderrBytes?: number;
  /** Max VFS total bytes. Overrides SandboxOptions.fsLimitBytes. */
  fsBytes?: number;
  /** Max file count in VFS. */
  fileCount?: number;
  /** Max command string length in bytes. Default 64KB. */
  commandBytes?: number;
  /** Max RPC payload size in bytes. Default 8MB. */
  rpcBytes?: number;
  /** Max WASM linear memory in bytes. Rejects modules that exceed this. */
  memoryBytes?: number;
}

/** Error classes returned in RunResult.errorClass. */
export type ErrorClass = 'TIMEOUT' | 'CANCELLED' | 'CAPABILITY_DENIED' | 'LIMIT_EXCEEDED';

/** Structured audit event. */
export interface AuditEvent {
  type: string;
  sessionId: string;
  timestamp: number;
  [key: string]: unknown;
}

export type AuditEventHandler = (event: AuditEvent) => void;

/** Error thrown when execution is cancelled. */
export class CancelledError extends Error {
  constructor(public reason: 'TIMEOUT' | 'CANCELLED') {
    super(`Execution ${reason.toLowerCase()}`);
    this.name = 'CancelledError';
  }
}
