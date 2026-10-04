import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import express from "express";
import session from "express-session";
import { openStore } from "../server/store.js";
import { rolePermissions } from "../server/role-permissions.js";
import { ticketService } from "../server/tickets.js";
import { ticketRouter } from "../server/ticket-routes.js";
import { partnershipContact } from "../server/partnership-contact.js";
import { AuthError } from "../server/discord.js";
import { config as fixture } from "./fixture.js";

const manager = { id: "manager", name: "Manager", roles: ["10", "28"] };
const founder = { id: "founder", name: "Founder", roles: ["10", "20"] };
const helper = { id: "helper", name: "Helper", roles: ["10", "23"] };
const guest = { id: "guest:partner", name: "Pack author", guest: true };
const discordOwner = { id: "123456789012345678", name: "Pack author" };
const network = "a".repeat(64);
const input = (override = {}) => ({
  requestId: randomUUID(),
  relationship: "owner",
  name: "Pack author",
  discord: "pack.author",
  email: "author@example.invalid",
  packUrl: "https://modrinth.com/modpack/example",
  description:
    "Our modpack is ready for a community server, with a focus on exploration and shared adventure.",
  preference: "email",
  ...override,
});
function harness(t) {
  let clock = Date.now();
  const config = {
    ...fixture,
    sessionSecret: randomBytes(32).toString("hex"),
    staffOrigin: "https://staff.example.invalid",
    applications: { publicOrigin: "https://example.invalid" },
    tickets: { guildId: "2", staffChannelId: "notices" },
    mail: {
      identities: [
        { address: "partners@drakora.org", name: "Drakora Partnerships" },
      ],
    },
  };
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const policy = rolePermissions(config, store),
    tickets = ticketService(config, store, policy, { now: () => clock });
  const state = {
    emails: [],
    dms: new Map(),
    blocked: false,
    lost: false,
    uncertain: false,
  };
  let nextId = BigInt(clock - 1420070400000) << 22n;
  const channel = {
    id: "dm",
    messages: {
      async fetch({ after }) {
        const found = new Map(
          [...state.dms].filter(([id]) => !after || BigInt(id) > BigInt(after)),
        );
        found.find = (predicate) => [...found.values()].find(predicate);
        return found;
      },
    },
    async send(options) {
      if (state.blocked)
        throw Object.assign(new Error("DM blocked"), { code: 50007 });
      assert.ok(options.content.length <= 2000);
      const message = {
        id: String(++nextId),
        author: { id: "bot", bot: true },
        guildId: null,
        createdTimestamp: clock,
        content: options.content,
        attachments: new Map(),
        channelId: "dm",
      };
      state.dms.set(message.id, message);
      if (state.lost) {
        state.lost = false;
        throw new Error("Lost send response");
      }
      return message;
    },
  };
  const client = new EventEmitter();
  client.user = { id: "bot" };
  client.isReady = () => true;
  client.users = { fetch: async () => ({ createDM: async () => channel }) };
  const mail = {
    identities: config.mail.identities,
    async send(_user, draft, _access, options) {
      state.emails.push({ ...draft, messageId: options.messageId });
      if (state.uncertain)
        throw Object.assign(new Error("Lost SMTP response"), {
          code: "mail_send_uncertain",
        });
      return { messageId: options.messageId, accepted: [draft.to] };
    },
  };
  const contact = partnershipContact(tickets, mail, client, {
    now: () => clock,
  });
  t.after(async () => {
    await contact.close();
    await tickets.stop();
    store.close();
    assert.equal(client.listenerCount("messageCreate"), 0);
  });
  return {
    config,
    policy,
    tickets,
    contact,
    store,
    state,
    clockAdvance: () => {
      clock += 300000;
    },
    channel,
  };
}

