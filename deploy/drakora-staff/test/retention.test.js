import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { openStore } from "../server/store.js";
import { ticketService } from "../server/tickets.js";
import { applicationService } from "../server/applications.js";
import { rolePermissions } from "../server/role-permissions.js";
import { legalRouter } from "../server/legal.js";
import {
  retentionService,
  privacyActivity,
  inactiveAt,
} from "../server/retention.js";
import { monthsAfter } from "../shared/privacy.js";
import { config as fixture } from "./fixture.js";

const forever = Number.MAX_SAFE_INTEGER;
const config = {
  ...fixture,
  privacy: { retentionEnabled: true },
  applications: {
    publicOrigin: "https://example.invalid",
    notificationChannelId: "50",
    specialistRoles: { builder: "51", artist: "52", developer: "25" },
  },
  tickets: { guildId: "2", minecraftEnabled: false },
};
const now = Date.parse("2026-10-03T12:00:00Z");
const old = Date.parse("2025-10-03T12:00:00Z");
function setup(t) {
  const stores = Array.from(
    { length: 3 },
    () => openStore(":memory:", randomBytes(32).toString("base64")).store,
  );
  const [staff, cases, apps] = stores;
  const tickets = ticketService(config, cases, rolePermissions(config, staff), {
    now: () => old,
  });
  const applications = applicationService(
    config,
    apps,
    async () => new Response(null, { status: 204 }),
  );
  const retention = retentionService(config, staff, {
    tickets,
    applications,
    applicationStore: apps,
    now: () => now,
  });
  t.after(async () => {
    await retention.close();
    await tickets.stop();
    await applications.close();
    for (const store of stores) store.close();
  });
  return { staff, cases, apps, tickets, applications, retention };
}
function ticket(tickets, ownerId = "100") {
  return tickets.create(
    { id: ownerId, name: "Player" },
    {
      requestId: randomUUID(),
      ign: "Player",
      type: "general",
      location: "Test",
      description: "A reproducible issue with a quest in the world.",
    },
  );
}
function application(store, id, discordId) {
  store.set(
    "application",
    id,
    {
      id,
      createdAt: old,
      role: "builder",
      status: "Denied",
      answers: { displayName: "Applicant" },
      discord: discordId ? { id: discordId } : null,
    },
    forever,
  );
  store.set(
    "application-summary",
    `${old}.${id}`,
    { id, createdAt: old, role: "builder", status: "Denied" },
    forever,
  );
}

test("inactivity uses calendar months and an exact boundary, including leap days", () => {
  const leap = Date.parse("2024-02-29T12:34:56Z");
  const due = Date.parse("2025-02-28T12:34:56Z");
  assert.equal(monthsAfter(leap, 12), due);
  assert.equal(inactiveAt(leap, due - 1), false);
  assert.equal(inactiveAt(leap, due), true);
  assert.equal(inactiveAt(undefined, now), false);
  assert.equal(inactiveAt(0, now), false);
});

test("sweep removes expired case children, applications and account credentials while preserving active owners", async (t) => {
  const { staff, cases, apps, tickets, retention } = setup(t);
  const expired = ticket(tickets);
  const active = ticket(tickets, "101");
  cases.set("ticket-discord-message", "900", { ticketId: expired.id }, forever);
  cases.set("ticket-email-access", "access", { ticketId: expired.id }, forever);
  cases.set("ticket-send", "msg", { ticketId: expired.id }, forever);
  cases.set(
    "ticket-history:" + expired.id,
    "entry",
    { actor: { id: "100" } },
    forever,
  );
  application(apps, "expired", "100");
  application(apps, "active", "101");
  apps.set("application-draft", "browser", { submittedId: "expired" }, forever);
  for (const id of ["100", "101"]) {
    staff.set(
      "user",
      id,
      { id, lastActiveAt: old, tokens: { secret: "test" } },
      forever,
    );
    staff.set("minecraft-link", id, { name: "Player" }, forever);
    privacyActivity(staff, id, old);
  }
  staff.set("session", "expired-session", { userId: "100" }, forever);
  privacyActivity(staff, "101", now);
  await retention.sweep();
  assert.equal(cases.get("ticket", expired.id), undefined);
  assert.equal(cases.get("ticket", active.id).id, active.id);
  for (const kind of cases.kinds())
    for (const [key, value] of cases.entries(kind)) {
      assert.ok(!key.includes(expired.id));
      assert.notEqual(value?.ticketId, expired.id);
    }
  assert.equal(apps.get("application", "expired"), undefined);
  assert.equal(apps.get("application-draft", "browser"), undefined);
  assert.equal(apps.get("application", "active").id, "active");
  assert.equal(staff.get("user", "100"), undefined);
  assert.equal(staff.get("minecraft-link", "100"), undefined);
  assert.equal(staff.get("session", "expired-session"), undefined);
  assert.ok(staff.get("user", "101"));
});

