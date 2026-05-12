/**
 * End-to-end checks for the Phase A C canaries shipped by the yurt
 * kernel ABI runtime.
 */
import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Sandbox } from "../sandbox.js";
import { NodeAdapter } from "../platform/node-adapter.js";
import { unsupportedRuntimeEngineBackend } from "../engine/backend.js";
import type {
  NetworkBridgeLike,
  SyncFetchResult,
  SyncRequestResult,
} from "../network/bridge.ts";
import type { SocketBackend, SocketHandle } from "../network/socket-backend.js";

const FIXTURES = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);
const HAS_BUSYBOX_FIXTURE = existsSync(resolve(FIXTURES, "busybox.wasm"));
const shellIt = HAS_BUSYBOX_FIXTURE ? it : it.skip;
// Phase 1 shared-library smoke test: gated on the side-module fixture
// being present. The fixture is built by `make -C abi side-module-canaries`
// (requires WASI SDK), so locally the test runs only if the dev has
// the fixture; in CI guest-compat.yml runs `make -C abi all copy-fixtures`
// which produces it.
const HAS_DLCANARY_FIXTURE =
  existsSync(resolve(FIXTURES, "libyurt_dlcanary.wasm")) &&
  existsSync(resolve(FIXTURES, "dlopen-canary.wasm"));
const HAS_UNIX_FIXTURE = existsSync(resolve(FIXTURES, "unix-canary.wasm"));

function installTestShell(sandbox: Sandbox): void {
  const vfs = (sandbox as unknown as {
    vfs: {
      withWriteAccess(fn: () => void): void;
      mkdirp(path: string): void;
      writeFile(path: string, data: Uint8Array): void;
      symlink(target: string, path: string): void;
      unlink(path: string): void;
      chmod(path: string, mode: number): void;
    };
  }).vfs;
  vfs.withWriteAccess(() => {
    vfs.mkdirp("/usr/bin");
    vfs.mkdirp("/bin");
    vfs.writeFile(
      "/usr/bin/busybox",
      Deno.readFileSync(resolve(FIXTURES, "busybox.wasm")),
    );
    vfs.chmod("/usr/bin/busybox", 0o555);
    try {
      vfs.unlink("/bin/sh");
    } catch {
      // The fixture manifest may not have installed this link yet.
    }
    vfs.symlink("/usr/bin/busybox", "/bin/sh");
  });
}

class StaticFetchBridge implements NetworkBridgeLike {
  requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | null;
    redirect?: "follow" | "manual";
  }> = [];

  fetchSync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    redirect?: "follow" | "manual",
  ): SyncFetchResult {
    this.requests.push({ url, method, headers, body, redirect });
    return {
      status: 200,
      headers: {},
      body: "fetch-canary-ok",
      body_base64: "ZmV0Y2gtY2FuYXJ5LW9r",
    };
  }

  requestSync(): SyncRequestResult {
    return { ok: false, error: "not used" };
  }
}

