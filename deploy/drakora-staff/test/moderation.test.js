import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { request as httpRequest } from "node:http";
import { openStore } from "../server/store.js";
import { honeypotService } from "../server/honeypot.js";
import { moderationHistory } from "../server/moderation.js";
import { moderationRouter } from "../server/moderation-routes.js";
import { ticketService } from "../server/tickets.js";
import { rolePermissions } from "../server/role-permissions.js";
import { config as fixture } from "./fixture.js";

const day = 86400000;
const database = (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  return store;
};
function save(store, extra = {}) {
  const record = {
    id: randomUUID(),
    userId: "100",
    name: "Player",
    username: "player",
    at: Date.now(),
    action: "timeout",
    result: "applied",
    guildId: "2",
    channelId: "3",
    ...extra,
  };
  store.set(
    "honeypot-audit",
    `${record.at}:${record.id}`,
    record,
    Number.MAX_SAFE_INTEGER,
  );
  return record;
}

test("moderation date and reason filters combine with actions and filtered counts", (t) => {
  const store = database(t),
    history = moderationHistory(store);
  const today = new Date().toISOString().slice(0, 10);
  const start = Date.parse(`${today}T00:00:00Z`);
  save(store, { at: start - 1, action: "ban", reason: "A unique test reason" });
  const wanted = save(store, {
    at: start,
    action: "timeout",
    reason: "A unique test reason",
  });
  save(store, { at: start, action: "ban", reason: "Another reason" });
  const result = history.list({
    from: today,
    to: today,
    query: "UNIQUE TEST",
    action: "timeout",
  });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, wanted.id);
  assert.deepEqual(result.counts, { warn: 0, timeout: 1, ban: 0 });
});

test("honeypot results connect identity and reasons to one retained moderation history", async (t) => {
  const store = database(t);
  const config = {
    sessionSecret: "fixture",
    honeypot: { enabled: true, guildId: "2", channelId: "3" },
  };
  let time = Date.now(),
    until = 0,
    present = true;
  const service = honeypotService(
    config,
    store,
    {
      ready: () => true,
      member: async () =>
        present
          ? {
              name: "Player One",
              username: "player.one",
              moderatable: true,
              bannable: true,
              timeoutUntil: until,
            }
          : null,
      timeout: async (_id, value) => {
        until = value;
      },
      ban: async () => {
        present = false;
      },
      isBanned: async () => false,
      removeMessage: async () => {},
      alert: async () => {},
      removeAlert: async () => {},
    },
    { now: () => time },
  );
  t.after(() => service.close());
  const incoming = {
    guildId: "2",
    channelId: "3",
    userId: "100",
    id: "1000",
    createdAt: time,
    name: "Original name",
    username: "original",
    content: "Never retain this text",
  };
  assert.equal(service.observe(incoming), true);
  await service.pump();
  const history = moderationHistory(store);
  let list = history.list({ userId: "100" });
  assert.equal(list.total, 1);
  assert.deepEqual(list.counts, { warn: 0, timeout: 1, ban: 0 });
  const timeout = list.items[0];
  assert.equal(timeout.name, "Player One");
  assert.equal(timeout.username, "player.one");
  assert.match(timeout.reason, /Honeypot.*First post/);
  assert.equal(timeout.timeoutUntil, time + day);
  assert.equal(timeout.expiresAt, time + 90 * day);
  assert.deepEqual(history.get(timeout.id), timeout);
  assert.equal(JSON.stringify(list).includes(incoming.content), false);
  time += day + 1;
  service.observe({ ...incoming, id: "1001", createdAt: time });
  await service.pump();
  list = history.list({ query: "PLAYER.ONE" });
  assert.equal(list.total, 2);
  assert.deepEqual(list.counts, { warn: 0, timeout: 1, ban: 1 });
  assert.equal(list.items[0].action, "ban");
  assert.match(list.items[0].reason, /Repeat post.*Permanent ban/);
  assert.equal(history.list({ userId: "200" }).total, 0);
  assert.equal(history.list({ userId: null }).matched, false);
  assert.equal(history.list({ userId: null }).total, 0);
  assert.equal(history.list({ action: "ban" }).total, 1);
});