test("holds and first migration preserve records, without renewing unrelated users", async (t) => {
  const { staff, cases, apps, tickets, retention } = setup(t);
  const linked = ticket(tickets);
  const held = ticket(tickets, "102");
  staff.set("user", "100", { id: "100" }, forever);
  cases.set(
    "privacy-hold",
    held.id,
    { reason: "Test dispute", reviewAt: now },
    forever,
  );
  application(apps, "guest", null);
  await retention.sweep();
  assert.ok(cases.get("ticket", linked.id));
  assert.ok(cases.get("ticket", held.id));
  assert.equal(apps.get("application", "guest"), undefined);
  assert.equal(staff.get("privacy-activity", "100").at, now);
});

test("external failure withholds a record and retries cleanup, without losing its deletion intent", async (t) => {
  const { cases, tickets, retention } = setup(t);
  const saved = ticket(tickets);
  let fail = true,
    deletions = 0;
  tickets.attach({
    eraseTicket: async () => {
      deletions++;
      if (fail) throw new Error("Discord unavailable");
    },
  });
  assert.equal((await retention.sweep()).failed, 1);
  assert.ok(cases.get("ticket", saved.id).erasingAt);
  assert.throws(
    () => tickets.get(saved.id),
    (error) => error.code === "ticket_not_found",
  );
  assert.equal(tickets.all().length, 0);
  fail = false;
  assert.equal((await retention.sweep()).removed, 1);
  assert.equal(deletions, 2);
  assert.equal(cases.get("ticket", saved.id), undefined);
});

test("erasure waits for in-flight consumers before deleting their late records", async (t) => {
  const { cases, tickets } = setup(t);
  const saved = ticket(tickets);
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  tickets.registerCleanupWaiter(() => pending);
  const erase = tickets.eraseInactive(saved.id, old);
  await Promise.resolve();
  cases.set(
    "ticket-notice-delivery",
    saved.id + ":late",
    { ticketId: saved.id },
    forever,
  );
  finish();
  await erase;
  assert.equal(
    cases.get("ticket-notice-delivery", saved.id + ":late"),
    undefined,
  );
});

test("application deletion removes saved external notices and waits on failed external cleanup", async (t) => {
  const { apps } = setup(t);
  const requests = [];
  const applications = applicationService(
    config,
    apps,
    async (url, options) => {
      requests.push([url, options.method]);
      return new Response(null, { status: 204 });
    },
  );
  t.after(() => applications.close());
  application(apps, "expired", "100");
  apps.set(
    "application-delivery",
    "expired",
    { channelId: "50", messageId: "90" },
    forever,
  );
  assert.equal(await applications.eraseInactive("expired", old), true);
  assert.deepEqual(requests, [
    ["https://discord.com/api/v10/channels/50/messages/90", "DELETE"],
  ]);
  assert.equal(apps.get("application-delivery", "expired"), undefined);
});

test("disabled retention never deletes records", async (t) => {
  const { staff, cases, tickets } = setup(t);
  const saved = ticket(tickets);
  const retention = retentionService({}, staff, { tickets, now: () => now });
  t.after(() => retention.close());
  await retention.sweep();
  assert.ok(cases.get("ticket", saved.id));
});

