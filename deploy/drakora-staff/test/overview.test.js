import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { minecraftStatus, networkMonitor } from "../server/network-status.js";
import { overviewService } from "../server/overview.js";
import { discordOverview } from "../server/discord-overview.js";
import { ChannelType } from "discord.js";
import { validateConfig } from "../server/config.js";
import { config as fixture } from "./fixture.js";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Minecraft status handles fragmented responses and closes stalled connections", async (t) => {
  const sockets = new Set();
  let extension = Buffer.alloc(0);
  const wireLength = (length) =>
    Buffer.from(length < 128 ? [length] : [(length & 127) | 128, length >>> 7]);
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      const body = Buffer.from(
        JSON.stringify({
          version: { name: "Test", protocol: 767 },
          players: { online: 12 },
        }),
      );
      const packet = Buffer.concat([
        wireLength(
          1 + wireLength(body.length).length + body.length + extension.length,
        ),
        Buffer.from([0]),
        wireLength(body.length),
        body,
        extension,
      ]);
      socket.write(packet.subarray(0, 1));
      setImmediate(() => socket.write(packet.subarray(1)));
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const status = await minecraftStatus({
    host: "127.0.0.1",
    port: server.address().port,
  });
  assert.equal(status.online, true);
  assert.equal(status.players, 12);
  extension = Buffer.from([5, ...Buffer.from("extra")]);
  assert.equal(
    (await minecraftStatus({ host: "127.0.0.1", port: server.address().port }))
      .players,
    12,
  );
  server.removeAllListeners("connection");
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  assert.deepEqual(
    await minecraftStatus(
      { host: "127.0.0.1", port: server.address().port },
      { timeout: 20 },
    ),
    { online: false, players: null },
  );
});

test("network totals exclude proxies and concurrent viewers share one fresh probe", async () => {
  let count = 0;
  let now = 100;
  const servers = [
    {
      id: "proxy",
      name: "Proxy",
      kind: "proxy",
      group: "Network",
      host: "private.invalid",
      port: 25565,
    },
    {
      id: "hub",
      name: "Hub",
      kind: "server",
      group: "Network",
      host: "private.invalid",
      port: 25566,
    },
    {
      id: "void",
      name: "Void",
      kind: "server",
      group: "Network",
      host: "private.invalid",
      port: 25567,
    },
  ];
  const monitor = networkMonitor(
    servers,
    async (server) => {
      count++;
      return {
        online: server.id !== "void",
        players: server.id === "void" ? null : 5,
      };
    },
    () => now,
  );
  const [a, b] = await Promise.all([monitor.snapshot(), monitor.snapshot()]);
  assert.equal(a, b);
  assert.equal(count, 3);
  assert.equal(a.players, 5);
  assert.equal(a.complete, false);
  assert.equal(a.reachable, 2);
  assert.doesNotMatch(JSON.stringify(a), /private.invalid|25565/);
  await monitor.snapshot();
  assert.equal(count, 3);
  now += 15000;
  await monitor.snapshot();
  assert.equal(count, 6);
});

test("private Unix relays use the same Minecraft status protocol", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "minecraft-status-test-"));
  const socketPath = join(directory, "status.sock");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      const body = Buffer.from(
        '{"version":{"protocol":763},"players":{"online":7}}',
      );
      socket.end(
        Buffer.concat([Buffer.from([body.length + 2, 0, body.length]), body]),
      );
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const status = await minecraftStatus({
    host: "private.invalid",
    port: 25565,
    socketPath,
  });
  assert.equal(status.online, true);
  assert.equal(status.players, 7);
});

test("Overview never reads private application or email counts without permission", async () => {
  let applications = 0;
  let email = 0;
  const service = overviewService(
    { mail: {}, overview: { servers: [] } },
    {
      applications: {
        attention: () => {
          applications++;
          return { pending: 3 };
        },
      },
      mail: {
        identities: [{ address: "support@drakora.org" }],
        attention: async () => {
          email++;
          return { unanswered: 2, unread: 1 };
        },
      },
    },
  );
  const user = { permissions: { dashboard: true }, capabilities: {} };
  const denied = await service.snapshot(user);
  assert.equal(denied.applications, null);
  assert.equal(denied.email, null);
  assert.equal(applications, 0);
  assert.equal(email, 0);
  user.capabilities = {
    "applications.view": true,
    "mail.view": true,
    "mail.inbox.support@drakora.org.view": true,
  };
  const allowed = await service.snapshot(user);
  assert.equal(allowed.applications.pending, 3);
  assert.equal(allowed.email.unanswered, 2);
  await service.snapshot(user);
  assert.equal(email, 1);
});

