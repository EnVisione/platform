import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { discordNicknames } from "../server/discord-nicknames.js";

const config = {
  minecraftBridge: { plusRoleId: "plus", storeMappings: [{ roleId: "wyrm" }] },
  roleSync: { guildId: "1", roles: [
    { staffId: "staff-mod", mainId: "mod" },
    { staffId: "staff-builder", mainId: "builder" },
  ] },
  ranks: [
    { id: "staff-mod", name: "Jr Moderator" },
    { id: "staff-builder", name: "Builder" },
  ],
};

async function until(condition) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Discord fixture did not settle");
}

function setup(t, roles, nick = null, globalName = "Profile Name") {
  const state = new Map();
  const store = {
    get: (_, id) => structuredClone(state.get(id)),
    set: (_, id, value) => state.set(id, structuredClone(value)),
    delete: (_, id) => state.delete(id),
  };
  const member = { roles, nick, user: { id: "2", username: "account", global_name: globalName } };
  const client = new EventEmitter();
  client.isReady = () => true;
  const commands = [];
  const edits = [];
  client.guilds = {
    async fetch(id) {
      assert.equal(id, "1");
      return { commands: {
        fetch: async () => commands,
        create: async (value) => commands.push(value),
      } };
    },
  };
  client.rest = {
    get: async (route) => route.endsWith("/members") ? [structuredClone(member)] : structuredClone(member),
    async patch(route, { body }) {
      assert.equal(route, "/guilds/1/members/2");
      member.nick = body.nick;
      edits.push(body.nick);
    },
  };
  const service = discordNicknames(config, store, client);
  t.after(() => service.close());
  const update = () => client.emit("raw", {
    t: "GUILD_MEMBER_UPDATE", d: { guild_id: "1", ...member },
  });
  function command(action, name, guildId = "1") {
    return new Promise((resolve) => client.emit("interactionCreate", {
      guildId,
      commandName: "nick",
      isChatInputCommand: () => true,
      user: member.user,
      options: { getSubcommand: () => action, getString: () => name },
      async deferReply({ flags }) { assert.equal(flags, 64); },
      async editReply({ content, allowedMentions }) {
        assert.deepEqual(allowedMentions, { parse: [] });
        resolve(content);
      },
    }));
  }
  return { state, member, client, commands, edits, command, update, service, store };
}

test("eligible ranks can set and reset their own nickname", async (t) => {
  const f = setup(t, ["wyrm"], "Previous");
  assert.match(await f.command("set", "New Name"), /New Name/);
  assert.equal(f.member.nick, "New Name");
  assert.match(await f.command("reset"), /reset/);
  assert.equal(f.member.nick, null);
  assert.equal(f.state.size, 0);
  assert.equal(f.commands[0].name, "nick");
  assert.deepEqual(f.commands[0].options.map(({ name }) => name), ["set", "reset"]);
});

test("unranked members and specialist-only roles cannot use nick", async (t) => {
  const f = setup(t, [], "Existing");
  assert.match(await f.command("set", "New"), /requires an eligible/);
  f.member.roles = ["builder"];
  assert.match(await f.command("set", "New"), /requires an eligible/);
  f.member.roles = ["mod"];
  assert.match(await f.command("set", "New"), /now New/);
  assert.deepEqual(f.edits, ["New"]);
});

test("startup and role updates add one Plus badge and restore the existing nickname on expiry", async (t) => {
  const f = setup(t, ["plus"], "Existing");
  await until(() => f.member.nick === "[★] Existing");
  f.update();
  await until(() => f.state.get("2")?.applied === "[★] Existing");
  f.member.roles = [];
  f.update();
  await until(() => f.member.nick === "Existing" && f.state.size === 0);
  assert.deepEqual(f.edits, ["[★] Existing", "Existing"]);
});

test("Plus uses the Discord profile by default and keeps an eligible custom name after expiry", async (t) => {
  const f = setup(t, ["plus", "wyrm"]);
  await until(() => f.member.nick === "[★] Profile Name");
  assert.match(await f.command("set", "Custom"), /\[★\] Custom/);
  f.member.roles = ["wyrm"];
  f.update();
  await until(() => f.member.nick === "Custom");
  f.member.roles = [];
  f.update();
  await until(() => f.member.nick === null);
});

test("Plus prefix fits Discord's limit and members cannot submit their own badge", async (t) => {
  const f = setup(t, ["plus"], null, "😀".repeat(16));
  await until(() => f.member.nick?.startsWith("[★] "));
  assert.equal(f.member.nick, "[★] " + "😀".repeat(14));
  assert.match(await f.command("set", "a".repeat(29)), /up to 28/);
  assert.match(await f.command("set", "[★] Fake"), /reserved Plus badge/);
  assert.equal(f.edits.length, 1);
});

test("a moderator's later nickname is preserved and becomes the new Plus base", async (t) => {
  const f = setup(t, ["plus", "wyrm"], "Original");
  await until(() => f.member.nick === "[★] Original");
  await f.command("set", "Custom");
  f.member.nick = "Moderated";
  f.update();
  await until(() => f.member.nick === "[★] Moderated");
  f.member.roles = ["wyrm"];
  f.update();
  await until(() => f.member.nick === "Moderated");
});

test("reconciliation recognizes a nickname already written before a crash", async (t) => {
  const f = setup(t, ["plus"], "[★] Existing");
  f.store.set("discord-nickname", "2", {
    base: "Existing", custom: null, applied: "Existing", pending: "[★] Existing",
  });
  await until(() => f.state.get("2")?.applied === "[★] Existing");
  assert.equal(f.edits.length, 0);
  f.member.roles = [];
  f.update();
  await until(() => f.member.nick === "Existing");
});
