import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openStore } from "../server/store.js";
import { honeypotService } from "../server/honeypot.js";
import { validateConfig } from "../server/config.js";
import { config as fixture } from "./fixture.js";

const day = 86400000;
function setup(t, options = {}) {
  const config = {
    sessionSecret: "fixture secret",
    honeypot: { enabled: true, guildId: "2", channelId: "3" },
  };
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  let time = Date.now() + 10000;
  let available = true;
  const actions = [],
    notices = [],
    removed = [];
  const members = new Map([
    ["100", { moderatable: true, bannable: true }],
    ["200", { protected: true }],
  ]);
  const bans = new Map();
  const transport = {
    ready: () => available,
    async member(id) {
      return members.get(id);
    },
    async timeout(id, until) {
      actions.push({ id, action: "timeout", until });
      members.get(id).timeoutUntil = until;
    },
    async ban(id, reference) {
      actions.push({ id, action: "ban" });
      bans.set(id, reference);
      members.delete(id);
    },
    async isBanned(id, reference) {
      return bans.get(id) === reference;
    },
    async removeMessage(id) {
      removed.push(id);
    },
    async alert(value) {
      notices.push(value);
    },
    ...options,
  };
  const services = [];
  function start() {
    const service = honeypotService(config, store, transport, {
      now: () => time,
    });
    services.push(service);
    return service;
  }
  const service = start();
  t.after(async () => {
    for (const value of services) await value.close();
    store.close();
  });
  const message = (id = "1000", overrides = {}) => ({
    id,
    userId: "100",
    guildId: "2",
    channelId: "3",
    createdAt: time,
    ...overrides,
  });
  return {
    service,
    store,
    start,
    actions,
    notices,
    removed,
    message,
    members,
    transport,
    advance(value) {
      time += value;
    },
    available(value) {
      available = value;
    },
  };
}

test("a first post times out for 24 hours; a repeat after restart is a permanent ban", async (t) => {
  const app = setup(t);
  const first = app.message();
  assert.equal(app.service.observe(first), true);
  await app.service.pump();
  assert.equal(app.actions[0].until, first.createdAt + day);
  assert.deepEqual(app.service.state(), {
    paused: false,
    caught: 1,
    timeouts: 1,
    bans: 0,
  });
  await app.service.close();
  app.advance(day + 1);
  const restarted = app.start();
  assert.equal(restarted.observe(app.message("1001")), true);
  await restarted.pump();
  assert.deepEqual(
    app.actions.map((value) => value.action),
    ["timeout", "ban"],
  );
  assert.equal(restarted.state().bans, 1);
  assert.deepEqual(app.removed, ["1000", "1001"]);
});

test("duplicates, queued bursts and delayed events never escalate the first violation", async (t) => {
  const app = setup(t);
  const first = app.message();
  app.service.observe(first);
  assert.equal(app.service.observe(first), false);
  assert.equal(app.service.observe(app.message("1001")), false);
  await app.service.pump();
  app.advance(10000);
  assert.equal(
    app.service.observe(app.message("1002", { createdAt: first.createdAt })),
    false,
  );
  await app.service.pump();
  assert.equal(app.actions.length, 1);
  assert.equal(app.service.state().caught, 1);
});

test("unrelated guilds, channels, bot, webhook and system messages cannot moderate anyone", async (t) => {
  const app = setup(t);
  for (const input of [
    { guildId: "9" },
    { channelId: "4" },
    { bot: true },
    { webhook: true },
    { system: true },
    { createdAt: NaN },
    { userId: "invalid" },
  ])
    assert.equal(app.service.observe(app.message("1000", input)), false);
  app.service.observe(app.message("1001", { userId: "200" }));
  await app.service.pump();
  assert.equal(app.actions.length, 0);
  assert.equal(app.service.state().caught, 0);
  assert.equal(app.service.logs()[0].code, "protected_member");
});

test("permission failures are reported without counting a timeout or creating a repeat marker", async (t) => {
  const app = setup(t);
  app.members.get("100").moderatable = false;
  app.service.observe(app.message());
  await app.service.pump();
  assert.equal(app.service.logs()[0].result, "failed");
  assert.equal(app.store.entries("honeypot-strike").length, 0);
  app.members.get("100").moderatable = true;
  app.advance(100);
  app.service.observe(app.message("1001"));
  await app.service.pump();
  assert.equal(app.actions[0].action, "timeout");
});

