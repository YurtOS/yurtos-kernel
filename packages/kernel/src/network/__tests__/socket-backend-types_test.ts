import type { SocketBackend } from "../socket-backend.js";

const connectOnlyBackend: SocketBackend = {
  connect: () => ({ ok: true, socket: 1 }),
  send: () => ({ ok: true, bytes_sent: 0 }),
  recv: () => ({ ok: false, error: "EAGAIN" }),
  close: () => ({ ok: true }),
};

void connectOnlyBackend;
