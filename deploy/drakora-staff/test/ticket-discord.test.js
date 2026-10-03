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

test("Discord transport creates private tickets, preserves webhook identity and recovers ambiguous sends", async (t) => {
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
          return typeof query === "string" ? messages.get(query) : messages;
        },
        async delete(id) {
          messages.delete(id);
        },
      },
    };
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
  assert.equal(sends, 1);
  const delivered = service.messages(ticket.id)[0];
  const duplicate = await transport.message(linked, outgoing, []);
  assert.equal(duplicate.id, delivered.discordId);
  assert.equal(sends, 1);
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
