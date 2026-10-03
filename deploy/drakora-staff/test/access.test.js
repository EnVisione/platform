import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { permissions as evaluatePermissions } from "../server/roles.js";
import { config, ranks, accessRoles } from "./fixture.js";
const permissions = (roles) => evaluatePermissions(config, roles);
import { openStore } from "../server/store.js";
import { discordClient } from "../server/discord.js";
import { memberActivity } from "../server/activity.js";

test("Dashboard admission grants workspace access without the legacy Todo role", () => {
  for (const rank of ranks) {
    assert.equal(permissions([rank.id]).dashboard, false);
    assert.equal(permissions([rank.id]).todo, false);
  }
  assert.equal(permissions([accessRoles.dashboard]).todo, true);
  assert.equal(permissions([accessRoles.todo]).dashboard, false);
  const both = permissions(Object.values(accessRoles));
  assert.equal(both.dashboard && both.todo, true);
});
test("Discord sign-in requires Dashboard even for Todo members", async () => {
  const records = new Map();
  const store = {
    get: (_, id) => records.get(id),
    set: (_, id, value) => records.set(id, value),
  };
  let roles = [accessRoles.todo];
  const client = discordClient(config, store, async (url) => {
    if (url.endsWith("/oauth2/token"))
      return Response.json({ access_token: "test", expires_in: 3600 });
    if (url.endsWith("/users/@me"))
      return Response.json({
        id: "42",
        email: "staff@example.invalid",
        verified: true,
        username: "staff",
      });
    return Response.json({ roles });
  });
  await assert.rejects(client.login("code"), {
    code: "dashboard_role_required",
    status: 403,
  });
  roles = [accessRoles.dashboard];
  const admitted = await client.login("code");
  assert.equal(admitted.permissions.dashboard, true);
  assert.equal(admitted.permissions.todo, true);
});
test("highest rank determines Huly permissions and specialist roles stay in Huly", () => {
  assert.equal(permissions(ranks.map((role) => role.id)).hulyRole, "OWNER");
  assert.equal(
    permissions(ranks.slice(1).map((role) => role.id)).hulyRole,
    "MAINTAINER",
  );
  assert.equal(
    permissions(
      ranks.filter((role) => role.huly === "USER").map((role) => role.id),
    ).hulyRole,
    "USER",
  );
  const specialist = permissions(
    ranks.filter((role) => !role.dashboard).map((role) => role.id),
  );
  assert.deepEqual(specialist.dashboardRanks, []);
  assert.deepEqual(specialist.hulyRanks, [
    "Developer",
    "Discord Management",
    "Server Management",
  ]);
});
test("persistent store encrypts secrets, expires data, and consumes handoffs once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "drakora-store-"));
  const path = join(dir, "test.sqlite");
  const key = randomBytes(32).toString("base64");
  const { store, OidcAdapter } = openStore(path, key);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true });
  });
  const testSecret = randomBytes(32).toString("hex");
  store.set("handoff", "one", { secret: testSecret });
  assert.deepEqual(store.take("handoff", "one"), {
    secret: testSecret,
  });
  assert.equal(store.take("handoff", "one"), undefined);
  store.set("handoff", "expired", {}, Date.now() - 1);
  assert.equal(store.get("handoff", "expired"), undefined);
  for (const file of [path, `${path}-wal`])
    assert.equal(readFileSync(file).includes(testSecret), false);
  const adapter = new OidcAdapter("AuthorizationCode");
  await adapter.upsert(
    "code",
    { grantId: "grant", exp: Math.floor(Date.now() / 1000) + 60 },
    60,
  );
  await adapter.consume("code");
  assert.equal(typeof (await adapter.find("code")).consumed, "number");
  await adapter.revokeByGrantId("grant");
  assert.equal(await adapter.find("code"), undefined);
});
test("Discord role removal is applied and API errors never grant access", async () => {
  const records = new Map();
  const store = {
    get: (_, id) => records.get(id),
    set: (_, id, value) => records.set(id, value),
  };
  records.set("42", {
    id: "42",
    tokens: { access_token: "test" },
    tokenExpires: Date.now() + 999999,
    checkedAt: 0,
  });
  let status = 200;
  let body = { roles: [accessRoles.dashboard] };
  const client = discordClient(
    config,
    store,
    async () => new Response(JSON.stringify(body), { status }),
  );
  assert.equal((await client.check("42", true)).permissions.todo, true);
  body = { roles: [] };
  assert.equal((await client.check("42", true)).permissions.todo, false);
  body = { roles: [accessRoles.dashboard], pending: true };
  assert.equal((await client.check("42", true)).permissions.todo, false);
  status = 503;
  await assert.rejects(client.check("42", true), {
    code: "discord_unavailable",
  });
  status = 404;
  assert.equal((await client.check("42", true)).permissions.todo, false);
});