test("partnership intake rejects non-team members and unverified DMs and stays staff-only", (t) => {
  const { tickets, store } = harness(t);
  assert.throws(
    () =>
      tickets.createPartnership(
        guest,
        input({ relationship: "neither" }),
        network,
      ),
    { code: "partnership_owner_required" },
  );
  assert.throws(
    () =>
      tickets.createPartnership(
        guest,
        input({ preference: "discord", allowDm: true }),
        network,
      ),
    { code: "partnership_discord_required" },
  );
  assert.throws(
    () =>
      tickets.createPartnership(
        guest,
        input({ packUrl: "http://example.invalid/pack" }),
        network,
      ),
    { code: "invalid_pack_link" },
  );
  assert.throws(
    () => tickets.createPartnership(guest, input({ email: "bad" }), network),
    { code: "invalid_ticket_email" },
  );
  const data = input();
  const ticket = tickets.createPartnership(guest, data, network);
  assert.equal(tickets.createPartnership(guest, data, network).id, ticket.id);
  assert.throws(() => tickets.createPartnership(guest, input(), network), {
    code: "partnership_limit",
  });
  assert.equal(store.entries("ticket-outbox").length, 0);
  assert.equal(store.entries("ticket-email-outbox").length, 0);
  assert.equal(
    tickets.list(manager, { category: "partnership" }).items.length,
    1,
  );
  assert.equal(tickets.list(helper).items.length, 0);
  assert.throws(() => tickets.view(guest, ticket.id), {
    code: "ticket_not_found",
  });
  assert.throws(() => tickets.view(helper, ticket.id, true), {
    code: "ticket_access_denied",
  });
  assert.equal(tickets.view(founder, ticket.id, true).path, null);
});

const decision = (tickets, id, outcome = "accepted", reason = "") => ({
  requestId: randomUUID(),
  revision: tickets.get(id).revision,
  outcome,
  reason,
});

test("partnership acceptance is final, permission controlled and delivered once by email", async (t) => {
  const { tickets, contact, state, policy, store } = harness(t);
  const ticket = tickets.createPartnership(guest, input(), network);
  await contact.pump();
  assert.equal(state.emails.length, 1);
  const data = decision(
    tickets,
    ticket.id,
    "accepted",
    "We will discuss hosting requirements.",
  );
  assert.throws(() => tickets.decidePartnership(helper, ticket.id, data), {
    code: "ticket_access_denied",
  });
  assert.throws(
    () =>
      tickets.decidePartnership(manager, ticket.id, { ...data, revision: 0 }),
    { code: "partnership_changed" },
  );
  assert.throws(
    () =>
      tickets.decidePartnership(manager, ticket.id, {
        ...data,
        outcome: "closed",
      }),
    { code: "invalid_partnership_decision" },
  );
  for (const action of ["reply", "claim", "closeTicket"])
    assert.throws(
      () =>
        tickets[action](
          manager,
          ticket.id,
          { requestId: randomUUID(), content: "Old chat reply" },
          true,
        ),
      { code: "ticket_access_denied" },
    );
  assert.throws(
    () =>
      tickets.addNote(manager, ticket.id, {
        requestId: randomUUID(),
        content: "Internal note",
      }),
    { code: "ticket_access_denied" },
  );
  assert.throws(() => tickets.notes(manager, ticket.id), {
    code: "partnership_application_only",
  });
  const lastActiveAt = tickets.get(ticket.id).lastActiveAt;
  tickets.decidePartnership(manager, ticket.id, data);
  tickets.decidePartnership(manager, ticket.id, data);
  assert.equal(tickets.get(ticket.id).lastActiveAt, lastActiveAt);
  assert.throws(
    () =>
      tickets.decidePartnership(
        founder,
        ticket.id,
        decision(tickets, ticket.id, "denied"),
      ),
    { code: "partnership_already_decided" },
  );
  assert.equal(
    tickets.view(manager, ticket.id, true).partnership.notification.status,
    "pending",
  );
  assert.equal(store.entries("partnership-outbox").length, 1);
  assert.equal(
    tickets.get(ticket.id).partnership.decision.actor.id,
    manager.id,
  );
  assert.equal(tickets.list(manager, { category: "partnership" }).total, 0);
  assert.equal(
    tickets.list(founder, { closed: true, staff: "Manager" }).total,
    1,
  );
  await contact.pump();
  await contact.pump();
  assert.equal(state.emails.length, 2);
  assert.match(state.emails[1].text, /accepted.*partnership/s);
  assert.match(state.emails[1].text, /in touch with more information/);
  assert.match(state.emails[1].text, /hosting requirements/);
  assert.equal(state.emails[1].from, "partners@drakora.org");
  assert.equal(
    tickets.view(manager, ticket.id, true).partnership.notification.status,
    "sent",
  );
  assert.equal(
    tickets.view(manager, ticket.id, true).partnership.notification.via,
    "email",
  );
  assert.equal(tickets.messages(ticket.id).length, 0);
  const roles = policy.read(founder);
  roles.roles.find((role) => role.name === "Manager").permissions[
    "tickets.category.partnership.decide"
  ] = false;
  policy.save(founder, {
    revision: roles.revision,
    roles: roles.roles.filter((role) => role.id),
  });
  assert.equal(tickets.view(manager, ticket.id, true).actions.decide, false);
  assert.throws(() => tickets.decidePartnership(manager, ticket.id, data), {
    code: "ticket_access_denied",
  });
});

