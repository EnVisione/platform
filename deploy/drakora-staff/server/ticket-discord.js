import { randomUUID } from "node:crypto";
import {
  ChannelType,
  PermissionFlagsBits as P,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  AttachmentBuilder,
} from "discord.js";
import { AuthError } from "./discord.js";
import { ticketTypes, ticketPath, ticketStatuses } from "../shared/tickets.js";
import { ticketTranscript } from "./ticket-transcript.js";

const actor = (user, member) => ({
  id: user.id,
  name: member?.displayName || user.globalName || user.username,
  avatar: user.displayAvatarURL({ size: 128 }),
});
const absent = (error) => [10003, 10008, 10007].includes(error.code);
const marker = (id) => `Drakora ticket ${id}`;
const messageMarker = (id) => `Drakora · ${id}`;

export function ticketDiscord(config, service, client, rolePolicy) {
  let stopped = false,
    setup,
    timer,
    recovering,
    refreshing;
  const settings = config.tickets;
  const save = (key, value) =>
    service.store.set("ticket-discord", key, value, Number.MAX_SAFE_INTEGER);
  const state = () => service.store.get("ticket-discord", "channels") || {};
  async function guild() {
    return client.guilds.fetch(settings.guildId);
  }
  async function staffUser(id) {
    const staffGuild = await client.guilds.fetch(config.guildId);
    try {
      const member = await staffGuild.members.fetch({ user: id, force: true });
      if (member.pending || member.user.bot) return null;
      return rolePolicy.apply({
        ...actor(member.user, member),
        roles: [...member.roles.cache.keys()],
      });
    } catch (error) {
      if (error.code === 10007) return null;
      throw error;
    }
  }
  async function staffMembers() {
    const staffGuild = await client.guilds.fetch(config.guildId);
    const members = await staffGuild.members.fetch();
    return [...members.values()]
      .filter((member) => !member.pending && !member.user.bot)
      .map((member) =>
        rolePolicy.apply({
          id: member.id || member.user.id,
          roles: [...member.roles.cache.keys()],
        }),
      );
  }
  function overwrites(members, owner, restricted = false) {
    const staff = members
      .filter(
        (user) =>
          user.id !== owner &&
          user.id !== client.user.id &&
          user.capabilities["tickets.view"] &&
          (!restricted || rolePolicy.isManager(user)),
      )
      .map((user) => ({
        id: user.id,
        type: 1,
        allow: [
          P.ViewChannel,
          P.SendMessages,
          P.ReadMessageHistory,
          P.AttachFiles,
          P.EmbedLinks,
        ],
      }));
    return [
      { id: settings.guildId, type: 0, deny: [P.ViewChannel] },
      ...staff,
      {
        id: client.user.id,
        type: 1,
        allow: [
          P.ViewChannel,
          P.SendMessages,
          P.ReadMessageHistory,
          P.AttachFiles,
          P.EmbedLinks,
          P.ManageChannels,
          P.ManageWebhooks,
          P.ManageMessages,
        ],
      },
      ...(owner
        ? [
            {
              id: owner,
              type: 1,
              allow: [
                P.ViewChannel,
                P.SendMessages,
                P.ReadMessageHistory,
                P.AttachFiles,
                P.EmbedLinks,
              ],
            },
          ]
        : []),
    ];
  }
  function ticketOverwrites(ticket, members) {
    const permissions = overwrites(
      members,
      ticket.owner.id,
      ticket.type === "staff",
    );
    if (["closed", "awaiting_resolution"].includes(ticket.status))
      for (const permission of permissions)
        if (permission.id !== client.user.id) {
          permission.allow = (permission.allow || []).filter(
            (bit) => bit !== P.SendMessages && bit !== P.AttachFiles,
          );
          permission.deny = [
            ...(permission.deny || []),
            P.SendMessages,
            P.AttachFiles,
          ];
        }
    return permissions;
  }
  async function initialize() {
    if (!client.isReady()) throw new AuthError("ticket_sync_unavailable", 503);
    const main = await guild(),
      channels = await main.channels.fetch(),
      members = await staffMembers();
    const archived = channels.get(settings.archiveCategoryId);
    if (!archived || archived.type !== ChannelType.GuildCategory)
      throw new Error("Ticket archive category is unavailable");
    const saved = state();
    let category =
      channels.get(saved.categoryId) ||
      [...channels.values()].find(
        (channel) =>
          channel?.type === ChannelType.GuildCategory &&
          channel.name === "Drakora Support",
      );
    if (!category)
      category = await main.channels.create({
        name: "Drakora Support",
        type: ChannelType.GuildCategory,
        permissionOverwrites: overwrites(members),
      });
    let media =
      channels.get(saved.mediaId) ||
      [...channels.values()].find(
        (channel) =>
          channel?.parentId === archived.id &&
          channel.topic ===
            "Drakora ticket attachments. Removed after 30 days.",
      );
    if (!media)
      media = await main.channels.create({
        name: "ticket-attachments",
        type: ChannelType.GuildText,
        parent: archived.id,
        topic: "Drakora ticket attachments. Removed after 30 days.",
        permissionOverwrites: overwrites(members, null, true),
      });
    saved.categoryId = category.id;
    saved.mediaId = media.id;
    save("channels", saved);
    save("permissions-pending", { generation: randomUUID() });
    const commands = await main.commands.fetch();
    const command = {
      name: "ticket",
      description: "Open a private Drakora support ticket",
      options: [],
    };
    const existing = commands.find((command) => command.name === "ticket");
    if (existing) await main.commands.edit(existing.id, command);
    else await main.commands.create(command);
    service.attach(transport);
  }
  async function ready() {
    if (!setup)
      setup = initialize().catch((error) => {
        setup = null;
        throw error;
      });
    return setup;
  }
  async function channel(id) {
    const value = await (await guild()).channels.fetch(id);
    if (!value?.isTextBased()) throw new Error("Ticket channel is unavailable");
    return value;
  }
  function controls(ticket) {
    if (["closed", "awaiting_resolution"].includes(ticket.status))
      return [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "Rate the help",
              custom_id: `ticket:rate:${ticket.id}`,
            },
            {
              type: 2,
              style: 2,
              label: "Get transcript",
              custom_id: `ticket:transcript:${ticket.id}`,
            },
            {
              type: 2,
              style: 5,
              label: "View ticket",
              url: `${config.applications.publicOrigin}${ticketPath(ticket)}`,
            },
          ],
        },
      ];
    return [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: "Claim ticket",
            custom_id: `ticket:claim:${ticket.id}`,
            disabled: Boolean(ticket.claimedBy),
          },
          {
            type: 2,
            style: 2,
            label: "Close ticket",
            custom_id: `ticket:close:${ticket.id}`,
          },
          {
            type: 2,
            style: 5,
            label: "View ticket",
            url: `${config.applications.publicOrigin}${ticketPath(ticket)}`,
          },
        ],
      },
    ];
  }
  function overview(ticket) {
    return {
      title: `${ticketTypes.find((type) => type.id === ticket.type)?.name} · ${ticket.ign}`,
      description: ticket.description,
      color: 0xb92323,
      fields: [
        {
          name: "Player",
          value: `${ticket.ign} · <@${ticket.owner.id}>`,
          inline: true,
        },
        {
          name: "Affected server or service",
          value: ticket.location,
          inline: true,
        },
        { name: "Status", value: ticketStatuses[ticket.status], inline: true },
        {
          name: "Helping you",
          value: ticket.claimedBy?.name || "Waiting for a staff member",
          inline: true,
        },
      ],
      footer: {
        text: "Messages sync with your private web ticket. Attachments are available for 30 days.",
      },
    };
  }
  const transport = {
    async removeClosed(ticket) {
      try {
        await (
          await channel(ticket.channelId)
        ).delete("Closed ticket retained in staff logs");
      } catch (error) {
        if (!absent(error)) throw error;
      }
    },
    async assertMember(id) {
      await (await guild()).members.fetch(id);
    },
    async create(ticket) {
      await ready();
      const main = await guild(),
        members = await staffMembers();
      await main.members.fetch(ticket.owner.id);
      const channels = await main.channels.fetch();
      let target = ticket.channelId
        ? channels.get(ticket.channelId)
        : [...channels.values()].find(
            (value) => value?.topic === marker(ticket.id),
          );
      if (!target)
        target = await main.channels.create({
          name: `${ticket.type}-${ticket.ign.toLowerCase()}-${ticket.id.slice(0, 6)}`,
          type: ChannelType.GuildText,
          parent: state().categoryId,
          topic: marker(ticket.id),
          permissionOverwrites: overwrites(
            members,
            ticket.owner.id,
            ticket.type === "staff",
          ),
        });
      service.bind(ticket.id, target.id);
      const saved = service.store.get("ticket-discord", ticket.id) || {};
      const recent = await target.messages.fetch({ limit: 100 });
      let intro = saved.introId
        ? recent.get(saved.introId)
        : recent.find(
            (message) =>
              message.author.id === client.user.id &&
              message.embeds[0]?.title === overview(ticket).title,
          );
      if (!intro)
        intro = await target.send({
          content: `<@${ticket.owner.id}> Your private ticket is ready. Staff will claim it shortly.`,
          embeds: [overview(ticket)],
          components: controls(ticket),
          allowedMentions: { parse: [] },
        });
      const hooks = await target.fetchWebhooks();
      let webhook = saved.webhookId
        ? hooks.get(saved.webhookId)
        : hooks.find(
            (hook) =>
              hook.owner?.id === client.user.id &&
              hook.name === "Drakora Support",
          );
      if (!webhook)
        webhook = await target.createWebhook({ name: "Drakora Support" });
      save(ticket.id, { ...saved, introId: intro.id, webhookId: webhook.id });
    },
    async status(ticket) {
      await ready();
      const members = await staffMembers();
      const target = await channel(ticket.channelId),
        saved = service.store.get("ticket-discord", ticket.id);
      const intro = await target.messages.fetch(saved.introId);
      await intro.edit({
        embeds: [overview(ticket)],
        components: controls(ticket),
        allowedMentions: { parse: [] },
      });
      await target.permissionOverwrites.set(ticketOverwrites(ticket, members));
      // closed channels no longer consume the support category channel limit.
      if (
        ticket.status === "closed" &&
        target.parentId !== settings.archiveCategoryId
      )
        await target.setParent(settings.archiveCategoryId, {
          lockPermissions: false,
        });
    },
    async message(ticket, message, attachments) {
      await ready();
      const target = await channel(ticket.channelId),
        saved = service.store.get("ticket-discord", ticket.id);
      const hook = (await target.fetchWebhooks()).get(saved.webhookId);
      if (!hook) {
        await transport.create(ticket);
        throw new Error("Ticket webhook was restored");
      }
      // webhooks lack an idempotency key. recover an acknowledged send by its stable reference before retrying.
      const recent = await target.messages.fetch({ limit: 100 });
      const existing = recent.find(
        (value) =>
          value.webhookId === hook.id &&
          value.embeds.some(
            (embed) => embed.footer?.text === messageMarker(message.id),
          ),
      );
      if (existing) return existing;
      const files = [];
      for (const file of attachments)
        if (!file.purged && file.expiresAt > Date.now())
          files.push({
            attachment: await transport.bytes(file),
            name: file.name,
          });
      const sent = await hook.send({
        content: message.content || undefined,
        username: message.actor.name.slice(0, 80),
        avatarURL: message.actor.avatar || undefined,
        embeds: [{ footer: { text: messageMarker(message.id) } }],
        files,
        allowedMentions: { parse: [] },
      });
      for (const file of attachments) {
        file.mirrorChannelId = target.id;
        file.mirrorMessageId = sent.id;
        service.store.set(
          "ticket-media",
          file.id,
          file,
          Number.MAX_SAFE_INTEGER,
        );
      }
      return sent;
    },
    async upload(bytes, name, type) {
      await ready();
      const target = await channel(state().mediaId);
      const sent = await target.send({
        files: [{ attachment: bytes, name }],
        allowedMentions: { parse: [] },
      });
      const attachment = sent.attachments.first();
      return {
        channelId: target.id,
        messageId: sent.id,
        attachmentId: attachment.id,
        name,
        type,
        size: bytes.length,
      };
    },
    async bytes(file) {
      if (file.expiresAt <= Date.now() || file.purged || file.removed)
        throw new AuthError("attachment_expired", 410);
      const source = await (
        await channel(file.channelId)
      ).messages.fetch(file.messageId);
      const attachment = source.attachments.get(file.attachmentId);
      if (!attachment) throw new AuthError("attachment_expired", 410);
      const url = new URL(attachment.url);
      if (
        !["cdn.discordapp.com", "media.discordapp.net"].includes(
          url.hostname,
        ) ||
        url.protocol !== "https:" ||
        !url.pathname.startsWith(
          `/attachments/${file.channelId}/${file.attachmentId}/`,
        )
      )
        throw new Error("Invalid ticket attachment source");
      if (attachment.size > 20 * 1024 * 1024)
        throw new AuthError("attachment_too_large", 413);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok) throw new AuthError("attachment_unavailable", 503);
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 20 * 1024 * 1024) {
          await response.body.cancel().catch(() => {});
          throw new AuthError("attachment_too_large", 413);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    async removeMedia(file) {
      for (const [channelId, messageId] of [
        [file.channelId, file.messageId],
        [file.mirrorChannelId, file.mirrorMessageId],
      ]) {
        if (!channelId || !messageId) continue;
        try {
          await (await channel(channelId)).messages.delete(messageId);
        } catch (error) {
          if (!absent(error)) throw error;
        }
      }
    },
  };
  async function observe(message, edited = false) {
    const ticket = service.linked(message.channelId);
    if (
      !ticket ||
      message.author?.bot ||
      message.webhookId ||
      message.guildId !== settings.guildId
    )
      return;
    const prior = service.store.get("ticket-discord-message", message.id);
    if (!edited && prior) return;
    const user = actor(message.author, message.member);
    const isOwner = user.id === ticket.owner.id;
    const staff = isOwner || prior ? null : await staffUser(user.id);
    if (!isOwner && !prior)
      service.staff(staff || { roles: [] }, ticket, "tickets.reply");
    service.ingest(ticket.id, {
      id: message.id,
      actor: user,
      staff: !isOwner,
      at: message.createdTimestamp,
      editedAt: message.editedTimestamp,
      content: message.content,
      attachments: [...message.attachments.values()].map((file) => ({
        channelId: message.channelId,
        messageId: message.id,
        attachmentId: file.id,
        name: file.name.slice(0, 120),
        type: file.contentType || "application/octet-stream",
        size: file.size,
      })),
    });
  }
  function refreshPermissions() {
    if (stopped || refreshing) return refreshing;
    if (!service.store.get("ticket-discord", "permissions-pending")) return;
    refreshing = Promise.resolve()
      .then(async () => {
        await ready();
        const pending = service.store.get(
            "ticket-discord",
            "permissions-pending",
          ),
          saved = state(),
          members = await staffMembers();
        const targets = [
          { id: saved.categoryId, permissions: overwrites(members) },
          { id: saved.mediaId, permissions: overwrites(members, null, true) },
          ...service
            .all()
            .filter((ticket) => ticket.channelId)
            .map((ticket) => ({
              id: ticket.channelId,
              permissions: ticketOverwrites(ticket, members),
            })),
        ];
        const main = await guild();
        let failed = false;
        for (const target of targets) {
          try {
            await (
              await main.channels.fetch(target.id)
            ).permissionOverwrites.set(target.permissions);
          } catch {
            failed = true;
          }
        }
        if (failed) throw new Error("Ticket permission refresh is incomplete");
        if (
          service.store.get("ticket-discord", "permissions-pending")
            ?.generation === pending?.generation
        )
          service.store.delete("ticket-discord", "permissions-pending");
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  async function recover() {
    if (stopped || !client.isReady()) return;
    if (recovering) return recovering;
    recovering = (async () => {
      await ready();
      try {
        await refreshPermissions();
      } catch {
        console.error("Ticket permission refresh is pending.");
      }
      for (const ticket of service
        .all()
        .filter((ticket) => ticket.channelId)
        .sort(
          (a, b) =>
            Number(a.status === "closed") - Number(b.status === "closed"),
        )) {
        try {
          const target = await channel(ticket.channelId);
          if (
            !target
              .permissionsFor(client.user)
              ?.has([P.ViewChannel, P.ReadMessageHistory])
          )
            throw new Error("Ticket message history is unavailable");
          let after =
            service.store.get("ticket-discord-cursor", ticket.id)?.after ||
            target.id;
          for (let page = 0; page < 20; page++) {
            const batch = await target.messages.fetch({
              limit: 100,
              ...(after ? { after } : {}),
            });
            const sorted = [...batch.values()].sort(
              (a, b) => a.createdTimestamp - b.createdTimestamp,
            );
            for (const message of sorted) await observe(message, true);
            if (sorted.length) {
              after = sorted.at(-1).id;
              service.store.set(
                "ticket-discord-cursor",
                ticket.id,
                { after },
                Number.MAX_SAFE_INTEGER,
              );
            }
            if (batch.size < 100) break;
          }
          const sweep = service.store.get("ticket-discord-sweep", ticket.id);
          const latest = await reconcile(ticket, target);
          const before = sweep?.before
            ? await reconcile(ticket, target, sweep.before)
            : latest;
          service.store.set(
            "ticket-discord-sweep",
            ticket.id,
            { before },
            Number.MAX_SAFE_INTEGER,
          );
        } catch {
          console.error("Ticket channel recovery is pending.");
        }
      }
    })()
      .catch(() => console.error("Ticket Discord recovery is pending."))
      .finally(() => {
        recovering = null;
      });
    return recovering;
  }
  async function reconcile(ticket, target, before) {
    // snapshot before fetching. newer gateway messages are outside this deletion check.
    const known = service
      .messages(ticket.id)
      .filter((message) => message.origin === "discord" && !message.deleted);
    const batch = await target.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    const sorted = [...batch.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp,
    );
    for (const message of sorted)
      if (service.store.get("ticket-discord-message", message.id))
        await observe(message, true);
    const oldest = sorted[0]?.id;
    for (const message of known) {
      if (batch.size === 100 && BigInt(message.discordId) < BigInt(oldest))
        continue;
      if (before && BigInt(message.discordId) >= BigInt(before)) continue;
      if (!batch.has(message.discordId))
        service.ingest(ticket.id, { id: message.discordId, deleted: true });
    }
    return batch.size === 100 ? oldest : null;
  }
  function intake(interaction) {
    const select = new StringSelectMenuBuilder()
      .setCustomId("ticket:type")
      .setPlaceholder("What do you need help with?")
      .addOptions(
        ticketTypes.map((type) => ({ label: type.name, value: type.id })),
      );
    return interaction.reply({
      content: "Choose the kind of help you need. Your ticket stays private.",
      components: [new ActionRowBuilder().addComponents(select)],
      flags: 64,
    });
  }
  function input(id, label, style, min, max, value) {
    const field = new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(style)
      .setRequired(true)
      .setMinLength(min)
      .setMaxLength(max);
    if (value) field.setValue(value);
    return new ActionRowBuilder().addComponents(field);
  }
  async function interact(interaction) {
    if (
      interaction.guildId !== settings.guildId &&
      !interaction.customId?.startsWith("ticket:")
    )
      return;
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "ticket"
    )
      return intake(interaction);
    if (!interaction.customId?.startsWith("ticket:")) return;
    const [, action, id] = interaction.customId.split(":");
    try {
      if (action === "type") {
        const type = interaction.values[0];
        if (!ticketTypes.some((item) => item.id === type))
          throw new AuthError("invalid_ticket", 400);
        return await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`ticket:intake:${type}`)
            .setTitle("Tell us what happened")
            .addComponents(
              input(
                "ign",
                "Minecraft Java username",
                TextInputStyle.Short,
                3,
                16,
              ),
              input(
                "location",
                "Server, world or Discord area affected",
                TextInputStyle.Short,
                2,
                100,
              ),
              input(
                "description",
                "Describe the issue and steps to reproduce",
                TextInputStyle.Paragraph,
                30,
                4000,
              ),
            ),
        );
      }
      if (action === "intake") {
        await interaction.deferReply({ flags: 64 });
        const ticket = service.create(
          actor(interaction.user, interaction.member),
          {
            type: id,
            ign: interaction.fields.getTextInputValue("ign"),
            location: interaction.fields.getTextInputValue("location"),
            description: interaction.fields.getTextInputValue("description"),
            requestId: randomUUID(),
          },
          "discord",
        );
        await service.pump();
        return await interaction.editReply(
          `Your ticket is ready: ${config.applications.publicOrigin}${ticketPath(ticket)}${service.get(ticket.id).channelId ? `\n<#${service.get(ticket.id).channelId}>` : "\nDiscord channel delivery is pending. Your ticket has been saved."}`,
        );
      }
      const ticket = service.get(id),
        owner = interaction.user.id === ticket.owner.id;
      const staffIdentity = await staffUser(interaction.user.id);
      const user = staffIdentity || actor(interaction.user, interaction.member);
      if (!owner) service.staff(user || { roles: [] }, ticket);
      if (
        action === "close" &&
        (!owner ||
          (staffIdentity?.capabilities["tickets.close"] &&
            (ticket.type !== "staff" || rolePolicy.isManager(staffIdentity))))
      ) {
        service.staff(user, ticket, "tickets.close");
        return await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`ticket:resolve:${id}`)
            .setTitle("Record the ticket resolution")
            .addComponents(
              input(
                "summary",
                "What did you do to resolve the issue?",
                TextInputStyle.Paragraph,
                20,
                4000,
              ),
              input(
                "commands",
                "Commands run (enter None if none)",
                TextInputStyle.Paragraph,
                4,
                2000,
              ),
            ),
        );
      }
      if (action === "rate") {
        service.authorize(user, ticket);
        return await interaction.reply({
          content: "Optional: how helpful was the support?",
          components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`ticket:rating:${id}`)
                .setPlaceholder("Choose 1–5 stars")
                .addOptions(
                  [1, 2, 3, 4, 5].map((value) => ({
                    label: `${value} ${value === 1 ? "star" : "stars"}`,
                    value: String(value),
                  })),
                ),
            ),
          ],
          flags: 64,
        });
      }
      await interaction.deferReply({ flags: 64 });
      if (action === "claim") service.claim(user, id);
      else if (action === "close") service.closeTicket(user, id, {}, false);
      else if (action === "resolve")
        service.closeTicket(
          user,
          id,
          {
            summary: interaction.fields.getTextInputValue("summary"),
            commands: interaction.fields.getTextInputValue("commands"),
          },
          true,
        );
      else if (action === "rating")
        service.rate(user, id, Number(interaction.values[0]));
      else if (action === "transcript") {
        service.authorize(user, ticket, !owner);
        if (!owner)
          return await interaction.editReply(
            `Download the staff or player transcript from the private staff panel: ${config.staffOrigin}/tickets/${id}`,
          );
        const html = await ticketTranscript(
          service,
          user,
          id,
          false,
          transport.bytes,
        );
        try {
          await interaction.user.send({
            content:
              "Your Drakora ticket transcript. Save this HTML file and open it in a browser.",
            files: [
              new AttachmentBuilder(Buffer.from(html), {
                name: `drakora-ticket-${id.slice(0, 8)}.html`,
              }),
            ],
          });
          return await interaction.editReply(
            "Your transcript was sent in a direct message.",
          );
        } catch {
          return await interaction.editReply(
            `Your DMs are closed. Download the transcript from your private ticket: ${config.applications.publicOrigin}${ticketPath(ticket)}`,
          );
        }
      } else throw new AuthError("invalid_ticket_action", 400);
      return await interaction.editReply(
        action === "close"
          ? "Ticket closed. Staff will add the resolution record. Rating and transcript buttons are available on the ticket overview."
          : "Ticket updated.",
      );
    } catch (error) {
      const message =
        {
          ticket_already_claimed:
            "Another staff member already claimed this ticket.",
          ticket_access_denied: "You do not have permission to do that.",
          ticket_limit:
            "You already have three open tickets. Continue in an existing ticket.",
          invalid_ticket:
            "Check your Minecraft username and provide detailed information.",
          ticket_already_rated: "You have already rated this ticket.",
        }[error.code] ||
        "This action could not be completed. Your existing ticket is safe; please try again.";
      if (interaction.deferred || interaction.replied)
        await interaction.editReply(message);
      else await interaction.reply({ content: message, flags: 64 });
    }
  }
  const handleMessage = (message) =>
    void observe(message).catch(() =>
      console.error("Ticket message ingestion is pending."),
    );
  const handleRaw = (event) => {
    if (
      event.d?.guild_id === config.guildId &&
      [
        "GUILD_MEMBER_ADD",
        "GUILD_MEMBER_UPDATE",
        "GUILD_MEMBER_REMOVE",
      ].includes(event.t)
    ) {
      save("permissions-pending", { generation: randomUUID() });
      void refreshPermissions().catch(() =>
        console.error("Ticket permission refresh is pending."),
      );
      return;
    }
    if (
      !["MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK"].includes(
        event.t,
      )
    )
      return;
    const ticket = service.linked(event.d.channel_id);
    if (!ticket) return;
    if (event.t === "MESSAGE_DELETE" || event.t === "MESSAGE_DELETE_BULK")
      for (const id of event.d.ids || [event.d.id])
        service.ingest(ticket.id, { id, deleted: true });
    else
      void channel(event.d.channel_id)
        .then((target) => target.messages.fetch(event.d.id))
        .then((message) => observe(message, true))
        .catch(() => console.error("Ticket edit recovery is pending."));
  };
  const handleInteraction = (interaction) =>
    void interact(interaction).catch(() =>
      console.error("Ticket interaction failed."),
    );
  const handleReady = () => {
    setup = null;
    void recover();
  };
  client.on("messageCreate", handleMessage);
  client.on("raw", handleRaw);
  client.on("interactionCreate", handleInteraction);
  client.on("clientReady", handleReady);
  client.on("shardResume", handleReady);
  timer = setInterval(() => void recover(), 30000);
  timer.unref();
  if (client.isReady()) void recover();
  return {
    ...transport,
    staffUser,
    recover,
    async refreshPermissions() {
      save("permissions-pending", { generation: randomUUID() });
      return refreshPermissions();
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      client.off("messageCreate", handleMessage);
      client.off("raw", handleRaw);
      client.off("interactionCreate", handleInteraction);
      client.off("clientReady", handleReady);
      client.off("shardResume", handleReady);
      await Promise.allSettled([recovering, refreshing]);
    },
  };
}
