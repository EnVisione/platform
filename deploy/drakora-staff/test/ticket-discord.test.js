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

function setupDiscord(t, notices = false) {
  const config = {
    ...fixture,
    staffOrigin: "https://staff.example.invalid",
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
  const dms = [];
  client.users = {
    async fetch() {
      return {
        async send(data) {
          dms.push(data);
        },
      };
    },
  };
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
        target.webhookReads = (target.webhookReads || 0) + 1;
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
              author: { id: "bot", bot: true, username: data.username },
              content: data.content || "",
              attachments: new Collection(),
              embeds: data.embeds || [],
              data,
            };
            messages.set(message.id, message);
            if (target.failAfterSend) {
              target.failAfterSend = false;
              throw new Error("Response lost after Discord accepted the send");
            }
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
        for (const file of data.files || []) {
          const attachment = {
            id: String(++nextId),
            name: file.name,
            size: file.attachment.length,
            contentType: "image/png",
            url: `https://cdn.discordapp.com/attachments/${id}/${nextId}/${file.name}`,
          };
          message.attachments.set(attachment.id, attachment);
        }
        if (target.failAfterBotSend) {
          target.failAfterBotSend = false;
          throw new Error("Response lost after bot send");
        }
        return message;
      },
      messages: {
        async fetch(query) {
          target.historyReads = (target.historyReads || 0) + 1;
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
  const staffMembers = new Collection(
    [
      ["200", "Manager", ["10", "28"]],
      ["201", "Helper", ["10", "23"]],
    ].map(([id, name, roles]) => [
      id,
      {
        id,
        user: { ...user, id },
        displayName: name,
        roles: { cache: new Collection(roles.map((role) => [role, {}])) },
      },
    ]),
  );
  const staffGuild = {
    channels: {
      async fetch(id) {
        return id === staffChannel?.id ? staffChannel : undefined;
      },
    },
    members: {
      async fetchMe() {
        return { id: client.user.id };
      },
      async fetch(query) {
        if (!query) return staffMembers;
        const member = staffMembers.get(query.user);
        if (!member)
          throw Object.assign(new Error("Unknown member"), { code: 10007 });
        return member;
      },
    },
  };
  const staffChannel = notices
    ? createChannel({ name: "staff-tickets", type: ChannelType.GuildText })
    : undefined;
  if (staffChannel) {
    channels.delete(staffChannel.id);
    staffChannel.guildId = config.guildId;
    config.tickets.staffChannelId = staffChannel.id;
  }
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
    staffMembers,
    staffChannel,
    user,
    dms,
    get sends() {
      return sends;
    },
  };
}

test("staff notices link both interfaces and recover an uncertain send across restart", async (t) => {
  const app = setupDiscord(t, true);
  const ticket = app.service.create(
    { id: app.user.id, name: "Player" },
    {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description:
        "PRIVATE detailed issue with enough information for staff to help.",
    },
  );
  await app.transport.create(ticket);
  await app.service.pump();
  const current = app.service.get(ticket.id);
  const job = { event: "opened", channelId: app.staffChannel.id };
  const key = `${ticket.id}:opened`;
  app.staffChannel.failAfterBotSend = true;
  await assert.rejects(
    app.transport.notice(current, job, key),
    /Response lost/,
  );
  const notice = app.staffChannel.savedMessages.first();
  assert.match(notice.data.embeds[0].description, /Jojo/);
  assert.equal(JSON.stringify(notice.data).includes("PRIVATE"), false);
  assert.equal(
    notice.data.components[0].components[0].url,
    `https://discord.com/channels/2/${current.channelId}`,
  );
  assert.equal(
    notice.data.components[0].components[1].url,
    `https://staff.example.invalid/tickets/${ticket.id}`,
  );
  assert.deepEqual(notice.data.allowedMentions, { parse: [] });
  assert.equal(notice.data.enforceNonce, true);
  assert.equal(notice.data.nonce.length, 25);
  for (let i = 0; i < 620; i++)
    await app.staffChannel.send({ content: "Other staff chat" });
  await app.transport.close();
  const restarted = ticketDiscord(
    app.config,
    app.service,
    app.client,
    app.policy,
  );
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.notice(current, job, key), {
    pending: true,
  });
  assert.equal((await restarted.notice(current, job, key)).id, notice.id);
  assert.equal((await restarted.notice(current, job, key)).id, notice.id);
  assert.equal(app.staffChannel.savedMessages.size, 621);
  app.staffChannel.readable = false;
  await assert.rejects(restarted.notice(current, job, key), /permissions/);
  app.staffChannel.readable = true;
  app.staffChannel.guildId = "2";
  await assert.rejects(restarted.notice(current, job, key), /unavailable/);
});