test("denial uses Discord DM with acknowledgement recovery and email fallback", async (t) => {
  const { tickets, contact, state, clockAdvance } = harness(t);
  const ticket = tickets.createPartnership(
    discordOwner,
    input({ preference: "discord", allowDm: true }),
    network,
  );
  state.lost = true;
  await contact.pump();
  clockAdvance();
  await contact.pump();
  assert.equal(state.dms.size, 1);
  assert.equal(state.emails.length, 0);
  tickets.decidePartnership(
    manager,
    ticket.id,
    decision(tickets, ticket.id, "denied", "The pack is not a fit right now."),
  );
  state.blocked = true;
  await contact.pump();
  await contact.pump();
  assert.equal(state.emails.length, 1);
  assert.match(state.emails[0].text, /unable to accept/);
  assert.match(state.emails[0].text, /not a fit/);
  assert.equal(tickets.get(ticket.id).partnership.emailFallback, true);
  assert.equal(
    tickets.view(manager, ticket.id, true).partnership.notification.via,
    "email",
  );
  assert.equal(tickets.messages(ticket.id).length, 0);
});

test("decision DM delivery succeeds without copying incoming conversations or sending legacy jobs", async (t) => {
  const { tickets, contact, state, store } = harness(t);
  const ticket = tickets.createPartnership(
    discordOwner,
    input({ preference: "discord", allowDm: true }),
    network,
  );
  await contact.pump();
  const message = {
    id: randomUUID(),
    content: "Previously queued reply",
    actor: manager,
    attachments: [],
    delivery: "pending",
  };
  store.set(
    `ticket-messages:${ticket.id}`,
    "000000000001",
    message,
    Number.MAX_SAFE_INTEGER,
  );
  store.set(
    "partnership-outbox",
    `${ticket.id}:message:old`,
    {
      ticketId: ticket.id,
      kind: "message",
      ref: "000000000001",
      failed: true,
      after: Number.MAX_SAFE_INTEGER,
    },
    Number.MAX_SAFE_INTEGER,
  );
  tickets.decidePartnership(founder, ticket.id, decision(tickets, ticket.id));
  await contact.pump();
  assert.equal(state.dms.size, 2);
  assert.match(
    [...state.dms.values()].at(-1).content,
    /accepted.*partnership/s,
  );
  assert.equal(
    tickets.view(manager, ticket.id, true).partnership.notification.via,
    "discord",
  );
  assert.equal(tickets.messages(ticket.id)[0].delivery, "cancelled");
  const denied = tickets.createPartnership(
    discordOwner,
    input({ preference: "discord", allowDm: true }),
    network,
  );
  await contact.pump();
  tickets.decidePartnership(
    founder,
    denied.id,
    decision(tickets, denied.id, "denied"),
  );
  await contact.pump();
  assert.equal(state.dms.size, 4);
  assert.match([...state.dms.values()].at(-1).content, /unable to accept/);
  assert.throws(
    () =>
      tickets.ingest(ticket.id, {
        id: "incoming",
        actor: discordOwner,
        content: "Hello",
      }),
    { code: "partnership_application_only" },
  );
});
test("uncertain email delivery stays visible and does not automatically duplicate a send", async (t) => {
  const { tickets, contact, state, clockAdvance } = harness(t);
  const ticket = tickets.createPartnership(guest, input(), network);
  state.uncertain = true;
  await contact.pump();
  clockAdvance();
  await contact.pump();
  assert.equal(state.emails.length, 1);
  assert.equal(
    tickets.view(manager, ticket.id, true).deliveryIssues[0].failure,
    "mail_send_uncertain",
  );
  tickets.decidePartnership(manager, ticket.id, decision(tickets, ticket.id));
  const revisions = [];
  const unwatch = tickets.watch(ticket.id, manager, true, (event) => {
    if (event.revision) revisions.push(event.revision);
  });
  t.after(unwatch);
  const beforeFailure = tickets.get(ticket.id).revision;
  await contact.pump();
  assert.ok(revisions.some((revision) => revision > beforeFailure));
  clockAdvance();
  await contact.pump();
  assert.equal(state.emails.length, 2);
  assert.equal(
    tickets.view(manager, ticket.id, true).partnership.notification.status,
    "failed",
  );
});

