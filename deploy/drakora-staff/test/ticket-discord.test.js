import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { Collection, ChannelType, PermissionFlagsBits as P } from "discord.js";
import { openStore } from "../server/store.js";
import { ticketService } from "../server/tickets.js";
import { ticketDiscord } from "../server/ticket-discord.js";
import { rolePermissions } from "../server/role-permissions.js";
import { config as fixture } from "./fixture.js";

function setupDiscord(t) {
  const config = {
    ...fixture,
    applications: { publicOrigin: "https://example.invalid" },
    tickets: { guildId: "2", archiveCategoryId: "archive" },
    roleSync: {
      roles: fixture.ranks
        .filter((role) => role.dashboard)
        .map((role) => ({ staffId: role.id, mainId: `main-${role.id}` })),
    },
  };
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const policy = rolePermissions(config, store),
    service = ticketService(config, store, policy);
  const client = new EventEmitter();
  client.user = { id: "bot" };
  client.isReady = () => true;
  const channels = new Collection([
    ["archive", { id: "archive", type: ChannelType.GuildCategory }],
  ]);
  let nextId = 1000,
    sends = 0;
  const user = {
    id: "100",
    username: "Player",
    globalName: "Player",
    displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
  };
  function createChannel(data) {
    const id = String(++nextId),
      messages = new Collection(),
      hooks = new Collection();
    const target = {
      id,
      ...data,
      guildId: "2",
      parentId: data.parent,
      isTextBased: () => true,
      readable: true,
      permissionsFor: () => ({ has: () => target.readable }),
      overwrites: data.permissionOverwrites,
      permissionOverwrites: {
        async set(values) {
          target.overwrites = values;
        },
      },
      async setParent(parent) {
        target.parentId = parent;
      },
      async delete() {
        channels.delete(id);
      },
      async fetchWebhooks() {
        return hooks;
      },
      async createWebhook(data) {
        const hook = {
          id: String(++nextId),
          ...data,
          owner: { id: "bot" },
          async send(data) {
            sends++;
            const message = {
              id: String(++nextId),
              createdTimestamp: nextId,
              channelId: id,
              guildId: "2",
              webhookId: hook.id,
              author: { id: "bot", bot: true },
              embeds: data.embeds || [],
              data,
            };
            messages.set(message.id, message);
            return message;
          },
        };
        hooks.set(hook.id, hook);
        return hook;
      },
      async send(data) {
        const message = {
          id: String(++nextId),
          createdTimestamp: nextId,
          channelId: id,
          guildId: "2",
          author: { id: "bot", bot: true },
          embeds: data.embeds || [],
          data,
          attachments: new Collection(),
          async edit(data) {
            message.data = data;
            message.embeds = data.embeds || [];
          },
        };
        messages.set(message.id, message);
        return message;
      },
      messages: {
        async fetch(query) {
          if (typeof query === "string") return messages.get(query);
          const sorted = [...messages.values()].sort(
            (a, b) => Number(a.id) - Number(b.id),
          );
          const found = query.after
            ? sorted
                .filter((message) => BigInt(message.id) > BigInt(query.after))
                .slice(0, query.limit)
                .reverse()
            : sorted
                .filter(
                  (message) =>
                    !query.before || BigInt(message.id) < BigInt(query.before),
                )
                .reverse()
                .slice(0, query.limit);
          return new Collection(found.map((message) => [message.id, message]));
        },
        async delete(id) {
          messages.delete(id);
        },
      },
    };
    target.savedMessages = messages;
    channels.set(id, target);
    return target;
  }
  const main = {
    id: "2",
    channels: {
      async fetch(id) {
        return id ? channels.get(id) : channels;
      },
      async create(data) {
        return createChannel(data);
      },
    },
    members: {
      async fetch() {
        return { user };
      },
    },
    commands: {
      async fetch() {
        return new Collection();
      },
      async create() {},
    },
  };
  const staffGuild = {
    members: {
      async fetch({ user: id }) {
        return {
          user: { ...user, id },
          roles: {
            cache: new Collection([
              ["10", {}],
              ["28", {}],
            ]),
          },
          displayName: "Manager",
        };
      },
    },
  };
  client.guilds = {
    async fetch(id) {
      return id === "2" ? main : staffGuild;
    },
  };
  const transport = ticketDiscord(config, service, client, policy);
  t.after(async () => {
    await transport.close();
    await service.stop();
    store.close();
  });
  return {
    config,
    service,
    transport,
    policy,
    client,
    channels,
    user,
    get sends() {
      return sends;
    },
  };
}

