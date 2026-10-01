export function validateConfig(config) {
  for (const key of ["staffOrigin", "todoOrigin"]) {
    const url = new URL(config[key]);
    if (url.protocol !== "https:" || url.origin !== config[key])
      throw new Error(
        `Invalid ${key}: use an HTTPS origin without a trailing slash`,
      );
  }
  if (config.staffOrigin === config.todoOrigin)
    throw new Error("Use separate staff and Huly origins");
  for (const key of [
    "discordClientSecret",
    "sessionSecret",
    "oidcClientSecret",
    "hulySecret",
    "hulyOwner",
    "hulyWorkspace",
    "hulyAccounts",
    "hulyUpstream",
  ])
    if (typeof config[key] !== "string" || !config[key])
      throw new Error(`Missing ${key}`);
  if (Buffer.from(config.databaseKey ?? "", "base64").length !== 32)
    throw new Error(
      "databaseKey must contain 32 random bytes encoded as base64",
    );
  const snowflake = (value) =>
    typeof value === "string" && /^\d{1,20}$/.test(value);
  const ids = [
    config.guildId,
    config.discordClientId,
    config.accessRoles?.dashboard,
    config.accessRoles?.todo,
  ];
  if (
    !ids.every(snowflake) ||
    config.accessRoles.dashboard === config.accessRoles.todo
  )
    throw new Error(
      "Configure a guild and distinct dashboard and Todo access roles",
    );
  if (
    !Array.isArray(config.ranks) ||
    !config.ranks.length ||
    config.ranks.some(
      (rank) =>
        !snowflake(rank.id) ||
        !rank.name ||
        !["OWNER", "MAINTAINER", "USER"].includes(rank.huly) ||
        typeof rank.dashboard !== "boolean",
    )
  )
    throw new Error(
      "Configure ordered staff ranks with valid Huly permission levels",
    );
  if (new Set(config.ranks.map((rank) => rank.id)).size !== config.ranks.length)
    throw new Error("Staff rank IDs must be unique");
  if (config.office) {
    const { categoryId, inviteChannelId, hostRoles, rooms } = config.office;
    if (
      !config.discordBotToken ||
      ![categoryId, inviteChannelId].every(snowflake) ||
      !Array.isArray(hostRoles) ||
      !hostRoles.length ||
      !hostRoles.every(snowflake) ||
      !Array.isArray(rooms) ||
      !rooms.length ||
      rooms.some(
        (room) =>
          !snowflake(room.id) ||
          typeof room.name !== "string" ||
          !room.name ||
          room.name.length > 60 ||
          !["meeting", "voice"].includes(room.kind),
      ) ||
      new Set(rooms.map((room) => room.id)).size !== rooms.length
    )
      throw new Error(
        "Configure the Discord bot, Office channels, and meeting host roles",
      );
  }
  return config;
}
