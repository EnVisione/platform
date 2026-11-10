import { Routes } from "discord.js";

const kind = "discord-nickname";
const lifetime = Number.MAX_SAFE_INTEGER;
const star = "[★] ";
const nicknameLimit = 32;
const staffRanks = new Set([
  "founder", "manager", "admin", "srmoderator", "moderator", "jrmoderator", "helper",
]);

const command = {
  name: "nick",
  description: "Customize your name on the Drakora server",
  options: [
    {
      type: 1, name: "set", description: "Set your server nickname",
      options: [{
        type: 3, name: "name", description: "Your new nickname",
        required: true, minLength: 1, maxLength: nicknameLimit,
      }],
    },
    { type: 1, name: "reset", description: "Use your Discord profile name" },
  ],
};

function prefixed(name) {
  const base = name.replace(/^(?:\[★\]\s*)+/u, "").trim();
  let result = star;
  for (const character of base) {
    if (result.length + character.length > nicknameLimit) break;
    result += character;
  }
  return result.trimEnd();
}

export function discordNicknames(config, store, client) {
  const guildId = config.roleSync.guildId;
  const plusRoleId = config.minecraftBridge.plusRoleId;
  const staffIds = new Set(config.ranks
    .filter((role) => staffRanks.has(role.name.toLowerCase().replaceAll(" ", "")))
    .map((role) => role.id));
  const eligible = new Set([
    plusRoleId,
    ...(config.minecraftBridge.storeMappings ?? []).map((role) => role.roleId),
    ...config.roleSync.roles.filter((role) => staffIds.has(role.staffId)).map((role) => role.mainId),
  ]);
  const pending = new Map();
  const replies = new Set();
  let stopped = false;
  let refresh;
  let registered = false;

  function exclusive(id, action) {
    const task = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    pending.set(id, task);
    return task.finally(() => {
      if (pending.get(id) === task) pending.delete(id);
    });
  }

  function save(id, value) {
    if (value) store.set(kind, id, value, lifetime);
    else store.delete(kind, id);
  }

  async function synchronize(id, request) {
    if (stopped) return;
    const route = Routes.guildMember(guildId, id);
    let member;
    try {
      member = await client.rest.get(route);
    } catch (error) {
      if (error.code !== 10007) throw error;
      save(id);
      return "Your server membership is unavailable.";
    }
    if (member.user.bot || member.pending)
      return "Finish joining the Drakora server before using this command.";
    const plus = member.roles.includes(plusRoleId);
    const canNick = member.roles.some((id) => eligible.has(id));
    if (request && !canNick) return "This command requires an eligible Drakora rank or Plus.";

    const saved = store.get(kind, id);
    if (!request && !plus && !saved) return;
    const current = member.nick ?? null;
    const owned = saved && (current === saved.applied ||
      (Object.hasOwn(saved, "pending") && current === saved.pending));
    let base = owned ? saved.base : current;
    let custom = owned && canNick ? saved.custom : null;
    if (request?.action === "set") {
      const name = request.name.trim();
      const limit = nicknameLimit - (plus ? star.length : 0);
      if (!name || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name) || name.startsWith("[★]"))
        return "Enter a plain nickname without the reserved Plus badge.";
      if (name.length > limit) return `Choose a nickname up to ${limit} characters.`;
      custom = name;
    } else if (request?.action === "reset") {
      base = null;
      custom = null;
    }
    const desired = plus
      ? prefixed(custom ?? base ?? member.user.global_name ?? member.user.username)
      : (custom ?? base);
    const keep = plus || custom !== null;
    if (desired !== current) {
      save(id, { base, custom, applied: current, pending: desired });
      try {
        await client.rest.patch(route, {
          body: { nick: desired },
          reason: request ? "member requested a Drakora nickname" : "synchronize Drakora Plus nickname",
        });
      } catch (error) {
        if (error.status >= 400 && error.status < 500 && error.status !== 429) save(id, saved);
        if (error.code === 50013)
          return "Discord role hierarchy prevents the bot from changing your nickname.";
        throw error;
      }
    }
    save(id, keep ? { base, custom, applied: desired } : undefined);
    if (request) return desired ? `Your server nickname is now ${desired}.` : "Your server nickname was reset.";
  }

  async function refreshMembers() {
    if (stopped || !client.isReady()) return;
    if (!registered) {
      const guild = await client.guilds.fetch(guildId);
      const commands = await guild.commands.fetch();
      const existing = commands.find((item) => item.name === command.name);
      if (existing) await guild.commands.edit(existing.id, command);
      else await guild.commands.create(command);
      registered = true;
    }
    let after;
    do {
      const query = new URLSearchParams({ limit: "1000" });
      if (after) query.set("after", after);
      const members = await client.rest.get(Routes.guildMembers(guildId), { query });
      for (const { user, roles } of members) {
        if (stopped) return;
        if (roles.includes(plusRoleId) || store.get(kind, user.id))
          await exclusive(user.id, () => synchronize(user.id)).catch(reportFailure);
      }
      after = members.length === 1000 ? members.at(-1).user.id : undefined;
    } while (after && !stopped);
  }

  function reportFailure() {
    console.error("Discord nickname synchronization is pending.");
  }

  function recover() {
    if (!stopped && !refresh)
      refresh = refreshMembers().catch(reportFailure).finally(() => { refresh = undefined; });
    return refresh;
  }

  function observe({ t, d }) {
    if (stopped || d?.guild_id !== guildId || !d.user?.id || d.user.bot) return;
    const id = d.user.id;
    if (t === "GUILD_MEMBER_REMOVE") {
      void exclusive(id, () => save(id)).catch(reportFailure);
    } else if (["GUILD_MEMBER_UPDATE", "GUILD_MEMBER_ADD"].includes(t) &&
        (d.roles?.includes(plusRoleId) || store.get(kind, id))) {
      void exclusive(id, () => synchronize(id)).catch(reportFailure);
    }
  }

  async function interact(interaction) {
    await interaction.deferReply({ flags: 64 });
    const action = interaction.options.getSubcommand();
    const name = action === "set" ? interaction.options.getString("name", true) : undefined;
    let content;
    try {
      content = await exclusive(interaction.user.id, () => synchronize(interaction.user.id, { action, name }));
    } catch {
      reportFailure();
      content = "Could not confirm your nickname change. Try again shortly.";
    }
    await interaction.editReply({
      content: content ?? "The nickname service is restarting. Try again shortly.",
      allowedMentions: { parse: [] },
    });
  }

  function handleInteraction(interaction) {
    if (stopped || interaction.guildId !== guildId || !interaction.isChatInputCommand() ||
        interaction.commandName !== command.name) return;
    const task = interact(interaction).catch(reportFailure).finally(() => replies.delete(task));
    replies.add(task);
  }

  client.on("clientReady", recover);
  client.on("raw", observe);
  client.on("interactionCreate", handleInteraction);
  const timer = setInterval(recover, 10 * 60_000).unref();
  if (client.isReady()) void recover();
  return {
    async close() {
      stopped = true;
      clearInterval(timer);
      client.off("clientReady", recover);
      client.off("raw", observe);
      client.off("interactionCreate", handleInteraction);
      await Promise.allSettled([refresh, ...pending.values(), ...replies]);
    },
  };
}