test("staff-server membership is required at login and bot checks fail closed", async (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  let member,
    available = true;
  const client = discordClient(
    config,
    store,
    async (url) => {
      if (url.endsWith("/oauth2/token"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      assert.ok(url.endsWith("/users/@me"));
      return Response.json({
        id: "42",
        verified: true,
        email: "staff@example.invalid",
        username: "staff",
      });
    },
    undefined,
    {
      available: () => available,
      member: async () => member,
    },
  );
  await assert.rejects(client.login("code"), { code: "staff_server_required" });
  member = { roles: [accessRoles.dashboard], pending: true };
  await assert.rejects(client.login("code"), { code: "staff_server_required" });
  member = { roles: [accessRoles.dashboard] };
  assert.equal((await client.login("code")).staffMember, true);
  available = false;
  await assert.rejects(client.check("42"), {
    code: "discord_unavailable",
    status: 503,
  });
});

test("gateway revocation ends exact staff sessions and wins against in-flight role checks", async (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  const until = Date.now() + 60000;
  store.set("user", "42", {
    id: "42",
    tokens: { access_token: "test" },
    tokenExpires: until,
    checkedAt: 0,
  });
  for (const [id, session] of [
    ["staff", { userId: "42", until }],
    ["workspace", { userId: "42", staffSessionId: "staff", until }],
    ["other", { userId: "43", until }],
    ["player", { ticketIdentity: { id: "42" }, until }],
  ])
    store.set("session", id, session, until);
  let resolveMember;
  const client = discordClient(config, store, undefined, undefined, {
    available: () => true,
    member: () =>
      new Promise((resolve) => {
        resolveMember = resolve;
      }),
  });
  const checking = client.check("42", true);
  const event = {
    t: "GUILD_MEMBER_REMOVE",
    d: { guild_id: config.guildId, user: { id: "42" } },
  };
  assert.equal(
    client.observe({ ...event, d: { ...event.d, guild_id: "main" } }),
    undefined,
  );
  assert.ok(store.get("session", "staff"));
  assert.deepEqual(client.observe(event), { id: "42", revoked: true });
  resolveMember({ roles: [accessRoles.dashboard] });
  const user = await checking;
  assert.equal(user.staffMember, false);
  assert.equal(user.permissions.dashboard, false);
  assert.equal(user.accessEpoch, 1);
  assert.equal(store.get("session", "staff"), undefined);
  assert.equal(store.get("session", "workspace"), undefined);
  assert.ok(store.get("session", "other"));
  assert.ok(store.get("session", "player"));
  client.observe({
    t: "GUILD_MEMBER_ADD",
    d: { ...event.d, roles: [accessRoles.dashboard] },
  });
  assert.equal(store.get("user", "42").accessEpoch, 1);
  client.observe({
    t: "GUILD_MEMBER_UPDATE",
    d: { ...event.d, roles: ["23"] },
  });
  assert.equal(store.get("user", "42").permissions.dashboard, false);
  assert.equal(store.get("user", "42").accessEpoch, 2);
});
test("last active records presence and invisible messages and survives a restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "drakora-activity-"));
  const path = join(dir, "test.sqlite");
  const key = randomBytes(32).toString("base64");
  t.after(() => rmSync(dir, { recursive: true }));
  const first = openStore(path, key);
  const observed = Date.now();
  try {
    const activity = memberActivity(first.store, {
      guildIds: ["1", "2"],
      isMember: (id) => id === "42",
    });
    assert.equal(activity.lastActiveAt("42"), undefined);
    activity.observe("42", "online", observed);
    activity.observe("42", "offline", observed + 1000);
    assert.equal(activity.lastActiveAt("42"), observed);
    activity.observeMessage({
      guildId: "2",
      author: { id: "42", bot: false },
      createdTimestamp: observed + 1000,
    });
    assert.equal(activity.lastActiveAt("42"), observed + 1000);
    assert.deepEqual(first.store.get("member-activity", "42"), {
      lastActiveAt: observed + 1000,
    });
  } finally {
    first.store.close();
  }
  const second = openStore(path, key);
  try {
    assert.equal(
      memberActivity(second.store).lastActiveAt("42"),
      observed + 1000,
    );
  } finally {
    second.store.close();
  }
});

test("message activity accepts only staff members in the configured guilds", (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  const members = new Set(["42"]);
  const activity = memberActivity(store, {
    guildIds: ["1", "2"],
    isMember: (id) => members.has(id),
  });
  const at = Date.now() - 5000;
  const message = {
    guildId: "2",
    author: { id: "42", bot: false },
    createdTimestamp: at,
  };
  for (const ignored of [
    { ...message, guildId: "3" },
    { ...message, guildId: null },
    { ...message, author: { id: "43", bot: false } },
    { ...message, author: { id: "42", bot: true } },
    { ...message, webhookId: "99" },
    { ...message, system: true },
    { ...message, createdTimestamp: NaN },
    { ...message, createdTimestamp: Date.now() + 3600000 },
  ])
    activity.observeMessage(ignored);
  assert.deepEqual(store.entries("member-activity"), []);
  Object.defineProperty(message, "content", {
    get() {
      throw new Error("Message contents must not be read");
    },
  });
  activity.observeMessage(message);
  assert.equal(activity.lastActiveAt("42"), at);
  activity.observeMessage({
    ...message,
    guildId: "1",
    createdTimestamp: at + 1000,
  });
  assert.equal(activity.lastActiveAt("42"), at + 1000);
  members.delete("42");
  activity.observeMessage({ ...message, createdTimestamp: at + 2000 });
  assert.equal(activity.lastActiveAt("42"), at + 1000);
});

test("recent messages update the exact timestamp without rewinding newer activity", (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  const activity = memberActivity(store, {
    guildIds: ["1"],
    isMember: (id) => id === "42",
  });
  const at = Date.now() - 600000;
  const message = (createdTimestamp) => ({
    guildId: "1",
    author: { id: "42", bot: false },
    createdTimestamp,
  });
  activity.observe("42", "online", at);
  activity.observeMessage(message(at + 1000));
  activity.observeMessage(message(at + 2000));
  assert.equal(activity.lastActiveAt("42"), at + 2000);
  activity.observeMessage(message(at));
  activity.observe("42", "online", at - 60000);
  assert.equal(activity.lastActiveAt("42"), at + 2000);
  activity.observe("42", "online", at + 120000);
  activity.observeMessage(message(at + 3000));
  assert.equal(activity.lastActiveAt("42"), at + 120000);
});
