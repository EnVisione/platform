import { validMailAddress } from "./mail-address.js";
import { isIP } from "node:net";

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
  if (config.website !== undefined) {
    if (
      !config.website ||
      typeof config.website !== "object" ||
      Array.isArray(config.website) ||
      !config.applications ||
      !snowflake(config.website.discordGuildId) ||
      typeof config.discordBotToken !== "string" ||
      !config.discordBotToken
    )
      throw new Error(
        "Configure public applications, a community Discord guild and bot for the website",
      );
    let invite;
    try {
      invite = new URL(config.website.discordInvite);
    } catch {
      throw new Error("Configure an HTTPS Discord invite for the website");
    }
    if (
      invite.protocol !== "https:" ||
      invite.username ||
      invite.password ||
      invite.port ||
      invite.search ||
      invite.hash ||
      !(
        (invite.hostname === "discord.gg" &&
          /^\/[a-zA-Z0-9_-]+$/.test(invite.pathname)) ||
        (invite.hostname === "discord.com" &&
          /^\/invite\/[a-zA-Z0-9_-]+$/.test(invite.pathname))
      )
    )
      throw new Error("Configure an HTTPS Discord invite for the website");
  }
  if (config.overview !== undefined) {
    if (
      !config.overview ||
      typeof config.overview !== "object" ||
      Array.isArray(config.overview)
    )
      throw new Error("Configure an Overview settings object");
    const { servers = [], queues = [] } = config.overview ?? {};
    if (
      !Array.isArray(servers) ||
      servers.length > 30 ||
      servers.some(
        (server) =>
          !server ||
          typeof server.id !== "string" ||
          !/^[a-z0-9-]{1,60}$/.test(server.id) ||
          typeof server.name !== "string" ||
          !server.name.trim() ||
          server.name.length > 60 ||
          typeof server.group !== "string" ||
          !server.group.trim() ||
          server.group.length > 40 ||
          !["proxy", "server"].includes(server.kind) ||
          typeof server.host !== "string" ||
          server.host.length > 253 ||
          !(
            isIP(server.host) ||
            /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(server.host)
          ) ||
          !Number.isInteger(server.port) ||
          server.port < 1 ||
          server.port > 65535 ||
          (server.socketPath !== undefined &&
            (typeof server.socketPath !== "string" ||
              server.socketPath.length > 250 ||
              !server.socketPath.startsWith("/") ||
              !server.socketPath.endsWith(".sock") ||
              /[\r\n\0]/.test(server.socketPath))),
      ) ||
      new Set(servers.map((server) => server.id)).size !== servers.length ||
      new Set(
        servers.map((server) => `${server.host.toLowerCase()}:${server.port}`),
      ).size !== servers.length
    )
      throw new Error("Configure distinct named Minecraft status endpoints");
    if (
      !Array.isArray(queues) ||
      queues.length > 4 ||
      queues.some(
        (queue) =>
          !queue ||
          !["tickets", "appeals"].includes(queue.kind) ||
          !snowflake(queue.guildId) ||
          !snowflake(queue.channelId) ||
          !["category", "forum"].includes(queue.mode) ||
          typeof queue.name !== "string" ||
          !queue.name.trim() ||
          queue.name.length > 60 ||
          !Array.isArray(queue.closedTagIds ?? []) ||
          !(queue.closedTagIds ?? []).every(snowflake) ||
          !Array.isArray(queue.excludedChannelIds ?? []) ||
          !(queue.excludedChannelIds ?? []).every(snowflake),
      ) ||
      new Set(queues.map((queue) => queue.channelId)).size !== queues.length ||
      (queues.length && !config.office)
    )
      throw new Error(
        "Configure Discord ticket and appeal queues with Office enabled",
      );
  }
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
  if (config.roleSync !== undefined) {
    const settings = config.roleSync;
    const staffRoleIds = new Set([
      ...config.ranks.map((rank) => rank.id),
      ...Object.values(config.applications?.specialistRoles ?? {}),
    ]);
    if (
      !config.office ||
      !settings ||
      !snowflake(settings.guildId) ||
      settings.guildId === config.guildId ||
      !["unchanged", "main", "staff"].includes(settings.initialSource) ||
      !Array.isArray(settings.roles) ||
      !settings.roles.length ||
      settings.roles.length > 20 ||
      settings.roles.some(
        (role) =>
          !role ||
          !staffRoleIds.has(role.staffId) ||
          Object.values(config.accessRoles).includes(role.staffId) ||
          !snowflake(role.mainId) ||
          role.mainId === settings.guildId,
      ) ||
      new Set(settings.roles.map((role) => role.staffId)).size !==
        settings.roles.length ||
      new Set(settings.roles.map((role) => role.mainId)).size !==
        settings.roles.length
    )
      throw new Error(
        "Configure distinct staff rank mappings and an initial conflict policy with Office enabled",
      );
  }
  if (config.todoForums !== undefined) {
    if (
      config.todoPublicTextExclusions !== undefined &&
      (!Array.isArray(config.todoPublicTextExclusions) ||
        config.todoPublicTextExclusions.length > 50 ||
        config.todoPublicTextExclusions.some(
          (term) =>
            typeof term !== "string" || !term.trim() || term.length > 80,
        ))
    )
      throw new Error("Configure up to 50 nonempty Tracker text exclusions");
    if (
      !config.discordBotToken ||
      !Array.isArray(config.todoForums) ||
      !config.todoForums.length ||
      config.todoForums.some(
        (forum) =>
          !snowflake(forum.channelId) ||
          !forum.projectId ||
          (forum.assigneeTags !== undefined &&
            (!forum.assigneeTags ||
              typeof forum.assigneeTags !== "object" ||
              Array.isArray(forum.assigneeTags) ||
              Object.entries(forum.assigneeTags).some(
                ([tag, id]) => !snowflake(tag) || !snowflake(id),
              ))),
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
    if (settings.smtp !== undefined) {
      const smtp = settings.smtp;
      const address = (value) =>
        typeof value === "string" &&
        value.length <= 254 &&
        /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
          value,
        );
      if (
        !smtp ||
        typeof smtp.socketPath !== "string" ||
        !smtp.socketPath.startsWith("/") ||
        smtp.socketPath.includes("\0") ||
        typeof smtp.user !== "string" ||
        !smtp.user ||
        /[\r\n\0]/.test(smtp.user) ||
        typeof smtp.password !== "string" ||
        !smtp.password ||
        !address(smtp.from) ||
        (smtp.replyTo !== undefined && !address(smtp.replyTo)) ||
        typeof smtp.ca !== "string" ||
        !smtp.ca.includes("-----BEGIN CERTIFICATE-----")
      )
        throw new Error(
          "Configure the private SMTP socket, Bridge credentials, sender address, and trusted certificate",
        );
    }
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
  if (config.mail !== undefined) {
    const settings = config.mail;
    if (
      !config.applications?.smtp ||
      !settings ||
      typeof settings.imapSocketPath !== "string" ||
      !settings.imapSocketPath.startsWith("/") ||
      settings.imapSocketPath.includes("\0") ||
      !Array.isArray(settings.identities) ||
      !settings.identities.length ||
      settings.identities.length > 20 ||
      (settings.folderPaths !== undefined &&
        (!Array.isArray(settings.folderPaths) ||
          settings.folderPaths.length > 30 ||
          settings.folderPaths.some(
            (path) =>
              typeof path !== "string" ||
              !path ||
              path.length > 300 ||
              /[\r\n\0]/.test(path),
          ))) ||
      settings.identities.some(
        (identity) =>
          !identity ||
          !validMailAddress(identity.address) ||
          typeof identity.name !== "string" ||
          !identity.name ||
          identity.name.length > 80 ||
          /[\r\n\0]/.test(identity.name),
      ) ||
      new Set(
        settings.identities.map((identity) => identity.address.toLowerCase()),
      ).size !== settings.identities.length
    )
      throw new Error(
        "Configure the private IMAP socket and distinct sender identities with Proton Bridge SMTP enabled",
      );
    if (
      settings.notifications !== undefined &&
      (!config.office ||
        !config.discordBotToken ||
        !snowflake(settings.notifications?.categoryId))
    )
      throw new Error(
        "Configure a staff category for private email notifications",
      );
  }
  if (config.tickets !== undefined) {
    const settings = config.tickets;
    if (
      !settings ||
      !config.office ||
      !config.applications ||
      !config.roleSync ||
      !snowflake(settings.guildId) ||
      settings.guildId !== config.roleSync.guildId ||
      !snowflake(settings.archiveCategoryId) ||
      (settings.staffChannelId !== undefined &&
        !snowflake(settings.staffChannelId)) ||
      (settings.feedbackChannelId !== undefined &&
        !snowflake(settings.feedbackChannelId)) ||
      Buffer.from(settings.databaseKey ?? "", "base64").length !== 32 ||
      settings.minecraftEnabled !== false ||
      settings.databaseKey === config.databaseKey ||
      settings.databaseKey === config.applications.databaseKey
    )
      throw new Error(
        "Configure a separate ticket database key, community guild, archive category, optional staff notice channel and feedback channel, and disabled Minecraft ticket integration",
      );
  }
  if (config.honeypot !== undefined) {
    const settings = config.honeypot;
    if (
      !config.office ||
      !settings ||
      typeof settings !== "object" ||
      Array.isArray(settings) ||
      typeof settings.enabled !== "boolean" ||
      ![settings.guildId, settings.channelId].every(snowflake) ||
      settings.guildId !== config.roleSync?.guildId
    )
      throw new Error(
        "Configure the community honeypot channel and explicit enabled flag with Office enabled",
      );
  }
  return config;
}