test("restricted notices stay generic and a claim during delivery cancels the reminder", async (t) => {
  const app = setupDiscord(t, true);
  const ticket = app.service.create(
    { id: app.user.id, name: "PrivatePlayer" },
    {
      requestId: randomUUID(),
      ign: "SecretIgn",
      type: "staff",
      location: "PrivateLocation",
      description:
        "PRIVATE detailed issue with enough information for staff to help.",
    },
  );
  await app.transport.create(ticket);
  await app.service.pump();
  const current = app.service.get(ticket.id);
  await app.transport.notice(
    current,
    { event: "opened", channelId: app.staffChannel.id },
    `${ticket.id}:opened`,
  );
  const data = JSON.stringify(app.staffChannel.savedMessages.first().data);
  for (const text of [
    "SecretIgn",
    "PrivatePlayer",
    "PrivateLocation",
    "PRIVATE",
  ])
    assert.equal(data.includes(text), false);
  const fetch = app.staffChannel.messages.fetch;
  app.staffChannel.messages.fetch = async (options) => {
    app.service.claim(
      { id: "200", name: "Manager", roles: ["10", "28"] },
      ticket.id,
    );
    return fetch(options);
  };
  assert.deepEqual(
    await app.transport.notice(
      current,
      { event: "unclaimed", channelId: app.staffChannel.id },
      `${ticket.id}:unclaimed`,
    ),
    { cancelled: true },
  );
  assert.equal(app.staffChannel.savedMessages.size, 1);
});

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
      .find((value) => value.id === "201" && value.type === 1)
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
  assert.equal(channels.has(target.id), false);
  assert.equal(service.get(ticket.id).channelId, null);
  assert.equal(service.view(user, ticket.id).sync, "saved");
  assert.equal(context.dms.length, 1);
  assert.equal(service.messages(ticket.id)[0].content, "Hello from the web");
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
  assert.ok(privateTarget.overwrites.some((value) => value.id === "200"));
  assert.ok(!privateTarget.overwrites.some((value) => value.id === "201"));
  assert.ok(!target.overwrites.some((value) => value.id.startsWith("main-")));
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

test("web replies send without embeds or history reads and recover lost responses without collapsing identical replies", async (t) => {
  const context = setupDiscord(t);
  const { service, transport, channels } = context;
  const owner = { id: "guest:test", name: "Jojo", guest: true };
  const ticket = service.create(
    owner,
    {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description: "Guest support without Discord account or guild membership.",
      email: "jojo@example.invalid",
    },
    "web",
    "a".repeat(64),
  );
  await transport.create(ticket);
  await service.pump();
  await transport.recover();
  const target = channels.get(service.get(ticket.id).channelId);
  assert.ok(!target.overwrites.some((entry) => entry.id === owner.id));
  assert.ok(!target.savedMessages.first().data.content.includes("<@guest:"));
  const histories = target.historyReads,
    hooks = target.webhookReads;
  const first = service.reply(owner, ticket.id, {
    requestId: randomUUID(),
    content: "Hello",
  });
  await service.pump();
  assert.equal(target.historyReads, histories);
  assert.equal(target.webhookReads, hooks);
  const delivered = service.messages(ticket.id)[0];
  assert.deepEqual(target.savedMessages.get(delivered.discordId).embeds, []);
  assert.equal(service.store.get("ticket-send", first.id), undefined);
  target.failAfterSend = true;
  service.reply(owner, ticket.id, {
    requestId: randomUUID(),
    content: "Hello",
  });
  await service.pump();
  assert.equal(context.sends, 2);
  for (const [key, job] of service.store.entries("ticket-outbox")) {
    job.after = 0;
    service.store.set("ticket-outbox", key, job, Number.MAX_SAFE_INTEGER);
  }
  await service.pump();
  assert.equal(context.sends, 2);
  assert.equal(service.store.entries("ticket-outbox").length, 0);
  assert.equal(service.messages(ticket.id).length, 2);
  assert.ok(
    service
      .messages(ticket.id)
      .every((message) => message.delivery === "delivered"),
  );
  assert.notEqual(
    service.messages(ticket.id)[0].discordId,
    service.messages(ticket.id)[1].discordId,
  );
});

