import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openStore } from "../server/store.js";
import {
  staffReviews,
  nextReviewDate,
  staffReviewAccess,
  reviewProgress,
} from "../server/staff-reviews.js";
import { staffDirectory } from "../server/staff-directory.js";
import { config as fixture } from "./fixture.js";
const forever = Number.MAX_SAFE_INTEGER;
const config = {
  ...fixture,
  staffOrigin: "https://staff.example.invalid",
  roleSync: { guildId: "2" },
  privacy: { retentionEnabled: true },
};
const manager = {
  id: "100",
  name: "Manager",
  roles: ["10", "28"],
  permissions: { dashboard: true },
};
function setup(t) {
  const store = openStore(":memory:", randomBytes(32).toString("base64")).store;
  const apps = openStore(":memory:", randomBytes(32).toString("base64")).store;
  let time = Date.parse("2026-10-05T12:00:00Z"),
    applied = true,
    grants = 0;
  const people = [
    { id: "200", name: "Helper", roles: ["10", "23"] },
    { id: "201", name: "Developer", roles: ["25"] },
    manager,
    { id: "202", name: "Founder", roles: ["20", "25"] },
  ];
  const assignments = {
    metadata: async () =>
      config.ranks.map((rank) => ({
        ...rank,
        assignable: true,
        specialist: ["25", "26", "27"].includes(rank.id),
      })),
    list: async (_user, id) => ({ members: [{ id, version: "current" }] }),
    status: () => ({
      discord: {
        main: { status: applied ? "synced" : "retry" },
        staff: { status: "synced" },
      },
    }),
    grant: async (user, id, version, rank) => {
      grants++;
      assert.equal(version, "current");
      store.set(
        "role-assignment",
        id,
        { rank, requestedAt: time, actor: user, status: "applied" },
        forever,
      );
    },
    reconcile: async () => {},
  };
  const service = staffReviews(config, store, {
    roster: async () => people,
    member: async (id) => people.find((item) => item.id === id),
    assignments,
    applicationStore: apps,
    now: () => time,
  });
  t.after(async () => {
    await service.close();
    store.close();
    apps.close();
  });
  return {
    service,
    store,
    apps,
    people,
    advance(value) {
      time = Date.parse(value);
    },
    applied(value) {
      applied = value;
    },
    grants: () => grants,
  };
}
test("calendar reviews clamp short months and return to the original day", () => {
  const anchor = Date.parse("2026-01-31T12:30:00Z");
  assert.equal(
    new Date(nextReviewDate(anchor, anchor)).toISOString(),
    "2026-02-28T12:30:00.000Z",
  );
  assert.equal(
    new Date(
      nextReviewDate(anchor, Date.parse("2026-02-28T12:30:00Z")),
    ).toISOString(),
    "2026-03-31T12:30:00.000Z",
  );
});
test("enrollment includes specialists, excludes Manager and Founder holders, and opens one review when due", async (t) => {
  const { service, advance } = setup(t);
  await service.tick();
  assert.deepEqual([...service.summaries().keys()], ["200", "201"]);
  assert.equal(service.records().length, 0);
  advance("2026-11-05T12:00:00Z");
  await service.tick();
  await service.tick();
  assert.equal(service.records().length, 2);
  assert.equal(
    service.records()[0].periodFrom,
    Date.parse("2026-10-05T12:00:00Z"),
  );
});
test("recorded acceptance anchors the first review, without fabricated legacy acceptance dates", async (t) => {
  const { service, apps } = setup(t);
  apps.set(
    "application",
    "accepted",
    {
      discord: { id: "200" },
      status: "Approved",
      decision: { decidedAt: Date.parse("2026-09-05T12:00:00Z") },
    },
    forever,
  );
  await service.tick();
  assert.equal(service.records().length, 1);
  assert.equal(service.records()[0].anchorSource, "application");
  assert.equal(service.summaries().get("201").anchorSource, "enrolled");
});
test("Admin and delegated capabilities do not authorize private reviews", async (t) => {
  const { service } = setup(t);
  const admin = {
    ...manager,
    roles: ["10", "21"],
    capabilities: { "accounts.view": true, "roles.assign": true },
  };
  assert.equal(staffReviewAccess(config, admin), false);
  await assert.rejects(service.startEarly(admin, "200"), {
    code: "staff_review_manager_required",
  });
  assert.throws(() => service.list(admin), {
    code: "staff_review_manager_required",
  });
  await assert.rejects(service.startEarly(manager, "202"), {
    code: "staff_review_ineligible",
  });
});
test("early reviews, discussion edits and Continue preserve a single decision and monthly schedule", async (t) => {
  const { service } = setup(t);
  const review = await service.startEarly(manager, "200");
  assert.equal((await service.startEarly(manager, "200")).id, review.id);
  service.comment(manager, review.id, "Useful work", "discord", "300");
  service.comment(
    manager,
    review.id,
    "Useful work and steady progress",
    "discord",
    "300",
  );
  assert.equal(service.detail(manager, review.id).messages.length, 1);
  await service.decide(manager, review.id, {
    action: "continue",
    assessment: "Keep observing",
  });
  await service.decide(manager, review.id, { action: "continue" });
  assert.equal(service.get(review.id).status, "continued");
  assert.equal(service.get(review.id).decision.assessment, "Keep observing");
  assert.equal(service.summaries().get("200").openId, null);
  assert.throws(() => service.comment(manager, review.id, "late message"), {
    code: "staff_review_closed",
  });
});
test("promotion restricts higher ranks and waits for both guilds without granting twice", async (t) => {
  const { service, applied, grants } = setup(t);
  const review = await service.startEarly(manager, "200");
  const choices = await service.promotionOptions(manager, review.id);
  assert.equal(
    choices.some((role) =>
      ["Founder", "Manager", "Helper"].includes(role.name),
    ),
    false,
  );
  assert.equal(
    choices.some((role) => role.name === "Moderator"),
    true,
  );
  await assert.rejects(
    service.decide(manager, review.id, { action: "promote", roleId: "20" }),
    { code: "invalid_review_promotion" },
  );
  applied(false);
  await service.decide(manager, review.id, {
    action: "promote",
    roleId: "22",
    message: "Well done!",
  });
  assert.equal(service.get(review.id).status, "promotion_pending");
  assert.equal(service.summaries().get("200").openId, review.id);
  applied(true);
  await service.decide(manager, review.id, { action: "promote", roleId: "22" });
  assert.equal(service.get(review.id).status, "promoted");
  assert.equal(service.get(review.id).decision.message, "Well done!");
  assert.equal(grants(), 1);
});
test("changed roles invalidate an open review instead of allowing a stale promotion", async (t) => {
  const { service, people } = setup(t);
  const review = await service.startEarly(manager, "200");
  people[0].roles = ["10", "22"];
  await assert.rejects(
    service.decide(manager, review.id, { action: "continue" }),
    { code: "staff_review_roles_changed" },
  );
  await service.tick();
  assert.equal(service.get(review.id).status, "cancelled");
});
test("retention removes external review resources before local data and respects holds", async (t) => {
  const { service, store, advance } = setup(t);
  const first = await service.startEarly(manager, "200");
  const second = await service.startEarly(manager, "201");
  service.comment(manager, first.id, "Private review content");
  let removed = [];
  service.setTransport({
    erase: async (review) => removed.push(review.id),
    flush: async () => {},
    close: async () => {},
  });
  store.set(
    "privacy-hold",
    second.id,
    { reason: "A scoped test hold" },
    forever,
  );
  advance("2027-10-06T12:00:00Z");
  const a = service.get(first.id);
  a.status = "continued";
  a.closedAt = first.openedAt;
  service.save(a);
  const b = service.get(second.id);
  b.status = "continued";
  b.closedAt = second.openedAt;
  service.save(b);
  await service.tick();
  assert.deepEqual(removed, [first.id]);
  assert.throws(() => service.get(first.id), {
    code: "staff_review_not_found",
  });
  assert.equal(store.entries(`staff-review-messages:${first.id}`).length, 0);
  assert.equal(service.get(second.id).id, second.id);
});
test("progress uses real ticket actors and task assignments, including zero and missing data", (t) => {
  const { store } = setup(t);
  store.set(
    "ticket",
    "case",
    {
      id: "case",
      status: "closed",
      resolution: { actor: { id: "200" }, at: 200 },
      rating: 5,
      ratingStaff: { id: "200" },
    },
    forever,
  );
  store.set(
    "ticket-messages:case",
    "message",
    { actor: { id: "200" }, at: 150, internal: false },
    forever,
  );
  store.set(
    "discord-todo",
    "task",
    {
      assigneeDiscordId: "200",
      discord: { title: "Build spawn", status: "In Progress" },
    },
    forever,
  );
  const progress = reviewProgress(store, { store }, "200", 100, 300);
  assert.equal(progress.ticketsResolved, 1);
  assert.equal(progress.replies, 1);
  assert.equal(progress.averageRating, 5);
  assert.deepEqual(progress.trackedTasks, [
    { title: "Build spawn", status: "In Progress" },
  ]);
  assert.equal(reviewProgress(store, null, "201", 100, 300).ticketsResolved, 0);
});
test("public directory publishes only current identities and ranks, with role changes reflected", async () => {
  const people = [
    {
      id: "200",
      name: "Helper",
      roles: ["23", "25"],
      email: "private@example.invalid",
      status: "online",
    },
  ];
  const directory = staffDirectory(
    config,
    async () => people,
    () => ({
      name: "MinecraftName",
      status: "pending",
      changeRequest: { name: "PrivateName" },
    }),
  );
  let data = await directory();
  assert.deepEqual(data.groups[0].members[0], {
    name: "Helper",
    minecraft: "MinecraftName",
    ranks: ["Helper", "Developer"],
  });
  people[0].roles = [];
  data = await directory();
  assert.equal(data.total, 0);
});