test("ambiguous timeout and ban responses recover the original action once", async (t) => {
  const app = setup(t);
  const originalTimeout = app.transport.timeout;
  app.transport.timeout = async (...args) => {
    await originalTimeout(...args);
    throw new Error("Lost response");
  };
  app.service.observe(app.message());
  await app.service.pump();
  assert.equal(app.service.state().caught, 0);
  await app.service.close();
  const restarted = app.start();
  app.advance(3000);
  await restarted.pump();
  assert.equal(app.actions.length, 1);
  assert.equal(restarted.state().caught, 1);
  const originalBan = app.transport.ban;
  app.transport.ban = async (...args) => {
    await originalBan(...args);
    throw new Error("Lost response");
  };
  app.advance(day);
  restarted.observe(app.message("1001"));
  await restarted.pump();
  assert.equal(restarted.state().bans, 1);
  await restarted.pump();
  assert.equal(app.actions.length, 2);
});

test("a member becoming staff during the queue is exempt and unavailable setup fails closed", async (t) => {
  const app = setup(t);
  app.available(false);
  assert.equal(app.service.observe(app.message()), false);
  app.available(true);
  app.service.observe(app.message("1001"));
  app.members.get("100").protected = true;
  await app.service.pump();
  assert.equal(app.actions.length, 0);
});

test("pausing drains queued work, survives restart and reset is explicit without undoing Discord actions", async (t) => {
  const app = setup(t);
  app.service.observe(app.message());
  await app.service.pause(true, "200");
  await app.service.pump();
  assert.equal(app.actions.length, 0);
  await app.service.close();
  const restarted = app.start();
  assert.equal(restarted.observe(app.message("1001")), false);
  await restarted.pause(false, "200");
  app.advance(100);
  restarted.observe(app.message("1002"));
  await restarted.pump();
  await restarted.reset("100", "200");
  assert.equal(app.store.entries("honeypot-strike").length, 0);
  assert.ok(app.members.get("100").timeoutUntil);
  assert.equal(
    restarted.logs().find((entry) => entry.action === "reset").actorId,
    "200",
  );
});

test("content is never persisted; audit and repeat markers have bounded expiry", async (t) => {
  const app = setup(t);
  app.service.observe(
    app.message("1000", { content: "sensitive message body" }),
  );
  await app.service.pump();
  assert.equal(
    JSON.stringify(app.store.entries("honeypot-audit")).includes(
      "sensitive message body",
    ),
    false,
  );
  assert.equal(
    app.store.entries("honeypot-strike")[0][0].includes("100"),
    false,
  );
  assert.equal(app.service.logs()[0].userId, "100");
  app.advance(366 * day);
  // Simulate expired encrypted records without changing the process clock.
  for (const [id, value] of app.store.entries("honeypot-strike"))
    app.store.set("honeypot-strike", id, value, Date.now() - 1);
  for (const [id, value] of app.store.entries("honeypot-audit"))
    app.store.set("honeypot-audit", id, value, Date.now() - 1);
  assert.equal(app.service.logs().length, 0);
  app.service.observe(app.message("1001"));
  await app.service.pump();
  assert.equal(app.actions.at(-1).action, "timeout");
});

test("configuration requires the community guild and an explicit activation flag", () => {
  const config = {
    ...fixture,
    staffOrigin: "https://staff.example.com",
    todoOrigin: "https://todo.example.com",
    discordClientId: "5",
    discordClientSecret: "test",
    sessionSecret: "test",
    oidcClientSecret: "test",
    hulySecret: "test",
    hulyOwner: "test",
    hulyWorkspace: "test",
    hulyAccounts: "test",
    hulyUpstream: "test",
    databaseKey: randomBytes(32).toString("base64"),
    discordBotToken: "test",
    office: { ...fixture.office, categoryId: "6", inviteChannelId: "7" },
    roleSync: {
      guildId: "2",
      initialSource: "unchanged",
      roles: [{ staffId: "20", mainId: "200" }],
    },
    honeypot: { guildId: "2", channelId: "3", enabled: false },
  };
  assert.equal(validateConfig(config), config);
  for (const settings of [
    { ...config.honeypot, enabled: undefined },
    { ...config.honeypot, guildId: "1" },
    { ...config.honeypot, channelId: "bad" },
  ])
    assert.throws(
      () => validateConfig({ ...config, honeypot: settings }),
      /honeypot/,
    );
});

test("private Discord alerts are removed after 90 days and failed cleanup retries", async (t) => {
  const app = setup(t);
  app.transport.alert = async () => ({ id: "3000", channelId: "3001" });
  app.service.observe(app.message());
  await app.service.pump();
  assert.equal(app.store.entries("honeypot-alert-message").length, 1);
  app.advance(91 * day);
  let attempts = 0;
  app.transport.removeAlert = async () => {
    attempts++;
    throw new Error("Unavailable");
  };
  await app.service.pump();
  assert.equal(app.store.entries("honeypot-alert-message").length, 1);
  app.transport.removeAlert = async (receipt) => {
    attempts++;
    assert.equal(receipt.id, "3000");
  };
  await app.service.pump();
  assert.equal(attempts, 2);
  assert.equal(app.store.entries("honeypot-alert-message").length, 0);
});
