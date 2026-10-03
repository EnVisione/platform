import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../server/store.js";
import { ticketService } from "../server/tickets.js";
import { ticketTranscript } from "../server/ticket-transcript.js";
import { rolePermissions } from "../server/role-permissions.js";
import { config as fixture } from "./fixture.js";

const config = {
  ...fixture,
  applications: { publicOrigin: "https://example.invalid" },
  tickets: { guildId: "2", minecraftEnabled: false },
};
const owner = { id: "100", name: "Player" };
const helper = { id: "200", name: "Helper", roles: ["10", "23"] };
const manager = { id: "201", name: "Manager", roles: ["10", "28"] };
const otherStaff = { id: "202", name: "Other Helper", roles: ["10", "23"] };
const input = (values = {}) => ({
  requestId: randomUUID(),
  ign: "Jojo",
  type: "general",
  location: "Prominence II — Terra",
  description: "The quest is stuck even after completing every listed step.",
  ...values,
});
function setup(t, options) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const policy = rolePermissions(config, store);
  const service = ticketService(config, store, policy, options);
  t.after(async () => {
    await service.stop();
    store.close();
  });
  return { store, policy, service };
}
function mediaFixture(service, user, id, metadata, internal = false) {
  const file = {
    ...metadata,
    id: randomUUID(),
    ticketId: id,
    uploader: user.id,
    internal,
    used: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 86400000,
  };
  service.store.set("ticket-media", file.id, file, Number.MAX_SAFE_INTEGER);
  return file;
}
const fails = (action, code) =>
  assert.throws(action, (error) => error.code === code);
const message = (content = "Hello") => ({ requestId: randomUUID(), content });

test("ticket intake verifies fields, prevents duplicate creation and enforces the open limit", (t) => {
  const { service } = setup(t);
  const data = input();
  const first = service.create(owner, data);
  assert.equal(service.create(owner, data).id, first.id);
  assert.equal(service.all().length, 1);
  fails(
    () => service.create(owner, input({ ign: "../../secret" })),
    "invalid_ticket",
  );
  fails(
    () => service.create(owner, input({ description: "hi" })),
    "invalid_ticket",
  );
  fails(
    () => service.create(owner, input(), "minecraft"),
    "ticket_origin_disabled",
  );
  service.create(owner, input());
  service.create(owner, input());
  fails(() => service.create(owner, input()), "ticket_limit");
  assert.equal(service.get(first.id).origin, "web");
});

test("private ownership and staff report rank boundaries apply to reads, replies and logs", (t) => {
  const { service } = setup(t);
  const ticket = service.create(owner, input({ type: "staff" }));
  fails(() => service.view({ id: "999" }, ticket.id), "ticket_not_found");
  fails(() => service.view(helper, ticket.id, true), "ticket_access_denied");
  fails(
    () => service.reply(helper, ticket.id, message(), true),
    "ticket_access_denied",
  );
  assert.equal(service.list(helper).total, 0);
  assert.equal(service.list(manager).total, 1);
  assert.equal(service.view(manager, ticket.id, true).ign, "Jojo");
  fails(
    () => service.claim({ ...helper, roles: ["23"] }, ticket.id),
    "ticket_access_denied",
  );
});

test("claim is atomic, repeat-safe and cannot be stolen by another staff member", (t) => {
  const { service } = setup(t);
  const ticket = service.create(owner, input());
  service.claim(helper, ticket.id);
  const revision = service.get(ticket.id).revision;
  service.claim(helper, ticket.id);
  assert.equal(service.get(ticket.id).revision, revision);
  fails(() => service.claim(otherStaff, ticket.id), "ticket_already_claimed");
  assert.equal(service.get(ticket.id).claimedBy.id, helper.id);
});

test("message retry is idempotent and attachment references cannot cross owners or tickets", (t) => {
  const { service } = setup(t);
  const first = service.create(owner, input()),
    second = service.create(owner, input());
  const file = mediaFixture(service, owner, first.id, {
    name: "proof.png",
    size: 8,
    type: "image/png",
  });
  const request = { ...message(), attachments: [file.id] };
  fails(() => service.reply(owner, second.id, request), "invalid_attachment");
  fails(
    () => service.reply(helper, first.id, request, true),
    "invalid_attachment",
  );
  const saved = service.reply(owner, first.id, request);
  assert.equal(service.reply(owner, first.id, request).id, saved.id);
  assert.equal(service.messages(first.id).length, 1);
  fails(
    () =>
      service.reply(owner, first.id, { ...request, requestId: randomUUID() }),
    "invalid_attachment",
  );
});

