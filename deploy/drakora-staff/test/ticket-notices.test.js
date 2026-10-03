import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { openStore } from "../server/store.js";
import { ticketService } from "../server/tickets.js";
import { ticketNotices } from "../server/ticket-notices.js";
import { validateConfig } from "../server/config.js";
import { rolePermissions } from "../server/role-permissions.js";
import { config as fixture } from "./fixture.js";

function setup(t, enabled = true) {
  const config = {
    ...fixture,
    tickets: { guildId: "2", ...(enabled ? { staffChannelId: "99" } : {}) },
  };
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  let time = 1800000000000;
  const now = () => time;
  const service = ticketService(config, store, rolePermissions(config, store), {
    now,
  });
  const sent = [];
  const transport = {
    async create(ticket) {
      service.bind(ticket.id, "100");
    },
    async message() {
      return { id: "101" };
    },
    async status() {},
    async notice(ticket, job) {
      sent.push({ id: ticket.id, event: job.event });
      return { id: String(sent.length) };
    },
  };
  const workers = [];
  function worker() {
    const value = ticketNotices(config, service, transport, { now });
    workers.push(value);
    return value;
  }
  t.after(async () => {
    for (const value of workers) await value.close();
    await service.stop();
    store.close();
  });
  const owner = { id: "100", name: "Player" };
  function create() {
    return service.create(owner, {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description:
        "A detailed issue with enough information for staff to help.",
    });
  }
  return {
    config,
    store,
    service,
    transport,
    sent,
    worker,
    create,
    owner,
    advance(ms) {
      time += ms;
    },
  };
}

test("notices wait for Discord links, persist through restart and remind once at one hour", async (t) => {
  const app = setup(t),
    first = app.worker(),
    ticket = app.create();
  await first.pump();
  assert.equal(app.sent.length, 0);
  assert.equal(app.store.entries("ticket-notice-outbox").length, 2);
  app.service.attach(app.transport);
  await app.service.pump();
  await first.pump();
  assert.deepEqual(app.sent, [{ id: ticket.id, event: "opened" }]);
  await first.close();
  const restarted = app.worker();
  app.advance(3599999);
  await restarted.pump();
  assert.equal(app.sent.length, 1);
  app.advance(1);
  await restarted.pump();
  assert.deepEqual(app.sent[1], { id: ticket.id, event: "unclaimed" });
  app.advance(7200000);
  await restarted.pump();
  assert.equal(app.sent.length, 2);
  assert.equal(app.store.entries("ticket-notice-outbox").length, 0);
});

test("claims and player closures cancel reminders, including while retrying", async (t) => {
  const app = setup(t),
    notices = app.worker();
  app.service.attach(app.transport);
  const claimed = app.create();
  await app.service.pump();
  await notices.pump();
  app.service.claim(
    { id: "200", name: "Helper", roles: ["10", "23"] },
    claimed.id,
  );
  const closed = app.create();
  await app.service.pump();
  await notices.pump();
  app.service.closeTicket(app.owner, closed.id, {});
  app.advance(3600000);
  await notices.pump();
  assert.equal(
    app.sent.filter((value) => value.event === "unclaimed").length,
    0,
  );
  for (const ticket of [claimed, closed])
    assert.equal(
      app.store.get("ticket-notice-delivery", `${ticket.id}:unclaimed`).status,
      "cancelled",
    );
});

test("notice outages do not block ticket replies and retry state survives worker restart", async (t) => {
  const app = setup(t),
    notices = app.worker();
  app.service.attach(app.transport);
  const ticket = app.create();
  await app.service.pump();
  const send = app.transport.notice;
  app.transport.notice = async () => {
    throw new Error("Unavailable");
  };
  await notices.pump();
  app.service.reply(app.owner, ticket.id, {
    requestId: randomUUID(),
    content: "Reply while notices are unavailable",
  });
  await app.service.pump();
  assert.equal(app.service.messages(ticket.id)[0].discordId, "101");
  assert.equal(
    app.store.get("ticket-notice-outbox", `${ticket.id}:opened`).attempts,
    1,
  );
  await notices.close();
  app.transport.notice = send;
  app.advance(2000);
  await app.worker().pump();
  assert.deepEqual(app.sent, [{ id: ticket.id, event: "opened" }]);
});

test("disabled notices do not queue jobs or call Discord", async (t) => {
  const app = setup(t, false);
  app.create();
  const notices = app.worker();
  notices.start();
  await notices.pump();
  assert.equal(app.store.entries("ticket-notice-outbox").length, 0);
  assert.equal(app.sent.length, 0);
});

test("notice retries are bounded and preserve failed work without resending", async (t) => {
  const app = setup(t),
    notices = app.worker();
  app.service.attach(app.transport);
  const ticket = app.create();
  await app.service.pump();
  let attempts = 0;
  app.transport.notice = async () => {
    attempts++;
    throw new Error("Unavailable");
  };
  for (let i = 0; i < 25; i++) {
    await notices.pump();
    app.advance(60000);
  }
  assert.equal(attempts, 20);
  assert.equal(
    app.store.get("ticket-notice-outbox", `${ticket.id}:opened`).failed,
    true,
  );
  assert.equal(app.store.entries("ticket-notice-outbox").length, 2);
});

test("staff notice configuration is optional and rejects malformed channel identifiers", () => {
  const config = {
    ...fixture,
    staffOrigin: "https://staff.example.invalid",
    todoOrigin: "https://todo.example.invalid",
    discordClientId: "3",
    discordBotToken: "fixture",
    databaseKey: randomBytes(32).toString("base64"),
    ...Object.fromEntries(
      [
        "discordClientSecret",
        "sessionSecret",
        "oidcClientSecret",
        "hulySecret",
        "hulyOwner",
        "hulyWorkspace",
        "hulyAccounts",
        "hulyUpstream",
      ].map((key) => [key, "fixture"]),
    ),
    office: { ...fixture.office, categoryId: "31", inviteChannelId: "32" },
    roleSync: {
      guildId: "2",
      initialSource: "staff",
      roles: [{ staffId: "20", mainId: "120" }],
    },
    applications: {
      publicOrigin: "https://public.example.invalid",
      databaseKey: randomBytes(32).toString("base64"),
      notificationChannelId: "9",
      specialistRoles: { builder: "51", artist: "52", developer: "25" },
    },
    tickets: {
      guildId: "2",
      archiveCategoryId: "8",
      databaseKey: randomBytes(32).toString("base64"),
      minecraftEnabled: false,
    },
  };
  assert.equal(validateConfig(config), config);
  config.tickets.staffChannelId = "1555475842925334578";
  assert.equal(validateConfig(config), config);
  for (const value of [
    null,
    "",
    "#tickets",
    "https://discord.com/channels/1/2",
    42,
  ]) {
    config.tickets.staffChannelId = value;
    assert.throws(() => validateConfig(config), /staff notice channel/);
  }
});
