import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openStore } from "../server/store.js";
import { rolePermissions } from "../server/role-permissions.js";
import { roleAssignments } from "../server/role-assignment.js";
import { staffRoleSync } from "../server/role-sync.js";
import { config as fixture } from "./fixture.js";
const config = {
  ...fixture,
  applications: {
    specialistRoles: { builder: "51", developer: "25", artist: "52" },
  },
  roleSync: {
    guildId: "2",
    initialSource: "staff",
    roles: fixture.ranks
      .filter((role) => role.dashboard)
      .map((role) => ({ staffId: role.id, mainId: `1${role.id}` })),
  },
};
const actor = (rank) => ({
  id: rank,
  name: `Manager ${rank}`,
  roles: [rank, "10", "11"],
});
const member = (guildId, id, roles) => ({
  guildId,
  id,
  name: `Member ${id}`,
  roles,
});
function setup(t, members, settings = config) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const roster = new Map(
    members.map((value) => [
      `${value.guildId}:${value.id}`,
      structuredClone(value),
    ]),
  );
  const changes = [],
    blocked = new Set();
  const transport = {
    validate: async () => {},
    members: async (guildId) =>
      structuredClone(
        [...roster.values()].filter((value) => value.guildId === guildId),
      ),
    member: async (guildId, id) =>
      structuredClone(roster.get(`${guildId}:${id}`)),
    async prepareChanges(guildId, planned) {
      if (
        planned.some(([role]) =>
          blocked.has(role[guildId === "1" ? "staffId" : "mainId"]),
        )
      )
        throw new Error("discord_role_hierarchy_required");
    },
    async change(guildId, id, role, add) {
      if (blocked.has(role)) throw new Error("discord_role_hierarchy_required");
      const value = roster.get(`${guildId}:${id}`);
      value.roles = add
        ? [...value.roles, role]
        : value.roles.filter((id) => id !== role);
      changes.push({ guildId, id, role, add });
    },
  };
  let sync = staffRoleSync(settings, store, transport);
  const policy = rolePermissions(settings, store);
  const extras = {
    lookup: async (id) =>
      structuredClone([...roster.values()].filter((value) => value.id === id)),
    search: async () => [
      ...new Set([...roster.values()].map((value) => value.id)),
    ],
    metadata: async (ids) =>
      ids.map((id) => ({ id, assignable: !blocked.has(id) })),
    change: (id, role, add) => transport.change("1", id, role, add),
  };
  let assignments = roleAssignments(settings, store, policy, extras, sync);
  t.after(async () => {
    await assignments.close();
    await sync.close();
    store.close();
  });
  return {
    roster,
    changes,
    blocked,
    store,
    policy,
    get sync() {
      return sync;
    },
    get assignments() {
      return assignments;
    },
    async input(
      id,
      rank,
      specialists = [],
      access = { dashboard: true, todo: true },
    ) {
      const { members } = await assignments.list(actor("20"), id);
      return { version: members[0].version, rank, specialists, access };
    },
    async restart() {
      await assignments.close();
      await sync.close();
      sync = staffRoleSync(settings, store, transport);
      assignments = roleAssignments(settings, store, policy, extras, sync);
      await sync.initialize();
    },
  };
}

test("panel assignments update both Discord servers while preserving unrelated and specialist roles", async (t) => {
  const app = setup(t, [
    member("1", "42", ["23", "10", "11", "99"]),
    member("2", "42", ["123", "98"]),
  ]);
  await app.assignments.assign(
    actor("28"),
    "42",
    await app.input("42", "21", ["51"]),
  );
  assert.deepEqual(
    new Set(app.roster.get("1:42").roles),
    new Set(["10", "11", "99", "21", "51"]),
  );
  assert.deepEqual(
    new Set(app.roster.get("2:42").roles),
    new Set(["98", "121"]),
  );
  assert.equal(app.assignments.status("42").request.status, "applied");
  assert.equal(app.policy.history(actor("20")).items[0].memberId, "42");
});

