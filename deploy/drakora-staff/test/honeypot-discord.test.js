import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { openStore } from "../server/store.js";
import { discordHoneypot } from "../server/honeypot-discord.js";
import { rolePermissions } from "../server/role-permissions.js";
import { config as fixture } from "./fixture.js";

function setup(t) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const config = {
    ...fixture,
    sessionSecret: "fixture secret",
    roleSync: { roles: [{ mainId: "200", staffId: "20" }] },
    honeypot: { guildId: "2", channelId: "3", enabled: true },
  };
  const client = new EventEmitter();
  client.user = { id: "9" };
  client.isReady = () => false;
  let sequence = 3000;
  const allPermissions = new PermissionsBitField(
    Object.values(PermissionFlagsBits),
  );
  const actions = [];
  const channels = new Collection();
  function createChannel(data) {
    const messages = new Collection();
    const channel = {
      id: String(sequence++),
      ...data,
      permissionOverwrites: { cache: new Collection() },
      permissionsFor: () => allPermissions,
      messages: {
        fetch: async (id) => {
          if (typeof id === "object") return messages;
          if (messages.has(id)) return messages.get(id);
          const error = new Error("Missing message");
          error.code = 10008;
          throw error;
        },
        delete: async (id) => messages.delete(id),
      },
      send: async (payload) => {
        const message = {
          id: String(sequence++),
          ...payload,
          author: client.user,
          pinned: false,
          pin: async () => {
            message.pinned = true;
          },
          edit: async (value) => {
            Object.assign(message, value);
            return message;
          },
          delete: async () => messages.delete(message.id),
        };
        messages.set(message.id, message);
        return message;
      },
    };
    channel.permissionOverwrites.set = async (entries) => {
      channel.permissionOverwrites.cache = new Collection(
        entries.map((entry) => [
          entry.id,
          {
            id: entry.id,
            allow: new PermissionsBitField(entry.allow ?? []),
            deny: new PermissionsBitField(entry.deny ?? []),
          },
        ]),
      );
    };
    void channel.permissionOverwrites.set(data.permissionOverwrites ?? []);
    channels.set(channel.id, channel);
    return channel;
  }
  const trap = createChannel({
    type: ChannelType.GuildText,
    name: "do-not-chat-here-new",
  });
  channels.delete(trap.id);
  trap.id = "3";
  channels.set(trap.id, trap);
  const members = new Collection();
  const bans = new Collection();
  function member(id, roles = [], permissions = []) {
    const result = {
      id,
      user: { id, bot: false },
      guild: { ownerId: "1000" },
      permissions: new PermissionsBitField(permissions),
      roles: { cache: new Collection(roles.map((id) => [id, { id }])) },
      moderatable: true,
      bannable: true,
      disableCommunicationUntil: async (until) => {
        actions.push({ action: "timeout", id, until });
        result.communicationDisabledUntilTimestamp = +until;
      },
      ban: async ({ reason, deleteMessageSeconds }) => {
        actions.push({ action: "ban", id, deleteMessageSeconds });
        bans.set(id, { reason });
        members.delete(id);
      },
    };
    members.set(id, result);
    return result;
  }
  member("100");
  member("2000", ["200"]);
  member("1000");
  member("2001", [], [PermissionFlagsBits.ModerateMembers]);
  const commands = new Collection();
  const main = {
    id: "2",
    members: {
      fetch: async ({ user }) => {
        if (members.has(user)) return members.get(user);
        const error = new Error("Missing member");
        error.code = 10007;
        throw error;
      },
      fetchMe: async () => ({ permissions: allPermissions }),
    },
    channels: { fetch: async (id) => channels.get(id) },
    bans: {
      fetch: async (id) => {
        if (bans.has(id)) return bans.get(id);
        const error = new Error("Not banned");
        error.code = 10026;
        throw error;
      },
    },
    commands: {
      fetch: async () => commands,
      create: async (value) =>
        commands.set(value.name, { id: value.name, ...value }),
      edit: async (id, value) => commands.set(id, { id, ...value }),
    },
  };
  const staff = {
    id: "1",
    channels: {
      fetch: async (id) => (id ? channels.get(id) : channels),
      create: async (value) => createChannel(value),
    },
  };
  client.guilds = { fetch: async (id) => (id === "2" ? main : staff) };
  let staffRoles = ["10", "20"];
  client.rest = { get: async () => ({ roles: staffRoles }) };
  const bot = discordHoneypot(
    config,
    store,
    client,
    rolePermissions(config, store),
  );
  client.isReady = () => true;
  t.after(async () => {
    await bot.close();
    store.close();
  });
  async function interact(action, options = {}) {
    let reply;
    const event = {
      guildId: "2",
      commandName: "honeypot",
      user: { id: "1000" },
      isChatInputCommand: () => true,
      options: {
        getSubcommand: () => action,
        getUser: () => ({ id: "100" }),
        getBoolean: () => options.confirm,
      },
      deferReply: async () => {
        event.deferred = true;
      },
      editReply: async (value) => {
        reply = value;
      },
    };
    client.emit("interactionCreate", event);
    await new Promise((resolve) => setImmediate(resolve));
    return reply;
  }
  return {
    bot,
    store,
    channels,
    trap,
    commands,
    actions,
    members,
    post(id, messageId) {
      client.emit("messageCreate", {
        id: messageId,
        author: { id, bot: false },
        guildId: "2",
        channelId: "3",
        createdTimestamp: Date.now(),
        system: false,
      });
    },
    interact,
    revoke() {
      staffRoles = [];
    },
  };
}