test("Discord transport creates private tickets, preserves webhook identity and recovers ambiguous sends", async (t) => {
  const context = setupDiscord(t);
  const { service, transport, policy, client, channels, user } = context;
  const ticket = service.create(
    { id: user.id, name: "Player", avatar: user.displayAvatarURL() },
    {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description:
        "A detailed issue with enough information for staff to help.",
    },
  );
  await transport.create(ticket);
  await service.pump();
  const linked = service.get(ticket.id),
    target = channels.get(linked.channelId);
  assert.equal(target.topic, `Drakora ticket ${ticket.id}`);
  assert.ok(
    target.overwrites
      .find((value) => value.id === "2")
      .deny.includes(P.ViewChannel),
  );
  assert.ok(
    target.overwrites
      .find((value) => value.id === user.id)
      .allow.includes(P.SendMessages),
  );
  assert.ok(
    target.overwrites
      .find((value) => value.id === "main-23")
      .allow.includes(P.ViewChannel),
  );
  const outgoing = service.reply(
    { id: user.id, name: "Player", avatar: user.displayAvatarURL() },
    ticket.id,
    { requestId: randomUUID(), content: "Hello from the web" },
  );
  await service.pump();
  assert.equal(context.sends, 1);
  const delivered = service.messages(ticket.id)[0];
  const duplicate = await transport.message(linked, outgoing, []);
  assert.equal(duplicate.id, delivered.discordId);
  assert.equal(context.sends, 1);
  const sent = await target.messages.fetch(delivered.discordId);
  assert.equal(sent.data.username, "Player");
  assert.equal(sent.data.avatarURL, user.displayAvatarURL());
  assert.deepEqual(sent.data.allowedMentions, { parse: [] });
  const staff = policy.apply({
    id: "200",
    name: "Manager",
    roles: ["10", "28"],
  });
  service.claim(staff, ticket.id);
  await service.pump();
  service.closeTicket(
    staff,
    ticket.id,
    {
      summary: "Verified and fixed the player's issue in the affected world.",
      commands: "None",
    },
    true,
  );
  await service.pump();
  assert.equal(target.parentId, "archive");
  assert.ok(
    target.overwrites
      .find((value) => value.id === user.id)
      .deny.includes(P.SendMessages),
  );
  const privateTicket = service.create(user, {
    requestId: randomUUID(),
    ign: "Jojo",
    type: "staff",
    location: "Discord",
    description: "A detailed report about a member of the staff team.",
  });
  await service.pump();
  const privateTarget = channels.get(service.get(privateTicket.id).channelId);
  assert.ok(privateTarget.overwrites.some((value) => value.id === "main-28"));
  assert.ok(!privateTarget.overwrites.some((value) => value.id === "main-23"));
  let modal;
  client.emit("interactionCreate", {
    guildId: "2",
    customId: "ticket:type",
    values: ["bug"],
    isChatInputCommand: () => false,
    async showModal(value) {
      modal = value.toJSON();
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(modal.custom_id, "ticket:intake:bug");
  assert.equal(modal.components.length, 3);
});

test("Discord reconnect backfills multiple pages and reconciles edits and deletions without duplicates", async (t) => {
  const { service, transport, client, channels, user } = setupDiscord(t);
  const ticket = service.create(
    { id: user.id, name: "Player" },
    {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description:
        "Reconnect verification with missing messages and changed history.",
    },
  );
  await transport.create(ticket);
  await service.pump();
  const target = channels.get(service.get(ticket.id).channelId);
  await transport.recover();
  service.store.delete("ticket-discord-cursor", ticket.id);
  for (let index = 0; index < 110; index++) {
    const id = String(2000 + index);
    target.savedMessages.set(id, {
      id,
      createdTimestamp: 2000 + index,
      channelId: target.id,
      guildId: "2",
      author: user,
      content: `Offline reply ${index}`,
      attachments: new Collection(),
    });
  }
  client.emit("shardResume");
  await transport.recover();
  assert.equal(service.messages(ticket.id).length, 110);
  assert.equal(service.messages(ticket.id)[0].content, "Offline reply 0");
  target.savedMessages.get("2109").content = "Edited while disconnected";
  target.savedMessages.delete("2108");
  client.emit("shardResume");
  await transport.recover();
  const saved = service.messages(ticket.id);
  assert.equal(saved.length, 110);
  assert.equal(saved.at(-1).content, "Edited while disconnected");
  assert.equal(saved.at(-2).deleted, true);
  client.emit("raw", {
    t: "MESSAGE_DELETE_BULK",
    d: { channel_id: target.id, ids: ["2000", "2001"] },
  });
  assert.ok(
    service
      .messages(ticket.id)
      .slice(0, 2)
      .every((message) => message.deleted),
  );
  target.readable = false;
  target.savedMessages.clear();
  client.emit("shardResume");
  await transport.recover();
  assert.equal(
    service.messages(ticket.id).filter((message) => message.deleted).length,
    3,
  );
  const other = service.create(
    { id: user.id, name: "Player" },
    {
      requestId: randomUUID(),
      ign: "OtherPlayer",
      type: "general",
      location: "Terra",
      description:
        "This ticket must recover while another channel has lost read permissions.",
    },
  );
  await service.pump();
  const otherTarget = channels.get(service.get(other.id).channelId);
  otherTarget.savedMessages.set("3000", {
    id: "3000",
    createdTimestamp: 3000,
    channelId: otherTarget.id,
    guildId: "2",
    author: user,
    content: "Unaffected ticket reply",
    attachments: new Collection(),
  });
  await transport.recover();
  assert.equal(
    service.messages(other.id)[0].content,
    "Unaffected ticket reply",
  );
  service.closeTicket({ id: user.id }, other.id, {});
  otherTarget.savedMessages.get("3000").content =
    "Edited after closure while disconnected";
  await transport.recover();
  assert.equal(
    service.messages(other.id)[0].content,
    "Edited after closure while disconnected",
  );
});