// ─────────────────────────────────────────────────────────────────────
// AF_UNIX (unix-canary)
//
// Spec: docs/superpowers/specs/2026-05-11-af-unix-design.md
// Plan: docs/superpowers/plans/2026-05-11-af-unix.md
//
// Slice 1 pins the contract: this describe.skip block lists every
// case the canary defines and the slice that will unskip it. The
// canary itself emits {"exit":99,"stdout":"pending-impl"} for each
// case until its slice lands, so the C source compiles cleanly
// against today's libyurt (which rejects AF_UNIX with EAFNOSUPPORT)
// and CI stays green.
//
// Each `it.skip` carries a one-line TODO citing the slice that flips
// it to `it`.
// ─────────────────────────────────────────────────────────────────────
describe("AF_UNIX (unix-canary)", () => {
  it("pair_basic: socketpair(AF_UNIX, SOCK_STREAM) returns two connected fds", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case pair_basic");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"pair_basic","exit":0,"stdout":"pair=ok"}');
  });

  it("bind_listen_accept: bind, listen, and accept on /tmp/foo.sock", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case bind_listen_accept");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"bind_listen_accept","exit":0,"stdout":"bla=ok"}');
  });

  it("stat_socket_inode: bind creates an S_IFSOCK inode visible to stat()", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case stat_socket_inode");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"stat_socket_inode","exit":0,"stdout":"ifsock=ok"}');
  });

  it("unlink_removes: unlink of the bound path makes subsequent connect() fail", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case unlink_removes");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"unlink_removes","exit":0,"stdout":"unlink=ok"}');
  });

  it("connect_refused: connect to a path with no listener returns ECONNREFUSED", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case connect_refused");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"connect_refused","exit":0,"stdout":"refused=ok"}');
  });

  it("abstract_bind_connect: bind/connect with a \\0-prefixed name", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//], unixAbstractAllowlist: [/.*/] },
    });
    const result = await sandbox.run("unix-canary --case abstract_bind_connect");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"abstract_bind_connect","exit":0,"stdout":"abstract=ok"}');
  });

  it("abstract_invisible_to_stat: abstract names do not appear in the VFS", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//], unixAbstractAllowlist: [/.*/] },
    });
    const result = await sandbox.run("unix-canary --case abstract_invisible_to_stat");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"abstract_invisible_to_stat","exit":0,"stdout":"invisible=ok"}');
  });

  it("dgram_pair_message_framing: socketpair SOCK_DGRAM preserves message boundaries", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case dgram_pair_message_framing");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"dgram_pair_message_framing","exit":0,"stdout":"dgram=ok"}');
  });

  it("dgram_path_sendto: sendto delivers a datagram to a bound path", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case dgram_path_sendto");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"dgram_path_sendto","exit":0,"stdout":"dgram-path=ok"}');
  });

  it("scm_rights_pipe_handoff: sendmsg with SCM_RIGHTS passes a pipe read end", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case scm_rights_pipe_handoff");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"scm_rights_pipe_handoff","exit":0,"stdout":"scm=ok"}');
  });
  it("peercred_after_accept: getsockopt(SO_PEERCRED) returns the peer's ucred", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case peercred_after_accept");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"peercred_after_accept","exit":0,"stdout":"peercred=ok"}');
  });

  it("dgram_sendto_after_unlink: sendto a dgram path after unlink must fail", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case dgram_sendto_after_unlink");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"dgram_sendto_after_unlink","exit":0,"stdout":"dgram-unlink=ok"}');
  });

  it("scm_rights_truncation: recvmsg with small control buffer receives one fd and does not crash", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case scm_rights_truncation");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"scm_rights_truncation","exit":0,"stdout":"scm-trunc=ok"}');
  });

  it("dgram_bind_rollback: failed dgram bind must not leak a stale dgram route", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case dgram_bind_rollback");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"dgram_bind_rollback","exit":0,"stdout":"dgram-rollback=ok"}');
  });

  it("dgram_so_type: getsockopt(SO_TYPE) on a SOCK_DGRAM socket returns SOCK_DGRAM", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case dgram_so_type");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"dgram_so_type","exit":0,"stdout":"so_type=ok"}');
  });

  it("dgram_nonblocking_recv: SOCK_NONBLOCK dgram recv returns EAGAIN immediately when empty", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case dgram_nonblocking_recv");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"dgram_nonblocking_recv","exit":0,"stdout":"nb-recv=ok"}');
  });

  it("peercred_uid_gid: SO_PEERCRED reports uid=1000/gid=1000 for sandbox processes", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case peercred_uid_gid");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"peercred_uid_gid","exit":0,"stdout":"uid-gid=ok"}');
  });

  it("recvmsg_ctrunc_tiny_ctrl: control buffer < CMSG_LEN(0) must not write past buffer", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case recvmsg_ctrunc_tiny_ctrl");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"recvmsg_ctrunc_tiny_ctrl","exit":0,"stdout":"ctrunc-tiny=ok"}');
  });

  it("abstract_bind_policy_denied: abstract AF_UNIX bind is rejected when name is not in abstract allowlist", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      // allowlist permits nothing matching "deny-policy"
      serverSockets: { allowUnixDomain: true, unixAbstractAllowlist: [/^allowed-only$/] },
    });
    const result = await sandbox.run("unix-canary --case abstract_bind_policy_denied");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"abstract_bind_policy_denied","exit":0,"stdout":"bind-denied=ok"}');
  });

  it("stat_after_listener_close: close() on listening socket must not unlink the socket inode", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true, unixPathAllowlist: [/^\/tmp\//] },
    });
    const result = await sandbox.run("unix-canary --case stat_after_listener_close");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"stat_after_listener_close","exit":0,"stdout":"inode-persists=ok"}');
  });

  it("listen_dgram_eopnotsupp: listen() on SOCK_DGRAM returns EOPNOTSUPP", async () => {
    if (!HAS_UNIX_FIXTURE) return;
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      serverSockets: { allowUnixDomain: true },
    });
    const result = await sandbox.run("unix-canary --case listen_dgram_eopnotsupp");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('{"case":"listen_dgram_eopnotsupp","exit":0,"stdout":"eopnotsupp=ok"}');
  });
});