import { EventEmitter } from "node:events";
import { staffReviewDiscord } from "../server/staff-review-discord.js";
test("private Discord threads restrict membership, sync both directions and recover uncertain sends", async (t) => {
  const { service, store, people } = setup(t);
  const review = await service.startEarly(manager, "200");
  const client = new EventEmitter();
  client.user = { id: "500" };
  client.isReady = () => true;
  client.guilds = {
    cache: new Map([
      [
        "1",
        {
          available: true,
          members: {
            cache: new Map(
              people.map((person) => [
                person.id,
                {
                  id: person.id,
                  user: { bot: false },
                  roles: {
                    cache: new Map(person.roles.map((role) => [role, true])),
                  },
                },
              ]),
            ),
          },
        },
      ],
    ]),
  };
  let channel,
    serial = 700,
    creations = 0,
    failSend = true;
  let members = [{ user_id: "300" }];
  const messages = new Map([["600", []]]);
  const forbidden = {
    ...manager,
    id: "300",
    name: "Admin",
    roles: ["10", "21"],
  };
  client.rest = {
    async get(path, options) {
      if (path === "/channels/600")
        return { id: "600", guild_id: "1", type: 0 };
      if (path === "/guilds/1/threads/active")
        return { threads: channel ? [channel] : [] };
      if (path === "/channels/601") return channel;
      if (path === "/channels/601/thread-members") return members;
      const match = path.match(/^\/channels\/(\d+)\/messages(?:\/(\d+))?$/);
      if (match) {
        const all = messages.get(match[1]) || [];
        if (match[2]) return all.find((item) => item.id === match[2]);
        const after = options?.query?.get("after");
        return after
          ? all.filter((item) => BigInt(item.id) > BigInt(after))
          : all;
      }
      throw new Error(`Unexpected Discord read ${path}`);
    },
    async post(path, { body }) {
      if (path === "/channels/600/threads") {
        creations++;
        assert.equal(body.type, 12);
        assert.equal(body.invitable, false);
        channel = {
          id: "601",
          parent_id: "600",
          type: 12,
          name: body.name,
          thread_metadata: { archived: false },
        };
        messages.set("601", []);
        return channel;
      }
      if (path === "/users/@me/channels") {
        messages.set("602", messages.get("602") || []);
        return { id: "602" };
      }
      const match = path.match(/^\/channels\/(\d+)\/messages$/);
      if (match) {
        const sent = {
          id: String(++serial),
          author: { id: "500", bot: true },
          ...body,
          timestamp: new Date().toISOString(),
        };
        messages.get(match[1]).push(sent);
        if (failSend && body.embeds[0].description === "Panel discussion") {
          failSend = false;
          throw new Error("Lost send response");
        }
        return sent;
      }
      throw new Error(`Unexpected Discord write ${path}`);
    },
    async put(path) {
      assert.ok(
        [
          "/channels/601/thread-members/100",
          "/channels/601/thread-members/202",
        ].includes(path),
      );
      members.push({ user_id: path.split("/").at(-1) });
    },
    async delete(path) {
      const id = path.split("/").at(-1);
      members = members.filter((item) => item.user_id !== id);
    },
    async patch(_path, { body }) {
      Object.assign(channel.thread_metadata, body);
    },
  };
  const bridge = staffReviewDiscord(
    { ...config, staffReviews: { channelId: "600" } },
    store,
    { gateway: client },
    service,
    async (id) =>
      id === "300" ? forbidden : people.find((item) => item.id === id),
  );
  service.setTransport(bridge);
  service.comment(manager, review.id, "Panel discussion");
  await bridge.flush();
  assert.ok(service.get(review.id).discord.error);
  await bridge.flush();
  assert.equal(service.get(review.id).discord.error, null);
  assert.equal(creations, 1);
  assert.deepEqual(members, [{ user_id: "100" }, { user_id: "202" }]);
  assert.equal(
    messages
      .get("601")
      .filter((item) => item.embeds[0].description === "Panel discussion")
      .length,
    1,
  );
  messages.get("601").push(
    {
      id: "900",
      author: { id: "100" },
      content: "Discord discussion",
      timestamp: "2026-10-05T12:00:00Z",
    },
    {
      id: "901",
      author: { id: "300" },
      content: "Must not import",
      timestamp: "2026-10-05T12:00:00Z",
    },
  );
  await bridge.flush();
  assert.equal(service.detail(manager, review.id).messages.length, 2);
  assert.equal(
    service
      .detail(manager, review.id)
      .messages.some((item) => item.body === "Must not import"),
    false,
  );
  await service.decide(manager, review.id, { action: "continue" });
  assert.equal(channel.thread_metadata.archived, true);
  assert.equal(channel.thread_metadata.locked, true);
  channel = null;
  const promotion = await service.startEarly(manager, "200");
  await service.decide(manager, promotion.id, {
    action: "promote",
    roleId: "22",
    message: "Thank you for your work!",
  });
  assert.equal(service.get(promotion.id).status, "promoted");
  assert.equal(service.get(promotion.id).discord.dm, "sent");
  assert.equal(
    messages.get("602").at(-1).embeds[0].description,
    "Thank you for your work!",
  );
  const count = messages.get("602").length;
  await bridge.flush();
  assert.equal(messages.get("602").length, count);
});

