import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type ListenerInfo,
  ListenerRegistry,
} from "../listener-registry.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("ListenerRegistry", () => {
  it("listen returns the requested port and a handle", () => {
    const reg = new ListenerRegistry();
    const r = reg.listen({ host: "127.0.0.1", port: 8888, backlog: 16 });
    expect(r.port).toBe(8888);
    expect(r.host).toBe("127.0.0.1");
    expect(typeof r.handle).toBe("number");
  });

  it("listen with port 0 allocates a unique ephemeral port", () => {
    const reg = new ListenerRegistry();
    const a = reg.listen({ host: "127.0.0.1", port: 0, backlog: 16 });
    const b = reg.listen({ host: "127.0.0.1", port: 0, backlog: 16 });
    expect(a.port).toBeGreaterThanOrEqual(49152);
    expect(b.port).toBeGreaterThan(a.port);
  });

  it("listen on the same host:port twice fails", () => {
    const reg = new ListenerRegistry();
    reg.listen({ host: "127.0.0.1", port: 9000, backlog: 16 });
    expect(() => reg.listen({ host: "127.0.0.1", port: 9000, backlog: 16 }))
      .toThrow(/in use/i);
  });

  it("wildcard bind blocks subsequent specific bind on the same port", () => {
    const reg = new ListenerRegistry();
    reg.listen({ host: "0.0.0.0", port: 9100, backlog: 16 });
    expect(() => reg.listen({ host: "127.0.0.1", port: 9100, backlog: 16 }))
      .toThrow(/in use/i);
    expect(() => reg.listen({ host: "localhost", port: 9100, backlog: 16 }))
      .toThrow(/in use/i);
  });

  it("specific bind blocks subsequent wildcard bind on the same port", () => {
    const reg = new ListenerRegistry();
    reg.listen({ host: "127.0.0.1", port: 9101, backlog: 16 });
    expect(() => reg.listen({ host: "0.0.0.0", port: 9101, backlog: 16 }))
      .toThrow(/in use/i);
  });

  it("localhost and 127.0.0.1 alias to the same listener", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "localhost", port: 7000, backlog: 16 });
    const conn = reg.connect({ host: "127.0.0.1", port: 7000 });
    expect(conn.ok).toBe(true);
    const accepted = await reg.accept(lr.handle);
    expect(accepted.localPort).toBe(7000);
  });

  it("connect to an unbound port fails", () => {
    const reg = new ListenerRegistry();
    const conn = reg.connect({ host: "127.0.0.1", port: 5555 });
    expect(conn.ok).toBe(false);
  });

  it("accept resolves when a connect happens after accept is awaited", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6000, backlog: 16 });
    const acceptPromise = reg.accept(lr.handle);
    const conn = reg.connect({ host: "127.0.0.1", port: 6000 });
    expect(conn.ok).toBe(true);
    const accepted = await acceptPromise;
    expect(accepted.localPort).toBe(6000);
    expect(accepted.peerPort).toBeGreaterThan(0);
  });

  it("accept resolves immediately if a connect happened first", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6001, backlog: 16 });
    reg.connect({ host: "127.0.0.1", port: 6001 });
    const accepted = await reg.accept(lr.handle);
    expect(accepted.localPort).toBe(6001);
  });

  it("multiple concurrent connects each get one accept", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6002, backlog: 16 });
    const c1 = reg.connect({ host: "127.0.0.1", port: 6002 });
    const c2 = reg.connect({ host: "127.0.0.1", port: 6002 });
    expect(c1.ok && c2.ok).toBe(true);
    const a1 = await reg.accept(lr.handle);
    const a2 = await reg.accept(lr.handle);
    expect(a1.socket).not.toBe(a2.socket);
  });

  it("rejects connects once the pending accept queue reaches backlog", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6004, backlog: 1 });

    const c1 = reg.connect({ host: "127.0.0.1", port: 6004 });
    expect(c1.ok).toBe(true);

    const c2 = reg.connect({ host: "127.0.0.1", port: 6004 });
    expect(c2.ok).toBe(false);
    if (!c2.ok) expect(c2.error).toMatch(/backlog/i);

    const accepted = await reg.accept(lr.handle);
    expect(accepted.localPort).toBe(6004);

    const c3 = reg.connect({ host: "127.0.0.1", port: 6004 });
    expect(c3.ok).toBe(true);
  });

  it("closeListener rejects pending accepts", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6003, backlog: 16 });
    const acceptPromise = reg.accept(lr.handle);
    reg.closeListener(lr.handle);
    await expect(acceptPromise).rejects.toThrow(/closed/i);
  });

  it("listListeners reports current bindings", () => {
    const reg = new ListenerRegistry();
    reg.listen({ host: "127.0.0.1", port: 6010, backlog: 16 });
    reg.listen({ host: "127.0.0.1", port: 6011, backlog: 16 });
    const list = reg.listListeners();
    const ports = list.map((l: ListenerInfo) => l.port).sort();
    expect(ports).toEqual([6010, 6011]);
  });

  it("emits listen / unlisten events", () => {
    const reg = new ListenerRegistry();
    const events: Array<[string, number]> = [];
    const off = reg.on(
      "listen",
      (info: ListenerInfo) => events.push(["listen", info.port]),
    );
    const offU = reg.on(
      "unlisten",
      (info: ListenerInfo) => events.push(["unlisten", info.port]),
    );
    const lr = reg.listen({ host: "127.0.0.1", port: 6020, backlog: 16 });
    reg.closeListener(lr.handle);
    off();
    offU();
    expect(events).toEqual([["listen", 6020], ["unlisten", 6020]]);
  });
});

