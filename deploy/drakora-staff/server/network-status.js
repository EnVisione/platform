import { createConnection } from "node:net";

const maximumPacket = 262144;

function varint(value) {
  const bytes = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function readVarint(buffer, offset = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null;
    const byte = buffer[offset + i];
    value |= (byte & 127) << (i * 7);
    if (!(byte & 128)) return { value, next: offset + i + 1 };
  }
  throw new Error("Invalid status packet");
}

export function minecraftStatus(server, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = createConnection(
      server.socketPath
        ? { path: server.socketPath }
        : { host: server.host, port: server.port },
    );
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const unavailable = () => finish({ online: false, players: null });
    const timer = setTimeout(unavailable, timeout);
    socket.once("error", unavailable);
    socket.once("end", unavailable);
    socket.once("close", unavailable);
    socket.once("connect", () => {
      const host = Buffer.from(server.host);
      const port = Buffer.alloc(2);
      port.writeUInt16BE(server.port);
      const handshake = Buffer.concat([
        varint(0),
        varint(767),
        varint(host.length),
        host,
        port,
        varint(1),
      ]);
      socket.write(
        Buffer.concat([
          varint(handshake.length),
          handshake,
          Buffer.from([1, 0]),
        ]),
      );
    });
    socket.on("data", (chunk) => {
      try {
        if (buffer.length + chunk.length > maximumPacket) return unavailable();
        buffer = Buffer.concat([buffer, chunk]);
        const packet = readVarint(buffer);
        if (!packet) return;
        if (packet.value < 2 || packet.value > maximumPacket)
          return unavailable();
        const end = packet.next + packet.value;
        if (buffer.length < end) return;
        const id = readVarint(buffer, packet.next);
        if (id?.value !== 0) return unavailable();
        const length = readVarint(buffer, id.next);
        if (!length || length.value < 0 || length.next + length.value > end)
          return unavailable();
        const status = JSON.parse(
          buffer
            .subarray(length.next, length.next + length.value)
            .toString("utf8"),
        );
        if (!Number.isSafeInteger(status?.version?.protocol))
          return unavailable();
        const players = status.players?.online;
        finish({
          online: true,
          players:
            Number.isSafeInteger(players) && players >= 0 ? players : null,
          responseMs: Date.now() - started,
        });
      } catch {
        unavailable();
      }
    });
  });
}

export function networkMonitor(
  servers = [],
  probe = minecraftStatus,
  now = Date.now,
) {
  let cached;
  let pending;
  return {
    snapshot() {
      if (cached && now() - cached.checkedAt < 15000)
        return Promise.resolve(cached);
      if (pending) return pending;
      pending = Promise.all(
        servers.map(async (server) => {
          let status;
          try {
            status = await probe(server);
          } catch {
            status = { online: false, players: null };
          }
          return {
            id: server.id,
            name: server.name,
            group: server.group,
            kind: server.kind,
            ...status,
          };
        }),
      )
        .then((items) => {
          const gameServers = items.filter(
            (server) => server.kind === "server",
          );
          const reporting = gameServers.filter(
            (server) => server.online && server.players !== null,
          );
          cached = {
            configured: items.length > 0,
            checkedAt: now(),
            servers: items,
            reachable: items.filter((server) => server.online).length,
            players: reporting.reduce(
              (total, server) => total + server.players,
              0,
            ),
            complete:
              gameServers.length > 0 && reporting.length === gameServers.length,
          };
          return cached;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