test("Discord queue counts respect channel access and exclude closed forum posts", async () => {
  const permissionsFor = (allowed) => () => ({ has: () => allowed });
  const parent = {
    id: "forum",
    type: ChannelType.GuildForum,
    permissionsFor: permissionsFor(true),
  };
  const guild = {
    id: "guild",
    members: { fetch: async () => ({ id: "staff" }) },
    channels: {
      fetch: async () => new Map([[parent.id, parent]]),
      fetchActiveThreads: async () => ({
        threads: new Map([
          [
            "open",
            {
              parentId: "forum",
              permissionsFor: permissionsFor(true),
              appliedTags: [],
            },
          ],
          [
            "hidden",
            {
              parentId: "forum",
              permissionsFor: permissionsFor(false),
              appliedTags: [],
            },
          ],
          [
            "done",
            {
              parentId: "forum",
              permissionsFor: permissionsFor(true),
              appliedTags: ["closed"],
            },
          ],
        ]),
      }),
    },
  };
  const config = {
    overview: {
      queues: [
        {
          kind: "appeals",
          name: "Appeals",
          mode: "forum",
          guildId: "guild",
          channelId: "forum",
          closedTagIds: ["closed"],
        },
      ],
    },
  };
  const queues = discordOverview(
    config,
    { guilds: { fetch: async () => guild } },
    () => true,
  );
  assert.equal((await queues({ id: "staff" }))[0].count, 1);
  parent.permissionsFor = permissionsFor(false);
  assert.deepEqual(await queues({ id: "staff" }), []);
  parent.type = ChannelType.GuildCategory;
  guild.channels.fetch = async () =>
    new Map([
      [parent.id, parent],
      [
        "ticket",
        {
          id: "ticket",
          parentId: "forum",
          type: ChannelType.GuildText,
          permissionsFor: permissionsFor(true),
        },
      ],
      [
        "logs",
        {
          id: "logs",
          parentId: "forum",
          type: ChannelType.GuildText,
          permissionsFor: permissionsFor(true),
        },
      ],
    ]);
  config.overview.queues[0].mode = "category";
  config.overview.queues[0].excludedChannelIds = ["logs"];
  const categories = discordOverview(
    config,
    { guilds: { fetch: async () => guild } },
    () => true,
  );
  const tickets = await categories({ id: "staff" });
  assert.equal(tickets[0].count, 1);
  assert.equal(tickets[0].href, "https://discord.com/channels/guild/ticket");
});

test("slow email counts do not hold up Overview and failed scans are cached", async () => {
  let complete;
  let scans = 0;
  const user = {
    capabilities: {
      "mail.view": true,
      "mail.inbox.support@drakora.org.view": true,
    },
  };
  const mail = {
    identities: [{ address: "support@drakora.org" }],
    attention: () => {
      scans++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  };
  const service = overviewService({ mail: {} }, { mail });
  const loading = await service.snapshot(user);
  assert.equal(loading.email.loading, true);
  complete({ unanswered: 2, unread: 0 });
  assert.equal((await service.snapshot(user)).email.unanswered, 2);
  assert.equal(scans, 1);
  const failed = overviewService(
    { mail: {} },
    {
      mail: {
        identities: [{ address: "support@drakora.org" }],
        attention: async () => {
          scans++;
          throw new Error("private detail");
        },
      },
    },
  );
  assert.equal((await failed.snapshot(user)).email.available, false);
  assert.equal((await failed.snapshot(user)).email.available, false);
  assert.equal(scans, 2);
});

test("Overview configuration rejects duplicate endpoints and invalid queue exclusions", () => {
  const valid = {
    ...fixture,
    office: undefined,
    staffOrigin: "https://staff.example.com",
    todoOrigin: "https://todo.example.com",
    discordClientId: "2",
    discordClientSecret: "fixture",
    sessionSecret: "fixture",
    oidcClientSecret: "fixture",
    hulySecret: "fixture",
    hulyOwner: "fixture",
    hulyWorkspace: "fixture",
    hulyAccounts: "fixture",
    hulyUpstream: "fixture",
    databaseKey: randomBytes(32).toString("base64"),
    overview: {
      servers: [
        {
          id: "hub",
          name: "Hub",
          group: "Network",
          kind: "server",
          host: "127.0.0.1",
          port: 25565,
        },
      ],
    },
  };
  assert.equal(validateConfig(valid), valid);
  const duplicate = structuredClone(valid);
  duplicate.overview.servers.push({
    ...duplicate.overview.servers[0],
    id: "another",
  });
  assert.throws(() => validateConfig(duplicate), /distinct named/);
  const badQueue = structuredClone(valid);
  badQueue.overview.queues = [
    {
      kind: "tickets",
      guildId: "1",
      channelId: "2",
      mode: "category",
      name: "Tickets",
      excludedChannelIds: ["invalid"],
    },
  ];
  assert.throws(() => validateConfig(badQueue), /ticket and appeal queues/);
});