test("Discord setup publishes one pinned warning, private log permissions and a scoped command", async (t) => {
  const app = setup(t);
  await app.bot.recover();
  assert.equal(app.bot.service.enabled(), true);
  const saved = app.store.get("honeypot-discord", "3");
  const panel = await app.trap.messages.fetch(saved.panelId);
  assert.equal(panel.pinned, true);
  assert.match(panel.embeds[0].description, /24 hour timeout/);
  assert.match(panel.embeds[0].description, /permanent ban/);
  assert.equal(panel.components[0].components[0].label, "Caught: 0");
  const log = app.channels.get(saved.logChannelId);
  assert.equal(
    log.permissionOverwrites.cache
      .get("1")
      .deny.has(PermissionFlagsBits.ViewChannel),
    true,
  );
  assert.equal(
    log.permissionOverwrites.cache
      .get("20")
      .allow.has(PermissionFlagsBits.ViewChannel),
    true,
  );
  assert.equal(log.permissionOverwrites.cache.has("23"), false);
  assert.equal(
    app.commands.get("honeypot").defaultMemberPermissions,
    PermissionFlagsBits.ManageGuild,
  );
  await app.bot.recover();
  assert.equal((await app.trap.messages.fetch({ limit: 100 })).size, 1);
});

test("gateway posts use the Discord timeout adapter, update the counter and exempt privileged members", async (t) => {
  const app = setup(t);
  await app.bot.recover();
  for (const [id, messageId] of [
    ["1000", "4000"],
    ["2000", "4001"],
    ["2001", "4002"],
  ])
    app.post(id, messageId);
  await app.bot.service.pump();
  assert.equal(app.actions.length, 0);
  app.post("100", "4003");
  await app.bot.service.pump();
  assert.equal(app.actions[0].action, "timeout");
  assert.ok(+app.actions[0].until >= Date.now() + 86400000 - 1000);
  await app.bot.recover();
  const panel = await app.trap.messages.fetch(
    app.store.get("honeypot-discord", "3").panelId,
  );
  assert.equal(panel.components[0].components[0].label, "Caught: 1");
  const log = app.channels.get(
    app.store.get("honeypot-discord", "3").logChannelId,
  );
  const alerts = await log.messages.fetch({ limit: 100 });
  assert.equal(
    [...alerts.values()].some((message) =>
      message.embeds[0].description.includes("Fixture message"),
    ),
    false,
  );
  assert.deepEqual([...alerts.values()][0].allowedMentions, { parse: [] });
});

test("staff commands recheck membership and Dashboard access before exposing logs or changing state", async (t) => {
  const app = setup(t);
  await app.bot.recover();
  assert.match(await app.interact("pause"), /paused/);
  assert.equal(app.bot.service.enabled(), false);
  assert.match(await app.interact("resume"), /resumed/);
  assert.match(
    await app.interact("reset", { confirm: false }),
    /Nothing changed/,
  );
  app.revoke();
  assert.match(await app.interact("logs"), /Only Managers and Founders/);
  assert.match(await app.interact("pause"), /Only Managers and Founders/);
  assert.equal(app.bot.service.enabled(), true);
});