test("outbox delivery isolates tickets and never overwrites changes made during a Discord request", async (t) => {
  const { service, store } = setup(t);
  const a = service.create(owner, input()),
    b = service.create(owner, input());
  service.bind(a.id, "400");
  service.bind(b.id, "401");
  service.reply(owner, a.id, message("First"));
  service.reply(owner, b.id, message("Second"));
  const delivered = [];
  service.attach({
    async create() {},
    async status() {},
    async message(ticket, item) {
      delivered.push(`${ticket.id}:${item.content}`);
      if (item.content === "First")
        service.reply(owner, a.id, message("During send"));
      return { id: String(500 + delivered.length) };
    },
  });
  await service.pump();
  await service.pump();
  assert.equal(delivered.length, 3);
  assert.equal(new Set(delivered).size, 3);
  assert.equal(service.get(a.id).sequence, 2);
  assert.equal(service.messages(a.id)[1].content, "During send");
  assert.equal(store.entries("ticket-outbox").length, 0);
});

test("a status change during delivery retains a fresh outbox job", async (t) => {
  const { service, store } = setup(t);
  const ticket = service.create(owner, input());
  service.bind(ticket.id, "400");
  service.claim(helper, ticket.id);
  let calls = 0;
  service.attach({
    async create() {},
    async status() {
      calls++;
      if (calls === 1) service.closeTicket(owner, ticket.id, {});
    },
  });
  await service.pump();
  assert.equal(store.entries("ticket-outbox").length, 1);
  await service.pump();
  assert.equal(calls, 2);
  assert.equal(service.get(ticket.id).status, "awaiting_resolution");
});

test("a failed reply holds later replies in order while other tickets continue", async (t) => {
  let time = Date.now();
  const { service } = setup(t, { now: () => time });
  const first = service.create(owner, input()),
    other = service.create(owner, input());
  service.bind(first.id, "400");
  service.bind(other.id, "401");
  service.reply(owner, first.id, message("First reply"));
  service.reply(owner, first.id, message("Later reply"));
  service.reply(owner, other.id, message("Other ticket"));
  const delivered = [];
  let unavailable = true;
  service.attach({
    async create() {},
    async status() {},
    async message(ticket, item) {
      if (item.content === "First reply" && unavailable)
        throw new Error("Temporary delivery failure");
      delivered.push(item.content);
      return { id: String(500 + delivered.length) };
    },
  });
  await service.pump();
  await service.pump();
  assert.deepEqual(delivered, ["Other ticket"]);
  unavailable = false;
  time += 3000;
  await service.pump();
  assert.deepEqual(delivered, ["Other ticket", "First reply", "Later reply"]);
});

test("Discord attachment edits preserve unchanged media and remove deleted files from views", (t) => {
  const { service } = setup(t);
  const ticket = service.create(owner, input());
  const original = {
    id: "650",
    actor: owner,
    content: "Evidence",
    attachments: [
      {
        channelId: "400",
        messageId: "650",
        attachmentId: "651",
        name: "proof.png",
        type: "image/png",
        size: 20,
      },
    ],
  };
  service.ingest(ticket.id, original);
  const revision = service.get(ticket.id).revision;
  const fileId = service.messages(ticket.id)[0].attachments[0];
  service.ingest(ticket.id, original);
  assert.equal(service.get(ticket.id).revision, revision);
  service.ingest(ticket.id, { ...original, content: "Updated evidence" });
  assert.deepEqual(service.messages(ticket.id)[0].attachments, [fileId]);
  service.ingest(ticket.id, {
    ...original,
    content: "Updated evidence",
    attachments: [],
  });
  assert.deepEqual(service.view(owner, ticket.id).messages[0].attachments, []);
  service.ingest(ticket.id, { ...original, id: "652" });
  service.ingest(ticket.id, { id: "652", deleted: true });
  assert.deepEqual(service.view(owner, ticket.id).messages[1].attachments, []);
  fails(() => service.media(owner, ticket.id, fileId), "attachment_expired");
  service.ingest(ticket.id, {
    ...original,
    id: "653",
    content: "Latest edit",
    editedAt: 20,
  });
  service.ingest(ticket.id, {
    ...original,
    id: "653",
    content: "Stale fetched edit",
    editedAt: 10,
  });
  assert.equal(service.messages(ticket.id).at(-1).content, "Latest edit");
  service.ingest(ticket.id, { id: "653", deleted: true });
  service.ingest(ticket.id, { ...original, id: "653", editedAt: 30 });
  assert.equal(service.messages(ticket.id).at(-1).deleted, true);
});

