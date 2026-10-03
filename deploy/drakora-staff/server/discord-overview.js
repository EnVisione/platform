import { ChannelType, PermissionFlagsBits } from "discord.js";

export function discordOverview(config, client, isReady) {
  const cache = new Map();
  async function channels(guild) {
    const old = cache.get(guild.id);
    if (old && Date.now() - old.at < 15000) return old.pending;
    const pending = Promise.all([
      guild.channels.fetch(),
      guild.channels.fetchActiveThreads(),
    ]).then(([items, active]) => ({ items, threads: active.threads }));
    cache.set(guild.id, { at: Date.now(), pending });
    try {
      return await pending;
    } catch (error) {
      cache.delete(guild.id);
      throw error;
    }
  }
  return async (user) => {
    const result = [];
    const members = new Map();
    for (const queue of config.overview?.queues ?? []) {
      const unavailable = { kind: queue.kind, available: false };
      if (!isReady()) {
        result.push(unavailable);
        continue;
      }
      try {
        const guild = await client.guilds.fetch(queue.guildId);
        if (!members.has(guild.id)) {
          const member = await guild.members
            .fetch({ user: user.id, force: true })
            .catch(() => null);
          members.set(guild.id, member);
        }
        const member = members.get(guild.id);
        if (!member) continue;
        const { items, threads } = await channels(guild);
        const parent = items.get(queue.channelId);
        const expected =
          queue.mode === "category"
            ? ChannelType.GuildCategory
            : ChannelType.GuildForum;
        if (!parent || parent.type !== expected) {
          result.push(unavailable);
          continue;
        }
        const visible = parent
          .permissionsFor(member)
          ?.has(PermissionFlagsBits.ViewChannel);
        if (queue.mode === "forum" && !visible) continue;
        const source = queue.mode === "category" ? items : threads;
        const open = [...source.values()].filter(
          (channel) =>
            channel.parentId === parent.id &&
            !channel.archived &&
            (queue.mode !== "category" ||
              channel.type === ChannelType.GuildText) &&
            !queue.excludedChannelIds?.includes(channel.id) &&
            channel
              .permissionsFor(member)
              ?.has(PermissionFlagsBits.ViewChannel) &&
            !(channel.appliedTags ?? []).some((tag) =>
              queue.closedTagIds?.includes(tag),
            ),
        );
        if (!visible && !open.length) continue;
        result.push({
          kind: queue.kind,
          name: queue.name,
          count: open.length,
          available: true,
          checkedAt: Date.now(),
          href: `https://discord.com/channels/${guild.id}/${queue.mode === "category" && open.length ? open[0].id : parent.id}`,
        });
      } catch {
        result.push(unavailable);
      }
    }
    return result;
  };
}
