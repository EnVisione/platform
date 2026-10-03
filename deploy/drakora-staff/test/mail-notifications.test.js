import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { openStore } from "../server/store.js";
import { rolePermissions } from "../server/role-permissions.js";
import {
  discordMailTransport,
  mailAlertMessage,
  mailNotifications,
} from "../server/mail-notifications.js";
import { config as fixture } from "./fixture.js";

const config = {
  ...fixture,
  staffOrigin: "https://staff.example.invalid",
  mail: {
    imapSocketPath: "/private/imap.sock",
    identities: [{ address: "support@drakora.org" }],
    notifications: { categoryId: "8" },
  },
};
const item = (uid) => ({
  uid,
  subject: "Player support",
  from: [{ name: "Player", address: "player@example.invalid" }],
  to: [{ address: "support@drakora.org" }],
  cc: [],
});
function database(t) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  return store;
}
function worker(t) {
  const store = database(t);
  const state = {
    through: 5,
    validity: "1",
    items: [],
    sends: [],
    errors: [],
    ensures: 0,
  };
  const mail = {
    async incoming(cursor) {
      if (!cursor || cursor.validity !== state.validity)
        return { validity: state.validity, through: state.through, items: [] };
      return {
        validity: state.validity,
        through: state.through,
        items: state.items.filter((entry) => entry.uid > cursor.uid),
      };
    },
  };
  const transport = {
    available: () => true,
    async ensure() {
      state.ensures++;
    },
    async send(entry, nonce, retry) {
      state.sends.push({ uid: entry.uid, nonce, retry });
      if (state.gate) await state.gate;
      if (state.fail === entry.uid) throw new Error("Discord unavailable");
    },
  };
  const create = () =>
    mailNotifications(config, store, mail, transport, (error) =>
      state.errors.push(error),
    );
  const service = create();
  t.after(() => service.close());
  return { state, store, service, create };
}

test("alerts establish a baseline, resume after restart, retry failed sends and retain no email content", async (t) => {
  const { service, state, store, create } = worker(t);
  await service.tick();
  assert.deepEqual(state.sends, []);
  state.items = [item(6), item(7)];
  state.through = 7;
  state.fail = 7;
  await service.tick();
  assert.deepEqual(
    state.sends.map((send) => send.uid),
    [6, 7],
  );
  assert.equal(state.errors.length, 1);
  await service.close();
  const restarted = create();
  t.after(() => restarted.close());
  state.fail = null;
  await restarted.tick();
  assert.deepEqual(
    state.sends.map((send) => send.uid),
    [6, 7, 7],
  );
  assert.equal(state.sends[2].nonce, state.sends[1].nonce);
  assert.equal(state.sends[2].retry, true);
  await restarted.tick();
  assert.equal(state.sends.length, 3);
  const stored = JSON.stringify(store.entries("mail-alert-cursor"));
  assert.equal(stored.includes("Player support"), false);
  assert.equal(stored.includes("player@example.invalid"), false);
  state.validity = "2";
  await restarted.tick();
  assert.equal(state.sends.length, 3);
});

test("overlapping polls coalesce, permission refresh does not send, shutdown awaits the active send", async (t) => {
  const { service, state } = worker(t);
  await service.tick();
  state.items = [item(6), item(7)];
  state.through = 7;
  let release;
  state.gate = new Promise((resolve) => {
    release = resolve;
  });
  const active = service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const overlap = service.tick();
  void service.refreshPermissions();
  const closing = service.close();
  release();
  await Promise.all([active, overlap, closing]);
  assert.deepEqual(
    state.sends.map((send) => send.uid),
    [6],
  );
  await service.tick();
  assert.equal(state.sends.length, 1);
});

test("mail alerts have color and keep private headers, content and mention pings out of Discord", () => {
  const entry = item(6);
  entry.subject = "@everyone **urgent**\r\n";
  entry.from[0].name = "*".repeat(1200);
  entry.text = "Private body";
  const message = mailAlertMessage(config, entry, "abc");
  assert.equal(message.embeds[0].color, 0x5865f2);
  assert.ok(message.embeds[0].fields[0].value.length <= 700);
  assert.equal(message.embeds[0].description.includes("@everyone"), false);
  assert.equal(JSON.stringify(message).includes("Private body"), false);
  assert.equal(
    JSON.stringify(message).includes("player@example.invalid"),
    false,
  );
  assert.equal(JSON.stringify(message).includes("urgent"), false);
  assert.deepEqual(message.allowedMentions, { parse: [] });
  assert.equal(
    message.components[0].components[0].url,
    "https://staff.example.invalid/email",
  );
});

function discordHarness(t, settings = config) {
  const store = database(t);
  const policy = rolePermissions(settings, store);
  const state = { creates: [], permissions: [], sends: [], recent: new Map() };
  const member = (id, roles) => ({
    id,
    user: { bot: false },
    roles: { cache: new Map(roles.map((role) => [role, {}])) },
  });
  const members = new Map([
    ["40", member("40", ["10", "21"])],
    ["41", member("41", ["21"])],
    ["42", member("42", ["10", "29"])],
  ]);
  const channel = {
    id: "9",
    type: ChannelType.GuildText,
    permissionOverwrites: {
      cache: new Map(),
      async set(entries) {
        state.permissions.push(entries);
        this.cache = new Map(
          entries.map((entry) => [
            entry.id,
            {
              ...entry,
              allow: { bitfield: entry.allow ?? 0n },
              deny: { bitfield: entry.deny ?? 0n },
            },
          ]),
        );
      },
    },
    messages: {
      async fetch() {
        return state.recent;
      },
    },
    async send(message) {
      state.sends.push(message);
    },
  };
  const channels = new Map();
  const guild = {
    id: "1",
    members: {
      async fetch() {
        return members;
      },
    },
    channels: {
      async fetch(id) {
        return id ? (channels.get(id) ?? null) : channels;
      },
      async create(options) {
        state.creates.push(options);
        const created = channels.size
          ? {
              ...channel,
              id: String(8 + state.creates.length),
              permissionOverwrites: {
                ...channel.permissionOverwrites,
                cache: new Map(),
              },
            }
          : channel;
        created.topic = options.topic;
        channels.set(created.id, created);
        return created;
      },
    },
  };
  const client = {
    isReady: () => true,
    user: { id: "99" },
    guilds: {
      async fetch() {
        return guild;
      },
    },
  };
  return {
    store,
    policy,
    state,
    members,
    channel,
    channels,
    transport: discordMailTransport(settings, store, policy, client),
  };
}