describe("ListenerRegistry socket I/O", () => {
  it("send delivers bytes to the peer recv", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7100, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7100 });
    if (!c.ok) throw new Error("connect failed");
    const accepted = await reg.accept(lr.handle);
    reg.send(c.socket, enc.encode("hello"));
    const got = await reg.recvAsync(accepted.socket, 1024);
    if (!got.ok) throw new Error("recv failed");
    expect(dec.decode(got.bytes)).toBe("hello");
  });

  it("recv returns EAGAIN when nonblocking and no data", () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7101, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7101 });
    if (!c.ok) throw new Error("connect failed");
    const r = reg.recv(c.socket, 1024, { nonblocking: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("EAGAIN");
    void lr;
  });

  it("recvAsync resolves with empty bytes when peer closes", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7102, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7102 });
    if (!c.ok) throw new Error("connect failed");
    const accepted = await reg.accept(lr.handle);
    const recvPromise = reg.recvAsync(accepted.socket, 1024);
    reg.closeSocket(c.socket);
    const got = await recvPromise;
    if (!got.ok) throw new Error("recv failed");
    expect(got.bytes.length).toBe(0);
  });

  it("partial recv leaves remainder for next call", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7103, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7103 });
    if (!c.ok) throw new Error("connect failed");
    const accepted = await reg.accept(lr.handle);
    reg.send(c.socket, enc.encode("hello world"));
    const r1 = await reg.recvAsync(accepted.socket, 5);
    const r2 = await reg.recvAsync(accepted.socket, 1024);
    if (!r1.ok || !r2.ok) throw new Error("recv failed");
    expect(dec.decode(r1.bytes)).toBe("hello");
    expect(dec.decode(r2.bytes)).toBe(" world");
  });

  it("closeSocket wakes the closer's own pending recvAsync", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7110, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7110 });
    if (!c.ok) throw new Error("connect failed");
    await reg.accept(lr.handle);
    const recvPromise = reg.recvAsync(c.socket, 1024);
    reg.closeSocket(c.socket);
    const got = await recvPromise;
    expect(got.ok).toBe(false);
  });

  it("closeListener delivers EOF to clients with unclaimed accepts", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7111, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7111 });
    if (!c.ok) throw new Error("connect failed");
    // Note: NO accept call. The connection sits in listener.pending.
    const recvPromise = reg.recvAsync(c.socket, 1024);
    reg.closeListener(lr.handle);
    const got = await recvPromise;
    if (!got.ok) throw new Error("expected EOF, got error: " + got.error);
    expect(got.bytes.length).toBe(0);
  });

  it("send to closed peer fails", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7104, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7104 });
    if (!c.ok) throw new Error("connect failed");
    const accepted = await reg.accept(lr.handle);
    reg.closeSocket(accepted.socket);
    const r = reg.send(c.socket, enc.encode("x"));
    expect(r.ok).toBe(false);
  });
});