test("mapped specialist panel changes use both guilds and never reappear after removal or restart", async (t) => {
  const settings = structuredClone(config);
  settings.roleSync.roles.push(
    { staffId: "51", mainId: "151" },
    { staffId: "25", mainId: "125" },
    { staffId: "52", mainId: "152" },
  );
  const app = setup(
    t,
    [member("1", "42", ["23", "99"]), member("2", "42", ["123", "98"])],
    settings,
  );
  const metadata = await app.assignments.metadata(actor("28"));
  assert.ok(
    metadata
      .filter((role) => ["51", "25", "52"].includes(role.id))
      .every((role) => role.syncsToMain),
  );
  await app.assignments.assign(
    actor("28"),
    "42",
    await app.input("42", "23", ["51", "25"], {
      dashboard: false,
      todo: false,
    }),
  );
  assert.deepEqual(
    new Set(app.roster.get("1:42").roles),
    new Set(["23", "99", "51", "25"]),
  );
  assert.deepEqual(
    new Set(app.roster.get("2:42").roles),
    new Set(["123", "98", "151", "125"]),
  );
  app.blocked.add("152");
  await app.assignments.assign(
    actor("28"),
    "42",
    await app.input("42", "23", ["52"], { dashboard: false, todo: false }),
  );
  assert.equal(
    app.assignments.status("42").discord["Main server"].status,
    "retry",
  );
  app.blocked.clear();
  await app.sync.retry(true);
  await app.restart();
  assert.deepEqual(
    new Set(app.roster.get("1:42").roles),
    new Set(["23", "99", "52"]),
  );
  assert.deepEqual(
    new Set(app.roster.get("2:42").roles),
    new Set(["123", "98", "152"]),
  );
});

test("Manager and Founder promotions, demotions and protected access changes require a Founder", async (t) => {
  const app = setup(t, [
    member("1", "42", ["23", "10", "11"]),
    member("1", "43", ["28", "10", "11"]),
  ]);
  for (const rank of ["20", "28"])
    await assert.rejects(
      app.assignments.assign(actor("28"), "42", await app.input("42", rank)),
      { code: "founder_role_required" },
    );
  await assert.rejects(
    app.assignments.assign(actor("28"), "43", await app.input("43", "21")),
    { code: "founder_role_required" },
  );
  await assert.rejects(
    app.assignments.assign(
      actor("28"),
      "43",
      await app.input("43", "28", [], { dashboard: false, todo: true }),
    ),
    { code: "founder_role_required" },
  );
  assert.equal(app.changes.length, 0);
  await app.assignments.assign(actor("20"), "42", await app.input("42", "28"));
  assert.ok(app.roster.get("1:42").roles.includes("28"));
});

test("queued ranks and access survive restart and wait until the member joins staff", async (t) => {
  const app = setup(t, [member("2", "42", ["123", "99"])]);
  await app.assignments.assign(
    actor("28"),
    "42",
    await app.input("42", "23", ["52"]),
  );
  assert.equal(app.assignments.status("42").request.status, "waiting_member");
  assert.equal(
    app.assignments.status("42").discord["Staff server"].status,
    "waiting_member",
  );
  await app.restart();
  app.roster.set("1:42", member("1", "42", ["98"]));
  await app.sync.join(app.roster.get("1:42"));
  await app.assignments.reconcile("42");
  assert.deepEqual(
    new Set(app.roster.get("1:42").roles),
    new Set(["98", "23", "52", "10", "11"]),
  );
  assert.equal(app.assignments.status("42").request.status, "applied");
});

