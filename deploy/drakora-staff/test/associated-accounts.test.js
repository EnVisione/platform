import test from "node:test";
import express from "express";
import { minecraftBridgeRouter } from "../server/minecraft-bridge-routes.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { openStore } from "../server/store.js";
import { rolePermissions } from "../server/role-permissions.js";
import { playerActivity } from "../server/players.js";
import { config } from "./fixture.js";

test("Helpers can review associated accounts while reported addresses and IP bans remain restricted", (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  const policy = rolePermissions(config, store);
  const helper = policy.apply({ id: "helper", roles: ["23"], staffMember: true });
  assert.equal(helper.capabilities["moderation.alts"], true);
  assert.equal(helper.capabilities["moderation.ip"], false);
  assert.equal(helper.capabilities["moderation.ipban"], false);
  const now = Date.now();
  const uuid = "12345678-1234-4234-8234-123456789012";
  const peer = "12345678-1234-4234-8234-123456789013";
  for (const [id, name] of [[uuid, "FirstPlayer"], [peer, "SecondPlayer"]])
    store.set("player-activity", id, {
      uuid: id, name, proxy: "na", ip: "192.0.2.1", ipObservedAt: now, lastSeen: now,
    });
  const players = playerActivity(store);
  const result = players.alts(helper, { uuid });
  assert.deepEqual(result.matches.map((value) => value.name), ["FirstPlayer", "SecondPlayer"]);
  assert.ok(!JSON.stringify(result).includes("192.0.2.1"));
  assert.ok(!Object.hasOwn(players.get(helper, uuid), "ip"));
  assert.throws(() => players.alts(helper, { ip: "192.0.2.1" }), { code: "players_access_denied" });
  assert.throws(() => players.alts({
    ...helper, capabilities: { ...helper.capabilities, "moderation.alts": false },
  }, { uuid }), { code: "players_access_denied" });
  const former = policy.apply({ ...helper, staffMember: false });
  assert.throws(() => players.alts(former, { uuid }), { code: "players_access_denied" });
});
test("the Minecraft alternate lookup uses the separate association capability", async (t) => {
  const app = express();
  const helper = { id: "helper", capabilities: { "moderation.alts": true } };
  const checks = [];
  app.use(minecraftBridgeRouter({
    staffOrigin: "http://127.0.0.1",
    storefront: { origin: "https://store.test" },
  }, {}, {}, () => "na", {
    moderation: {
      actor: async () => helper,
      authorize: (actor, key) => {
        checks.push(key);
        if (!actor.capabilities[key]) throw Object.assign(new Error(), { status: 403 });
      },
      resolveMinecraftTarget: async (_actor, target) => target,
    },
    players: {
      alts: (actor, target) => {
        assert.equal(actor, helper);
        assert.equal(target.uuid, "12345678-1234-4234-8234-123456789012");
        return { matches: [{ name: "AssociatedPlayer" }] };
      },
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${server.address().port}/api/minecraft/proxy`, {
      method: "POST",
      agent: false,
      headers: { Host: "127.0.0.1", "Content-Type": "application/json" },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    });
    request.on("error", reject);
    request.end(JSON.stringify({
      operation: "moderation-alts", actorUuid: "helper",
      target: { uuid: "12345678-1234-4234-8234-123456789012" },
    }));
  });
  assert.equal(response.status, 200);
  assert.deepEqual(checks, ["moderation.alts"]);
  assert.deepEqual(response.body, { ok: true, matches: [{ name: "AssociatedPlayer" }] });
});
