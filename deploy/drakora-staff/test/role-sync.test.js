import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { staffRoleSync, discordRoleTransport } from "../server/role-sync.js";
import { openStore } from "../server/store.js";
import { validateConfig } from "../server/config.js";
import { config as fixture } from "./fixture.js";

const config = {
  ...fixture,
  roleSync: {
    guildId: "2",
    initialSource: "staff",
    roles: [
      { staffId: "20", mainId: "120" },
      { staffId: "28", mainId: "128" },
      { staffId: "22", mainId: "122" },
      { staffId: "23", mainId: "123" },
    ],
  },
};
const snapshot = (guildId, roles, id = "42", extra = {}) => ({
  guildId,
  id,
  roles,
  joinedAt: "2026-10-01T00:00:00Z",
  ...extra,
});

function setup(t, members, settings = config) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const roster = new Map(
    members.map((member) => [
      `${member.guildId}:${member.id}`,
      structuredClone(member),
    ]),
  );
  const changes = [];
  const blocked = new Set();
  let sync;
  const transport = {
    validate: async () => {},
    members: async (guildId) =>
      structuredClone(
        [...roster.values()].filter((member) => member.guildId === guildId),
      ),
    member: async (guildId, id) =>
      structuredClone(roster.get(`${guildId}:${id}`)),
    async change(guildId, id, role, add) {
      if (blocked.has(role)) throw new Error("discord_role_hierarchy_required");
      const member = roster.get(`${guildId}:${id}`);
      member.roles = add
        ? [...member.roles, role]
        : member.roles.filter((value) => value !== role);
      changes.push({ guildId, role, add });
      void sync.update(structuredClone(member));
    },
  };
  sync = staffRoleSync(settings, store, transport);
  const instances = [sync];
  t.after(async () => {
    for (const instance of instances) await instance.close();
    store.close();
  });
  return {
    store,
    roster,
    transport,
    changes,
    blocked,
    get sync() {
      return sync;
    },
    roles(guildId, id = "42") {
      return roster.get(`${guildId}:${id}`)?.roles;
    },
    async update(member) {
      roster.set(`${member.guildId}:${member.id}`, structuredClone(member));
      await sync.update(member);
    },
    async restart() {
      await sync.close();
      sync = staffRoleSync(settings, store, transport);
      instances.push(sync);
      await sync.initialize();
    },
  };
}

test("first sync copies staff ranks to main and preserves unrelated roles and access gates", async (t) => {
  const app = setup(t, [
    snapshot("1", ["28", "10", "11", "25"]),
    snapshot("2", ["122", "99"]),
  ]);
  await app.sync.initialize();
  assert.deepEqual(app.roles("1"), ["28", "10", "11", "25"]);
  assert.deepEqual(app.roles("2"), ["99", "128"]);
  assert.equal(app.store.get("discord-role-sync", "42").sourceGuildId, "1");
  assert.equal(app.changes.length, 2);
});

test("new specialist links preserve existing teams in both guilds and synchronize later removals", async (t) => {
  const settings = structuredClone(config);
  settings.applications = {
    specialistRoles: { builder: "51", developer: "25", artist: "52" },
  };
  const app = setup(
    t,
    [snapshot("1", ["28", "25", "10"]), snapshot("2", ["128", "99"])],
    settings,
  );
  await app.sync.initialize();
  const legacy = app.store.get("discord-role-sync", "42");
  delete legacy.mappedIds;
  app.store.set("discord-role-sync", "42", legacy, Number.MAX_SAFE_INTEGER);
  app.roster.get("2:42").roles.push("151");
  settings.roleSync.roles.push(
    { staffId: "51", mainId: "151" },
    { staffId: "25", mainId: "125" },
    { staffId: "52", mainId: "152" },
  );
  await app.restart();
  assert.deepEqual(new Set(app.roles("1")), new Set(["28", "25", "51", "10"]));
  assert.deepEqual(
    new Set(app.roles("2")),
    new Set(["128", "125", "151", "99"]),
  );
  await app.update(snapshot("2", ["128", "151", "99"]));
  assert.deepEqual(new Set(app.roles("1")), new Set(["28", "51", "10"]));
  await app.update(snapshot("1", ["28", "51", "52", "10"]));
  assert.ok(app.roles("2").includes("152"));
  await app.restart();
  assert.equal(app.roles("1").includes("25"), false);
  assert.equal(app.roles("2").includes("125"), false);
});

test("first sync combines independent specialist roles without replacing the preferred community rank", async (t) => {
  const settings = structuredClone(config);
  settings.applications = {
    specialistRoles: { builder: "51", developer: "25" },
  };
  settings.roleSync.roles.push(
    { staffId: "51", mainId: "151" },
    { staffId: "25", mainId: "125" },
  );
  const app = setup(
    t,
    [snapshot("1", ["28", "25"]), snapshot("2", ["123", "151"])],
    settings,
  );
  await app.sync.initialize();
  assert.deepEqual(new Set(app.roles("1")), new Set(["28", "25", "51"]));
  assert.deepEqual(new Set(app.roles("2")), new Set(["128", "125", "151"]));
});

