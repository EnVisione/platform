import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { openStore } from "../server/store.js";
import { ticketService } from "../server/tickets.js";
import { ticketRouter } from "../server/ticket-routes.js";
import { rolePermissions } from "../server/role-permissions.js";
import { AuthError } from "../server/discord.js";
import { reviewProgress } from "../server/staff-review-metrics.js";
import { ticketTranscript } from "../server/ticket-transcript.js";
import { config as fixture } from "./fixture.js";

const owner = { id: "100", name: "Player" };
const helper = { id: "200", name: "First Helper", roles: ["10", "23"] };
const second = { id: "201", name: "Second Helper", roles: ["10", "23"] };
const manager = { id: "300", name: "Manager", roles: ["10", "28"] };
const founder = { id: "400", name: "Founder", roles: ["10", "20"] };
const admin = { id: "500", name: "Admin", roles: ["10", "21"] };
function setup(t) {
  const config = {
    ...fixture,
    staffOrigin: "https://staff.example.invalid",
    applications: { publicOrigin: "https://example.invalid" },
    tickets: { guildId: "2" },
  };
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const policy = rolePermissions(config, store);
  const service = ticketService(config, store, policy);
  t.after(async () => {
    await service.stop();
    store.close();
  });
  const ticket = service.create(owner, {
    requestId: randomUUID(),
    ign: "Player",
    type: "general",
    location: "Eclipse",
    description: "A detailed issue for rating and staff history verification.",
  });
  service.claim(helper, ticket.id);
  service.closeTicket(helper, ticket.id, {}, true);
  const closureId = service.get(ticket.id).closureId;
  service.rate(owner, ticket.id, 1, closureId);
  const clearOutbox = () => {
    for (const [key] of store.entries("ticket-outbox"))
      store.delete("ticket-outbox", key);
  };
  const override = (action, extra = {}) =>
    service.overrideRating(manager, ticket.id, {
      revision: service.get(ticket.id).revision,
      closureId,
      action,
      reason: "Reviewed the circumstances of this support interaction.",
      ...extra,
    });
  return {
    config,
    store,
    policy,
    service,
    ticket,
    closureId,
    clearOutbox,
    override,
  };
}
const fails = (fn, code) => assert.throws(fn, (error) => error.code === code);

test("reopened logs retain the owner and every claimant in staff searches", async (t) => {
  const { service, ticket, clearOutbox } = setup(t);
  clearOutbox();
  await service.reopen(owner, ticket.id);
  service.claim(second, ticket.id);
  for (const member of [helper, second]) {
    const logs = service.list(founder, { closed: true, staff: member.id });
    assert.equal(logs.total, 1);
    assert.equal(logs.items[0].status, "claimed");
    assert.equal(logs.items[0].lastReopened.actor.id, owner.id);
    assert.deepEqual(
      logs.items[0].staffHistory.map((actor) => actor.id),
      [helper.id, second.id],
    );
  }
  assert.equal(service.list(founder, { staff: helper.name }).total, 1);
  assert.equal(
    service.list(founder, { closed: true, query: helper.name }).total,
    1,
  );
  assert.equal(
    service.list(founder, { closed: true, category: "billing" }).total,
    0,
  );
  assert.equal(service.staffStats(founder).get(helper.id).ticketsResolved, 1);
});

test("rating overrides exclude replace and restore without changing the player score", async (t) => {
  const { service, store, ticket, override } = setup(t);
  const totals = () => store.get("staff-support-totals", helper.id);
  assert.equal(totals().ticketsResolved, 1);
  override("exclude");
  assert.equal(service.get(ticket.id).rating, 1);
  assert.equal(service.staffStats(founder).get(helper.id).reviewCount, 0);
  assert.equal(totals().ratingCount, 0);
  assert.equal(totals().ratingTotal, 0);
  assert.equal(
    reviewProgress(store, service, helper.id, 0, Date.now() + 1000).ratingCount,
    0,
  );
  override("set", { rating: 4 });
  assert.equal(service.staffStats(founder).get(helper.id).averageRating, 4);
  assert.equal(totals().ratingCount, 1);
  assert.equal(totals().ratingTotal, 4);
  override("restore");
  assert.equal(service.staffStats(founder).get(helper.id).averageRating, 1);
  assert.equal(totals().ratingCount, 1);
  assert.equal(totals().ratingDistribution[4], 0);
  assert.equal(totals().ratingDistribution[1], 1);
  assert.equal(
    service
      .view(founder, ticket.id, true)
      .history.filter((entry) => entry.action === "rating_override").length,
    3,
  );
});

test("rating overrides on a previous closure persist through restart without duplicate totals", async (t) => {
  const { config, service, store, policy, ticket, override, clearOutbox } =
    setup(t);
  clearOutbox();
  await service.reopen(owner, ticket.id);
  service.claim(second, ticket.id);
  override("exclude");
  assert.equal(service.get(ticket.id).rating, null);
  assert.equal(
    service.view(manager, ticket.id, true).ratingModeration[0].effectiveRating,
    null,
  );
  assert.equal(service.staffStats(founder).get(helper.id).reviewCount, 0);
  const restarted = ticketService(config, store, policy);
  t.after(() => restarted.stop());
  assert.equal(store.get("staff-support-totals", helper.id).ratingCount, 0);
  assert.equal(restarted.staffStats(founder).get(helper.id).reviewCount, 0);
  override("restore");
  assert.equal(store.get("staff-support-totals", helper.id).ratingCount, 1);
});

