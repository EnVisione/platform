export function discordAvatar(user, guildId, guildAvatar) {
  if (!/^\d+$/.test(user.id)) throw new Error("Invalid Discord identity");
  if (guildAvatar && /^[a-zA-Z0-9_]+$/.test(guildAvatar))
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${guildAvatar}.png?size=256`;
  if (user.avatar && /^[a-zA-Z0-9_]+$/.test(user.avatar))
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`;
  const index =
    user.discriminator && user.discriminator !== "0"
      ? Number(user.discriminator) % 5
      : Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