test("owner close requires a later staff resolution, optional rating accepts only one valid score", (t) => {
  const { service } = setup(t);
  const ticket = service.create(owner, input());
  fails(() => service.rate(owner, ticket.id, 5), "invalid_rating");
  service.closeTicket(owner, ticket.id, {});
  assert.equal(service.get(ticket.id).status, "awaiting_resolution");
  fails(() => service.reply(owner, ticket.id, message()), "ticket_closed");
  fails(
    () =>
      service.closeTicket(
        helper,
        ticket.id,
        { summary: "done", commands: "None" },
        true,
      ),
    "resolution_required",
  );
  service.closeTicket(
    helper,
    ticket.id,
    {
      summary:
        "Restored the missing quest state and verified the player's progress.",
      commands: "None",
    },
    true,
  );
  assert.equal(service.get(ticket.id).status, "closed");
  assert.equal(service.get(ticket.id).resolution.actor.id, helper.id);
  assert.equal(service.list(helper).total, 0);
  assert.equal(service.list(helper, { closed: true }).total, 1);
  fails(() => service.rate(owner, ticket.id, 6), "invalid_rating");
  service.rate(owner, ticket.id, 5);
  fails(() => service.rate(owner, ticket.id, 1), "ticket_already_rated");
});

test("player HTML escapes content and excludes private staff resolution and evidence", async (t) => {
  const { service } = setup(t);
  const ticket = service.create(
    owner,
    input({
      description:
        '<script>alert("x")</script> This is a detailed example issue.',
    }),
  );
  service.reply(owner, ticket.id, message('<img src=x onerror="alert(1)">'));
  const evidence = mediaFixture(
    service,
    helper,
    ticket.id,
    { name: "staff-secret.png", type: "image/png", size: 8 },
    true,
  );
  service.closeTicket(
    helper,
    ticket.id,
    {
      summary: "PRIVATE-RESOLUTION: checked and restored the affected player.",
      commands: "PRIVATE-COMMAND",
      attachments: [evidence.id],
    },
    true,
  );
  const player = await ticketTranscript(
    service,
    owner,
    ticket.id,
    false,
    async () => Buffer.from("proof"),
  );
  assert.ok(player.includes("&lt;script&gt;"));
  assert.ok(!player.includes("<script>"));
  assert.ok(!player.includes("PRIVATE-RESOLUTION"));
  assert.ok(!player.includes("PRIVATE-COMMAND"));
  assert.ok(!player.includes("staff-secret"));
  const staff = await ticketTranscript(
    service,
    helper,
    ticket.id,
    true,
    async () => Buffer.from("proof"),
  );
  assert.ok(staff.includes("PRIVATE-RESOLUTION"));
  assert.ok(staff.includes("PRIVATE-COMMAND"));
  assert.ok(staff.includes("staff-secret"));
  fails(() => service.media(owner, ticket.id, evidence.id), "ticket_not_found");
  const playerCopy = await ticketTranscript(
    service,
    helper,
    ticket.id,
    false,
    async () => Buffer.from("proof"),
    { authorizeAsStaff: true },
  );
  assert.ok(!playerCopy.includes("PRIVATE-RESOLUTION"));
});

test("Discord ingress handles repeated messages, edits, deletion and webhook echoes without duplication", (t) => {
  const { service, store } = setup(t);
  const ticket = service.create(owner, input());
  const incoming = {
    id: "600",
    actor: owner,
    content: "Original",
    attachments: [],
  };
  service.ingest(ticket.id, incoming);
  service.ingest(ticket.id, incoming);
  assert.equal(service.messages(ticket.id).length, 1);
  service.ingest(ticket.id, { ...incoming, content: "Edited" });
  assert.equal(service.messages(ticket.id)[0].content, "Edited");
  service.ingest(ticket.id, { id: "600", deleted: true });
  assert.equal(service.messages(ticket.id)[0].deleted, true);
  const outgoing = service.reply(owner, ticket.id, message());
  store.set("ticket-discord-message", "601", {
    ticketId: ticket.id,
    key: String(outgoing.sequence).padStart(12, "0"),
  });
  service.ingest(ticket.id, { ...incoming, id: "601", content: "Echo" });
  assert.equal(service.messages(ticket.id).length, 2);
  assert.equal(service.messages(ticket.id)[1].content, "Hello");
});