test("rating overrides stay visible in staff transcripts and private from players", async (t) => {
  const { service, ticket, override, clearOutbox } = setup(t);
  override("exclude");
  const transcript = (user, staffView) =>
    ticketTranscript(service, user, ticket.id, staffView, async () =>
      Buffer.alloc(0),
    );
  assert.match(await transcript(founder, true), /Excluded from averages/);
  assert.doesNotMatch(
    await transcript(owner, false),
    /Excluded from averages|Required reason/,
  );
  clearOutbox();
  await service.reopen(owner, ticket.id);
  assert.match(await transcript(founder, true), /Excluded from averages/);
  assert.doesNotMatch(
    await transcript(helper, true),
    /Excluded from averages|Support rating excluded/,
  );
  assert.doesNotMatch(
    await transcript(owner, false),
    /Excluded from averages|Support rating excluded/,
  );
});

test("rating overrides enforce Manager permission reason closure and revision boundaries", (t) => {
  const { service, ticket, closureId, override } = setup(t);
  const input = {
    closureId,
    revision: service.get(ticket.id).revision,
    action: "exclude",
    reason: "Required reason",
  };
  for (const user of [
    owner,
    helper,
    admin,
    { ...helper, capabilities: { "tickets.rating.override": true } },
  ])
    assert.throws(() => service.overrideRating(user, ticket.id, input));
  fails(() => override("exclude", { reason: " " }), "invalid_rating_override");
  fails(() => override("set", { rating: 6 }), "invalid_rating_override");
  fails(
    () => override("exclude", { revision: input.revision - 1 }),
    "ticket_revision_changed",
  );
  fails(
    () => override("exclude", { closureId: randomUUID() }),
    "ticket_rating_not_found",
  );
  override("exclude");
  const limited = service.view(helper, ticket.id, true);
  assert.equal(limited.ratingModeration, undefined);
  assert.equal(limited.rating, undefined);
  assert.ok(
    limited.history.every((entry) => entry.action !== "rating_override"),
  );
  assert.equal(
    service.list(helper, { closed: true }).items[0].ratingOverride,
    undefined,
  );
  assert.equal(
    service.view(manager, ticket.id, true).ratingModeration[0].originalRating,
    1,
  );
  assert.equal(service.get(ticket.id).rating, 1);
});

test("rating overrides are protected by HTTP authorization and CSRF", async (t) => {
  const { service, config, policy, store, ticket, closureId } = setup(t);
  let identity = manager;
  const app = express();
  app.use(
    ticketRouter(
      config,
      service,
      {},
      {
        staffView: true,
        database: store,
        dist: "/missing",
        authorize: async () => policy.apply(identity),
        mutation: (req) => {
          if (req.headers["x-csrf-token"] !== "fixture")
            throw new AuthError("invalid_request", 403);
        },
      },
    ),
  );
  app.use((error, req, res, next) =>
    res.status(error.status || 500).json({ error: error.code }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/tickets/${ticket.id}/rating-override`;
  const body = JSON.stringify({
    revision: service.get(ticket.id).revision,
    closureId,
    action: "exclude",
    reason: "Checked by management.",
  });
  const call = (token) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body,
    });
  assert.equal((await call("invalid")).status, 403);
  identity = admin;
  assert.equal((await call("fixture")).status, 403);
  identity = manager;
  assert.equal((await call("fixture")).status, 200);
  assert.equal((await call("fixture")).status, 409);
  assert.equal(service.staffStats(founder).get(helper.id).reviewCount, 0);
});

test("rating overrides follow Manager grants and revocations without a rank bypass", (t) => {
  const { policy, service, ticket, closureId } = setup(t);
  assert.equal(
    policy.apply(manager).capabilities["tickets.rating.override"],
    true,
  );
  assert.equal(
    policy.apply(admin).capabilities["tickets.rating.override"],
    false,
  );
  const snapshot = policy.read(founder);
  policy.save(founder, {
    revision: snapshot.revision,
    roles: snapshot.roles
      .filter((role) => role.id)
      .map((role) => ({
        id: role.id,
        permissions: {
          ...role.permissions,
          ...(role.id === "28" ? { "tickets.rating.override": false } : {}),
        },
      })),
  });
  fails(
    () =>
      service.overrideRating(manager, ticket.id, {
        closureId,
        revision: service.get(ticket.id).revision,
        action: "exclude",
        reason: "A recorded reason.",
      }),
    "ticket_rating_manager_required",
  );
  assert.equal(service.get(ticket.id).ratingOverride, undefined);
  service.overrideRating(founder, ticket.id, {
    closureId,
    revision: service.get(ticket.id).revision,
    action: "exclude",
    reason: "Founder decision after review.",
  });
  assert.equal(service.staffStats(founder).get(helper.id).reviewCount, 0);
});