test("ticket visibility follows screened staff membership and Dashboard access instead of main-server ranks", async (t) => {
  const { service, transport, client, channels, user, staffMembers, config } =
    setupDiscord(t);
  const ticket = service.create(user, {
    requestId: randomUUID(),
    ign: "Jojo",
    type: "general",
    location: "Void",
    description:
      "Verify that staff access is removed from existing Discord tickets.",
  });
  await transport.create(ticket);
  await service.pump();
  await transport.recover();
  const target = channels.get(service.get(ticket.id).channelId);
  const category = [...channels.values()].find(
    (value) => value.name === "Drakora Support",
  );
  assert.equal(await transport.staffUser("300"), null);
  assert.ok(!target.overwrites.some((value) => value.id === "300"));
  assert.ok(target.overwrites.some((value) => value.id === "201"));
  const helper = staffMembers.get("201");
  helper.roles.cache.delete(config.accessRoles.dashboard);
  client.emit("raw", {
    t: "GUILD_MEMBER_UPDATE",
    d: { guild_id: config.guildId, user: { id: "201" }, roles: ["23"] },
  });
  await transport.recover();
  assert.equal((await transport.staffUser("201")).permissions.dashboard, false);
  for (const channel of [target, category]) {
    assert.ok(!channel.overwrites.some((value) => value.id === "201"));
    assert.ok(
      !channel.overwrites.some((value) => value.id.startsWith("main-")),
    );
  }
  assert.ok(target.overwrites.some((value) => value.id === user.id));
  const updateCategory = category.permissionOverwrites.set;
  category.permissionOverwrites.set = async () => {
    throw new Error("Missing permission");
  };
  staffMembers.delete("200");
  await assert.rejects(transport.refreshPermissions(), /refresh is incomplete/);
  assert.ok(!target.overwrites.some((value) => value.id === "200"));
  assert.ok(service.store.get("ticket-discord", "permissions-pending"));
  category.permissionOverwrites.set = updateCategory;
  await transport.recover();
  assert.equal(
    service.store.get("ticket-discord", "permissions-pending"),
    undefined,
  );
  helper.roles.cache.set(config.accessRoles.dashboard, {});
  helper.pending = true;
  await transport.refreshPermissions();
  assert.equal(await transport.staffUser("201"), null);
  assert.ok(!target.overwrites.some((value) => value.id === "201"));
  helper.pending = false;
  await transport.refreshPermissions();
  assert.ok(target.overwrites.some((value) => value.id === "201"));
  staffMembers.delete("201");
  client.emit("raw", {
    t: "GUILD_MEMBER_REMOVE",
    d: { guild_id: config.guildId, user: { id: "201" } },
  });
  await transport.recover();
  assert.ok(!target.overwrites.some((value) => value.id === "201"));
});

test("closure saves paginated missed history and preserves Discord files before channel deletion", async (t) => {
  const { service, transport, channels, user, dms } = setupDiscord(t);
  const ticket = service.create(
    { id: user.id, name: "Player" },
    {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description: "A detailed ticket with history and a screenshot to retain.",
    },
  );
  await transport.create(ticket);
  await service.pump();
  const target = channels.get(service.get(ticket.id).channelId);
  for (let index = 0; index < 600; index++) {
    const id = String(2000 + index);
    target.savedMessages.set(id, {
      id,
      channelId: target.id,
      guildId: "2",
      author: user,
      content: `Saved Discord reply ${index}`,
      createdTimestamp: Date.now() - 10000,
      attachments: new Collection(
        index === 599
          ? [
              [
                "20000",
                {
                  id: "20000",
                  name: "proof.png",
                  contentType: "image/png",
                  size: 7,
                  url: `https://cdn.discordapp.com/attachments/${target.id}/20000/proof.png`,
                },
              ],
            ]
          : [],
      ),
    });
  }
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(Buffer.from("picture")),
  );
  service.closeTicket({ id: user.id, name: "Player" }, ticket.id, {});
  await service.pump();
  assert.equal(channels.has(target.id), true);
  assert.equal(
    service.store.get("ticket-discord-close", ticket.id).historySaved,
    false,
  );
  await service.pump();
  assert.equal(channels.has(target.id), false);
  assert.equal(service.messages(ticket.id).length, 600);
  const [, file] = service.store.entries("ticket-media")[0];
  assert.notEqual(file.channelId, target.id);
  assert.equal(channels.get(file.channelId).name, "ticket-attachments");
  assert.equal(file.expiresAt - file.createdAt, 30 * 86400000);
  assert.equal((await transport.bytes(file)).toString(), "picture");
  assert.equal(
    dms[0].components[0].components[0].custom_id,
    `ticket:rate:${ticket.id}`,
  );
  service.rate({ id: user.id, name: "Player" }, ticket.id, 4);
  assert.equal(service.get(ticket.id).rating, 4);
});