test("changes in either server replace the old rank without granting dashboard access", async (t) => {
  const app = setup(t, [snapshot("1", ["23"]), snapshot("2", ["123"])]);
  await app.sync.initialize();
  await app.update(snapshot("1", ["28"]));
  assert.deepEqual(app.roles("2"), ["128"]);
  await app.update(snapshot("2", ["122"]));
  assert.deepEqual(app.roles("1"), ["22"]);
  await app.update(snapshot("2", []));
  assert.deepEqual(app.roles("1"), []);
});

test("a sole main-server rank waits durably for staff membership, including across restart", async (t) => {
  const app = setup(t, [snapshot("2", ["123"])]);
  await app.sync.initialize();
  assert.equal(
    app.store.get("discord-role-sync", "42").delivery["1"].status,
    "waiting_member",
  );
  await app.restart();
  const joined = snapshot("1", ["99"], "42", {
    joinedAt: "2026-10-02T00:00:00Z",
  });
  app.roster.set("1:42", joined);
  await app.sync.join(joined);
  assert.deepEqual(app.roles("1"), ["99", "23"]);
});

test("removing a rank while the peer is absent replaces a pending assignment", async (t) => {
  const app = setup(t, [snapshot("1", ["28"])]);
  await app.sync.initialize();
  await app.update(snapshot("1", []));
  const joined = snapshot("2", ["128", "99"]);
  app.roster.set("2:42", joined);
  await app.sync.join(joined);
  assert.deepEqual(app.roles("2"), ["99"]);
});

test("a revoked main-server rank cannot be granted from an old queue when staff membership begins", async (t) => {
  const app = setup(t, [snapshot("2", ["123"])]);
  await app.sync.initialize();
  await app.update(snapshot("2", []));
  await app.restart();
  const joined = snapshot("1", ["99"]);
  app.roster.set("1:42", joined);
  await app.sync.join(joined);
  assert.deepEqual(app.roles("1"), ["99"]);
  assert.equal(app.roles("1").includes("10"), false);
});

test("membership screening waits for completion before giving a pending rank", async (t) => {
  const app = setup(t, [
    snapshot("1", ["23"]),
    snapshot("2", [], "42", { pending: true }),
  ]);
  await app.sync.initialize();
  assert.equal(
    app.store.get("discord-role-sync", "42").delivery["2"].status,
    "waiting_screening",
  );
  assert.deepEqual(app.changes, []);
  await app.update(snapshot("2", [], "42", { pending: false }));
  assert.deepEqual(app.roles("2"), ["123"]);
});

test("Founder hierarchy failure stays pending without blocking other members", async (t) => {
  const app = setup(t, [
    snapshot("1", ["20"]),
    snapshot("2", []),
    snapshot("1", ["28"], "43"),
    snapshot("2", [], "43"),
  ]);
  app.blocked.add("120");
  await app.sync.initialize();
  assert.equal(
    app.store.get("discord-role-sync", "42").delivery["2"].status,
    "retry",
  );
  assert.deepEqual(app.roles("2", "43"), ["128"]);
  app.blocked.clear();
  await app.sync.retry(true);
  assert.deepEqual(app.roles("2"), ["120"]);
  assert.equal(
    app.store.get("discord-role-sync", "42").delivery["2"].status,
    "synced",
  );
});

test("profile-only updates, unrelated roles, other guilds, and bots do not change ranks", async (t) => {
  const app = setup(t, [snapshot("1", ["23"]), snapshot("2", ["123"])]);
  await app.sync.initialize();
  const version = app.store.get("discord-role-sync", "42").version;
  await app.update(snapshot("1", ["23", "25", "10"]));
  await app.sync.update(snapshot("3", ["28"]));
  await app.sync.update(snapshot("1", ["28"], "44", { bot: true }));
  assert.equal(app.store.get("discord-role-sync", "42").version, version);
  assert.equal(app.store.get("discord-role-sync", "44"), undefined);
  assert.deepEqual(app.changes, []);
});

test("joining with no saved intent recovers the other server's rank", async (t) => {
  const app = setup(t, [snapshot("1", ["22"]), snapshot("2", [])]);
  await app.sync.join(snapshot("2", []));
  assert.deepEqual(app.roles("2"), ["122"]);
});

test("restart observes offline promotions while a rejoin retains the saved assignment", async (t) => {
  const app = setup(t, [snapshot("1", ["23"]), snapshot("2", ["123"])]);
  await app.sync.initialize();
  await app.sync.update({ guildId: "2", id: "42", roles: ["123"] });
  app.roster.set("2:42", snapshot("2", ["128"]));
  await app.restart();
  assert.deepEqual(app.roles("1"), ["28"]);
  app.roster.set(
    "2:42",
    snapshot("2", [], "42", { joinedAt: "2026-10-02T00:00:00Z" }),
  );
  await app.restart();
  assert.deepEqual(app.roles("2"), ["128"]);
});

