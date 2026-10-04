import {
  Client,
  Partials,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  Options,
  Routes,
} from "discord.js";
import { meetingService } from "./meetings.js";
import { AuthError } from "./discord.js";
import { discordMembers } from "./discord-members.js";
import { canHost, permissions } from "./roles.js";
import { discordOverview } from "./discord-overview.js";
import { discordAvatar } from "./avatar.js";
import { memberActivity } from "./activity.js";
import { discordRoleTransport, staffRoleSync } from "./role-sync.js";
import { discordRoleAdministration } from "./role-assignment.js";
import {
  discordMailTransport,
  mailNotifications,
} from "./mail-notifications.js";

export function discordOffice(config, store, dependencies = {}) {
  let guild;
  let activityRefresh;
  const activityGuilds = new Set([
    config.guildId,
    ...(config.activityGuildIds ?? []),
  ]);
  const activity = memberActivity(store, {
    guildIds: activityGuilds,
    isMember: (id) => guild?.members.cache.has(id) ?? false,
  });
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      ...(config.tickets
        ? [GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages]
        : []),
    ],
    partials: [Partials.Channel],
    makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
    allowedMentions: { parse: [] },
  });
  const emailAlerts =
    config.mail?.notifications && dependencies.mail
      ? mailNotifications(
          config,
          store,
          dependencies.mail,
          discordMailTransport(config, store, dependencies.rolePolicy, client),
        )
      : undefined;
  for (const event of [
    "guildMemberUpdate",
    "guildMemberAdd",
    "guildMemberRemove",
  ])
    client.on(event, (member) => {
      if (member.guild.id === config.guildId)
        void emailAlerts?.refreshPermissions();
    });
  let ready = false;
  const roleSync = config.roleSync
    ? staffRoleSync(config, store, discordRoleTransport(config, client))
    : undefined;
  let roleTimer;
  const roleFailure = () =>
    console.error("Discord staff rank synchronization is pending.");
  let reconnectTimer;
  let connecting = false;
  let attempts = 0;
  let stopped = false;
  let roleListener = () => {};
  let accessListener = () => {};
  let todoListener = () => {};
  const voiceLink = (id) =>
    `https://discord.com/channels/${config.guildId}/${id}`;
  async function channel(id, type) {
    if (!ready || !guild?.available)
      throw new AuthError("office_unavailable", 503);
    const result = await guild.channels.fetch(id);
    if (
      !result ||
      result.type !== type ||
      result.parentId !== config.office.categoryId
    )
      throw new Error("Office channel configuration no longer matches Discord");
    return result;
  }
  const transport = {
    async setOpen(room, open) {
      const target = await channel(room.id, ChannelType.GuildVoice);
      await target.permissionOverwrites.edit(
        config.accessRoles.todo,
        { ViewChannel: true, Connect: open, Speak: true },
        { reason: "staff meeting access" },
      );
    },
    async invite(room, user, nonce) {
      const target = await channel(
        config.office.inviteChannelId,
        ChannelType.GuildText,
      );
      const message = await target.send({
        content: `<@&${config.accessRoles.todo}> **${room.name} is starting.**\nHosted by <@${user.id}>. Join when you are ready.`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: `Join ${room.name}`,
                url: voiceLink(room.id),
              },
            ],
          },
        ],
        allowedMentions: {
          parse: [],
          roles: [config.accessRoles.todo],
          users: [],
        },
        nonce,
        enforceNonce: true,
      });
      return message.id;
    },
    async endInvite(room, messageId) {
      const target = await channel(
        config.office.inviteChannelId,
        ChannelType.GuildText,
      );
      try {
        await target.messages.edit(messageId, {
          content: `**${room.name} has ended.** The room is closed to new joins.`,
          components: [],
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
    },
  };
  const meetings = meetingService(config, store, transport);
  const profile = (member) => {
    const assigned = permissions(config, [...member.roles.cache.keys()]);
    return {
      id: member.id,
      name: member.displayName,
      avatar: discordAvatar(member.user, config.guildId, member.avatar),
      ranks: assigned.hulyRanks,
      staff:
        assigned.dashboard || assigned.todo || assigned.hulyRanks.length > 0,
      status:
        ready && guild?.available
          ? (member.presence?.status ?? "offline")
          : "unknown",
      lastActiveAt: activity.lastActiveAt(member.id),
      voiceRoomId: ready && guild?.available ? member.voice.channelId : null,
      muted: ready && guild?.available && Boolean(member.voice.mute),
      deafened: ready && guild?.available && Boolean(member.voice.deaf),
    };
  };
  async function refreshActivity() {
    let scanned = 0;
    let unavailable = 0;
    for (const id of activityGuilds) {
      if (stopped) return;
      const source = client.guilds.cache.get(id);
      if (!source?.available) {
        unavailable++;
        continue;
      }
      let channels;
      try {
        channels = await source.channels.fetch();
        const active = await source.channels.fetchActiveThreads();
        for (const [id, thread] of active.threads) channels.set(id, thread);
      } catch {
        unavailable++;
        if (!channels) continue;
      }
      for (const target of channels.values()) {
        if (stopped) return;
        if (
          !target?.isTextBased() ||
          !target.messages ||
          !target
            .permissionsFor(client.user)
            ?.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
            ])
        )
          continue;
        try {
          const messages = await target.messages.fetch({
            limit: 100,
            cache: false,
          });
          if (stopped) return;
          for (const message of messages.values())
            activity.observeMessage(message);
          scanned++;
        } catch {
          unavailable++;
        }
      }
    }
    if (!stopped)
      console.log(
        `Discord message activity refreshed. ${scanned} channels, ${unavailable} unavailable.`,
      );
  }
  async function connect() {
    if (connecting || stopped || !client.isReady()) return;
    connecting = true;
    clearTimeout(reconnectTimer);
    try {
      guild = await client.guilds.fetch(config.guildId);
      await discordMembers(client, guild);
      if (stopped) return;
      for (const member of guild.members.cache.values())
        if (!member.user.bot)
          activity.observe(member.id, member.presence?.status);
      ready = true;
      await meetings.reconcile();
      attempts = 0;
      console.log("Discord office connected.");
      emailAlerts?.start();
      if (roleSync) {
        void roleSync.initialize().catch(roleFailure);
        if (!roleTimer)
          roleTimer = setInterval(
            () => void roleSync.retry().catch(roleFailure),
            60000,
          ).unref();
      }
      if (!activityRefresh)
        activityRefresh = refreshActivity().finally(() => {
          activityRefresh = undefined;
        });
    } catch {
      ready = false;
      console.error("Discord office initialization failed.");
      if (++attempts < 5 && !stopped)
        reconnectTimer = setTimeout(
          connect,
          Math.min(30000 * attempts, 120000),
        );
    } finally {
      connecting = false;
    }
  }
  client.on("clientReady", () => {
    attempts = 0;
    void connect();
  });
  client.on("shardDisconnect", () => {
    ready = false;
  });
  client.on("shardResume", () => {
    attempts = 0;
    void connect();
  });
  client.on("presenceUpdate", (_before, after) => {
    if (!stopped && after.guild.id === config.guildId)
      activity.observe(after.userId, after.status);
  });
  client.on("messageCreate", (message) => {
    if (!stopped) activity.observeMessage(message);
  });
  client.on("raw", (packet) => {
    if (
      !stopped &&
      config.todoForums &&
      [
        "THREAD_CREATE",
        "THREAD_UPDATE",
        "THREAD_DELETE",
        "MESSAGE_CREATE",
        "MESSAGE_UPDATE",
        "MESSAGE_DELETE",
        "MESSAGE_DELETE_BULK",
      ].includes(packet.t)
    ) {
      const data = packet.d;
      if (
        data?.guild_id === config.guildId &&
        (config.todoForums.some(
          (forum) => forum.channelId === data.parent_id,
        ) ||
          store.get("discord-todo", data.channel_id))
      )
        todoListener();
    }
    if (stopped) return;
    accessListener(packet);
    if (!roleSync) return;
    const data = packet.d;
    if (![config.guildId, config.roleSync.guildId].includes(data?.guild_id))
      return;
    if (
      ["GUILD_ROLE_UPDATE", "GUILD_ROLE_CREATE", "GUILD_ROLE_DELETE"].includes(
        packet.t,
      )
    ) {
      void roleSync.retry(true).catch(roleFailure);
      roleListener();
      return;
    }
    if (
      !["GUILD_MEMBER_UPDATE", "GUILD_MEMBER_ADD"].includes(packet.t) ||
      !data.user ||
      !Array.isArray(data.roles)
    )
      return;
    const member = {
      guildId: data.guild_id,
      id: data.user.id,
      bot: data.user.bot,
      roles: data.roles,
      pending: data.pending,
      joinedAt: data.joined_at,
    };
    roleListener(member.id);
    void (
      packet.t === "GUILD_MEMBER_ADD"
        ? roleSync.join(member)
        : roleSync.update(member)
    ).catch(roleFailure);
  });
  client.on("error", () => {
    ready = false;
    console.error("Discord office connection failed.");
  });
  client
    .login(config.discordBotToken)
    .catch(() => console.error("Discord office login failed."));
  function snapshot(user) {
    const members = guild
      ? [...guild.members.cache.values()]
          .filter((member) => !member.user.bot)
          .map(profile)
      : [];
    const available = ready && guild?.available;
    return {
      connected: Boolean(available),
      canHost: canHost(config, user),
      guildName: guild?.name ?? "Staff Office",
      discordUrl: voiceLink(config.office.inviteChannelId),
      members: members.sort((a, b) => a.name.localeCompare(b.name)),
      rooms: config.office.rooms.map((room) => {
        const state = meetings.get(room.id);
        const target = guild?.channels.cache.get(room.id);
        const allowed =
          target
            ?.permissionsFor(config.accessRoles.todo)
            ?.has(PermissionFlagsBits.Connect) ?? false;
        return {
          ...room,
          status: !available
            ? "unavailable"
            : room.kind === "voice"
              ? allowed
                ? "open"
                : "closed"
              : state.status,
          joinUrl: voiceLink(room.id),
          joinable: Boolean(
            available &&
            allowed &&
            (room.kind === "voice" || state.status === "live"),
          ),
          startedAt: state.status === "live" ? state.startedAt : undefined,
          hostId: state.status === "live" ? state.hostId : undefined,
          memberIds: available
            ? members
                .filter((member) => member.voiceRoomId === room.id)
                .map((member) => member.id)
            : [],
        };
      }),
    };
  }
  return {
    gateway: client,
    snapshot,
    overviewQueues: discordOverview(config, client, () => ready),
    meetings,
    roleSync,
    emailAlerts,
    roleAdministration: discordRoleAdministration(config, client),
    staffAvailable: () => ready && Boolean(guild?.available),
    async staffMember(id) {
      try {
        return await client.rest.get(Routes.guildMember(config.guildId, id));
      } catch (error) {
        if (error.code === 10007) return undefined;
        throw new AuthError("discord_unavailable", 503);
      }
    },
    onAccessChanged(listener) {
      accessListener = listener;
    },
    onRolesChanged(listener) {
      roleListener = listener;
    },
    onTodoChanged(listener) {
      todoListener = listener;
    },
    close: async () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(roleTimer);
      ready = false;
      await emailAlerts?.close();
      await roleSync?.close();
      await client.destroy();
      await activityRefresh;
    },
  };
}