test("channel is private at creation and effective View email permission controls membership", async (t) => {
  const { transport, state, policy, members, channel } = discordHarness(t);
  await transport.ensure();
  assert.equal(state.creates.length, 1);
  const entries = state.creates[0].permissionOverwrites;
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["1", "99", "40"],
  );
  assert.ok(entries[0].deny & PermissionFlagsBits.ViewChannel);
  assert.equal(entries[2].allow & PermissionFlagsBits.SendMessages, 0n);
  const founder = { id: "50", name: "Founder", roles: ["10", "20"] };
  const model = policy.read(founder);
  const roles = model.roles
    .filter((role) => role.id)
    .map((role) => ({ id: role.id, permissions: { ...role.permissions } }));
  roles.find((role) => role.id === "29").permissions["mail.view"] = true;
  for (const identity of config.mail.identities)
    roles.find((role) => role.id === "29").permissions[
      `mail.inbox.${identity.address}.view`
    ] = true;
  policy.save(founder, { revision: model.revision, roles });
  await transport.ensure();
  assert.ok(channel.permissionOverwrites.cache.has("42"));
  members.delete("40");
  await transport.ensure();
  assert.equal(channel.permissionOverwrites.cache.has("40"), false);
  assert.equal(channel.permissionOverwrites.cache.has("41"), false);
  assert.equal(state.creates.length, 1);
});

test("inbox alerts isolate partners from support and refresh revoked access", async (t) => {
  const settings = {
    ...config,
    mail: {
      ...config.mail,
      identities: [
        ...config.mail.identities,
        { address: "partners@drakora.org" },
      ],
    },
  };
  const { transport, channels, members, policy } = discordHarness(t, settings);
  members.set("43", {
    id: "43",
    user: { bot: false },
    roles: {
      cache: new Map([
        ["10", {}],
        ["28", {}],
      ]),
    },
  });
  members.set("50", {
    id: "50",
    user: { bot: false },
    roles: {
      cache: new Map([
        ["10", {}],
        ["20", {}],
      ]),
    },
  });
  await transport.ensure();
  await transport.send(item(6), "support", false);
  await transport.send(
    { ...item(7), to: [{ address: "partners@drakora.org" }] },
    "partners",
    false,
  );
  const support = [...channels.values()].find((entry) =>
    entry.topic.includes("Mailboxes: support@drakora.org."),
  );
  const partners = [...channels.values()].find((entry) =>
    entry.topic.includes("Mailboxes: partners@drakora.org."),
  );
  assert.ok(support.permissionOverwrites.cache.has("40"));
  assert.equal(partners.permissionOverwrites.cache.has("40"), false);
  assert.ok(partners.permissionOverwrites.cache.has("43"));
  assert.ok(partners.permissionOverwrites.cache.has("50"));
  const founder = { id: "50", name: "Founder", roles: ["10", "20"] };
  const model = policy.read(founder);
  const roles = model.roles
    .filter((entry) => entry.id)
    .map((entry) => ({
      id: entry.id,
      permissions: { ...entry.permissions },
    }));
  for (const action of ["view", "send", "reply"])
    roles.find((entry) => entry.id === "28").permissions[
      `mail.inbox.partners@drakora.org.${action}`
    ] = false;
  policy.save(founder, { revision: model.revision, roles });
  await transport.ensure();
  assert.equal(partners.permissionOverwrites.cache.has("43"), false);
  assert.ok(partners.permissionOverwrites.cache.has("50"));
  assert.ok(support.permissionOverwrites.cache.has("43"));
});

test("uncertain deliveries recover from recent bot alerts, and manual messages cannot impersonate them", async (t) => {
  const { transport, state } = discordHarness(t);
  await transport.ensure();
  state.recent.set("a", {
    author: { id: "40" },
    embeds: [{ footer: { text: "Drakora mail · abc" } }],
  });
  await transport.send(item(6), "abc", true);
  assert.equal(state.sends.length, 1);
  state.recent.set("b", {
    author: { id: "99" },
    embeds: [{ footer: { text: "Drakora mail · abc" } }],
  });
  await transport.send(item(6), "abc", true);
  assert.equal(state.sends.length, 1);
});

test("lost channels recreate privately, edited channel ownership stops sends and capacity fails closed", async (t) => {
  const { transport, state, members, channel, channels } = discordHarness(t);
  await transport.ensure();
  channels.delete(channel.id);
  await transport.ensure();
  assert.equal(state.creates.length, 2);
  channel.topic = "User-managed channel";
  await assert.rejects(transport.ensure(), /ownership/);
  channel.topic = state.creates[0].topic;
  for (let id = 100; id < 199; id++)
    members.set(String(id), {
      id: String(id),
      user: { bot: false },
      roles: {
        cache: new Map([
          ["10", {}],
          ["21", {}],
        ]),
      },
    });
  await assert.rejects(transport.ensure(), /capacity/);
  assert.deepEqual([...channel.permissionOverwrites.cache.keys()], ["1", "99"]);
});
