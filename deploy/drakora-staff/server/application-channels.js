const permanent = Number.MAX_SAFE_INTEGER;
const snowflake = (value) =>
  typeof value === "string" && /^\d{1,20}$/.test(value);
const access = String((1n << 10n) | (1n << 11n) | (1n << 16n));
const botAccess = String(BigInt(access) | (1n << 14n));

export function applicationChannels(config, store, request) {
  const settings = config.applications.fallback;
  const unavailable = (code) =>
    Object.assign(new Error(code), { status: 403, code });
  function permissions(userId, botId) {
    return [
      { id: settings.guildId, type: 0, allow: "0", deny: "1024" },
      ...settings.reviewerRoleIds.map((id) => ({
        id,
        type: 0,
        allow: access,
        deny: "0",
      })),
      ...[...new Set([userId, botId])].map((id) => ({
        id,
        type: 1,
        allow: id === botId ? botAccess : access,
        deny: "0",
      })),
    ];
  }
  const normalized = (overwrites) =>
    JSON.stringify(
      overwrites
        .map(({ id, type, allow, deny }) => ({
          id,
          type,
          allow: String(BigInt(allow)),
          deny: String(BigInt(deny)),
        }))
        .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)),
    );
  async function channel(userId) {
    if (!settings) throw unavailable("fallback_not_configured");
    if (!snowflake(userId)) throw unavailable("fallback_invalid_member");
    try {
      const member = await request(
        `/guilds/${settings.guildId}/members/${userId}`,
      );
      if (member.user?.id !== userId)
        throw unavailable("fallback_invalid_member");
    } catch (error) {
      if (error.status === 404) throw unavailable("fallback_join_required");
      throw error;
    }
    const me = await request("/users/@me");
    if (!snowflake(me.id)) throw unavailable("fallback_invalid_bot");
    const roles = await request(`/guilds/${settings.guildId}/roles`);
    if (
      !Array.isArray(roles) ||
      settings.reviewerRoleIds.some(
        (id) => !roles.some((role) => role.id === id),
      )
    )
      throw unavailable("fallback_roles_changed");
    const category = await request(`/channels/${settings.categoryId}`);
    if (category.guild_id !== settings.guildId || category.type !== 4)
      throw unavailable("fallback_invalid_category");
    const marker = `Drakora application updates · ${userId}`;
    const owned = (value) =>
      value.guild_id === settings.guildId &&
      value.type === 0 &&
      value.topic === marker;
    const cached = store.get("application-private-channel", userId);
    let value;
    if (cached?.guildId === settings.guildId) {
      try {
        value = await request(`/channels/${cached.channelId}`);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (value && !owned(value)) throw unavailable("fallback_channel_changed");
    }
    const overwrites = permissions(userId, me.id);
    if (!value) {
      const channels = await request(`/guilds/${settings.guildId}/channels`);
      if (!Array.isArray(channels))
        throw unavailable("fallback_invalid_channels");
      value = channels.find(owned);
      if (!value)
        value = await request(`/guilds/${settings.guildId}/channels`, "POST", {
          name: `application-${userId}`,
          type: 0,
          topic: marker,
          parent_id: settings.categoryId,
          permission_overwrites: overwrites,
        });
    }
    if (!snowflake(value.id) || !owned(value))
      throw unavailable("fallback_invalid_channel");
    if (
      value.parent_id !== settings.categoryId ||
      !Array.isArray(value.permission_overwrites) ||
      normalized(value.permission_overwrites) !== normalized(overwrites)
    )
      value = await request(`/channels/${value.id}`, "PATCH", {
        parent_id: settings.categoryId,
        permission_overwrites: overwrites,
      });
    if (
      !owned(value) ||
      value.parent_id !== settings.categoryId ||
      !Array.isArray(value.permission_overwrites) ||
      normalized(value.permission_overwrites) !== normalized(overwrites)
    )
      throw unavailable("fallback_permissions_failed");
    store.set(
      "application-private-channel",
      userId,
      { guildId: settings.guildId, channelId: value.id },
      permanent,
    );
    return {
      id: value.id,
      url: `https://discord.com/channels/${settings.guildId}/${value.id}`,
    };
  }
  async function erase(userId) {
    const saved = store.get("application-private-channel", userId);
    if (!saved) return;
    if (!settings || saved.guildId !== settings.guildId)
      throw unavailable("fallback_channel_changed");
    try {
      const value = await request(`/channels/${saved.channelId}`);
      if (
        value.guild_id !== settings.guildId ||
        value.type !== 0 ||
        value.topic !== `Drakora application updates · ${userId}`
      )
        throw unavailable("fallback_channel_changed");
      await request(`/channels/${saved.channelId}`, "DELETE");
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    store.delete("application-private-channel", userId);
  }
  return { channel, erase };
}