describe("ListenerRegistry AF_UNIX pathname sockets", () => {
  it("listenOnPath returns a handle and sets localPath", () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnPath("/tmp/test.sock", 16);
    expect(typeof handle).toBe("number");
    const list = reg.listListeners();
    const entry = list.find((l: ListenerInfo) => l.localPath === "/tmp/test.sock");
    expect(entry).toBeDefined();
    expect(entry!.host).toBeUndefined();
    expect(entry!.port).toBe(0);
  });

  it("listenOnPath twice on the same path throws EADDRINUSE", () => {
    const reg = new ListenerRegistry();
    reg.listenOnPath("/tmp/dup.sock", 16);
    expect(() => reg.listenOnPath("/tmp/dup.sock", 16)).toThrow(/in use/i);
  });

  it("connectToPath fails when no listener is bound", () => {
    const reg = new ListenerRegistry();
    const r = reg.connectToPath("/tmp/nobody.sock");
    expect(r.ok).toBe(false);
  });

  it("connectToPath succeeds and returns matching path info", () => {
    const reg = new ListenerRegistry();
    reg.listenOnPath("/tmp/conn.sock", 16);
    const r = reg.connectToPath("/tmp/conn.sock");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.peerPath).toBe("/tmp/conn.sock");
    expect(r.localPath).toBe("/tmp/conn.sock");
  });

  it("acceptUnix resolves when connect arrives after await", async () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnPath("/tmp/accept-async.sock", 16);
    const acceptP = reg.acceptUnix(handle);
    const conn = reg.connectToPath("/tmp/accept-async.sock");
    expect(conn.ok).toBe(true);
    const accepted = await acceptP;
    expect(accepted.localPath).toBe("/tmp/accept-async.sock");
    expect(typeof accepted.socket).toBe("number");
  });

  it("acceptNowUnix returns immediately when connect already queued", () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnPath("/tmp/accept-now.sock", 16);
    reg.connectToPath("/tmp/accept-now.sock");
    const accepted = reg.acceptNowUnix(handle);
    expect(accepted).not.toBeNull();
    expect(accepted!.localPath).toBe("/tmp/accept-now.sock");
  });

  it("acceptNowUnix returns null when queue is empty", () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnPath("/tmp/accept-empty.sock", 16);
    expect(reg.acceptNowUnix(handle)).toBeNull();
  });

  it("backlog enforcement: connects beyond backlog fail", () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnPath("/tmp/backlog.sock", 1);
    const c1 = reg.connectToPath("/tmp/backlog.sock");
    expect(c1.ok).toBe(true);
    const c2 = reg.connectToPath("/tmp/backlog.sock");
    expect(c2.ok).toBe(false);
    if (!c2.ok) expect(c2.error).toMatch(/backlog/i);
    // after draining one, a new connect succeeds
    reg.acceptNowUnix(handle);
    const c3 = reg.connectToPath("/tmp/backlog.sock");
    expect(c3.ok).toBe(true);
  });

  it("closePathListener rejects pending acceptUnix waiters", async () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnPath("/tmp/close-path.sock", 16);
    const acceptP = reg.acceptUnix(handle);
    reg.closePathListener("/tmp/close-path.sock");
    await expect(acceptP).rejects.toThrow(/closed/i);
  });

  it("closePathListener makes subsequent connectToPath fail", () => {
    const reg = new ListenerRegistry();
    reg.listenOnPath("/tmp/close-conn.sock", 16);
    reg.closePathListener("/tmp/close-conn.sock");
    const r = reg.connectToPath("/tmp/close-conn.sock");
    expect(r.ok).toBe(false);
  });

  it("data flows between connectToPath client and acceptUnix server", async () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnPath("/tmp/data.sock", 16);
    const connResult = reg.connectToPath("/tmp/data.sock");
    if (!connResult.ok) throw new Error("connect failed");
    const accepted = await reg.acceptUnix(handle);
    reg.send(connResult.socket, enc.encode("ping"));
    const got = await reg.recvAsync(accepted.socket, 1024);
    if (!got.ok) throw new Error("recv failed");
    expect(dec.decode(got.bytes)).toBe("ping");
  });

  it("listListeners includes unix listeners with no host/port", () => {
    const reg = new ListenerRegistry();
    reg.listen({ host: "127.0.0.1", port: 8100, backlog: 16 });
    reg.listenOnPath("/tmp/list.sock", 16);
    const list = reg.listListeners();
    const tcp = list.find((l: ListenerInfo) => l.port === 8100);
    const unix = list.find((l: ListenerInfo) => l.localPath === "/tmp/list.sock");
    expect(tcp!.host).toBe("127.0.0.1");
    expect(unix!.host).toBeUndefined();
    expect(unix!.port).toBe(0); // AF_UNIX listeners have no port
  });
});