test("individual onboarding grants preserve queued access and specialist roles before joining", async (t) => {
  const app = setup(t, [member("2", "42", ["99"])]);
  for (const roleId of ["10", "52", "23"]) {
    const { members } = await app.assignments.list(actor("28"), "42");
    await app.assignments.grant(actor("28"), "42", members[0].version, roleId);
  }
  assert.equal(app.assignments.status("42").request.status, "waiting_member");
  assert.deepEqual(
    new Set(app.roster.get("2:42").roles),
    new Set(["99", "123"]),
  );
  assert.equal(
    app.assignments.status("42").discord["Main server"].status,
    "synced",
  );
  await app.restart();
  assert.ok(app.roster.get("2:42").roles.includes("123"));
  assert.equal(app.assignments.status("42").request.status, "waiting_member");
  app.roster.set("1:42", member("1", "42", ["98"]));
  await app.sync.join(app.roster.get("1:42"));
  await app.assignments.reconcile("42");
  assert.deepEqual(
    new Set(app.roster.get("1:42").roles),
    new Set(["98", "23", "52", "10"]),
  );
  assert.equal(app.assignments.status("42").request.status, "applied");
});

test("blocked Founder promotion keeps the existing rank until bot permissions allow the complete change", async (t) => {
  const app = setup(t, [
    member("1", "42", ["28", "10", "11"]),
    member("2", "42", ["128"]),
  ]);
  app.blocked.add("20");
  app.blocked.add("120");
  await app.assignments.assign(actor("20"), "42", await app.input("42", "20"));
  assert.ok(app.roster.get("1:42").roles.includes("28"));
  assert.ok(app.roster.get("2:42").roles.includes("128"));
  assert.equal(app.changes.length, 0);
  assert.equal(
    app.assignments.status("42").discord["Staff server"].error,
    "discord_role_hierarchy_required",
  );
  app.blocked.clear();
  await app.sync.retry(true);
  assert.ok(app.roster.get("1:42").roles.includes("20"));
  assert.ok(app.roster.get("2:42").roles.includes("120"));
});

test("role grants cannot bypass queued protected promotions or stale membership", async (t) => {
  const app = setup(t, [member("2", "42", ["99"])]);
  app.blocked.add("120");
  let { members } = await app.assignments.list(actor("20"), "42");
  await app.assignments.grant(actor("20"), "42", members[0].version, "20");
  ({ members } = await app.assignments.list(actor("28"), "42"));
  await assert.rejects(
    app.assignments.grant(actor("28"), "42", members[0].version, "23"),
    { code: "founder_role_required" },
  );
  app.roster.get("2:42").roles.push("98");
  await assert.rejects(
    app.assignments.grant(actor("20"), "42", members[0].version, "52"),
    { code: "discord_roles_changed" },
  );
  assert.equal(app.store.get("role-assignment", "42").rank, "20");
});

test("stale assignment versions, invalid roles and self-removal cannot change Discord", async (t) => {
  const app = setup(t, [
    member("1", "42", ["23", "10"]),
    member("1", "20", ["20", "10", "11"]),
  ]);
  const input = await app.input("42", "21");
  app.roster.get("1:42").roles.push("99");
  await assert.rejects(app.assignments.assign(actor("28"), "42", input), {
    code: "discord_roles_changed",
  });
  await assert.rejects(
    app.assignments.assign(actor("20"), "20", await app.input("20", "21")),
    { code: "founder_access_protected" },
  );
  await assert.rejects(
    app.assignments.assign(actor("28"), "42", {
      ...(await app.input("42", "21")),
      specialists: ["999"],
    }),
    { code: "invalid_role_assignment" },
  );
  await assert.rejects(
    app.assignments.assign(actor("21"), "42", await app.input("42", "23")),
    { code: "role_management_required" },
  );
  assert.equal(app.changes.length, 0);
});

test("specialist changes wait for hierarchy and screening without discarding the saved intent", async (t) => {
  const app = setup(t, [member("1", "42", ["23", "10", "11"])]);
  app.blocked.add("51");
  await app.assignments.assign(
    actor("28"),
    "42",
    await app.input("42", "23", ["51"]),
  );
  assert.equal(
    app.assignments.status("42").request.status,
    "waiting_hierarchy",
  );
  app.blocked.clear();
  app.roster.get("1:42").pending = true;
  await app.assignments.retry();
  assert.equal(
    app.assignments.status("42").request.status,
    "waiting_screening",
  );
  app.roster.get("1:42").pending = false;
  await app.assignments.retry();
  assert.ok(app.roster.get("1:42").roles.includes("51"));
});
