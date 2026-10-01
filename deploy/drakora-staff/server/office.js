import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import { meetingService } from "./meetings.js";
import { AuthError } from "./discord.js";
import { canHost, permissions } from "./roles.js";
import { discordAvatar } from "./avatar.js";

export function discordOffice(config, store) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildVoiceStates,
    ],
    allowedMentions: { parse: [] },
  });
  let ready = false;
  let guild;
  let reconnectTimer;
  let connecting = false;
  let attempts = 0;
  let stopped = false;
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
  const profile = (member) => ({
    id: member.id,
    name: member.displayName,
    avatar: discordAvatar(member.user, config.guildId, member.avatar),
    ranks: permissions(config, [...member.roles.cache.keys()]).hulyRanks,
    status:
      ready && guild?.available
        ? (member.presence?.status ?? "offline")
        : "unknown",
    voiceRoomId: ready && guild?.available ? member.voice.channelId : null,
    muted: ready && guild?.available && Boolean(member.voice.mute),
    deafened: ready && guild?.available && Boolean(member.voice.deaf),
  });
  async function connect() {
    if (connecting || stopped || !client.isReady()) return;
    connecting = true;
    clearTimeout(reconnectTimer);
    try {
      guild = await client.guilds.fetch(config.guildId);
      await guild.members.fetch({ withPresences: true });
      ready = true;
      await meetings.reconcile();
      attempts = 0;
      console.log("Discord office connected.");
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
          .filter(
            (member) =>
              !member.user.bot &&
              !member.pending &&
              member.roles.cache.has(config.accessRoles.todo),
          )
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
    snapshot,
    meetings,
    close: () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      ready = false;
      client.destroy();
    },
  };
}