test("closure leaves the channel intact if history permissions or ownership are unavailable", async (t) => {
  const { service, transport, channels, user } = setupDiscord(t);
  const ticket = service.create(
    { id: user.id, name: "Player" },
    {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description:
        "A detailed ticket that cannot be deleted without its history.",
    },
  );
  await transport.create(ticket);
  await service.pump();
  const target = channels.get(service.get(ticket.id).channelId);
  target.readable = false;
  service.closeTicket({ id: user.id, name: "Player" }, ticket.id, {});
  await service.pump();
  assert.equal(channels.has(target.id), true);
  assert.equal(service.store.get("ticket-discord-close", ticket.id), undefined);
  target.readable = true;
  target.topic = "Another channel";
  await assert.rejects(transport.status(service.get(ticket.id)), /ownership/);
  assert.equal(channels.has(target.id), true);
  assert.ok(service.store.entries("ticket-outbox").length);
});

test("a lost channel deletion response resumes from the saved transcript checkpoint", async (t) => {
  const { service, transport, channels, user, dms } = setupDiscord(t);
  const ticket = service.create(
    { id: user.id, name: "Player" },
    {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description:
        "A detailed ticket for retrying an uncertain channel deletion.",
    },
  );
  await transport.create(ticket);
  await service.pump();
  const target = channels.get(service.get(ticket.id).channelId);
  target.delete = async () => {
    channels.delete(target.id);
    throw new Error("Deletion response lost");
  };
  service.closeTicket({ id: user.id, name: "Player" }, ticket.id, {});
  await service.pump();
  assert.equal(
    service.store.get("ticket-discord-close", ticket.id).ready,
    true,
  );
  assert.equal(service.get(ticket.id).channelId, target.id);
  for (const [key, job] of service.store.entries("ticket-outbox"))
    service.store.set(
      "ticket-outbox",
      key,
      { ...job, after: 0 },
      Number.MAX_SAFE_INTEGER,
    );
  await service.pump();
  assert.equal(service.get(ticket.id).channelId, null);
  assert.equal(service.view({ id: user.id }, ticket.id).discordUrl, null);
  assert.equal(dms.length, 1);
});

test("attachment copy failure keeps the original channel and resumes without extending retention", async (t) => {
  const { service, transport, channels, user } = setupDiscord(t);
  const ticket = service.create(
    { id: user.id, name: "Player" },
    {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description:
        "A detailed ticket with a file that is initially unavailable.",
    },
  );
  await transport.create(ticket);
  await service.pump();
  const target = channels.get(service.get(ticket.id).channelId);
  const at = Date.now() - 10000;
  target.savedMessages.set("2000", {
    id: "2000",
    channelId: target.id,
    guildId: "2",
    author: user,
    content: "Here is the screenshot.",
    createdTimestamp: at,
    attachments: new Collection([
      [
        "20000",
        {
          id: "20000",
          name: "proof.png",
          contentType: "image/png",
          size: 7,
          url: `https://cdn.discordapp.com/attachments/${target.id}/20000/proof.png`,
        },
      ],
    ]),
  });
  let available = false;
  t.mock.method(globalThis, "fetch", async () =>
    available
      ? new Response(Buffer.from("picture"))
      : new Response(null, { status: 503 }),
  );
  service.closeTicket({ id: user.id, name: "Player" }, ticket.id, {});
  await service.pump();
  assert.equal(channels.has(target.id), true);
  assert.equal(
    service.store.get("ticket-discord-close", ticket.id).ready,
    undefined,
  );
  const [id, file] = service.store.entries("ticket-media")[0];
  assert.equal(file.channelId, target.id);
  assert.equal(file.createdAt, at);
  available = true;
  for (const [key, job] of service.store.entries("ticket-outbox"))
    service.store.set(
      "ticket-outbox",
      key,
      { ...job, after: 0 },
      Number.MAX_SAFE_INTEGER,
    );
  await service.pump();
  assert.equal(channels.has(target.id), false);
  assert.equal(service.store.get("ticket-media", id).expiresAt, file.expiresAt);
  assert.equal(service.messages(ticket.id).length, 1);
});