test("image retention removes Discord copies and retries failed deletion without losing history", async (t) => {
  let time = Date.now();
  const { service } = setup(t, { now: () => time });
  const ticket = service.create(owner, input()),
    file = mediaFixture(service, owner, ticket.id, {
      name: "proof.png",
      size: 8,
      type: "image/png",
    });
  service.reply(owner, ticket.id, { ...message(), attachments: [file.id] });
  let attempts = 0;
  service.attach({
    async removeMedia() {
      if (++attempts === 1) throw new Error("Discord unavailable");
    },
  });
  time += 31 * 86400000;
  await service.expire();
  fails(() => service.media(owner, ticket.id, file.id), "attachment_expired");
  await service.expire();
  assert.equal(attempts, 2);
  assert.equal(
    service.view(owner, ticket.id).messages[0].attachments[0].expired,
    true,
  );
  assert.equal(service.messages(ticket.id)[0].content, "Hello");
});

test("Discord identity handoff is single-use and bound to the opening browser", (t) => {
  const { service } = setup(t);
  const challenge = service.challenge("session-a", "/help/new");
  const url = service.handoff(challenge, owner),
    handoff = new URL(url).searchParams.get("handoff");
  fails(() => service.consume(handoff, "session-b"), "invalid_handoff");
  assert.equal(service.consume(handoff, "session-a").identity.id, owner.id);
  fails(() => service.consume(handoff, "session-a"), "invalid_handoff");
  fails(() => service.handoff(challenge, owner), "invalid_login_state");
});

test("saved tickets and pending deliveries survive database close and restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "drakora-tickets-test-"));
  let current;
  t.after(() => {
    current?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const key = randomBytes(32).toString("base64"),
    path = join(directory, "tickets.sqlite");
  current = openStore(path, key).store;
  const first = ticketService(
    config,
    current,
    rolePermissions(config, current),
  );
  const ticket = first.create(owner, input());
  first.reply(owner, ticket.id, message("Persist me"));
  await first.stop();
  current.close();
  current = openStore(path, key).store;
  const restored = ticketService(
    config,
    current,
    rolePermissions(config, current),
  );
  t.after(() => restored.stop());
  assert.equal(
    restored.view(owner, ticket.id).messages[0].content,
    "Persist me",
  );
  const sent = [];
  restored.attach({
    async create(value) {
      restored.bind(value.id, "700");
    },
    async message(_ticket, item) {
      sent.push(item.content);
      return { id: "701" };
    },
  });
  await restored.pump();
  await restored.pump();
  assert.deepEqual(sent, ["Persist me"]);
  assert.equal(current.entries("ticket-outbox").length, 0);
});

test("oversized attachment batches roll back without consuming uploaded files", (t) => {
  const { service } = setup(t);
  const ticket = service.create(owner, input());
  const files = [1, 2, 3].map(() =>
    mediaFixture(service, owner, ticket.id, {
      name: "proof.zip",
      type: "application/zip",
      size: 8 * 1024 * 1024,
    }),
  );
  fails(
    () =>
      service.reply(owner, ticket.id, {
        ...message(),
        attachments: files.map((file) => file.id),
      }),
    "attachments_too_large",
  );
  assert.equal(service.messages(ticket.id).length, 0);
  assert.equal(service.media(owner, ticket.id, files[0].id).used, false);
});

test("closed Discord channels expire even when the ticket has no attachments", async (t) => {
  let time = Date.now();
  const { service } = setup(t, { now: () => time });
  const ticket = service.create(owner, input());
  service.bind(ticket.id, "900");
  service.closeTicket(
    helper,
    ticket.id,
    {
      summary: "Confirmed the issue is resolved and documented the outcome.",
      commands: "None",
    },
    true,
  );
  const removed = [];
  service.attach({
    async removeClosed(value) {
      removed.push(value.id);
    },
  });
  time += 31 * 86400000;
  await service.expire();
  assert.deepEqual(removed, [ticket.id]);
  assert.equal(service.get(ticket.id).channelId, null);
  assert.equal(service.view(owner, ticket.id).sync, "archived");
  assert.equal(service.list(helper, { closed: true }).total, 1);
});
