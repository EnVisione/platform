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
    incoming: [],
    headers: new Map(),
    uploads: [],
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
    async incoming(cursor) {
      return {
        validity: "51",
        through: state.incoming.at(-1)?.uid || 0,
        items: cursor
          ? state.incoming.filter((item) => item.uid > cursor.uid)
          : [],
      };
    },
    async detail({ uid }) {
      return state.headers.get(uid);
    },
    async attachment() {
      return { filename: "proof.txt", content: Buffer.from("proof") };
    },
  };
  const media = {
    async bytes() {
      return Buffer.from("proof");
    },
    async upload(bytes, name, type, ticket) {
      state.uploads.push(ticket.type);
      return {
        channelId: "private-partner-media",
        messageId: randomUUID(),
        attachmentId: randomUUID(),
        name,
        type,
        size: bytes.length,
      };
    },
  };
  const contact = partnershipContact(config, tickets, mail, client, media, {
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

test("staff email replies and verified incoming email stay in one request with deduplication", async (t) => {
  const { tickets, contact, state } = harness(t);
  const ticket = tickets.createPartnership(guest, input(), network);
  await contact.pump();
  assert.equal(state.emails.length, 1);
  tickets.reply(
    manager,
    ticket.id,
    { requestId: randomUUID(), content: "Tell us the expected player count." },
    true,
  );
  await contact.pump();
  assert.equal(state.emails.length, 2);
  assert.equal(tickets.messages(ticket.id)[0].delivery, "delivered");
  const details = {
    messageId: "<reply@example.invalid>",
    inReplyTo: state.emails[1].messageId,
    references: [],
    from: [{ address: "author@example.invalid" }],
    to: [{ address: "partners@drakora.org" }],
    cc: [],
    mailboxes: ["partners@drakora.org"],
    replyText: "We expect twenty players.",
    attachments: [],
  };
  state.incoming = [{ uid: 1, to: details.to, cc: [] }];
  state.headers.set(1, details);
  await contact.poll();
  await contact.poll();
  assert.equal(tickets.messages(ticket.id).length, 2);
  assert.equal(tickets.messages(ticket.id)[1].origin, "email");
  assert.equal(
    tickets.messages(ticket.id)[1].content,
    "We expect twenty players.",
  );
  state.incoming.push({ uid: 2, to: details.to, cc: [] });
  state.headers.set(2, {
    ...details,
    messageId: "<forged@example.invalid>",
    from: [{ address: "intruder@example.invalid" }],
  });
  await contact.poll();
  assert.equal(tickets.messages(ticket.id).length, 2);
  tickets.closeTicket(
    manager,
    ticket.id,
    {
      summary: "We agreed on the server requirements and sent the next steps.",
      commands: "No server commands were needed.",
    },
    true,
  );
  await contact.pump();
  assert.match(state.emails.at(-1).text, /closed/);
  assert.equal(state.emails.at(-1).reply.uid, 1);
  const resolution = tickets.get(ticket.id).resolution;
  assert.equal(state.emails.at(-1).text.includes(resolution.summary), false);
  assert.equal(state.emails.at(-1).text.includes(resolution.commands), false);
});

test("DM sends recover lost acknowledgements, split long replies, ingest owner DMs and fall back when blocked", async (t) => {
  const { tickets, contact, state, clockAdvance, channel } = harness(t);
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
  assert.equal(tickets.view(manager, ticket.id, true).deliveryPending, 0);
  tickets.reply(
    manager,
    ticket.id,
    { requestId: randomUUID(), content: "a".repeat(2000) },
    true,
  );
  await contact.pump();
  assert.equal(state.dms.size, 3);
  assert.equal(tickets.messages(ticket.id)[0].delivery, "delivered");
  const incoming = {
    id: String(BigInt([...state.dms.keys()].at(-1)) + 1n),
    guildId: null,
    author: { id: discordOwner.id, bot: false },
    channelId: channel.id,
    createdTimestamp: Date.now(),
    content: "Here is our answer.",
    attachments: new Map(),
  };
  await Promise.all([contact.receiveDm(incoming), contact.receiveDm(incoming)]);
  assert.equal(tickets.messages(ticket.id).length, 2);
  state.blocked = true;
  tickets.reply(
    manager,
    ticket.id,
    { requestId: randomUUID(), content: "We can continue by email." },
    true,
  );
  await contact.pump();
  assert.equal(state.emails.length, 1);
  assert.equal(tickets.get(ticket.id).partnership.emailFallback, true);
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