import express from "express";
import { request as httpRequest } from "node:http";
import { staffReviewRouter } from "../server/staff-review-routes.js";
import { AuthError } from "../server/discord.js";
test("review HTTP routes enforce Manager access, host, mutation guard and malformed request limits", async (t) => {
  const { service } = setup(t);
  const review = await service.startEarly(manager, "200");
  let user = manager;
  const app = express();
  app.use(
    staffReviewRouter({
      reviews: service,
      staffHost: "staff.example.invalid",
      dist: "/unused",
      authorize: async () => user,
      mutation: (req) => {
        if (req.headers["x-csrf-token"] !== "approved")
          throw new AuthError("invalid_request");
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res
      .status(error.status || 503)
      .json({ error: error.code || "service_unavailable" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = `http://127.0.0.1:${server.address().port}`;
  function sendHTTP(url, options = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        url,
        { method: options.method || "GET", headers: options.headers },
        (response) => {
          response.resume();
          response.on("end", () => resolve({ status: response.statusCode }));
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  }
  const headers = {
    Host: "staff.example.invalid",
    "Content-Type": "application/json",
  };
  assert.equal(
    (await sendHTTP(`${address}/api/staff-reviews/${review.id}`, { headers }))
      .status,
    200,
  );
  user = { ...manager, roles: ["10", "21"] };
  assert.equal(
    (await sendHTTP(`${address}/api/staff-reviews/${review.id}`, { headers }))
      .status,
    403,
  );
  user = manager;
  assert.equal(
    (
      await sendHTTP(`${address}/api/staff-reviews/${review.id}/decision`, {
        headers,
        method: "POST",
        body: JSON.stringify({ action: "continue" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await sendHTTP(`${address}/api/staff-reviews/${review.id}/messages`, {
        headers: { ...headers, "x-csrf-token": "approved" },
        method: "POST",
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await sendHTTP(`${address}/api/staff-reviews`, {
        headers: { Host: "other.example.invalid" },
      })
    ).status,
    404,
  );
  assert.equal(service.get(review.id).status, "open");
});
