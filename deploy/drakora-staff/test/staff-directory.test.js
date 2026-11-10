import test from "node:test";
import assert from "node:assert/strict";
import { staffAccountRoster, staffDirectory } from "../server/staff-directory.js";

test("departed staff registrations do not appear in the current account roster", () => {
  const departed = { name: "LaCricc", status: "pending" };
  const current = { name: "CurrentPlayer", status: "verified" };
  const registrations = [
    ["former", departed],
    ["current", current],
  ];
  const snapshot = {
    connected: true,
    members: [
      { id: "current", staff: true },
      { id: "unregistered", staff: true },
      { id: "visitor", staff: false },
    ],
  };
  const roster = staffAccountRoster(snapshot, registrations);
  assert.deepEqual([...roster.keys()], ["current", "unregistered"]);
  assert.equal(roster.get("current").minecraft, current);
  assert.equal(roster.get("unregistered").minecraft, null);
  assert.deepEqual(registrations, [
    ["former", departed],
    ["current", current],
  ]);
  assert.equal(departed.name, "LaCricc");
});

test("current registered members remain visible while awaiting a staff rank", () => {
  const member = { id: "current", staff: false, ranks: [] };
  const roster = staffAccountRoster(
    { connected: true, members: [member] },
    [[member.id, { name: "CurrentPlayer", status: "pending" }]],
  );
  assert.equal(roster.get(member.id).member, member);
});

test("bots and members awaiting screening do not become staff accounts", () => {
  const members = [
    { id: "bot", staff: true, bot: true },
    { id: "pending", staff: true, pending: true },
  ];
  const roster = staffAccountRoster(
    { connected: true, members },
    members.map((member) => [member.id, { name: member.id }]),
  );
  assert.equal(roster.size, 0);
});

test("Discord unavailability does not restore historical registrations to the roster", () => {
  for (const snapshot of [undefined, { connected: false, members: [] }]) {
    assert.throws(
      () => staffAccountRoster(snapshot, [["former", { name: "LaCricc" }]]),
      (error) => error.code === "discord_unavailable" && error.status === 503,
    );
  }
});

test("public staff directory still includes only currently ranked staff", async () => {
  const directory = staffDirectory(
    { ranks: [{ id: "helper", name: "Helper" }] },
    async () => [
      { id: "ranked", name: "Ranked", roles: ["helper"] },
      { id: "unranked", name: "Unranked", roles: [] },
    ],
    (id) => (id === "ranked" ? { name: "CurrentPlayer" } : undefined),
  );
  assert.deepEqual(await directory(), {
    groups: [
      {
        name: "Helper",
        members: [
          { name: "Ranked", minecraft: "CurrentPlayer", ranks: ["Helper"] },
        ],
      },
    ],
    total: 1,
  });
});
