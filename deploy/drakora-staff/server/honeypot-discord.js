import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  Routes,
} from "discord.js";
import { createHash } from "node:crypto";
import { honeypotService } from "./honeypot.js";

const permanent = Number.MAX_SAFE_INTEGER;
const reason = "Drakora honeypot. Posting in the clearly marked spam trap.";
const nonce = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

export function discordHoneypot(config, store, client, rolePolicy) {
  const settings = config.honeypot;
  let ready = false;
  let stopped = false;
  let recovering;
  let commandsReady = false;
  let timer;
  let lastPanel;
  const interactions = new Set();
  const saved = () => store.get("honeypot-discord", settings.channelId) ?? {};
  const save = (value) =>
    store.set("honeypot-discord", settings.channelId, value, permanent);
  const guild = () => client.guilds.fetch(settings.guildId);
  const immuneRoles = new Set(
    settings.guildId === config.guildId
      ? [
          ...config.ranks.map((rank) => rank.id),
          ...Object.values(config.applications?.specialistRoles ?? {}),
        ]
      : (config.roleSync?.roles ?? []).map((role) => role.mainId),
  );
  function protectedMember(member) {
    return (
      member.id === member.guild.ownerId ||
      member.user.bot ||
      member.roles.cache.some((role) => immuneRoles.has(role.id)) ||
      [
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ModerateMembers,
        PermissionFlagsBits.BanMembers,
      ].some((permission) => member.permissions.has(permission))
    );
  }
  async function member(id) {
    try {
      return await (await guild()).members.fetch({ user: id, force: true });
    } catch (error) {
      if (error.code === 10007) return undefined;
      throw error;
    }
  }
  async function eligible(id) {
    const value = await member(id);
    if (!value || protectedMember(value)) {
      const error = new Error("Protected or absent honeypot member");
      error.code = "protected_member";
      throw error;
    }
    return value;
  }
  async function trap() {
    const value = await (await guild()).channels.fetch(settings.channelId);
    if (
      !value ||
      value.type !== ChannelType.GuildText ||
      !/do-not-chat|honeypot/.test(value.name)
    )
      throw new Error("The honeypot must be an explicitly named text channel");
    return value;
  }
  async function logChannel() {
    const staff = await client.guilds.fetch(config.guildId);
    const current = saved();
    let channel =
      current.logChannelId &&
      (await staff.channels.fetch(current.logChannelId).catch((error) => {
        if (error.code === 10003) return undefined;
        throw error;
      }));
    const topic = `Drakora honeypot moderation alerts. Trap ${settings.channelId}.`;
    const overwrites = [
      { id: staff.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      ...config.ranks
        .filter((rank) => ["Founder", "Manager"].includes(rank.name))
        .map((rank) => ({
          id: rank.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
          ],
          deny: [PermissionFlagsBits.SendMessages],
        })),
    ];
    if (!channel) {
      const channels = await staff.channels.fetch();
      channel = channels.find(
        (value) =>
          value?.type === ChannelType.GuildText && value.topic === topic,
      );
    }
    if (!channel)
      channel = await staff.channels.create({
        name: "honeypot-alerts",
        type: ChannelType.GuildText,
        topic,
        permissionOverwrites: overwrites,
        reason: "Private honeypot moderation alerts",
      });
    if (channel.type !== ChannelType.GuildText || channel.topic !== topic)
      throw new Error("Honeypot alert channel ownership could not be verified");
    if (
      channel.permissionOverwrites.cache.size !== overwrites.length ||
      overwrites.some((entry) => {
        const actual = channel.permissionOverwrites.cache.get(entry.id);
        return (
          !actual ||
          actual.allow.bitfield !==
            new PermissionsBitField(entry.allow ?? []).bitfield ||
          actual.deny.bitfield !==
            new PermissionsBitField(entry.deny ?? []).bitfield
        );
      })
    )
      await channel.permissionOverwrites.set(
        overwrites,
        "Private honeypot alert access",
      );
    save({ ...saved(), logChannelId: channel.id });
    return channel;
  }
  const transport = {
    ready: () => ready && client.isReady(),
    async member(id) {
      const value = await member(id);
      return (
        value && {
          protected: protectedMember(value),
          moderatable: value.moderatable,
          bannable: value.bannable,
          timeoutUntil: value.communicationDisabledUntilTimestamp,
        }
      );
    },
    async timeout(id, until) {
      const value = await eligible(id);
      await value.disableCommunicationUntil(
        new Date(until),
        reason + " First violation, 24 hour timeout.",
      );
    },
    async ban(id, reference) {
      const value = await eligible(id);
      await value.ban({
        reason:
          reason + ` Repeat violation, permanent ban. Reference ${reference}.`,
        deleteMessageSeconds: 0,
      });
    },
    async isBanned(id, reference) {
      try {
        return (
          (await (await guild()).bans.fetch(id)).reason?.includes(
            `Reference ${reference}.`,
          ) ?? false
        );
      } catch (error) {
        if (error.code === 10026) return false;
        throw error;
      }
    },
    async removeMessage(id) {
      try {
        await (await trap()).messages.delete(id);
      } catch (error) {
        if (![10003, 10008].includes(error.code)) throw error;
      }
    },
    async alert(record) {
      const channel = await logChannel();
      const footer = `Honeypot ${record.id}`;
      if (record.attempts) {
        const messages = await channel.messages.fetch({
          limit: 100,
          cache: false,
        });
        const existing = messages.find(
          (message) =>
            message.author.id === client.user.id &&
            message.embeds.some((embed) => embed.footer?.text === footer),
        );
        if (existing) return { id: existing.id, channelId: channel.id };
      }
      const message = await channel.send({
        embeds: [
          {
            title:
              record.result === "applied"
                ? "Honeypot action applied"
                : "Honeypot action not applied",
            description: `<@${record.userId}> · ${record.action === "ban" ? "Permanent ban" : record.action === "timeout" ? "24 hour timeout" : (record.action ?? "Eligibility check")}\nResult: ${record.result}${record.code ? ` · ${record.code}` : ""}${record.actorId ? `\nReviewed by <@${record.actorId}>` : ""}\nTrap: <#${settings.channelId}>`,
            color: record.result === "applied" ? 0xd4a644 : 0xba3d32,
            timestamp: new Date(record.at).toISOString(),
            footer: { text: footer },
          },
        ],
        allowedMentions: { parse: [] },
        nonce: nonce(record.id),
        enforceNonce: true,
      });
      return { id: message.id, channelId: channel.id };
    },
    async removeAlert(receipt) {
      const staff = await client.guilds.fetch(config.guildId);
      try {
        const channel = await staff.channels.fetch(receipt.channelId);
        if (!channel || channel.type !== ChannelType.GuildText)
          throw new Error("Invalid alert cleanup channel");
        const message = await channel.messages.fetch(receipt.id);
        if (
          message.author.id !== client.user.id ||
          !message.embeds.some(
            (embed) => embed.footer?.text === `Honeypot ${receipt.reference}`,
          )
        )
          throw new Error("Alert cleanup ownership mismatch");
        await message.delete();
      } catch (error) {
        if (![10003, 10008].includes(error.code)) throw error;
      }
    },
  };
  const service = honeypotService(config, store, transport);
  function panel() {
    const state = service.state();
    return {
      embeds: [
        {
          title: "Do not send messages in this channel",
          description: service.state().paused
            ? "The Drakora honeypot is paused. Do not post here. Staff are reviewing its configuration."
            : "This channel is a trap for spam bots. It is not used for chat.\n\n**First violation: a 24 hour timeout. A repeat violation within 365 days: a permanent ban.**\n\nIf you are reading this, you are fine. Do not send anything.\n\nStaff and trusted bot messages are exempt. Moderation details are logged privately for 90 days, and a repeat violation marker is kept for 365 days. Contact support@drakora.org to appeal.",
          color: 0xd4a644,
          footer: { text: "Drakora honeypot" },
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 2,
              custom_id: "drakora:honeypot:count",
              label: `Caught: ${state.caught}`,
              emoji: { name: "🍯" },
              disabled: true,
            },
          ],
        },
      ],
      allowedMentions: { parse: [] },
    };
  }
  async function registerCommands(main) {
    const command = {
      name: "honeypot",
      description: "Manage the Drakora spam trap",
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
      options: [
        {
          type: 1,
          name: "status",
          description: "Show honeypot health and counters",
        },
        {
          type: 1,
          name: "logs",
          description: "Show the latest private moderation results",
        },
        {
          type: 1,
          name: "pause",
          description: "Pause automatic honeypot moderation",
        },
        {
          type: 1,
          name: "resume",
          description: "Resume the configured honeypot",
        },
        {
          type: 1,
          name: "reset",
          description: "Clear a member's repeat violation marker after review",
          options: [
            {
              type: 6,
              name: "member",
              description: "Member to reset",
              required: true,
            },
            {
              type: 5,
              name: "confirm",
              description: "Confirm the reset after reviewing the case",
              required: true,
            },
          ],
        },
      ],
    };
    const commands = await main.commands.fetch();
    const existing = commands.find((item) => item.name === command.name);
    if (existing) await main.commands.edit(existing.id, command);
    else await main.commands.create(command);
    commandsReady = true;
  }
  async function initialize() {
    if (stopped || !client.isReady()) return;
    const main = await guild();
    if (!commandsReady) await registerCommands(main);
    if (!settings.enabled) return;
    const channel = await trap();
    const me = await main.members.fetchMe();
    if (
      !me.permissions.has([
        PermissionFlagsBits.ModerateMembers,
        PermissionFlagsBits.BanMembers,
      ]) ||
      !channel
        .permissionsFor(me)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages,
        ])
    )
      throw new Error("Honeypot permissions are incomplete");
    await logChannel();
    let message;
    if (saved().panelId) {
      try {
        message = await channel.messages.fetch(saved().panelId);
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
      if (message && message.author.id !== client.user.id)
        throw new Error("Honeypot panel ownership mismatch");
    }
    if (!message) {
      ready = false;
      const messages = await channel.messages.fetch({
        limit: 100,
        cache: false,
      });
      message = messages.find(
        (item) =>
          item.author.id === client.user.id &&
          item.embeds.some(
            (embed) => embed.footer?.text === "Drakora honeypot",
          ),
      );
    }
    const payload = panel();
    const signature = JSON.stringify(payload);
    if (!message)
      message = await channel.send({
        ...payload,
        nonce: nonce(`panel:${settings.channelId}`),
        enforceNonce: true,
      });
    else if (signature !== lastPanel) await message.edit(payload);
    save({ ...saved(), panelId: message.id });
    if (!message.pinned) await message.pin();
    lastPanel = signature;
    ready = true;
  }
  function recover() {
    if (!recovering)
      recovering = initialize()
        .catch(() => {
          ready = false;
          console.error(
            "Honeypot setup is unavailable. Automatic moderation is paused.",
          );
        })
        .finally(() => {
          recovering = undefined;
        });
    return recovering;
  }
  async function administrator(id) {
    const staff = await client.rest.get(Routes.guildMember(config.guildId, id));
    const user = rolePolicy.apply({ id, roles: staff.roles });
    return user.permissions.dashboard && rolePolicy.isManager(user);
  }
  async function interact(interaction) {
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== "honeypot" ||
      interaction.guildId !== settings.guildId
    )
      return;
    await interaction.deferReply({ flags: 64 });
    if (!(await administrator(interaction.user.id)))
      return interaction.editReply(
        "Only Managers and Founders with Dashboard access in the staff server can manage the honeypot.",
      );
    if (stopped)
      return interaction.editReply(
        "The honeypot service is restarting. Try again shortly.",
      );
    const action = interaction.options.getSubcommand();
    if (action === "pause" || action === "resume") {
      if (action === "resume" && !settings.enabled)
        return interaction.editReply(
          "The honeypot is not enabled in server configuration. Complete the moderation bot handoff first.",
        );
      await service.pause(action === "pause", interaction.user.id);
      lastPanel = undefined;
      await recover();
      return interaction.editReply(
        action === "pause"
          ? "Automatic honeypot moderation is paused. An action already sent to Discord may finish."
          : service.enabled()
            ? "Honeypot moderation resumed."
            : "Honeypot checks failed. Automatic moderation remains paused.",
      );
    }
    if (action === "reset") {
      if (!interaction.options.getBoolean("confirm", true))
        return interaction.editReply(
          "The reset was not confirmed. Nothing changed.",
        );
      const user = interaction.options.getUser("member", true);
      await service.reset(user.id, interaction.user.id);
      return interaction.editReply(
        "The repeat violation marker was cleared. This does not remove an existing Discord timeout or ban.",
      );
    }
    if (action === "logs") {
      const logs = service.logs();
      return interaction.editReply({
        content:
          logs
            .map(
              (entry) =>
                `<@${entry.userId}> · ${entry.action ?? "check"} · ${entry.result}${entry.code ? ` · ${entry.code}` : ""} · <t:${Math.floor(entry.at / 1000)}:f>`,
            )
            .join("\n") || "No moderation results recorded.",
        allowedMentions: { parse: [] },
      });
    }
    const state = service.state();
    return interaction.editReply(
      `Honeypot: ${service.enabled() ? "Active" : "Paused or unavailable"}\nCaught: ${state.caught} · Timeouts: ${state.timeouts} · Bans: ${state.bans}\nFirst violation: 24 hour timeout. Repeat within 365 days: permanent ban.\nPrivate action logs: 90 days. Repeat marker: 365 days.`,
    );
  }
  const handleMessage = (message) => {
    if (
      service.observe({
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        id: message.id,
        createdAt: message.createdTimestamp,
        bot: message.author.bot,
        webhook: Boolean(message.webhookId),
        system: message.system,
      })
    )
      void service
        .pump()
        .catch(() => console.error("Honeypot processing failed."));
  };
  const handleInteraction = (interaction) => {
    const task = interact(interaction)
      .catch(async () => {
        console.error("Honeypot staff command failed.");
        if (interaction.deferred)
          await interaction
            .editReply(
              "The honeypot action could not be completed. No successful change is being reported.",
            )
            .catch(() => {});
      })
      .finally(() => interactions.delete(task));
    interactions.add(task);
  };
  const handleReady = () => {
    ready = false;
    commandsReady = false;
    void recover();
  };
  const handleRaw = (event) => {
    if (
      (event.t === "MESSAGE_DELETE" && event.d?.id === saved().panelId) ||
      (event.t === "MESSAGE_DELETE_BULK" &&
        event.d?.ids?.includes(saved().panelId))
    ) {
      ready = false;
      lastPanel = undefined;
    }
  };
  client.on("messageCreate", handleMessage);
  client.on("interactionCreate", handleInteraction);
  client.on("clientReady", handleReady);
  client.on("shardResume", handleReady);
  client.on("raw", handleRaw);
  timer = setInterval(() => void recover(), 30000);
  timer.unref();
  service.start();
  if (client.isReady()) void recover();
  return {
    service,
    recover,
    async close() {
      stopped = true;
      ready = false;
      clearInterval(timer);
      client.off("messageCreate", handleMessage);
      client.off("interactionCreate", handleInteraction);
      client.off("clientReady", handleReady);
      client.off("shardResume", handleReady);
      client.off("raw", handleRaw);
      await recovering;
      await service.close();
      await Promise.allSettled(interactions);
    },
  };
}
