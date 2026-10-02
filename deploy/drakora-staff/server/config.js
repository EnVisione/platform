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
  if (
    config.activityGuildIds !== undefined &&
    (!config.office ||
      !Array.isArray(config.activityGuildIds) ||
      config.activityGuildIds.length > 2 ||
      new Set([config.guildId, ...config.activityGuildIds]).size > 2 ||
      !config.activityGuildIds.every(snowflake) ||
      new Set(config.activityGuildIds).size !== config.activityGuildIds.length)
  )
    throw new Error(
      "Configure up to two distinct Discord activity guild IDs with Office enabled",
    );
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
  if (config.todoForums !== undefined) {
    if (
      !config.discordBotToken ||
      !Array.isArray(config.todoForums) ||
      !config.todoForums.length ||
      config.todoForums.some(
        (forum) => !snowflake(forum.channelId) || !forum.projectId,
      ) ||
      new Set(config.todoForums.map((forum) => forum.channelId)).size !==
        config.todoForums.length ||
      new Set(config.todoForums.map((forum) => forum.projectId)).size !==
        config.todoForums.length
    )
      throw new Error("Configure distinct Discord forums and Huly projects");
  }
  if (config.applications) {
    const settings = config.applications;
    const origin = new URL(settings.publicOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== settings.publicOrigin ||
      [config.staffOrigin, config.todoOrigin].includes(settings.publicOrigin)
    )
      throw new Error("Configure a separate HTTPS application origin");
    if (
      Buffer.from(settings.databaseKey ?? "", "base64").length !== 32 ||
      !snowflake(settings.notificationChannelId) ||
      !config.discordBotToken ||
      !["builder", "artist", "developer"].every((role) =>
        snowflake(settings.specialistRoles?.[role]),
      )
    )
      throw new Error(
        "Configure the application database key, notification channel, and specialist roles",
      );
    if (settings.fallback !== undefined) {
      const fallback = settings.fallback;
      if (
        !fallback ||
        !snowflake(fallback.guildId) ||
        !snowflake(fallback.categoryId) ||
        !Array.isArray(fallback.reviewerRoleIds) ||
        !fallback.reviewerRoleIds.length ||
        fallback.reviewerRoleIds.length > 20 ||
        !fallback.reviewerRoleIds.every(snowflake) ||
        fallback.reviewerRoleIds.includes(fallback.guildId) ||
        new Set(fallback.reviewerRoleIds).size !==
          fallback.reviewerRoleIds.length
      )
        throw new Error(
          "Configure a private application fallback category and reviewer roles in its guild",
        );
    }
  }
  return config;
}
