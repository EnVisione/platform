import { ChannelType, PermissionFlagsBits as Flags } from "discord.js";

export function trackerChannelOverwrites(config, channel, roleIds) {
  const controlled = new Set([
    config.guildId,
    ...config.ranks.map((rank) => rank.id),
  ]);
  const entries = [...channel.permissionOverwrites.cache.values()]
    .filter((entry) => !controlled.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      allow: entry.allow.bitfield,
      deny: entry.deny.bitfield,
    }));
  const allowed = new Set(roleIds);
  const access =
    Flags.ViewChannel |
    Flags.SendMessages |
    Flags.ReadMessageHistory |
    Flags.CreatePublicThreads |
    Flags.SendMessagesInThreads |
    Flags.EmbedLinks |
    Flags.AttachFiles;
  for (const id of controlled) {
    const previous = channel.permissionOverwrites.cache.get(id);
    const allow = previous?.allow.bitfield ?? 0n;
    const deny = previous?.deny.bitfield ?? 0n;
    entries.push({
      id,
      type: 0,
      allow: allowed.has(id) ? allow | access : allow & ~Flags.ViewChannel,
      deny: allowed.has(id) ? deny & ~access : deny | Flags.ViewChannel,
    });
  }
  return entries;
}

export async function reconcileTrackerChannels(config, guild) {
  const forums = [];
  for (const settings of config.todoForums ?? []) {
    const project = config.trackerProjects?.find(
      (item) => item.projectId === settings.projectId,
    );
    if (!project) continue;
    const channel = await guild.channels.fetch(settings.channelId);
    if (!channel || channel.type !== ChannelType.GuildForum)
      throw new Error("Tracker forum configuration no longer matches Discord");
    forums.push({ channel, roleIds: project.roleIds });
  }
  const categories = new Map();
  for (const { channel, roleIds } of forums) {
    await channel.permissionOverwrites.set(
      trackerChannelOverwrites(config, channel, roleIds),
      "staff team Tracker access",
    );
    if (channel.parentId) {
      const roles = categories.get(channel.parentId) ?? new Set();
      for (const role of roleIds) roles.add(role);
      categories.set(channel.parentId, roles);
    }
  }
  for (const [id, roles] of categories) {
    const category = await guild.channels.fetch(id);
    if (!category || category.type !== ChannelType.GuildCategory)
      throw new Error(
        "Tracker category configuration no longer matches Discord",
      );
    await category.permissionOverwrites.set(
      trackerChannelOverwrites(config, category, [...roles]),
      "staff team Tracker access",
    );
  }
}