test("moderation history excludes failed, protected and expired actions and validates pagination", (t) => {
  const store = database(t),
    history = moderationHistory(store);
  for (let i = 0; i < 30; i++) save(store, { at: Date.now() - i });
  const warning = save(store, { action: "warn", reason: "Recorded warning." });
  const failed = save(store, { result: "failed", action: "ban" });
  const expired = save(store, { at: Date.now() - 91 * day });
  save(store, { result: "skipped" });
  save(store, { action: "reset" });
  assert.equal(history.list().total, 31);
  assert.equal(history.list().items.length, 25);
  assert.equal(history.list({ offset: 25 }).items.length, 6);
  assert.equal(history.list({ action: "warn" }).items[0].id, warning.id);
  assert.equal(history.list({ query: "absent" }).total, 0);
  assert.throws(() => history.get(failed.id), { code: "moderation_not_found" });
  assert.throws(() => history.get(expired.id), {
    code: "moderation_not_found",
  });
  assert.throws(() => history.get("invalid"), { code: "moderation_not_found" });
  for (const input of [
    { offset: -1 },
    { offset: 0.1 },
    { offset: Infinity },
    { query: [] },
    { query: "x".repeat(101) },
    { action: "reset" },
  ])
    assert.throws(() => history.list(input), { code: "invalid_request" });
});

test("staff moderation routes combine current grants, verified identities and ticket category access", async (t) => {
  const store = database(t),
    history = moderationHistory(store);
  const config = { ...fixture, tickets: { guildId: "2" } };
  const policy = rolePermissions(config, store),
    tickets = ticketService(config, store, policy);
  t.after(() => tickets.stop());
  const applied = save(store);
  const support = tickets.create(
    { id: "100", name: "Player" },
    {
      type: "general",
      ign: "Player",
      location: "Server",
      description: "A sufficiently long support description for this test",
      requestId: randomUUID(),
    },
  );
  const billing = tickets.create(
    { id: "100", name: "Player" },
    {
      type: "billing",
      ign: "Player",
      location: "Store",
      description: "A sufficiently long billing description for this test",
      requestId: randomUUID(),
    },
  );
  const applications = {
    get: (id) =>
      ({
        linked: { discord: { id: "100" } },
        other: { discord: { id: "200" } },
        guest: { discord: null, answers: { ign: "Player" } },
      })[id],
  };
  let user = policy.apply({ id: "400", name: "Reviewer", roles: ["10", "22"] });
  const app = express();
  app.use(
    moderationRouter({
      history,
      authorize: async () => user,
      applications,
      tickets,
      staffHost: "staff.invalid",
      dist: "/does-not-exist",
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.code }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const call = (path, host = "staff.invalid") =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${server.address().port}${path}`,
        { headers: { host } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              json: async () => JSON.parse(body),
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end();
    });
  assert.equal((await call("/api/moderation")).status, 200);
  assert.equal((await call("/api/moderation?from=2026-02-30")).status, 400);
  assert.equal(
    (await (await call("/api/moderation?from=2099-01-01")).json()).total,
    0,
  );
  assert.equal(
    (
      await (await call(`/api/moderation/${applied.id}`)).json()
    ).reason.includes("Honeypot"),
    true,
  );
  assert.equal(
    (await (await call("/api/applications/linked/moderation")).json()).total,
    1,
  );
  assert.equal(
    (await (await call("/api/applications/other/moderation")).json()).total,
    0,
  );
  const guest = await (await call("/api/applications/guest/moderation")).json();
  assert.equal(guest.matched, false);
  assert.equal(guest.total, 0);
  assert.equal(
    (await call("/api/applications/missing/moderation")).status,
    404,
  );
  assert.equal(
    (await (await call(`/api/tickets/${support.id}/moderation`)).json()).total,
    1,
  );
  assert.equal(
    (await call(`/api/tickets/${billing.id}/moderation`)).status,
    403,
  );
  assert.equal((await call("/api/moderation", "public.invalid")).status, 403);
  user = {
    ...user,
    capabilities: { ...user.capabilities, "moderation.view": false },
  };
  assert.equal((await call("/api/moderation")).status, 403);
  assert.equal((await call(`/api/moderation/${applied.id}`)).status, 403);
  assert.equal((await call("/api/applications/linked/moderation")).status, 403);
  user = policy.apply({ id: "400", roles: ["22"] });
  assert.equal((await call("/api/moderation")).status, 403);
  user = policy.apply({ id: "400", roles: ["10", "20"] });
  assert.equal(
    (await call(`/api/tickets/${billing.id}/moderation`)).status,
    200,
  );
});