test("staff partnership decision HTTP protects current role, origin and CSRF", async (t) => {
  const { config, tickets, store } = harness(t);
  let identity = manager;
  const app = express();
  app.use(
    ticketRouter(
      config,
      tickets,
      {},
      {
        staffView: true,
        database: store,
        dist: "/does-not-exist",
        authorize: async () => identity,
        mutation: (req) => {
          if (
            req.headers.origin !== config.staffOrigin ||
            req.headers["x-csrf-token"] !== "fixture"
          )
            throw new AuthError("invalid_request");
        },
      },
    ),
  );
  app.use((error, _req, res, _next) =>
    res
      .status(error.status || 503)
      .json({ error: error.code || "unavailable" }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const ticket = tickets.createPartnership(guest, input(), network);
  const url = `http://127.0.0.1:${server.address().port}/api/tickets/${ticket.id}`;
  const data = decision(tickets, ticket.id, "denied");
  const send = (extra = {}) =>
    fetch(`${url}/decision`, {
      method: "POST",
      headers: {
        Origin: config.staffOrigin,
        "X-CSRF-Token": "fixture",
        "Content-Type": "application/json",
        ...extra,
      },
      body: JSON.stringify(data),
    });
  assert.equal((await send({ "X-CSRF-Token": "wrong" })).status, 403);
  assert.equal((await send({ Origin: "https://other.invalid" })).status, 403);
  identity = helper;
  assert.equal((await send()).status, 403);
  identity = manager;
  assert.equal((await fetch(`${url}/notes`)).status, 409);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  const view = await (await fetch(url)).json();
  assert.equal(view.partnership.decision.outcome, "denied");
  assert.equal(view.partnership.decision.actor.id, manager.id);
  assert.equal(view.actions.reply, undefined);
});

test("public partnership HTTP intake enforces eligibility and CSRF and returns no live ticket URL", async (t) => {
  const { config, tickets, store } = harness(t);
  const app = express();
  app.use(
    session({
      secret: randomBytes(32).toString("hex"),
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.use(
    ticketRouter(
      config,
      tickets,
      { assertMember: async () => {} },
      { dist: process.cwd(), database: store },
    ),
  );
  app.use((error, _req, res, _next) =>
    res
      .status(error.status || 503)
      .json({ error: error.code || "unavailable" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/help/api/session`);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const sessionData = await response.json();
  assert.equal(
    sessionData.types.some((type) => type.id === "partnership"),
    false,
  );
  const submit = (data, csrf = sessionData.csrf) =>
    fetch(`${base}/partners/api/requests`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: config.applications.publicOrigin,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  assert.equal((await submit(input(), "wrong")).status, 403);
  assert.equal((await submit(input({ relationship: "neither" }))).status, 400);
  const created = await submit(input());
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.ok(result.reference);
  assert.equal(result.path, undefined);
  const ticket = tickets.get(result.reference);
  assert.equal(ticket.channelId, null);
  assert.equal(
    (
      await fetch(`${base}/help/api/tickets/${ticket.id}`, {
        headers: { Cookie: cookie },
      })
    ).status,
    401,
  );
});