test("application erasure preserves a shared update channel until the last record and checks ownership", async (t) => {
  const { apps } = setup(t);
  const calls = [];
  let topic = "Drakora application updates · 100";
  const applications = applicationService(
    {
      ...config,
      applications: {
        ...config.applications,
        fallback: { guildId: "60", categoryId: "62", reviewerRoleIds: ["61"] },
      },
    },
    apps,
    async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: options.method });
      return options.method === "GET"
        ? Response.json({ id: "200", guild_id: "60", type: 0, topic })
        : new Response(null, { status: 204 });
    },
  );
  t.after(() => applications.close());
  for (const id of ["old", "current"]) application(apps, id, "100");
  apps.set(
    "application-private-channel",
    "100",
    { guildId: "60", channelId: "200" },
    forever,
  );
  apps.set(
    "application-dm-delivery",
    "old:received",
    {
      route: "private",
      channelId: "999",
      channelUrl: "https://discord.com/channels/60/200",
      messageId: "90",
    },
    forever,
  );
  await applications.eraseInactive("old", old);
  assert.deepEqual(calls, [
    { path: "/api/v10/channels/200/messages/90", method: "DELETE" },
  ]);
  assert.ok(apps.get("application-private-channel", "100"));
  topic = "Unrelated channel";
  await assert.rejects(
    applications.eraseInactive("current", old),
    /fallback_channel_changed/,
  );
  assert.ok(apps.get("application-private-channel", "100"));
  topic = "Drakora application updates · 100";
  await applications.eraseInactive("current", old);
  assert.equal(apps.get("application-private-channel", "100"), undefined);
  assert.ok(
    calls.some(
      ({ path, method }) =>
        path === "/api/v10/channels/200" && method === "DELETE",
    ),
  );
});

test("legal routes are separate, escape runtime identity and require enabled retention before publication", async (t) => {
  const settings = {
    privacy: {
      published: true,
      retentionEnabled: true,
      controllerName: "Private <Operator>",
    },
  };
  const app = express();
  app.use(legalRouter(settings));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const policy = await (await fetch(origin + "/privacy")).text();
  assert.ok(policy.includes("Private &lt;Operator&gt;"));
  assert.ok(!policy.includes('<article id="terms"'));
  assert.ok(!policy.includes("<aside"));
  const terms = await (await fetch(origin + "/terms")).text();
  assert.ok(!terms.includes("Private &lt;Operator&gt;"));
  assert.ok(terms.includes("By joining or playing"));
  const css = await (await fetch(origin + "/legal.css")).text();
  assert.ok(
    css.includes("text-decoration: none") ||
      css.includes("text-decoration:none"),
  );
  settings.privacy.retentionEnabled = false;
  assert.equal((await fetch(origin + "/privacy")).status, 503);
});

test("account activity arriving during a sweep protects a later case", async (t) => {
  const { staff, cases, tickets, retention } = setup(t);
  const first = ticket(tickets),
    second = ticket(tickets, "101");
  let erased;
  tickets.attach({
    eraseTicket: async (saved) => {
      erased = saved.id;
      privacyActivity(staff, saved.id === first.id ? "101" : "100", now);
    },
  });
  assert.equal((await retention.sweep()).removed, 1);
  assert.equal(cases.get("ticket", erased), undefined);
  assert.ok(cases.get("ticket", erased === first.id ? second.id : first.id));
});

test("failed application cleanup stays hidden and is retried without deleting unrelated records", async (t) => {
  const { apps } = setup(t);
  let failure = true;
  const applications = applicationService(
    config,
    apps,
    async () =>
      new Response(
        failure ? JSON.stringify({ message: "Unavailable" }) : null,
        { status: failure ? 503 : 204 },
      ),
  );
  t.after(() => applications.close());
  application(apps, "expired", "100");
  application(apps, "other", "101");
  apps.set(
    "application-delivery",
    "expired",
    { channelId: "50", messageId: "90" },
    forever,
  );
  await assert.rejects(applications.eraseInactive("expired", old));
  assert.ok(apps.get("application", "expired").erasingAt);
  assert.equal(applications.get("expired"), undefined);
  assert.deepEqual(
    applications.list().items.map((item) => item.id),
    ["other"],
  );
  failure = false;
  await applications.eraseInactive("expired", old);
  assert.equal(apps.get("application", "expired"), undefined);
  assert.ok(apps.get("application", "other"));
});
