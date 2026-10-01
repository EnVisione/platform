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

test("access roles are independent and ranks never grant access", () => {
  for (const rank of ranks) {
    assert.equal(permissions([rank.id]).dashboard, false);
    assert.equal(permissions([rank.id]).todo, false);
  }
  assert.equal(permissions([accessRoles.dashboard]).todo, false);
  assert.equal(permissions([accessRoles.todo]).dashboard, false);
  const both = permissions(Object.values(accessRoles));
  assert.equal(both.dashboard && both.todo, true);
});
test("highest rank determines Huly permissions and specialist roles stay in Huly", () => {
  assert.equal(permissions(ranks.map((role) => role.id)).hulyRole, "OWNER");
  assert.equal(
    permissions(ranks.slice(1).map((role) => role.id)).hulyRole,
    "MAINTAINER",
  );
  assert.equal(
    permissions(ranks.slice(2).map((role) => role.id)).hulyRole,
    "USER",
  );
  const specialist = permissions(ranks.slice(5).map((role) => role.id));
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
  let body = { roles: [accessRoles.todo] };
  const client = discordClient(
    config,
    store,
    async () => new Response(JSON.stringify(body), { status }),
  );
  assert.equal((await client.check("42", true)).permissions.todo, true);
  body = { roles: [] };
  assert.equal((await client.check("42", true)).permissions.todo, false);
  body = { roles: [accessRoles.todo], pending: true };
  assert.equal((await client.check("42", true)).permissions.todo, false);
  status = 503;
  await assert.rejects(client.check("42", true), {
    code: "discord_unavailable",
  });
  status = 404;
  assert.equal((await client.check("42", true)).permissions.todo, false);
});
