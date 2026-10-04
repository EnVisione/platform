import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { openStore } from "../server/store.js";
import { rolePermissions } from "../server/role-permissions.js";
import {
  applicationControls,
  applicationOnboarding,
} from "../server/application-onboarding.js";
import { applicationNotifications } from "../server/application-notifications.js";
import { applicationService } from "../server/applications.js";
import { config as fixture } from "./fixture.js";

const id = "00000000-0000-4000-8000-000000000001";
const config = {
  ...fixture,
  staffOrigin: "https://staff.example.com",
  discordBotToken: "test-token",
  applications: {
    notificationChannelId: "50",
    specialistRoles: { builder: "51", developer: "25", artist: "52" },
  },
  roleSync: { guildId: "2" },
};
const record = {
  id,
  status: "Approved",
  role: "community",
  answers: { displayName: "Applicant" },
  discord: { id: "123" },
  decision: { author: { id: "20", name: "Founder" }, reason: "Welcome" },
};
function setup(t) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  store.set("application", id, record, Number.MAX_SAFE_INTEGER);
  const client = new EventEmitter();
  const requests = [],
    grants = [];
  const staff = new Map([
    ["20", { roles: ["20", "10"], user: { username: "Founder" } }],
    ["28", { roles: ["28", "10"], user: { username: "Manager" } }],
    ["21", { roles: ["21", "10"], user: { username: "Admin" } }],
  ]);
  let blocked = false;
  client.rest = {
    async get(path) {
      requests.push({ method: "GET", path });
      return { id: "50", guild_id: "1" };
    },
    async post(path, options) {
      requests.push({ method: "POST", path, body: options.body });
      if (path.endsWith("/invites"))
        return { code: "unique-invite", guild: { id: "1" } };
      if (path === "/users/@me/channels") return { id: "999" };
      if (path === "/channels/999/messages") {
        if (blocked) throw Object.assign(new Error("blocked"), { code: 50007 });
        return { id: "1000" };
      }
      assert.fail(`Unexpected request ${path}`);
    },
    async delete(path) {
      requests.push({ method: "DELETE", path });
    },
  };
  const policy = rolePermissions(config, store);
  const assignments = {
    metadata: async () =>
      policy.roles
        .filter((role) => role.id)
        .map((role) => ({ id: role.id, assignable: true })),
    list: async () => ({ members: [{ id: "123", version: "a".repeat(64) }] }),
    async grant(user, target, version, roleId) {
      grants.push({ user, target, version, roleId });
      return {
        request: { status: "applied" },
        discord: { staff: { status: "synced" }, main: { status: "synced" } },
      };
    },
  };
  const service = applicationOnboarding(
    config,
    store,
    {
      gateway: client,
      staffMember: async (id) => staff.get(id),
    },
    policy,
    assignments,
  );
  t.after(async () => {
    await service.close();
    store.close();
  });
  function interact(customId, options = {}) {
    let timer;
    return new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Interaction did not finish")),
        2000,
      );
      const interaction = {
        customId,
        user: { id: options.actorId ?? "20" },
        guildId: options.guildId ?? "1",
        values: options.values,
        isButton: () => !options.values,
        isStringSelectMenu: () => Boolean(options.values),
        async deferReply(payload) {
          assert.equal(payload.flags, 64);
          this.deferred = true;
        },
        async editReply(payload) {
          resolve(payload);
        },
      };
      client.emit("interactionCreate", interaction);
    }).finally(() => clearTimeout(timer));
  }
  return {
    store,
    client,
    requests,
    grants,
    staff,
    service,
    interact,
    block: (value) => {
      blocked = value;
    },
  };
}

test("only accepted linked applications expose manual onboarding buttons", () => {
  const buttons = applicationControls(config, record, "approved")[0].components;
  assert.deepEqual(
    buttons.map((button) => button.label),
    ["Click to view", "Give role", "Invite to staff server"],
  );
  assert.equal(buttons[1].custom_id, `application:onboard:choose:${id}`);
  for (const event of [undefined, "reviewing", "denied"])
    assert.equal(
      applicationControls(config, record, event)[0].components.length,
      1,
    );
  assert.equal(
    applicationControls(config, { ...record, discord: null }, "approved")[0]
      .components.length,
    1,
  );
});

test("role selection is private, bound to its reviewer and uses synchronized role grants", async (t) => {
  const app = setup(t);
  const menu = await app.interact(`application:onboard:choose:${id}`, {
    actorId: "28",
  });
  const select = menu.components[0].components[0];
  assert.ok(select.options.some((option) => option.label === "Developer"));
  assert.ok(
    select.options.some((option) => option.label === "Dashboard access"),
  );
  assert.ok(
    !select.options.some((option) =>
      ["Founder", "Manager"].includes(option.label),
    ),
  );
  const stolen = await app.interact(select.custom_id, {
    actorId: "20",
    values: ["22"],
  });
  assert.match(stolen.content, /expired/);
  assert.equal(app.grants.length, 0);
  const granted = await app.interact(select.custom_id, {
    actorId: "28",
    values: ["22"],
  });
  assert.match(granted.content, /Moderator: Role saved and synced/);
  assert.equal(app.grants[0].target, "123");
  assert.equal(app.grants[0].roleId, "22");
  assert.equal(app.grants[0].version, "a".repeat(64));
  assert.match(
    (await app.interact(select.custom_id, { actorId: "28", values: ["22"] }))
      .content,
    /expired/,
  );
  assert.equal(app.grants.length, 1);
});

