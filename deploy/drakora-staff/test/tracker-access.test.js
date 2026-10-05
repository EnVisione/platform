import test from "node:test";
import assert from "node:assert/strict";
import {
  trackerProjectIds,
  reconcileTrackerProjects,
} from "../server/tracker-access.js";
import { trackerChannelOverwrites } from "../server/tracker-channels.js";
import { PermissionFlagsBits as Flags } from "discord.js";

const config = {
  guildId: "1",
  hulyOwner: "recovery",
  ranks: ["20", "21", "25", "51", "52"].map((id) => ({ id })),
  trackerProjects: [
    { projectId: "dev", name: "Dev", roleIds: ["20", "21", "25"] },
    { projectId: "build", name: "Builders", roleIds: ["20", "21", "51"] },
    { projectId: "art", name: "Artists", roleIds: ["20", "21", "52"] },
  ],
};
const user = (account, roles, allowed = true) => ({
  hulyAccount: account,
  roles,
  permissions: { dashboard: allowed, todo: allowed },
});
function fixture() {
  const docs = new Map(
    config.trackerProjects.map(({ projectId }) => [
      projectId,
      {
        _id: projectId,
        _class: "tracker:class:Project",
        space: "space",
        private: false,
        autoJoin: true,
        autoJoinForRoles: ["USER"],
        members: ["artist", "developer", "former", "manual"],
      },
    ]),
  );
  const writes = [];
  const client = {
    findOne: async (_, query) => structuredClone(docs.get(query._id)),
    updateDoc: async (_, __, id, update) => {
      writes.push({ id, update });
      Object.assign(docs.get(id), structuredClone(update));
    },
  };
  return { docs, writes, client };
}

test("Tracker grants require portal and workspace access and combine team roles", () => {
  assert.deepEqual(trackerProjectIds(config, user("artist", ["52"])), ["art"]);
  assert.deepEqual(trackerProjectIds(config, user("both", ["51", "52"])), [
    "build",
    "art",
  ]);
  assert.deepEqual(trackerProjectIds(config, user("manager", ["21"])), [
    "dev",
    "build",
    "art",
  ]);
  for (const roles of [[], ["11"], ["10"]])
    assert.deepEqual(trackerProjectIds(config, user("none", roles)), []);
  const denied = user("artist", ["52"]);
  denied.permissions.todo = false;
  assert.deepEqual(trackerProjectIds(config, denied), []);
  denied.permissions.dashboard = false;
  denied.permissions.todo = true;
  assert.deepEqual(trackerProjectIds(config, denied), []);
});

test("native projects become private and remove auto join and stale or unverified members", async () => {
  const app = fixture();
  const users = [
    user("artist", ["52"]),
    user("developer", ["25"]),
    user("builder", ["51"]),
    user("manager", ["21"]),
    user("former", ["52"], false),
  ];
  await reconcileTrackerProjects(app.client, config, users);
  for (const doc of app.docs.values()) {
    assert.equal(doc.private, true);
    assert.equal(doc.autoJoin, false);
    assert.deepEqual(doc.autoJoinForRoles, []);
    assert.ok(
      !doc.members.includes("former") && !doc.members.includes("manual"),
    );
    assert.ok(
      doc.members.includes("manager") && doc.members.includes("recovery"),
    );
  }
  assert.deepEqual(
    new Set(app.docs.get("art").members),
    new Set(["artist", "manager", "recovery"]),
  );
  assert.deepEqual(
    new Set(app.docs.get("dev").members),
    new Set(["developer", "manager", "recovery"]),
  );
  const count = app.writes.length;
  await reconcileTrackerProjects(app.client, config, users);
  assert.equal(app.writes.length, count);
});

test("login and role changes add or remove only the current account", async () => {
  const app = fixture();
  await reconcileTrackerProjects(
    app.client,
    config,
    [user("artist", ["52"])],
    "artist",
  );
  assert.ok(app.docs.get("art").members.includes("artist"));
  assert.ok(!app.docs.get("dev").members.includes("artist"));
  assert.ok(app.docs.get("dev").members.includes("developer"));
  await reconcileTrackerProjects(
    app.client,
    config,
    [user("artist", ["51"])],
    "artist",
  );
  assert.ok(!app.docs.get("art").members.includes("artist"));
  assert.ok(app.docs.get("build").members.includes("artist"));
  await reconcileTrackerProjects(
    app.client,
    config,
    [user("artist", ["51"], false)],
    "artist",
  );
  assert.ok(
    [...app.docs.values()].every((doc) => !doc.members.includes("artist")),
  );
});

test("missing configured projects fail without pretending access was reconciled", async () => {
  const app = fixture();
  app.docs.delete("art");
  await assert.rejects(
    reconcileTrackerProjects(app.client, config, []),
    /Artists was not found/,
  );
  assert.equal(app.writes.length, 0);
});

test("Discord forum grants allow only matching team roles and retain bot overwrites", () => {
  const cache = new Map([
    [
      "1",
      {
        id: "1",
        type: 0,
        allow: { bitfield: Flags.ViewChannel },
        deny: { bitfield: 0n },
      },
    ],
    [
      "25",
      {
        id: "25",
        type: 0,
        allow: { bitfield: Flags.ViewChannel },
        deny: { bitfield: 0n },
      },
    ],
    [
      "bot",
      {
        id: "bot",
        type: 1,
        allow: { bitfield: Flags.ManageChannels },
        deny: { bitfield: 0n },
      },
    ],
  ]);
  const entries = trackerChannelOverwrites(
    config,
    { permissionOverwrites: { cache } },
    ["20", "21", "52"],
  );
  for (const id of ["20", "21", "52"]) {
    const entry = entries.find((entry) => entry.id === id);
    assert.ok(entry.allow & Flags.ViewChannel);
    assert.equal(entry.deny & Flags.ViewChannel, 0n);
  }
  for (const id of ["1", "25", "51"]) {
    const entry = entries.find((entry) => entry.id === id);
    assert.equal(entry.allow & Flags.ViewChannel, 0n);
    assert.ok(entry.deny & Flags.ViewChannel);
  }
  assert.equal(
    entries.find((entry) => entry.id === "bot").allow,
    Flags.ManageChannels,
  );
});
