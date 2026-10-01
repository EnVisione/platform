import test from "node:test";
import assert from "node:assert/strict";
import { contactRanks } from "../server/contact-ranks.js";

test("Huly contact badges follow the connected Discord roster", () => {
  const users = new Map([
    ["one", { hulyAccount: "account-one" }],
    ["two", { hulyAccount: "account-two" }],
  ]);
  const snapshot = {
    connected: true,
    members: [
      { id: "one", ranks: ["Founder", "Developer"] },
      { id: "two", ranks: ["Moderator"] },
      { id: "unlinked", ranks: ["Helper"] },
    ],
  };
  const lookup = (id) => users.get(id);

  assert.deepEqual({ ...contactRanks(snapshot, lookup).byAccount }, {
    "account-one": ["Founder", "Developer"],
    "account-two": ["Moderator"],
  });

  snapshot.members[0].ranks = ["Admin"];
  assert.deepEqual(contactRanks(snapshot, lookup).byAccount["account-one"], [
    "Admin",
  ]);

  snapshot.connected = false;
  assert.deepEqual(contactRanks(snapshot, lookup), {
    connected: false,
    byAccount: Object.create(null),
  });
});