test("onboarding rechecks current permissions, application state and server", async (t) => {
  const app = setup(t);
  assert.match(
    (await app.interact(`application:onboard:invite:${id}`, { actorId: "21" }))
      .content,
    /permission/,
  );
  assert.match(
    (await app.interact(`application:onboard:invite:${id}`, { guildId: "2" }))
      .content,
    /staff server/,
  );
  const menu = await app.interact(`application:onboard:choose:${id}`);
  app.staff.set("20", {
    roles: ["23", "10"],
    user: { username: "Former founder" },
  });
  assert.match(
    (
      await app.interact(menu.components[0].components[0].custom_id, {
        values: ["22"],
      })
    ).content,
    /permission/,
  );
  app.store.set(
    "application",
    id,
    { ...record, status: "Denied" },
    Number.MAX_SAFE_INTEGER,
  );
  assert.match(
    (await app.interact(`application:onboard:choose:${id}`, { actorId: "28" }))
      .content,
    /no longer accepted/,
  );
  assert.equal(app.requests.length, 0);
  assert.equal(app.grants.length, 0);
});

test("simultaneous invite clicks send one private DM with a single-use staff invite", async (t) => {
  const app = setup(t);
  const results = await Promise.all([
    app.interact(`application:onboard:invite:${id}`),
    app.interact(`application:onboard:invite:${id}`, { actorId: "28" }),
  ]);
  assert.match(results[0].content, /sent.*DM/);
  assert.match(results[1].content, /already received/);
  const create = app.requests.filter((request) =>
    request.path.endsWith("/invites"),
  );
  assert.equal(create.length, 1);
  assert.deepEqual(create[0].body, {
    max_age: 86400,
    max_uses: 1,
    temporary: false,
    unique: true,
  });
  const messages = app.requests.filter((request) =>
    request.path.endsWith("/messages"),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].path, "/channels/999/messages");
  assert.equal(
    messages[0].body.components[0].components[0].url,
    "https://discord.gg/unique-invite",
  );
  assert.deepEqual(messages[0].body.allowed_mentions, {
    parse: [],
    users: [],
    roles: [],
    replied_user: false,
  });
  assert.equal(messages[0].body.enforce_nonce, true);
  assert.ok(app.store.get("application-onboarding", `${id}:invite`).sentAt);
  assert.equal(app.store.entries("application-dm-delivery").length, 1);
  assert.equal(
    app.store.entries("role-audit")[0][1].action,
    "application-invite",
  );
  const policy = rolePermissions(config, app.store);
  assert.equal(
    policy.history({ id: "20", roles: ["20", "10"] }, 0, {
      action: "application-invite",
      query: id,
    }).total,
    1,
  );
});

test("manual invites respect the applicant's email preference", async (t) => {
  const app = setup(t);
  app.store.set(
    "application",
    id,
    { ...record, notificationPreference: "email" },
    Number.MAX_SAFE_INTEGER,
  );
  assert.match(
    (await app.interact(`application:onboard:invite:${id}`)).content,
    /chose email updates/,
  );
  assert.equal(app.requests.length, 0);
});

test("blocked invite DMs report failure and retry the same unexpired invite", async (t) => {
  const app = setup(t);
  app.block(true);
  assert.match(
    (await app.interact(`application:onboard:invite:${id}`)).content,
    /enable direct messages/,
  );
  assert.equal(
    app.store.get("application-onboarding", `${id}:invite`).sentAt,
    undefined,
  );
  assert.equal(app.store.entries("application-dm-delivery").length, 0);
  app.block(false);
  assert.match(
    (await app.interact(`application:onboard:invite:${id}`)).content,
    /sent.*DM/,
  );
  assert.equal(
    app.requests.filter((request) => request.path.endsWith("/invites")).length,
    1,
  );
  await app.service.erase(record);
  assert.deepEqual(
    app.requests
      .filter((request) => request.method === "DELETE")
      .map((request) => request.path),
    ["/invites/unique-invite"],
  );
});

test("old approval notices get buttons without replaying messages or DMs", async (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  store.set("application", id, record, Number.MAX_SAFE_INTEGER);
  const key = `${id}:staff:approved`;
  store.set(
    "application-delivery",
    key,
    { messageId: "100", channelId: "50", sentAt: 1 },
    Number.MAX_SAFE_INTEGER,
  );
  const requests = [];
  const notifications = applicationNotifications(
    config,
    store,
    async (url, options) => {
      requests.push({
        url,
        method: options.method,
        body: JSON.parse(options.body),
      });
      return Response.json({ id: "100" });
    },
  );
  t.after(async () => {
    await notifications.close();
    store.close();
  });
  await notifications.delivery();
  await notifications.delivery();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].body.components[0].components[1].label, "Give role");
  assert.equal(requests[0].body.embeds, undefined);
  assert.equal(store.get("application-delivery", key).sentAt, 1);
});

test("application inactivity erasure revokes the invite and removes its DM and receipts", async (t) => {
  const app = setup(t);
  await app.interact(`application:onboard:invite:${id}`);
  const deleted = [];
  const applications = applicationService(
    config,
    app.store,
    async (url, options) => {
      assert.equal(options.method, "DELETE");
      deleted.push(url);
      return new Response(null, { status: 204 });
    },
    undefined,
    undefined,
    undefined,
    (record) => app.service.erase(record),
  );
  try {
    assert.equal(await applications.eraseInactive(id, Date.now()), true);
    assert.ok(
      app.requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path === "/invites/unique-invite",
      ),
    );
    assert.deepEqual(deleted, [
      "https://discord.com/api/v10/channels/999/messages/1000",
    ]);
    assert.equal(app.store.get("application", id), undefined);
    assert.equal(
      app.store.get("application-onboarding", `${id}:invite`),
      undefined,
    );
    assert.equal(app.store.entries("application-dm-delivery").length, 0);
  } finally {
    await applications.close();
  }
});
