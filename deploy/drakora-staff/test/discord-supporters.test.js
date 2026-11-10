import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { discordSupporters } from "../server/discord-supporters.js";

test("recognizes existing supporters and credits gift purchases to linked buyers", async (t) => {
  const config = {
    roleSync: { guildId: "community" },
    minecraftBridge: { plusRoleId: "plus", storeMappings: [{ roleId: "wyrm" }] },
  };
  const members = new Map([
    ["ranked", ["wyrm"]], ["subscribed", ["plus"]], ["legacy", ["early"]],
    ["buyer", []], ["recipient", []], ["unlinked", []], ["refunded", []],
    ["staffLinkOnly", []], ["staleLink", []], ["noLongerEligible", ["supporter"]],
  ].map(([id, roles]) => [id, { user: { id }, roles }]));
  const receipts = [
    { uuid: "recipient", buyerUuid: "buyer", active: true, coins: 100 },
    { uuid: "unlinked", active: true, coins: 100 },
    { uuid: "refunded", active: true, coins: 100, refunded: true },
    { uuid: "staffLinkOnly", active: true, coins: 100 },
    { uuid: "staleLink", active: true, coins: 100 },
  ];
  const linked = new Set(["buyer", "recipient", "refunded", "staleLink"]);
  const store = {
    entries: (kind) => kind === "supporter-receipt" ? receipts.entries() : [],
    get(kind, id) {
      if (kind === "minecraft-owner" && (linked.has(id) || id === "staffLinkOnly"))
        return { memberLinked: linked.has(id), staffLinked: true, discord: { id } };
      if (kind === "minecraft-discord-owner")
        return { uuid: id === "staleLink" ? "other-account" : id };
    },
  };
  const client = new EventEmitter();
  client.isReady = () => true;
  const writes = [];
  function change(route, add) {
    const id = route.match(/^\/guilds\/community\/members\/([^/]+)\/roles\/supporter$/)?.[1];
    assert.ok(id);
    const member = members.get(id);
    if (add) member.roles.push("supporter");
    else member.roles = member.roles.filter((role) => role !== "supporter");
    writes.push([id, add]);
  }
  client.rest = {
    async get(route) {
      if (route === "/guilds/community/roles")
        return [{ id: "supporter", managed: false, permissions: "0" }];
      if (route === "/guilds/community/members") return [...members.values()];
      return members.get(route.split("/").at(-1));
    },
    put: (route) => change(route, true),
    delete: (route) => change(route, false),
  };
  const service = discordSupporters(config, store, client, {
    roleId: "supporter", earlyRoleId: "early",
  });
  t.after(() => service.close());

  await service.refresh();
  assert.deepEqual(writes, [
    ["ranked", true], ["subscribed", true], ["legacy", true],
    ["buyer", true], ["noLongerEligible", false],
  ]);
  await service.refresh();
  assert.equal(writes.length, 5);

  receipts[0].disputed = true;
  members.get("subscribed").roles = ["supporter"];
  await service.refresh();
  assert.deepEqual(writes.slice(5), [["subscribed", false], ["buyer", false]]);
});