test("a newer external change wins during an in-flight copy and ignores its delayed echo", async (t) => {
  const app = setup(t, [snapshot("1", ["23"]), snapshot("2", ["123"])]);
  await app.sync.initialize();
  const change = app.transport.change;
  let delayed;
  app.transport.change = async (guildId, id, role, add) => {
    if (guildId === "2" && role === "128" && add) {
      const member = app.roster.get("2:42");
      member.roles.push(role);
      delayed = structuredClone(member);
      const newer = snapshot("1", ["22"]);
      app.roster.set("1:42", newer);
      void app.sync.update(newer);
    } else await change(guildId, id, role, add);
  };
  await app.update(snapshot("1", ["28"]));
  assert.deepEqual(app.roles("2"), ["122"]);
  await app.sync.update(delayed);
  assert.deepEqual(app.roles("1"), ["22"]);
  assert.deepEqual(app.store.get("discord-role-sync", "42").roles, ["22"]);
});

test("an ambiguous REST failure keeps echo protection for a mutation Discord applied", async (t) => {
  const app = setup(t, [snapshot("1", ["23"]), snapshot("2", ["123"])]);
  await app.sync.initialize();
  const change = app.transport.change;
  let delayed;
  app.transport.change = async (guildId, id, role, add) => {
    if (guildId === "2" && role === "128" && add && !delayed) {
      const member = app.roster.get("2:42");
      member.roles.push(role);
      delayed = structuredClone(member);
      throw Object.assign(new Error("timeout"), { status: 503 });
    }
    await change(guildId, id, role, add);
  };
  await app.update(snapshot("1", ["28"]));
  await app.update(snapshot("1", ["22"]));
  await app.sync.update(delayed);
  assert.deepEqual(app.roles("1"), ["22"]);
  assert.deepEqual(app.roles("2"), ["122"]);
});

test("startup snapshots cannot overwrite a newer Gateway change", async (t) => {
  const app = setup(t, [snapshot("1", ["23"]), snapshot("2", ["123"])]);
  const members = app.transport.members;
  app.transport.members = async (guildId) => {
    const result = await members(guildId);
    if (guildId === "2") await app.update(snapshot("1", ["28"]));
    return result;
  };
  await app.sync.initialize();
  assert.deepEqual(app.roles("1"), ["28"]);
  assert.deepEqual(app.roles("2"), ["128"]);
});

test("optional configuration rejects access-role mappings and ambiguous role pairs", () => {
  const valid = {
    ...structuredClone(config),
    staffOrigin: "https://staff.example.invalid",
    todoOrigin: "https://todo.example.invalid",
    discordClientId: "3",
    discordBotToken: "fixture",
    databaseKey: Buffer.alloc(32).toString("base64"),
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
  };
  assert.equal(validateConfig(valid), valid);
  const disabled = structuredClone(valid);
  delete disabled.roleSync;
  assert.equal(validateConfig(disabled), disabled);
  for (const patch of [
    { guildId: "1" },
    { initialSource: "unknown" },
    { roles: [] },
    { roles: [{ staffId: "999", mainId: "123" }] },
    {
      roles: [
        { staffId: "20", mainId: "123" },
        { staffId: "28", mainId: "123" },
      ],
    },
    {
      roles: [
        { staffId: "20", mainId: "123" },
        { staffId: "20", mainId: "128" },
      ],
    },
  ]) {
    const invalid = structuredClone(valid);
    Object.assign(invalid.roleSync, patch);
    assert.throws(() => validateConfig(invalid), /staff rank mappings/);
  }
  const access = structuredClone(valid);
  access.ranks.push({ ...fixture.ranks[0], id: "10" });
  access.roleSync.roles = [{ staffId: "10", mainId: "123" }];
  assert.throws(() => validateConfig(access), /staff rank mappings/);
});

test("Discord transport uses individual role endpoints and treats missing membership as pending", async () => {
  const calls = [];
  const roleCache = (guildId) =>
    new Map(
      config.roleSync.roles.map((role) => [
        role[guildId === "1" ? "staffId" : "mainId"],
        { id: role[guildId === "1" ? "staffId" : "mainId"], editable: true },
      ]),
    );
  const client = {
    guilds: {
      fetch: async (id) => ({
        roles: { fetch: async () => {}, cache: roleCache(id) },
        members: {
          fetchMe: async () => ({ permissions: { has: () => true } }),
        },
      }),
    },
    rest: {
      get: async () => {
        throw Object.assign(new Error("Unknown member"), { code: 10007 });
      },
      put: async (route) => calls.push(["put", route]),
      delete: async (route) => calls.push(["delete", route]),
    },
  };
  const transport = discordRoleTransport(config, client);
  await transport.validate();
  assert.equal(await transport.member("2", "42"), undefined);
  await transport.change("2", "42", "128", true);
  await transport.change("2", "42", "122", false);
  assert.deepEqual(calls, [
    ["put", "/guilds/2/members/42/roles/128"],
    ["delete", "/guilds/2/members/42/roles/122"],
  ]);
});