describe("Kernel ABI canaries", { sanitizeOps: false, sanitizeResources: false }, () => {
  let sandbox: Sandbox | null = null;

  afterEach(() => {
    sandbox?.destroy();
    sandbox = null;
  });

  it("runs stdio-canary as a normal command", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    sandbox.writeFile(
      "/tmp/in.txt",
      new TextEncoder().encode("hello canary\n"),
    );

    const result = await sandbox.run("stdio-canary /tmp/in.txt /tmp/out.txt");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("stdio-ok");
    expect(new TextDecoder().decode(sandbox.readFile("/tmp/out.txt"))).toBe(
      "hello canary\n",
    );
  });

  it("runs sleep-canary and prints the sleep duration", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const requestedMs = 20;
    const lowerBoundMs = 10;
    const started = performance.now();
    const result = await sandbox.run(`sleep-canary ${requestedMs}`);
    const elapsedMs = performance.now() - started;

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`slept:${requestedMs}`);
    expect(elapsedMs).toBeGreaterThanOrEqual(lowerBoundMs);
  });

  shellIt("runs system-canary through POSIX system()", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });
    installTestShell(sandbox);

    const result = await sandbox.run("system-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain("system-ok");
  });

  shellIt("runs popen-canary and captures command output", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });
    installTestShell(sandbox);

    const result = await sandbox.run("popen-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("popen:hello-from-shell");
  });

  shellIt(
    "streams large system() command output through the process path",
    async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      installTestShell(sandbox);

      const result = await sandbox.run("system-canary large");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("system-large-ok");
    },
  );

  shellIt("returns the command exit status from pclose", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });
    installTestShell(sandbox);

    const result = await sandbox.run("popen-canary status");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("pclose:7");
  });

  it("reports a single visible CPU through the affinity compat layer", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("affinity-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("affinity:get=1,set0=0,set1=einval");
  });

  it("reports priority changes as unsupported without an engine scheduler backend", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      runtimeBackend: unsupportedRuntimeEngineBackend,
    });

    const result = await sandbox.run(
      "posix-runtime-canary --case priority_unsupported",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      '{"case":"priority_unsupported","exit":0,"stdout":"priority_unsupported:ok"}',
    );
  });

  it("routes scheduler policy metadata through the process kernel", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run(
      "affinity-canary --case scheduler_policy_metadata",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      '{"case":"scheduler_policy_metadata","exit":0,"stdout":"scheduler:policy=other,param=0"}',
    );
  });

  it("exposes ISO-10646 wchar conversion semantics to C ports", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("locale-canary unicode_quote_ascii");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("locale:iso10646=1");
    expect(result.stdout).toContain("locale:c_wctomb=-1 errno=25");
    expect(result.stdout).toContain("locale:strftime_invalid=0 first=120");
  });

  // ──────────────────────────────────────────────────────────────────────
  // setjmp/longjmp — POSIX exception-style control flow over Asyncify.
  //
  // yurt implements setjmp/longjmp on top of binaryen's Asyncify pass:
  // setjmp captures the current Asyncify save-state into env, longjmp
  // triggers an unwind that the runtime rewinds back to setjmp's call
  // site so the import returns the longjmp value.  These cases exercise
  // the full surface — first-call zero return, value preservation across
  // longjmp, the POSIX zero→one promotion, longjmp from a few frames
  // deep, and negative values — to make sure every dimension of the
  // contract is hit.
  // ──────────────────────────────────────────────────────────────────────
  describe("setjmp-canary", () => {
    it("setjmp returns 0 on the first call", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const r = await sandbox.run("setjmp-canary --case setjmp_returns_zero");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(
        '{"case":"setjmp_returns_zero","exit":0,"observed":0}',
      );
    });

    it("longjmp(env, 42) makes setjmp return 42", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const r = await sandbox.run("setjmp-canary --case smoke");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"smoke","exit":0,"observed":42}');
    });

    it("longjmp(env, 0) is promoted to 1 (POSIX)", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const r = await sandbox.run("setjmp-canary --case longjmp_zero");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(
        '{"case":"longjmp_zero","exit":0,"observed":1}',
      );
    });

    it("longjmp from N frames deep unwinds intermediate frames", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const r = await sandbox.run("setjmp-canary --case longjmp_through_calls");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(
        '{"case":"longjmp_through_calls","exit":0,"observed":7}',
      );
      // The "middle" frame's post-longjmp diagnostic must NOT appear:
      // longjmp must skip the intermediate frame, not return to it.
      expect(r.stderr).not.toContain("returned from longjmp");
    });

    it("preserves negative longjmp values byte-for-byte", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const r = await sandbox.run("setjmp-canary --case longjmp_negative");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(
        '{"case":"longjmp_negative","exit":0,"observed":-7}',
      );
    });

    it("captures enough continuation stack for deep setjmp users", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const r = await sandbox.run("setjmp-canary --case longjmp_deep_stack");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(
        '{"case":"longjmp_deep_stack","exit":0,"observed":23}',
      );
    });
  });

  describe("fork-canary", () => {
    it("keeps plain fork as ENOSYS outside continuation builds", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const r = await sandbox.run("fork-default-canary --case default-enosys");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("fork-default-enosys");
    });

    it("splits parent and child under the asyncify continuation runtime", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const r = await sandbox.run("fork-canary --case continuation-split");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toMatch(/^fork-ok child=\d+ parent=\d+$/);
    });

    it("preserves pre-fork continuation frames in children", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const cases = [
        ["child-longjmp-prefork", "fork-child-longjmp-ok"],
        ["child-nested-longjmp-prefork", "fork-child-nested-longjmp-ok"],
        ["child-wait-longjmp-prefork", "fork-child-wait-longjmp-ok"],
      ];
      for (const [caseName, expected] of cases) {
        const r = await sandbox.run(`fork-canary --case ${caseName}`);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe(expected);
      }
    });

    it("allows forked children to exec another process image", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });
      const r = await sandbox.run("fork-canary --case child-exec");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("fork-child-exec-ok");
    });
  });

  it("routes stderr through stdout after dup2(1, 2)", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("dup2-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("dup2-ok");
    expect(result.stderr).toBe("");
  });

  it("exposes the narrow getgroups compatibility contract", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("getgroups-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("getgroups:1:1000");
  });

  it("runs spawn-canary including non-stdio file action open errors", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("spawn-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('{"case":"open_errno","exit":0}');
  });

  it("reports EPERM for unprivileged resource hard-limit raises", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("resource-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      '{"case":"setrlimit_raise_hard_eperm","exit":0,"v":0}',
    );
  });

  describe("posix-runtime-canary", () => {
    it("reports deterministic hostname and loopback interface lookups", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });

      const hostname = await sandbox.run(
        "posix-runtime-canary --case hostname",
      );
      expect(hostname.exitCode).toBe(0);
      expect(hostname.stdout.trim()).toBe(
        '{"case":"hostname","exit":0,"stdout":"hostname:yurt"}',
      );

      const nameToIndex = await sandbox.run(
        "posix-runtime-canary --case loopback_name_to_index",
      );
      expect(nameToIndex.exitCode).toBe(0);
      expect(nameToIndex.stdout.trim()).toBe(
        '{"case":"loopback_name_to_index","exit":0,"stdout":"if_nametoindex:1"}',
      );

      const indexToName = await sandbox.run(
        "posix-runtime-canary --case loopback_index_to_name",
      );
      expect(indexToName.exitCode).toBe(0);
      expect(indexToName.stdout.trim()).toBe(
        '{"case":"loopback_index_to_name","exit":0,"stdout":"if_indextoname:lo"}',
      );
    });

    it("exercises deterministic sendfile edge behavior", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });

      const zero = await sandbox.run(
        "posix-runtime-canary --case sendfile_zero_count",
      );
      expect(zero.exitCode).toBe(0);
      expect(zero.stdout.trim()).toBe(
        '{"case":"sendfile_zero_count","exit":0,"stdout":"sendfile_zero:0"}',
      );

      const badFd = await sandbox.run(
        "posix-runtime-canary --case sendfile_bad_fd",
      );
      expect(badFd.exitCode).toBe(0);
      expect(badFd.stdout.trim()).toBe(
        '{"case":"sendfile_bad_fd","exit":0,"stdout":"sendfile_bad_fd:-1","errno":8}',
      );
    });

    it("preserves fcntl status flags on pipe descriptors", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });

      const result = await sandbox.run(
        "posix-runtime-canary --case fcntl_pipe_status_flags",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(
        '{"case":"fcntl_pipe_status_flags","exit":0,"stdout":"fcntl_pipe_status_flags:ok"}',
      );
    });

    it("does not let F_SETFL change access mode bits", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });

      const result = await sandbox.run(
        "posix-runtime-canary --case fcntl_setfl_masks_access_mode",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(
        '{"case":"fcntl_setfl_masks_access_mode","exit":0,"stdout":"fcntl_setfl_masks_access_mode:ok"}',
      );
    });

    it("returns POSIX dot entries from readdir", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });

      const result = await sandbox.run(
        "posix-runtime-canary --case readdir_dot_entries",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(
        '{"case":"readdir_dot_entries","exit":0,"stdout":"readdir_dot_entries:ok"}',
      );
    });

    it("applies utimes mtime updates through WASI filestat setters", async () => {
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });

      const result = await sandbox.run(
        "posix-runtime-canary --case utimes_mtime",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(
        '{"case":"utimes_mtime","exit":0,"stdout":"utimes_mtime:ok"}',
      );
    });
  });

  it("exposes the narrow signal compatibility header surface", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("signal-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("signal-ok");
  });

  it("delivers host-routed kill signals to guest handlers", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run(
      "signal-canary --case host_kill_delivers_handler",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      '{"case":"host_kill_delivers_handler","exit":0,"stdout":"kill:handled"}',
    );
  });

  it("round-trips SIGCHLD through the compact signal mask ABI", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run(
      "signal-canary --case sigprocmask_sigchld_roundtrip",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      '{"case":"sigprocmask_sigchld_roundtrip","exit":0,"stdout":"sigprocmask:sigchld"}',
    );
  });

  it("keeps host-routed signals pending while the guest mask blocks them", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run(
      "signal-canary --case blocked_host_signal_delivers_after_unblock",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      '{"case":"blocked_host_signal_delivers_after_unblock","exit":0,"stdout":"kill:blocked-then-handled"}',
    );
  });

  it("reports terminating signals through waitpid status", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run(
      "signal-canary --case waitpid_reports_terminating_signal",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      '{"case":"waitpid_reports_terminating_signal","exit":0,"stdout":"waitpid:signal"}',
    );
  });

  it("preserves normal child exit codes above 128 through waitpid status", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run(
      "signal-canary --case waitpid_preserves_high_exit_code",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      '{"case":"waitpid_preserves_high_exit_code","exit":0,"stdout":"waitpid:exit143"}',
    );
  });

  it("runs the pthread-canary single-thread compatibility test", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("pthread-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("pthread:ok");
  });

  it("treats pthread_exit from main as a clean process exit", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      serverSockets: { allowUnixDomain: true },
    });

    const result = await sandbox.run("pthread-main-exit-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exposes the POSIX socket compatibility header surface", async () => {
    // socket-canary now exercises socketpair(), which emulates AF_UNIX
    // SOCK_STREAM via a TCP-loopback listen/accept dance (yurtos-kernel
    // PR #22's yurt_socket.c::socketpair). Allow loopback listeners so
    // that path can complete. The canary still verifies that listen()
    // on 0.0.0.0 is denied (EOPNOTSUPP) before the socketpair section
    // runs — that case fires because 0.0.0.0 is not loopback.
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      serverSockets: { allowLoopback: true },
    });

    const result = await sandbox.run("socket-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"case":"socket_surface","exit":0}');
  });

  it("runs C POSIX socket listener through bind/listen/accept", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      serverSockets: { allowLoopback: true },
    });

    const result = await sandbox.run("socket-listen-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("socket-listen=ok");
  });

  it("rejects 0.0.0.0 listener when mapped port authorization denies it", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      serverSockets: {
        portMappings: [{
          sandboxHost: "0.0.0.0",
          sandboxPort: 8080,
          hostPort: 0,
        }],
        onListen: () => false,
      },
    });

    const result = await sandbox.run("socket-listen-denied-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("listen-denied=ok");
  });

  it("reports POSIX peer and local socket addresses through socket.h", async () => {
    let socketBackend: SocketBackend;
    socketBackend = {
      connect: () => ({ ok: true, socket: 606 }),
      send: (_socket, dataB64) => ({
        ok: true,
        bytes_sent: atob(dataB64).length,
      }),
      recv: (_socket, _maxBytes, opts) =>
        opts?.nonblocking
          ? { ok: false, error: "EAGAIN" }
          : { ok: true, data_b64: "" },
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("socket-address-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("socket-address=ok");
  });

  it("routes C host_network_fetch through yurt_fetch_text", async () => {
    const networkBridge = new StaticFetchBridge();
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["example.test"] },
      networkBridge,
    });

    const result = await sandbox.run("fetch-canary https://example.test/data");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("fetch-canary-ok");
    expect(networkBridge.requests).toEqual([{
      url: "https://example.test/data",
      method: "GET",
      headers: {},
      body: null,
      redirect: "manual",
    }]);
  });

  it("links Rust POSIX socket FFI calls through libyurt", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("socket-rust-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"case":"socket_surface","exit":0}');
  });

  it("runs Rust std::env::temp_dir through the Yurt std patch", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-tempdir-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/tmp");
  });

  it("runs Rust std env/process helpers through the Yurt std patch", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-env-process-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("home=/home/yurt");
    expect(result.stdout).toContain("exe=");
    expect(result.stdout).toContain("pid=1");
  });

  it("runs Rust std path list helpers through the Yurt std patch", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-paths-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      "split=/bin:/usr/bin\njoined=/bin:/usr/bin\ninvalid=true",
    );
  });

  it("runs Rust std filesystem helpers through the Yurt std patch", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-fs-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("canonical=");
    expect(result.stdout).toContain("yurt-std-fs-canary.txt");
    expect(result.stdout).toContain("contents=yurt");
  });

  it("runs Rust std file locks with real conflict behavior", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-file-lock-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("exclusive-blocks=true");
  });

  it("runs Rust std thread spawn/join through the Yurt std patch", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-thread-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(
      /^parallelism=\d+ joined=42 scoped=6$/,
    );
  });

  it("runs Rust std::process::Command status through libyurt spawn/wait", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-process-status-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      "true success=true code=Some(0)\nfalse success=false code=Some(1)",
    );
  });

  it("runs Rust std::process::Command output through libyurt pipes", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-process-output-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'status=Some(0) stdout="hello-rust" stderr=""',
    );
  });

  it("runs Rust std::process::Command env and cwd through libyurt spawn", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-process-env-cwd-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("env-status=Some(0)");
    expect(result.stdout).toContain("cwd-status=Some(0)");
    expect(result.stdout).toContain('cwd-stdout="marker.txt\\n"');
  });

  it("runs Rust std::process::Command spawn with piped stdio", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-process-spawn-stdio-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'status=Some(0) stdout="spawn-stdin\\n" stderr=""',
    );
  });

  it("reads Rust std::process child stdout after wait", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-process-child-stdout-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'status=Some(0) stdout="child-stdout"',
    );
  });

  it("routes Rust std::process::Stdio from a child stdout pipe", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-process-stdio-from-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'status=Some(0) stdout="from-child-stdout"',
    );
  });

  it("routes Rust std::net::TcpStream connect through libyurt sockets", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("std-net-connect-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("kind=ConnectionRefused");
  });

  it("routes Rust std::net::TcpStream read/write through socket fd I/O", async () => {
    const handle: SocketHandle = 101;
    const requests: Record<string, unknown>[] = [];
    let socketBackend: SocketBackend;
    socketBackend = {
      connect(req) {
        requests.push({ op: "connect", ...req });
        return { ok: true, socket: handle };
      },
      send(socket, dataB64) {
        requests.push({ op: "send", socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: 4 };
      },
      recv(socket, maxBytes) {
        requests.push({ op: "recv", socket, max_bytes: maxBytes });
        return { ok: true, data_b64: btoa("pong") };
      },
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-stream-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("reply=pong");
    expect(requests).toContainEqual({
      op: "connect",
      host: "127.0.0.1",
      port: 9,
      tls: false,
    });
    expect(requests).toContainEqual({
      op: "send",
      socket: handle,
      data_b64: btoa("ping"),
    });
    expect(requests).toContainEqual({
      op: "recv",
      socket: handle,
      max_bytes: 4,
    });
  });

  it("reports Rust std::net::TcpStream peer_addr for connected streams", async () => {
    let socketBackend: SocketBackend;
    socketBackend = {
      connect: () => ({ ok: true, socket: 202 }),
      send: (_socket, dataB64) => ({
        ok: true,
        bytes_sent: atob(dataB64).length,
      }),
      recv: () => ({ ok: true, data_b64: "" }),
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-peer-addr-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("peer=127.0.0.1:9");
  });

  it("routes Rust std::net hostname connects through libyurt netdb", async () => {
    const handle: SocketHandle = 303;
    const requests: Record<string, unknown>[] = [];
    let socketBackend: SocketBackend;
    socketBackend = {
      connect(req) {
        requests.push({ op: "connect", ...req });
        return { ok: true, socket: handle };
      },
      send(socket, dataB64) {
        requests.push({ op: "send", socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: atob(dataB64).length };
      },
      recv(socket, maxBytes) {
        requests.push({ op: "recv", socket, max_bytes: maxBytes });
        return { ok: true, data_b64: btoa("pong") };
      },
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-hostname-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("reply=pong");
    expect(requests).toContainEqual({
      op: "connect",
      host: "example.test",
      port: 443,
      tls: false,
    });
    expect(requests).toContainEqual({
      op: "send",
      socket: handle,
      data_b64: btoa("ping"),
    });
    expect(requests).toContainEqual({
      op: "recv",
      socket: handle,
      max_bytes: 4,
    });
  });

  it("routes Rust std::net::TcpStream shutdown through WASI socket shutdown", async () => {
    const requests: Record<string, unknown>[] = [];
    let socketBackend: SocketBackend;
    socketBackend = {
      connect(req) {
        requests.push({ op: "connect", ...req });
        return { ok: true, socket: 404 };
      },
      send(socket, dataB64) {
        requests.push({ op: "send", socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: atob(dataB64).length };
      },
      recv(socket, maxBytes) {
        requests.push({ op: "recv", socket, max_bytes: maxBytes });
        return { ok: true, data_b64: "" };
      },
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-shutdown-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("shutdown=both");
    expect(requests).toContainEqual({
      op: "connect",
      host: "127.0.0.1",
      port: 9,
      tls: false,
    });
    expect(requests).toContainEqual({ op: "close", socket: 404 });
  });

  it("duplicates Rust std::net::TcpStream fds through libyurt dup", async () => {
    const requests: Record<string, unknown>[] = [];
    let socketBackend: SocketBackend;
    socketBackend = {
      connect(req) {
        requests.push({ op: "connect", ...req });
        return { ok: true, socket: 505 };
      },
      send(socket, dataB64) {
        requests.push({ op: "send", socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: atob(dataB64).length };
      },
      recv(socket, maxBytes) {
        requests.push({ op: "recv", socket, max_bytes: maxBytes });
        return { ok: true, data_b64: "" };
      },
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-try-clone-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("try_clone=ok");
    expect(requests).toContainEqual({
      op: "connect",
      host: "127.0.0.1",
      port: 9,
      tls: false,
    });
    expect(requests).toContainEqual({
      op: "send",
      socket: 505,
      data_b64: btoa("one"),
    });
    expect(requests).toContainEqual({
      op: "send",
      socket: 505,
      data_b64: btoa("two"),
    });
    expect(requests.filter((req) => req.op === "close")).toEqual([{
      op: "close",
      socket: 505,
    }]);
  });

  it("reports Rust std::net::TcpStream socket_addr through libyurt getsockname", async () => {
    let socketBackend: SocketBackend;
    socketBackend = {
      connect: () => ({ ok: true, socket: 707 }),
      send: (_socket, dataB64) => ({
        ok: true,
        bytes_sent: atob(dataB64).length,
      }),
      recv: () => ({ ok: true, data_b64: "" }),
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-socket-addr-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^local=10\.0\.2\.15:\d+$/);
  });

  it("routes Rust std::net::TcpStream take_error through libyurt getsockopt", async () => {
    let socketBackend: SocketBackend;
    socketBackend = {
      connect: () => ({ ok: true, socket: 808 }),
      send: (_socket, dataB64) => ({
        ok: true,
        bytes_sent: atob(dataB64).length,
      }),
      recv: () => ({ ok: true, data_b64: "" }),
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-take-error-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("take_error=none");
  });

  it("routes Rust std::net::TcpStream nodelay through libyurt socket options", async () => {
    const requests: unknown[] = [];
    let socketBackend: SocketBackend;
    socketBackend = {
      connect: () => ({ ok: true, socket: 909 }),
      send: (_socket, dataB64) => ({
        ok: true,
        bytes_sent: atob(dataB64).length,
      }),
      recv: () => ({ ok: true, data_b64: "" }),
      close: () => ({ ok: true }),
      setNoDelay: (socket, enabled) => {
        requests.push({ op: "setNoDelay", socket, enabled });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-nodelay-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("nodelay=ok");
    expect(requests).toEqual([
      { op: "setNoDelay", socket: 909, enabled: true },
      { op: "setNoDelay", socket: 909, enabled: false },
    ]);
  });

  it("routes Rust std::net::TcpStream peek through libyurt socket recv buffering", async () => {
    const requests: unknown[] = [];
    let socketBackend: SocketBackend;
    socketBackend = {
      connect: () => ({ ok: true, socket: 1001 }),
      send: (_socket, dataB64) => ({
        ok: true,
        bytes_sent: atob(dataB64).length,
      }),
      recv: (socket, maxBytes) => {
        requests.push({ op: "recv", socket, maxBytes });
        return { ok: true, data_b64: btoa("abc") };
      },
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-peek-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("peek=ok");
    expect(requests).toEqual([{ op: "recv", socket: 1001, maxBytes: 3 }]);
  });

  it("routes Rust std::net::TcpStream nonblocking through WASI fd flags", async () => {
    const requests: unknown[] = [];
    let socketBackend: SocketBackend;
    socketBackend = {
      connect: () => ({ ok: true, socket: 1002 }),
      send: (_socket, dataB64) => ({
        ok: true,
        bytes_sent: atob(dataB64).length,
      }),
      recv: (socket, maxBytes, opts) => {
        requests.push({
          op: "recv",
          socket,
          maxBytes,
          nonblocking: opts?.nonblocking === true,
        });
        return opts?.nonblocking
          ? { ok: false, error: "EAGAIN" }
          : { ok: true, data_b64: btoa("abc") };
      },
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run("std-net-nonblocking-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("nonblocking=ok");
    expect(requests).toEqual([{
      op: "recv",
      socket: 1002,
      maxBytes: 3,
      nonblocking: true,
    }]);
  });

  it("runs Rust std::net::TcpListener through libyurt sockets", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      serverSockets: { allowLoopback: true },
    });

    const result = await sandbox.run("std-net-listener-canary");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("std-net-listener=ok");
  });

  it("spawns a tool via absolute path to its /usr/bin stub", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    // Invoking /usr/bin/seq directly (absolute path, not bare name) must work.
    // Before the Gap-1 fix, exec_path would try to execute the tool stub
    // content as a shell script and return exit code 127.
    const result = await sandbox.run("/usr/bin/seq 1 3");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1\n2\n3");
  });

  it("preserves exec permission failures for non-executable VFS files", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run("exec-canary execv_eacces");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      '{"case":"execv_eacces","exit":0,"errno":2}',
    );
  });

  it("spawns a tool via a VFS symlink to a tool stub", async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    // A user-created symlink that resolves directly to a multicall
    // binary stub picks up the link's basename as argv[0], which the
    // BusyBox dispatcher uses to select the applet.  /tmp/seq → busybox
    // therefore runs as `seq` — same expected output as a standalone
    // seq.wasm.  (Indirect chains like /tmp/x → /tmp/seq → busybox
    // would carry argv[0]="x" and trip the dispatcher, mirroring
    // Linux behavior — this is documented in the busybox-multicall
    // test below.)
    await sandbox.run("ln -sf /usr/bin/busybox /tmp/seq");
    const result = await sandbox.run("/tmp/seq 1 3");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1\n2\n3");
  });

  const busyboxIt = HAS_BUSYBOX_FIXTURE ? it : it.skip;

  busyboxIt(
    "BusyBox is the default for /usr/bin/<applet> when busybox.wasm ships",
    async () => {
      // The sandbox auto-installs BusyBox applet symlinks at sandbox-
      // creation time when busybox.wasm is present in wasmDir.  This
      // is equivalent to running `busybox --install -s` once at boot:
      // every applet name in the curated list (declared in
      // test-fixtures/c-ports/busybox/manifest.json's `multicall.applets`,
      // shipped to wasmDir as busybox.manifest.json by the port's
      // copy-fixtures step) is symlinked /usr/bin/<applet> →
      // /usr/bin/busybox, and the registry entry for that name is
      // overridden to the busybox.wasm path so the shell dispatches
      // through the multicall binary.
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
      });

      sandbox.writeFile(
        "/tmp/data.txt",
        new TextEncoder().encode("foo\nbar\n"),
      );

      // /usr/bin/grep is a symlink to /usr/bin/busybox out of the box.
      const linkResult = await sandbox.run("readlink /usr/bin/grep");
      expect(linkResult.stdout.trim()).toBe("/usr/bin/busybox");

      // Bare `grep` resolves through PATH, follows the symlink, and
      // BusyBox's multicall dispatcher picks the grep applet from
      // argv[0].  BusyBox's --help banner says "BusyBox v..." which
      // discriminates against the standalone GNU-style Rust grep.
      const bbHelp = await sandbox.run("grep --help 2>&1");
      expect(bbHelp.stdout + bbHelp.stderr).toContain("BusyBox");

      // Functional dispatch — produces the expected match output.
      const bbGrep = await sandbox.run("grep foo /tmp/data.txt");
      expect(bbGrep.exitCode).toBe(0);
      expect(bbGrep.stdout.trim()).toBe("foo");

      // Absolute path through the symlink also dispatches.  argv[0]
      // is the basename of the path the user typed ("grep"), and
      // BusyBox routes on that — the symlink resolution to busybox.wasm
      // is what the kernel-side spawn picks, but the dispatcher reads
      // argv[0], not the resolved path.
      const bbAbsGrep = await sandbox.run("/usr/bin/grep foo /tmp/data.txt");
      expect(bbAbsGrep.exitCode).toBe(0);
      expect(bbAbsGrep.stdout.trim()).toBe("foo");

      // Direct `busybox <applet>` form still works regardless of PATH.
      const busyboxResult = await sandbox.run("busybox seq 3");
      expect(busyboxResult.exitCode).toBe(0);
      expect(busyboxResult.stdout).toBe("1\n2\n3\n");
    },
  );

  // dlopen-canary documents the Phase 1 shared-library contract.
  // Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md
  // Plan: docs/superpowers/plans/2026-05-09-shared-libraries-phase1.md
  //
  // happy_path is the first end-to-end gate for Phase 1: a real
  // dynamically-linked guest binary builds, loads, and calls a
  // function exported by a separately-compiled side module via
  // dlopen / dlsym. It runs only when the fixtures exist (built by
  // `make -C abi all copy-fixtures` in CI / locally with WASI SDK).
  // The remaining cases stay in `describe.ignore` until Phase 1 1F
  // dogfood validates the broader contract.
  //
  // SKIP: the happy_path is currently skipped because the Phase 1
  // dlopen wiring on the sandbox.run() path is incomplete — the main
  const dlcanaryIt = HAS_DLCANARY_FIXTURE ? it : it.skip;
  describe("dlopen-canary (Phase 1 shared libraries — happy path)", () => {
    dlcanaryIt(
      "happy_path: load /lib/libyurt_dlcanary.wasm and call yurt_dlcanary_double(21) → 42",
      async () => {
        // The Phase 1 search path resolves /lib/<name> against the
        // sandbox VFS. Use a HostMount at create time so the side
        // module is in place before the test runs anything — the
        // earlier sandbox.mkdir("/lib") + sandbox.writeFile() path
        // failed at mkdir (the sandbox's effective uid lacks
        // permission to mkdir at root) and then at writeFile (parent
        // /lib still missing).
        sandbox = await Sandbox.create({
          wasmDir: FIXTURES,
          adapter: new NodeAdapter(),
          mounts: [
            {
              path: "/lib",
              files: {
                "libyurt_dlcanary.wasm": readFileSync(
                  resolve(FIXTURES, "libyurt_dlcanary.wasm"),
                ),
              },
            },
          ],
        });


        const result = await sandbox.run("dlopen-canary --case happy_path");

        if (result.exitCode !== 0) {
          console.log("--- dlopen-canary stdout ---\n" + result.stdout);
          console.log("--- dlopen-canary stderr ---\n" + result.stderr);
        }
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toContain('"stdout":"dlcanary-ok"');
      },
    );
  });

  describe.ignore(
    "dlopen-canary (Phase 1 shared libraries — pending 1F)",
    () => {
      it("lazy_now_equiv: RTLD_LAZY and RTLD_NOW return identical handles", async () => {
        sandbox = await Sandbox.create({
          wasmDir: FIXTURES,
          adapter: new NodeAdapter(),
        });

        const result = await sandbox.run(
          "dlopen-canary --case lazy_now_equiv",
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toContain('"stdout":"lazy-now-ok"');
      });

      it("double_open_refcount: two opens, one close, dlsym still works", async () => {
        sandbox = await Sandbox.create({
          wasmDir: FIXTURES,
          adapter: new NodeAdapter(),
        });

        const result = await sandbox.run(
          "dlopen-canary --case double_open_refcount",
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toContain('"stdout":"refcount-ok"');
      });

      it("missing_path: dlopen returns NULL, dlerror is non-empty", async () => {
        sandbox = await Sandbox.create({
          wasmDir: FIXTURES,
          adapter: new NodeAdapter(),
        });

        const result = await sandbox.run("dlopen-canary --case missing_path");

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toContain('"stdout":"missing-path-ok"');
      });

      it("missing_symbol: dlsym returns NULL, dlerror is non-empty", async () => {
        sandbox = await Sandbox.create({
          wasmDir: FIXTURES,
          adapter: new NodeAdapter(),
        });

        const result = await sandbox.run(
          "dlopen-canary --case missing_symbol",
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toContain('"stdout":"missing-symbol-ok"');
      });

      it("bad_format: opening a non-side-module wasm is rejected", async () => {
        sandbox = await Sandbox.create({
          wasmDir: FIXTURES,
          adapter: new NodeAdapter(),
        });

        sandbox.writeFile(
          "/tmp/not-a-side-module.wasm",
          readFileSync(resolve(FIXTURES, "dup2-canary.wasm")),
        );

        const result = await sandbox.run("dlopen-canary --case bad_format");

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toContain('"stdout":"bad-format-ok"');
      });
    },
  );
});