describe("ListenerRegistry AF_UNIX abstract namespace", () => {
  it("listenOnAbstract returns a handle with NUL-prefixed localPath", () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnAbstract("myservice", 16);
    expect(typeof handle).toBe("number");
    const list = reg.listListeners();
    const entry = list.find((l: ListenerInfo) => l.localPath === "\0myservice");
    expect(entry).toBeDefined();
  });

  it("listenOnAbstract twice on the same name throws", () => {
    const reg = new ListenerRegistry();
    reg.listenOnAbstract("dup-abstract", 16);
    expect(() => reg.listenOnAbstract("dup-abstract", 16)).toThrow(/in use/i);
  });

  it("connectToAbstract fails when no listener is bound", () => {
    const reg = new ListenerRegistry();
    const r = reg.connectToAbstract("nobody");
    expect(r.ok).toBe(false);
  });

  it("connectToAbstract succeeds and both paths carry the NUL prefix", () => {
    const reg = new ListenerRegistry();
    reg.listenOnAbstract("svc", 16);
    const r = reg.connectToAbstract("svc");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.peerPath).toBe("\0svc");
    expect(r.localPath).toBe("\0svc");
  });

  it("acceptUnix resolves for abstract listener", async () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnAbstract("async-svc", 16);
    const acceptP = reg.acceptUnix(handle);
    reg.connectToAbstract("async-svc");
    const accepted = await acceptP;
    expect(accepted.localPath).toBe("\0async-svc");
  });

  it("closeAbstractListener rejects pending acceptUnix waiters", async () => {
    const reg = new ListenerRegistry();
    const handle = reg.listenOnAbstract("close-svc", 16);
    const acceptP = reg.acceptUnix(handle);
    reg.closeAbstractListener("close-svc");
    await expect(acceptP).rejects.toThrow(/closed/i);
  });

  it("closeAbstractListener makes subsequent connectToAbstract fail", () => {
    const reg = new ListenerRegistry();
    reg.listenOnAbstract("gone-svc", 16);
    reg.closeAbstractListener("gone-svc");
    expect(reg.connectToAbstract("gone-svc").ok).toBe(false);
  });

  it("abstract and pathname listeners with matching names are independent", () => {
    const reg = new ListenerRegistry();
    reg.listenOnPath("/tmp/overlap.sock", 16);
    reg.listenOnAbstract("/tmp/overlap.sock", 16); // same string, different namespace
    const rPath = reg.connectToPath("/tmp/overlap.sock");
    const rAbstract = reg.connectToAbstract("/tmp/overlap.sock");
    expect(rPath.ok).toBe(true);
    expect(rAbstract.ok).toBe(true);
  });
});

describe("ListenerRegistry AF_UNIX socketpair", () => {
  it("openUnixPair returns two different socket handles", () => {
    const reg = new ListenerRegistry();
    const { a, b } = reg.openUnixPair();
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
    expect(a).not.toBe(b);
  });

  it("openUnixPair sockets carry bytes in both directions", async () => {
    const reg = new ListenerRegistry();
    const { a, b } = reg.openUnixPair();
    reg.send(a, enc.encode("hello"));
    reg.send(b, enc.encode("world"));
    const fromA = await reg.recvAsync(b, 1024);
    const fromB = await reg.recvAsync(a, 1024);
    if (!fromA.ok || !fromB.ok) throw new Error("recv failed");
    expect(dec.decode(fromA.bytes)).toBe("hello");
    expect(dec.decode(fromB.bytes)).toBe("world");
  });

  it("openUnixPair: closing one end delivers EOF to the other", async () => {
    const reg = new ListenerRegistry();
    const { a, b } = reg.openUnixPair();
    const recvP = reg.recvAsync(b, 1024);
    reg.closeSocket(a);
    const got = await recvP;
    if (!got.ok) throw new Error("expected EOF");
    expect(got.bytes.length).toBe(0);
  });
});
