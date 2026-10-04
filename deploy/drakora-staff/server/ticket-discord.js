import { createHash, randomUUID } from "node:crypto";
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
import { discordMembers } from "./discord-members.js";
import {
  ticketTypes,
  ticketIntake,
  ticketDetails,
  ticketPath,
  ticketStatusLabel,
  ticketCategory,
} from "../shared/tickets.js";
import { ticketTranscript } from "./ticket-transcript.js";
import { ticketNotesDiscord } from "./ticket-notes-discord.js";

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
  const webhooks = new Map();
  const intakeReplies = new Map();
  const intakeReplyTasks = new Set();
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
    const members = await discordMembers(client, staffGuild);
    return [...members.values()]
      .filter((member) => !member.pending && !member.user.bot)
      .map((member) =>
        rolePolicy.apply({
          id: member.id || member.user.id,
          roles: [...member.roles.cache.keys()],
        }),
      );
  }
  function overwrites(members, owner, category = "support") {
    const categories = Array.isArray(category) ? category : [category];
    const canReply = (user) =>
      user.capabilities["tickets.reply"] &&
      categories.every(
        (entry) => user.capabilities[`tickets.category.${entry}.reply`],
      );
    const ownerNotesReply = members.some(
      (user) =>
        user.id === owner &&
        user.capabilities["tickets.view"] &&
        categories.every(
          (entry) => user.capabilities[`tickets.category.${entry}.view`],
        ) &&
        canReply(user),
    );
    const staff = members
      .filter(
        (user) =>
          user.id !== owner &&
          user.id !== client.user.id &&
          user.capabilities["tickets.view"] &&
          categories.every(
            (entry) => user.capabilities[`tickets.category.${entry}.view`],
          ),
      )
      .map((user) => ({
        id: user.id,
        type: 1,
        allow: [
          P.ViewChannel,
          P.ReadMessageHistory,
          ...(canReply(user)
            ? [
                P.SendMessages,
                P.SendMessagesInThreads,
                P.AttachFiles,
                P.EmbedLinks,
              ]
            : []),
        ],
        deny: [
          P.ManageThreads,
          P.CreatePublicThreads,
          P.CreatePrivateThreads,
          ...(canReply(user)
            ? []
            : [P.SendMessages, P.SendMessagesInThreads, P.AttachFiles]),
        ],
      }));
    if (staff.length > (owner ? 97 : 98))
      throw new Error("Ticket access capacity exceeded");
    return [
      {
        id: settings.guildId,
        type: 0,
        deny: [
          P.ViewChannel,
          P.ManageThreads,
          P.CreatePublicThreads,
          P.CreatePrivateThreads,
          P.SendMessagesInThreads,
        ],
      },
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
          P.CreatePrivateThreads,
          P.SendMessagesInThreads,
          P.ManageThreads,
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
                ...(ownerNotesReply ? [P.SendMessagesInThreads] : []),
              ],
              deny: [
                P.ManageThreads,
                P.CreatePublicThreads,
                P.CreatePrivateThreads,
                ...(!ownerNotesReply ? [P.SendMessagesInThreads] : []),
              ],
            },
          ]
        : []),
    ];
  }
  function ticketOverwrites(ticket, members) {
    const permissions = overwrites(
      members,
      ticket.owner.guest ? null : ticket.owner.id,
      ticketCategory(ticket),
    );
    if (["closed", "awaiting_resolution"].includes(ticket.status))
      for (const permission of permissions)
        if (permission.id !== client.user.id) {
          const notesReply = permission.allow?.includes(
            P.SendMessagesInThreads,
          );
          permission.allow = (permission.allow || []).filter(
            (bit) =>
              bit !== P.SendMessages && (notesReply || bit !== P.AttachFiles),
          );
          permission.deny = [
            ...(permission.deny || []),
            P.SendMessages,
            ...(notesReply ? [] : [P.AttachFiles]),
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
        permissionOverwrites: overwrites(members, null, "billing"),
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
    service.queueClosedUpdates();
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
  async function ticketChannel(ticket) {
    try {
      return await channel(ticket.channelId);
    } catch (error) {
      if (error.code !== 10003) throw error;
      webhooks.delete(ticket.channelId);
      service.missingChannel(ticket.id, ticket.channelId);
      return null;
    }
  }
  function controls(ticket, staffControls = false) {
    if (
      staffControls &&
      ["closed", "awaiting_resolution"].includes(ticket.status)
    )
      return [
        ratingRow(ticket),
        {
          type: 1,
          components: [
            ...(ticket.status === "awaiting_resolution"
              ? [
                  {
                    type: 2,
                    style: 1,
                    label: "Resolve ticket",
                    custom_id: feedbackId("close", ticket),
                  },
                ]
              : []),
            {
              type: 2,
              style: 2,
              label: "Reopen ticket",
              custom_id: feedbackId("reopen", ticket),
            },
            {
              type: 2,
              style: 4,
              label: "Delete channel · Admin+",
              custom_id: feedbackId("delete", ticket),
            },
            {
              type: 2,
              style: 5,
              label: "Staff dashboard",
              url: `${config.staffOrigin}/tickets/${ticket.id}`,
            },
            {
              type: 2,
              style: 2,
              label: "Internal staff notes",
              custom_id: `ticket:notes:${ticket.id}`,
            },
          ],
        },
      ];
    if (["closed", "awaiting_resolution"].includes(ticket.status))
      return [
        ratingRow(ticket),
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 2,
              label: "Get transcript",
              custom_id: `ticket:transcript:${ticket.id}`,
            },
            {
              type: 2,
              style: 2,
              label: "Reopen ticket",
              custom_id: feedbackId("reopen", ticket),
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
          ...(ticket.claimedBy
            ? [
                {
                  type: 2,
                  style: 2,
                  label: "Take over / request",
                  custom_id: `ticket:takeover:${ticket.id}:${ticket.claimedBy.id}`,
                },
              ]
            : []),
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
          {
            type: 2,
            style: 2,
            label: "Internal staff notes",
            custom_id: `ticket:notes:${ticket.id}`,
          },
        ],
      },
    ];
  }
  function feedbackId(action, ticket) {
    return `ticket:${action}:${ticket.id}${ticket.closureId ? `:${ticket.closureId}` : ""}`;
  }
  function ratingRow(ticket) {
    return {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: feedbackId("rating", ticket),
          placeholder:
            ticket.rating === null
              ? "Rate the support · 1–5 stars"
              : "Rating saved",
          disabled: ticket.rating !== null,
          options: [1, 2, 3, 4, 5].map((value) => ({
            label: `${value} ${value === 1 ? "star" : "stars"}`,
            value: String(value),
          })),
        },
      ],
    };
  }
  function feedbackQuestion(ticket) {
    const name =
      ticket.ratingStaff?.name ||
      ticket.claimedBy?.name ||
      ticket.helpedBy?.name;
    return `${name ? `How did ${name.replace(/[\\*_~`|]/g, "")} do?` : "How helpful was the support?"} Rate the help from 1 to 5. Your rating is visible only to you and authorized staff.`;
  }
  function overview(ticket) {
    return {
      title: `${ticketTypes.find((type) => type.id === ticket.type)?.name} · ${ticket.ign}`,
      description: ticket.description,
      color: 0xb92323,
      fields: [
        { name: "Ticket update", value: openingText(ticket) },
        {
          name: "Player",
          value: ticket.owner.guest
            ? `${ticket.ign} · Website guest`
            : `${ticket.ign} · <@${ticket.owner.id}>`,
          inline: true,
        },
        {
          name: "Affected server or service",
          value: ticket.location,
          inline: true,
        },
        ...ticketDetails(ticket).map((detail) => ({
          name: detail.label,
          value: detail.value,
        })),
        { name: "Status", value: ticketStatusLabel(ticket), inline: true },
        {
          name: "Helping you",
          value:
            ticket.claimedBy?.name ||
            ticket.helpedBy?.name ||
            "Waiting for a staff member",
          inline: true,
        },
      ],
      footer: {
        text: "Messages sync with your private web ticket. Attachments are available for 30 days.",
      },
    };
  }
  function openingText(ticket) {
    const owner = ticket.owner.guest ? ticket.ign : `<@${ticket.owner.id}>`;
    if (ticket.status === "awaiting_resolution")
      return `${owner} This ticket was closed by the player. Staff resolution is pending.`;
    if (ticket.status === "closed")
      return `${owner} This ticket is resolved and closed. Its saved history remains in the staff dashboard.`;
    if (ticket.status === "claimed")
      return `${owner} ${ticketStatusLabel(ticket)}. Continue in this private ticket.`;
    return `${owner} Your private ticket is ready. Staff will claim it shortly.`;
  }
  async function staffUpdate(ticket, notice, target) {
    if (!notice || ticket.status !== "claimed") return;
    if (
      notice.event === "replied"
        ? ticket.claimedBy || ticket.helpedBy?.id !== notice.actor.id
        : ticket.claimedBy?.id !== notice.actor.id
    )
      return;
    const owner = ticket.owner.guest ? ticket.ign : `<@${ticket.owner.id}>`;
    const staff = `<@${notice.actor.id}>`;
    const content =
      notice.event === "replied"
        ? `${owner} ${staff} replied to your ticket. You can continue here or on the website.`
        : notice.event === "taken_over"
          ? `${owner} ${staff} took over your ticket and is now helping you.`
          : `${owner} ${staff} claimed your ticket and is now helping you.`;
    return await sendUpdate(
      ticket,
      notice,
      target,
      content,
      [],
      [notice.actor.id, ...(!ticket.owner.guest ? [ticket.owner.id] : [])],
    );
  }
  async function sendUpdate(
    ticket,
    notice,
    target,
    content,
    components,
    mentions,
  ) {
    const key = notice.id || `${ticket.id}:${notice.revision}`;
    const kind = "ticket-status-notice";
    let intent = service.store.get(kind, key);
    const persist = () =>
      service.store.set(kind, key, intent, Number.MAX_SAFE_INTEGER);
    const legacyFooter = notice.id
      ? `Ticket ${ticket.id} · Activity ${notice.id}`
      : `Ticket ${ticket.id} · Staff update ${notice.revision}`;
    const url = `${config.staffOrigin}/tickets/${ticket.id}#update=${encodeURIComponent(key)}`;
    const embed = {
      title: `${ticketTypes.find((type) => type.id === ticket.type)?.name} · ${ticket.ign}`,
      url,
      description: content,
      fields: [{ name: "Status", value: ticketStatusLabel(ticket) }],
      color: 0xb92323,
      footer: { text: `Drakora support · ${ticket.id.slice(0, 8)}` },
    };
    const acknowledge = async (message) => {
      intent.messageId = message.id;
      persist();
      await message.edit({
        content: "",
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
      intent.layoutVersion = 2;
      persist();
    };
    if (intent?.messageId) {
      if (intent.layoutVersion === 2) return;
      return acknowledge(await target.messages.fetch(intent.messageId));
    }
    if (intent) {
      for (let page = 0; page < 5; page++) {
        const recent = await target.messages.fetch({
          limit: 100,
          ...(intent.before ? { before: intent.before } : {}),
        });
        const sent = recent.find(
          (message) =>
            message.author.id === client.user.id &&
            message.embeds?.some(
              (value) =>
                value.url === url || value.footer?.text === legacyFooter,
            ),
        );
        if (sent) return await acknowledge(sent);
        const oldest = [...recent.keys()].sort((a, b) =>
          BigInt(a) < BigInt(b) ? -1 : 1,
        )[0];
        if (recent.size < 100 || BigInt(oldest) <= BigInt(intent.after)) {
          delete intent.before;
          persist();
          break;
        }
        intent.before = oldest;
        persist();
        if (page === 4) return { pending: true };
      }
    } else {
      const latest = await target.messages.fetch({ limit: 1 });
      intent = {
        ticketId: ticket.id,
        channelId: target.id,
        after: latest.first()?.id || "0",
      };
      persist();
    }
    await acknowledge(
      await target.send({
        content: [...new Set(mentions)].map((id) => `<@${id}>`).join(" "),
        embeds: [embed],
        components,
        allowedMentions: { parse: [], users: [...new Set(mentions)] },
        nonce: createHash("sha256")
          .update(`staff-update:${key}`)
          .digest("hex")
          .slice(0, 25),
        enforceNonce: true,
      }),
    );
  }

  async function activityUpdate(ticket, notice) {
    if (
      !notice ||
      notice.cycle !== (ticket.reopenedCount || 0) ||
      notice.closureId !== (ticket.closureId || null)
    )
      return;
    if (!ticket.channelId) {
      const kind = "ticket-status-notice";
      if (service.store.get(kind, notice.id)?.messageId) return;
      const result = await transport.notice(
        ticket,
        {
          event: notice.event,
          activityId: notice.id,
          channelId: settings.staffChannelId,
          cycle: notice.cycle,
        },
        `${notice.id}:staff`,
      );
      if (result.id)
        service.store.set(
          kind,
          notice.id,
          {
            ticketId: ticket.id,
            channelId: result.channelId,
            messageId: result.id,
          },
          Number.MAX_SAFE_INTEGER,
        );
      return result;
    }
    const closed = ["closed", "awaiting_resolution"].includes(ticket.status);
    if (closed && !service.store.get("ticket-discord-close", ticket.id)?.ready)
      return { pending: true };
    const target = await channel(ticket.channelId);
    const content = {
      closed:
        "The player closed this ticket. The closed channel remains visible so they can rate the support.",
      resolved:
        "Staff recorded the resolution and closed this ticket. The closed channel remains visible for private feedback.",
      rated:
        "Private feedback received. The player submitted a support rating. Authorized staff can view it in the dashboard.",
      reopened:
        "This ticket was reopened and returned to the waiting queue. Staff can claim it again.",
    }[notice.event];
    if (!content) throw new Error("Unknown ticket activity notice");
    const mentions = notice.silent
      ? []
      : closed
        ? [
            notice.staff?.id,
            !notice.actor.guest && notice.actor.id !== ticket.owner.id
              ? notice.actor.id
              : null,
          ].filter(Boolean)
        : [
            !ticket.owner.guest ? ticket.owner.id : null,
            !notice.actor.guest ? notice.actor.id : null,
          ].filter(Boolean);
    return await sendUpdate(
      ticket,
      notice,
      target,
      `${content}${closed ? " Admins and higher can delete this Discord channel separately. Saved ticket history stays in the staff dashboard." : ""}${mentions.length ? `\n${[...new Set(mentions)].map((id) => `<@${id}>`).join(" ")}` : ""}`,
      controls(ticket, closed),
      mentions,
    );
  }
  const transport = {
    staffUser,
    async notice(ticket, job, key) {
      if (!client.isReady()) throw new Error("Discord is not ready");
      const staffGuild = await client.guilds.fetch(config.guildId);
      let target = await staffGuild.channels.fetch(job.channelId);
      const category = ticketCategory(ticket);
      const members = await staffMembers();
      const permissionsForCategory = overwrites(members, null, category).map(
        (entry) =>
          entry.id === settings.guildId
            ? { ...entry, id: config.guildId }
            : entry,
      );
      if (category !== "support") {
        const saved = state();
        saved.categoryNotices ??= {};
        const channels = await staffGuild.channels.fetch();
        const topic = `Drakora private ${category} ticket notices.`;
        target =
          channels.get(saved.categoryNotices[category]) ||
          [...channels.values()].find((entry) => entry?.topic === topic);
        if (!target)
          target = await staffGuild.channels.create({
            name: `${category}-tickets`,
            type: ChannelType.GuildText,
            parent: (await staffGuild.channels.fetch(job.channelId)).parentId,
            topic,
            permissionOverwrites: permissionsForCategory,
          });
        saved.categoryNotices[category] = target.id;
        save("channels", saved);
      }
      await target.permissionOverwrites.set(permissionsForCategory);
      if (
        target?.guildId !== config.guildId ||
        target.type !== ChannelType.GuildText
      )
        throw new Error("Ticket staff notice channel is unavailable");
      const permissions = target.permissionsFor(
        await staffGuild.members.fetchMe(),
      );
      if (
        !permissions?.has([
          P.ViewChannel,
          P.SendMessages,
          P.EmbedLinks,
          P.ReadMessageHistory,
        ])
      )
        throw new Error("Ticket staff notice channel permissions are missing");
      const footer = job.activityId
        ? `Ticket ${ticket.id} · Activity ${job.activityId}`
        : `Ticket ${ticket.id} · ${job.event}${job.cycle ? ` · ${job.cycle}` : ""}`;
      const put = (value) =>
        service.store.set(
          "ticket-notice-send",
          key,
          value,
          Number.MAX_SAFE_INTEGER,
        );
      let intent = service.store.get("ticket-notice-send", key);
      function acknowledge(sent) {
        put({ ...intent, acknowledgedId: sent.id });
        return { id: sent.id, channelId: target.id };
      }
      if (intent?.acknowledgedId)
        return { id: intent.acknowledgedId, channelId: target.id };
      if (intent) {
        // Recover a send whose response was lost, including after a restart.
        for (let page = 0; page < 5; page++) {
          const recent = await target.messages.fetch({
            limit: 100,
            ...(intent.before ? { before: intent.before } : {}),
          });
          const existing = recent.find(
            (message) =>
              message.author.id === client.user.id &&
              message.embeds?.some((embed) => embed.footer?.text === footer),
          );
          if (existing) return acknowledge(existing);
          const oldest = [...recent.keys()].sort((a, b) =>
            BigInt(a) < BigInt(b) ? -1 : 1,
          )[0];
          if (recent.size < 100 || BigInt(oldest) <= BigInt(intent.after)) {
            delete intent.before;
            put(intent);
            break;
          }
          intent.before = oldest;
          put(intent);
          if (page === 4) return { pending: true };
        }
      } else {
        const latest = await target.messages.fetch({ limit: 1 });
        intent = { channelId: target.id, after: latest.first()?.id || "0" };
        put(intent);
      }
      const current = service.get(ticket.id);
      if (
        (!job.activityId &&
          ["closed", "awaiting_resolution"].includes(current.status)) ||
        (job.event === "unclaimed" &&
          (current.status !== "pending" || current.claimedBy))
      )
        return { cancelled: true };
      const restricted = category !== "support";
      const activity = {
        closed: [
          "Ticket closed by the player",
          "The player closed the conversation. Staff resolution is pending.",
        ],
        resolved: [
          "Ticket resolved",
          "Staff recorded the resolution and closed the conversation.",
        ],
        rated: [
          "Private feedback received",
          "The player submitted a support rating. Authorized staff can view it in the dashboard.",
        ],
        channel_deleted: [
          "Ticket channel deleted",
          "An Admin or higher deleted the Discord channel. Saved messages, history and transcripts remain in the staff dashboard.",
        ],
      }[job.event];
      const sent = await target.send({
        embeds: [
          {
            title: activity
              ? activity[0]
              : job.event === "reopened"
                ? "Ticket reopened"
                : job.event === "opened"
                  ? `New ${category === "partnership" ? "partnership request" : `${category} ticket`}`
                  : "Ticket still waiting for staff",
            description: activity
              ? activity[1]
              : restricted
                ? job.event !== "unclaimed"
                  ? "A restricted ticket has opened. Authorized staff can review it."
                  : "A restricted ticket has been unclaimed for at least one hour. Authorized staff can review it."
                : job.event !== "unclaimed"
                  ? `**${ticket.ign}** ${job.event === "reopened" ? "reopened" : "opened"} a ${ticketTypes.find((type) => type.id === ticket.type).name.toLowerCase()} ticket.`
                  : `**${ticket.ign}** has been waiting for at least one hour. This ticket still needs a staff member.`,
            color: 0xb92323,
            footer: { text: footer },
            timestamp: new Date(
              activity ? ticket.updatedAt : ticket.createdAt,
            ).toISOString(),
          },
        ],
        components: [
          {
            type: 1,
            components: [
              ...(ticket.channelId
                ? [
                    {
                      type: 2,
                      style: 5,
                      label: "Open Discord ticket",
                      url: `https://discord.com/channels/${settings.guildId}/${ticket.channelId}`,
                    },
                  ]
                : []),
              {
                type: 2,
                style: 5,
                label: "Open staff panel",
                url: `${config.staffOrigin}/tickets/${ticket.id}`,
              },
            ],
          },
        ],
        allowedMentions: { parse: [] },
        nonce: createHash("sha256")
          .update(`${job.channelId}:${key}`)
          .digest("hex")
          .slice(0, 25),
        enforceNonce: true,
      });
      return acknowledge(sent);
    },
    async assertMember(id) {
      await (await guild()).members.fetch(id);
    },
    async feedback(ticket, job, key) {
      await ready();
      const delivered = service.store.get("ticket-feedback-delivery", key);
      if (delivered) return { id: delivered.messageId };
      const kind = "ticket-feedback-send";
      let intent = service.store.get(kind, key) || { route: "dm" };
      const persist = () =>
        service.store.set(kind, key, intent, Number.MAX_SAFE_INTEGER);
      const nonce = createHash("sha256").update(key).digest("hex").slice(0, 25);
      let target;
      if (intent.route === "dm") {
        try {
          target = await (await client.users.fetch(ticket.owner.id)).createDM();
        } catch (error) {
          if (error.code !== 50007) throw error;
          intent = { route: "channel" };
          persist();
        }
      }
      if (intent.route === "channel") {
        if (!settings.feedbackChannelId)
          throw new Error("Ticket feedback channel is not configured");
        target = await channel(settings.feedbackChannelId);
        if (
          target.guildId !== settings.guildId ||
          target.type !== ChannelType.GuildText ||
          !target
            .permissionsFor(client.user)
            ?.has([P.ViewChannel, P.ReadMessageHistory])
        )
          throw new Error("Ticket feedback channel permissions are missing");
      }
      if (intent.channelId && intent.channelId !== target.id)
        throw new Error("Ticket feedback channel changed during delivery");
      const finish = async (sent) => {
        intent.messageId = sent.id;
        persist();
        if (intent.route === "channel") {
          try {
            await target.messages.delete(sent.id);
          } catch (error) {
            if (error.code !== 10008) throw error;
          }
        }
        service.store.transaction(() => {
          service.store.set(
            "ticket-feedback-delivery",
            key,
            {
              ticketId: ticket.id,
              closureId: job.ref,
              route: intent.route,
              channelId: target.id,
              messageId: sent.id,
              at: Date.now(),
            },
            Number.MAX_SAFE_INTEGER,
          );
          service.store.delete(kind, key);
        });
        return { id: sent.id };
      };
      if (intent.messageId) return finish({ id: intent.messageId });
      if (intent.channelId) {
        for (let page = 0; page < 5; page++) {
          const batch = await target.messages.fetch({
            limit: 100,
            ...(intent.before ? { before: intent.before } : {}),
          });
          const found = batch.find(
            (message) =>
              message.author.id === client.user.id &&
              (intent.route === "channel"
                ? String(message.nonce) === nonce
                : message.components?.some((row) =>
                    row.components.some((component) =>
                      [
                        feedbackId("rate", ticket),
                        feedbackId("rating", ticket),
                      ].includes(component.customId || component.custom_id),
                    ),
                  )),
          );
          if (found) return finish(found);
          const oldest = [...batch.keys()].sort((a, b) =>
            BigInt(a) < BigInt(b) ? -1 : 1,
          )[0];
          if (batch.size < 100 || BigInt(oldest) <= BigInt(intent.after)) {
            delete intent.before;
            persist();
            break;
          }
          intent.before = oldest;
          persist();
          if (page === 4) return { pending: true };
        }
      } else {
        const latest = await target.messages.fetch({ limit: 1 });
        intent.channelId = target.id;
        intent.after = latest.first()?.id || "0";
        persist();
      }
      const current = service.get(ticket.id);
      if (current.closureId !== job.ref || current.rating !== null)
        return { cancelled: true };
      if (intent.route === "channel") {
        const owner = await (await guild()).members.fetch(ticket.owner.id);
        if (
          !target
            .permissionsFor(owner)
            ?.has([P.ViewChannel, P.ReadMessageHistory]) ||
          !target.permissionsFor(client.user)?.has(P.SendMessages)
        )
          throw new Error("Ticket feedback channel permissions are missing");
      }
      try {
        return await finish(
          await target.send({
            content:
              intent.route === "dm"
                ? ""
                : `<@${ticket.owner.id}> Your ticket is closed. Use My tickets in the ticket panel to rate the support privately or reopen it.`,
            embeds:
              intent.route === "dm"
                ? [
                    {
                      title: "How was your Drakora support?",
                      description: `Your ticket is closed and its transcript is saved. ${feedbackQuestion(ticket)}\n\nAfter you rate it, the closed Discord channel is removed once staff have recorded the resolution. You can still reopen the ticket on the website.`,
                      color: 0xb92323,
                      fields: [
                        {
                          name: "Ticket",
                          value: `${ticketTypes.find((type) => type.id === ticket.type)?.name} · ${ticket.ign}`,
                        },
                      ],
                    },
                  ]
                : [],
            components: intent.route === "dm" ? controls(ticket) : [],
            allowedMentions:
              intent.route === "dm"
                ? { parse: [] }
                : { parse: [], users: [ticket.owner.id] },
            nonce,
            enforceNonce: true,
          }),
        );
      } catch (error) {
        if (intent.route !== "dm" || error.code !== 50007) throw error;
        intent = { route: "channel" };
        persist();
        return { pending: true };
      }
    },
    async create(ticket) {
      await ready();
      const main = await guild(),
        members = await staffMembers();
      if (!ticket.owner.guest) await main.members.fetch(ticket.owner.id);
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
          permissionOverwrites: ticketOverwrites(ticket, members),
        });
      service.bind(ticket.id, target.id);
      finishIntakeReply(service.get(ticket.id));
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
          content: "",
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
      webhooks.set(target.id, webhook);
    },
    async status(ticket, job = {}) {
      await ready();
      ticket = service.get(ticket.id);
      if (job.kind === "activity")
        return await activityUpdate(ticket, job.notice);
      if (["closed", "awaiting_resolution"].includes(ticket.status))
        return await closeChannel(ticket);
      const target = await ticketChannel(ticket);
      if (!target) return { pending: true };
      const saved = service.store.get("ticket-discord", ticket.id);
      const intro = await target.messages.fetch(saved.introId);
      ticket = service.get(ticket.id);
      if (["closed", "awaiting_resolution"].includes(ticket.status))
        return await closeChannel(ticket);
      await intro.edit({
        content: "",
        embeds: [overview(ticket)],
        components: controls(ticket),
        allowedMentions: { parse: [] },
      });
      const result = await staffUpdate(ticket, job.notice, target);
      if (result?.pending) return result;
      const members = await staffMembers();
      await target.permissionOverwrites.set(ticketOverwrites(ticket, members));
    },
    async deleteChannel(ticket) {
      await ready();
      return await closeChannel(ticket, true);
    },
    async checkChannel(ticket) {
      await ready();
      return await ticketChannel(ticket);
    },
    async eraseTicket(ticket) {
      await ready();
      await notes.erase(ticket);
      let target;
      try {
        if (ticket.channelId)
          target = await (await guild()).channels.fetch(ticket.channelId);
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
      if (
        target &&
        (target.guildId !== settings.guildId ||
          target.type !== ChannelType.GuildText ||
          target.topic !== marker(ticket.id))
      )
        throw new Error("Ticket erasure channel ownership does not match");
      const copies = [];
      for (const kind of [
        "ticket-notice-delivery",
        "ticket-notice-send",
        "ticket-feedback-delivery",
        "ticket-feedback-send",
        "partnership-dm-send",
      ])
        for (const [key, value] of service.store.entries(kind))
          if (
            (value.ticketId === ticket.id ||
              key === ticket.id ||
              key.startsWith(`${ticket.id}:`)) &&
            (value.messageId || value.acknowledgedId)
          )
            copies.push({
              ...value,
              messageId: value.messageId || value.acknowledgedId,
            });
      const deleted = new Set();
      for (const copy of copies) {
        let channelId = copy.channelId;
        if (!channelId && ticket.type === "partnership")
          channelId = (
            await (
              await client.users.fetch(ticket.partnership.discordId)
            ).createDM()
          ).id;
        if (!channelId)
          throw new Error("Ticket notification destination unavailable");
        const copyId = `${channelId}:${copy.messageId}`;
        if (deleted.has(copyId)) continue;
        try {
          const destination = await client.channels.fetch(channelId);
          if (!destination) continue;
          const message = await destination.messages.fetch(copy.messageId);
          if (message.author.id !== client.user.id)
            throw new Error("Ticket notification ownership does not match");
          await message.delete();
        } catch (error) {
          if (![10003, 10008].includes(error.code)) throw error;
        }
        deleted.add(copyId);
      }

      if (!target) return;
      await target.delete("Ticket data retention expired.");
      webhooks.delete(ticket.channelId);
    },
    async message(ticket, message, attachments, { retry = false } = {}) {
      if (message.internal)
        throw new Error("Internal notes cannot use the player channel");
      await ready();
      const target = await ticketChannel(ticket);
      if (!target) return { pending: true };
      const saved = service.store.get("ticket-discord", ticket.id);
      const key = String(message.sequence).padStart(12, "0");
      const delivered = service.store.get(`ticket-messages:${ticket.id}`, key);
      if (delivered?.id === message.id && delivered.discordId)
        return { id: delivered.discordId };
      function acknowledge(sent) {
        service.store.transaction(() => {
          service.store.set(
            "ticket-send",
            message.id,
            {
              ...intent,
              acknowledgedId: sent.id,
            },
            Number.MAX_SAFE_INTEGER,
          );
          save(ticket.id, {
            ...service.store.get("ticket-discord", ticket.id),
            lastSentId: sent.id,
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
        });
        return sent;
      }
      let intent = service.store.get("ticket-send", message.id);
      if (intent?.acknowledgedId) return { id: intent.acknowledgedId };
      let hook = webhooks.get(target.id);
      if (!hook) {
        hook = (await target.fetchWebhooks()).get(saved.webhookId);
        if (hook) webhooks.set(target.id, hook);
      }
      if (!hook) {
        await transport.create(ticket);
        throw new Error("Ticket webhook was restored");
      }
      // recover uncertain sends after the last acknowledged message, without a visible marker.
      if (intent || retry) {
        let before;
        for (let page = 0; page < 20; page++) {
          const recent = await target.messages.fetch({
            limit: 100,
            ...(before
              ? { before }
              : intent?.after
                ? { after: intent.after }
                : {}),
          });
          const sorted = [...recent.values()].sort((a, b) =>
            BigInt(a.id) < BigInt(b.id) ? -1 : 1,
          );
          const existing = sorted.find(
            (value) =>
              value.webhookId === (intent?.webhookId || hook.id) &&
              (intent?.after
                ? BigInt(value.id) > BigInt(intent.after)
                : value.embeds?.some(
                    (embed) => embed.footer?.text === messageMarker(message.id),
                  )),
          );
          if (existing) return acknowledge(existing);
          if (
            recent.size < 100 ||
            (intent?.after && BigInt(sorted[0].id) <= BigInt(intent.after))
          )
            break;
          if (page === 19)
            throw new Error("Ticket send recovery history remains pending");
          before = sorted[0].id;
        }
      }
      const files = [];
      for (const file of attachments)
        if (!file.purged && file.expiresAt > Date.now())
          files.push({
            attachment: await transport.bytes(file),
            name: file.name,
          });
      if (!intent) {
        const after = [saved.lastSentId, saved.introId, ticket.lastDiscordId]
          .filter((id) => /^\d+$/.test(id || ""))
          .sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1))[0];
        intent = { after, webhookId: hook.id, at: Date.now() };
        service.store.set(
          "ticket-send",
          message.id,
          intent,
          Number.MAX_SAFE_INTEGER,
        );
      }
      let sent;
      try {
        sent = await hook.send({
          content: message.content || undefined,
          username: message.actor.name.slice(0, 80),
          avatarURL: message.actor.avatar || undefined,
          files,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        if (error.code === 10015) webhooks.delete(target.id);
        throw error;
      }
      return acknowledge(sent);
    },
    async upload(bytes, name, type, ticket) {
      await ready();
      const saved = state();
      const category = ticket ? ticketCategory(ticket) : "staff";
      saved.categoryMedia ??= {};
      const main = await guild();
      const channels = await main.channels.fetch();
      const topic = `Drakora ${category} ticket attachments. Removed after 30 days.`;
      let target =
        channels.get(saved.categoryMedia[category]) ||
        [...channels.values()].find(
          (entry) =>
            entry?.parentId === settings.archiveCategoryId &&
            entry.topic === topic,
        );
      if (!target)
        target = await main.channels.create({
          name: `${category}-attachments`,
          type: ChannelType.GuildText,
          parent: settings.archiveCategoryId,
          topic,
          permissionOverwrites: overwrites(
            await staffMembers(),
            null,
            category,
          ),
        });
      saved.categoryMedia[category] = target.id;
      save("channels", saved);
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
        file.directMessage || file.staffGuildId === config.guildId
          ? await client.channels.fetch(file.channelId)
          : await channel(file.channelId)
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
        [file.sourceChannelId, file.sourceMessageId],
      ]) {
        if (!channelId || !messageId) continue;
        const reference = service.store.get(
          "ticket-discord-message",
          messageId,
        );
        if (reference && reference.ticketId === file.ticketId)
          service.store.set(
            "ticket-discord-message",
            messageId,
            { ...reference, mediaRemoved: true },
            Number.MAX_SAFE_INTEGER,
          );
        try {
          await (
            await client.channels.fetch(channelId)
          ).messages.delete(messageId);
        } catch (error) {
          if (!absent(error)) throw error;
        }
      }
    },
  };
  const notes = ticketNotesDiscord(config, service, client, {
    staffUser,
    staffMembers,
    ticketOverwrites,
    ready,
    bytes: (file) => transport.bytes(file),
    retainMedia,
  });
  transport.note = notes.send;
  transport.notesThread = notes.ensure;
  async function observe(message, edited = false, closing = false) {
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
    service.ingest(
      ticket.id,
      {
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
      },
      closing,
    );
  }
  async function retainMedia(ticket, channelId) {
    let copied = 0;
    const needsCopy = (file) =>
      file &&
      file.ticketId === ticket.id &&
      file.channelId === channelId &&
      !file.purged &&
      !file.removed &&
      file.expiresAt > Date.now();
    for (const [id, file] of service.store.entries("ticket-media")) {
      if (!needsCopy(file)) continue;
      if (copied++ === 5) return false;
      const stored = await transport.upload(
        await transport.bytes(file),
        file.name,
        file.type,
        ticket,
      );
      const current = service.store.get("ticket-media", id);
      if (
        !needsCopy(current) ||
        current.messageId !== file.messageId ||
        current.attachmentId !== file.attachmentId
      ) {
        await transport.removeMedia(stored);
        continue;
      }
      service.store.set(
        "ticket-media",
        id,
        {
          ...current,
          ...stored,
          sourceChannelId: current.channelId,
          sourceAttachmentId: current.attachmentId,
          sourceMessageId: current.messageId,
          mirrorChannelId: null,
          mirrorMessageId: null,
        },
        Number.MAX_SAFE_INTEGER,
      );
    }
    return !service.store
      .entries("ticket-media")
      .some(([, file]) => needsCopy(file));
  }
  async function closeChannel(ticket, deletion = false) {
    let snapshot = service.store.get("ticket-discord-close", ticket.id);
    const persist = () =>
      service.store.set(
        "ticket-discord-close",
        ticket.id,
        snapshot,
        Number.MAX_SAFE_INTEGER,
      );
    if (snapshot && snapshot.channelId !== ticket.channelId)
      throw new Error("Ticket closure channel does not match");
    let target;
    try {
      target = await (await guild()).channels.fetch(ticket.channelId);
    } catch (error) {
      if (error.code !== 10003 || !snapshot?.ready) throw error;
    }
    if (!target) {
      if (!snapshot?.ready)
        throw new Error("Ticket channel missing before transcript capture");
      webhooks.delete(ticket.channelId);
      return { deleted: true };
    }
    if (
      target.guildId !== settings.guildId ||
      target.type !== ChannelType.GuildText ||
      target.topic !== marker(ticket.id)
    )
      throw new Error("Ticket channel ownership does not match");
    if (
      !target
        .permissionsFor(client.user)
        ?.has([P.ViewChannel, P.ReadMessageHistory, P.ManageChannels])
    )
      throw new Error("Ticket closure permissions are missing");
    await target.permissionOverwrites.set(
      ticketOverwrites(ticket, await staffMembers()),
    );
    const saved = service.store.get("ticket-discord", ticket.id);
    if (saved?.introId)
      await (
        await target.messages.fetch(saved.introId)
      ).edit({
        content: "",
        embeds: [overview(ticket)],
        components: controls(ticket, true),
        allowedMentions: { parse: [] },
      });
    if (!snapshot?.ready) {
      snapshot ||= { channelId: target.id, historySaved: false };
      for (let page = 0; !snapshot.historySaved && page < 5; page++) {
        snapshot.before = await reconcile(
          ticket,
          target,
          snapshot.before,
          true,
        );
        snapshot.historySaved = !snapshot.before;
        persist();
      }
      if (!snapshot.historySaved) return { pending: true };
      if (!(await retainMedia(ticket, target.id))) return { pending: true };
      snapshot.ready = true;
      persist();
    }
    if (!deletion) return { closed: true };
    if ((await notes.deleteThread(ticket))?.pending) return { pending: true };
    try {
      await target.delete(
        "Closed ticket channel removed; transcript saved in staff logs",
      );
    } catch (error) {
      if (error.code !== 10003) throw error;
    }
    webhooks.delete(target.id);
    return { deleted: true };
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
          {
            id: saved.mediaId,
            permissions: overwrites(members, null, "billing"),
          },
          ...Object.entries(saved.categoryMedia || {}).map(([type, id]) => ({
            id,
            permissions: overwrites(members, null, [
              type,
              ...new Set(
                service.store
                  .entries("ticket-media")
                  .filter(([, file]) => file.channelId === id && !file.purged)
                  .map(([, file]) =>
                    ticketCategory(service.get(file.ticketId)),
                  ),
              ),
            ]),
          })),
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
            const channel = await main.channels.fetch(target.id);
            if (channel)
              await channel.permissionOverwrites.set(target.permissions);
          } catch (error) {
            if (error.code !== 10003) failed = true;
          }
        }
        const staffGuild = await client.guilds.fetch(config.guildId);
        const noticeChannels = {
          ...saved.categoryNotices,
          ...(settings.staffChannelId
            ? { support: settings.staffChannelId }
            : {}),
        };
        for (const [type, id] of Object.entries(noticeChannels)) {
          try {
            const channel = await staffGuild.channels.fetch(id);
            if (!channel) continue;
            await channel.permissionOverwrites.set(
              overwrites(members, null, type).map((entry) =>
                entry.id === settings.guildId
                  ? { ...entry, id: config.guildId }
                  : entry,
              ),
            );
          } catch (error) {
            if (error.code !== 10003) failed = true;
          }
        }
        await notes.refreshPermissions();
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
      await notes.recover();
      let noticeEdits = 0;
      const oldNotices = service.store
        .entries("ticket-status-notice")
        .filter(([, entry]) => entry.messageId && entry.layoutVersion !== 2);
      for (const ticket of service
        .all()
        .filter((ticket) => ticket.channelId)
        .sort(
          (a, b) =>
            Number(a.status === "closed") - Number(b.status === "closed"),
        )) {
        try {
          const target = await channel(ticket.channelId);
          for (const [key, entry] of oldNotices) {
            if (
              entry.ticketId !== ticket.id ||
              entry.channelId !== target.id ||
              noticeEdits >= 20
            )
              continue;
            noticeEdits++;
            try {
              const message = await target.messages.fetch(entry.messageId);
              if (message.author.id !== client.user.id)
                throw new Error("Ticket notice ownership changed");
              const old = message.embeds[0]?.toJSON?.() || message.embeds[0];
              const url = `${config.staffOrigin}/tickets/${ticket.id}#update=${encodeURIComponent(key)}`;
              const legacy = old?.footer?.text?.startsWith(
                `Ticket ${ticket.id} ·`,
              );
              if (!old || (!legacy && old.url !== url))
                throw new Error("Ticket notice marker changed");
              await message.edit({
                content: "",
                embeds: [
                  {
                    ...old,
                    title: `${ticketTypes.find((type) => type.id === ticket.type)?.name} · ${ticket.ign}`,
                    url,
                    description: (
                      (legacy ? message.content : null) ||
                      old.description ||
                      "Ticket updated"
                    ).slice(0, 4096),
                    fields:
                      old.fields ||
                      (legacy && old.description
                        ? [{ name: "Status", value: old.description }]
                        : []),
                    footer: {
                      text: `Drakora support · ${ticket.id.slice(0, 8)}`,
                    },
                  },
                ],
                allowedMentions: { parse: [] },
              });
            } catch (error) {
              if (error.code !== 10008) throw error;
            }
            service.store.set(
              "ticket-status-notice",
              key,
              { ...entry, layoutVersion: 2 },
              Number.MAX_SAFE_INTEGER,
            );
          }
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
        } catch (error) {
          if (error.code === 10003) {
            webhooks.delete(ticket.channelId);
            service.missingChannel(ticket.id, ticket.channelId);
          } else console.error("Ticket channel recovery is pending.");
        }
      }
    })()
      .catch(() => console.error("Ticket Discord recovery is pending."))
      .finally(() => {
        recovering = null;
      });
    return recovering;
  }
  async function reconcile(ticket, target, before, closing = false) {
    // snapshot before fetching. newer gateway messages are outside this deletion check.
    const known = service
      .messages(ticket.id)
      .filter(
        (message) =>
          message.origin === "discord" &&
          !message.internal &&
          !message.deleted &&
          message.sequence > (ticket.reopenedSequence || 0),
      );
    const batch = await target.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (service.get(ticket.id).channelId !== target.id) return null;
    const sorted = [...batch.values()].sort(
      (a, b) =>
        a.createdTimestamp - b.createdTimestamp ||
        (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
    );
    for (const message of sorted)
      if (closing || service.store.get("ticket-discord-message", message.id))
        await observe(message, true, closing);
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
        ticketTypes
          .filter((type) => type.id !== "partnership")
          .map((type) => ({ label: type.name, value: type.id })),
      );
    return interaction.reply({
      content: `Choose the kind of help you need. Your ticket stays private. By submitting, you agree to the [Terms of Service](${config.applications.publicOrigin}/terms). Read the [Privacy Policy](${config.applications.publicOrigin}/privacy) for data use, retention and your rights.`,
      components: [
        new ActionRowBuilder().addComponents(select),
        myTicketsButton(),
      ],
      flags: 64,
    });
  }
  function myTicketsButton() {
    return {
      type: 1,
      components: [
        { type: 2, style: 2, label: "My tickets", custom_id: "ticket:mine" },
      ],
    };
  }
  function intakeReply(ticket) {
    const web = `${config.applications.publicOrigin}${ticketPath(ticket)}`;
    return {
      content: ticket.channelId
        ? `Please go to your ticket here: <#${ticket.channelId}>\nYou can also continue on the website: ${web}`
        : `Your ticket has been saved. Your private Discord channel is being created; this message will update with its link when it is ready.\nYou can also continue on the website: ${web}`,
      components: ticket.channelId
        ? [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 5,
                  label: "Go to your ticket",
                  url: `https://discord.com/channels/${settings.guildId}/${ticket.channelId}`,
                },
              ],
            },
          ]
        : [myTicketsButton()],
      allowedMentions: { parse: [] },
    };
  }
  function finishIntakeReply(ticket) {
    const pending = intakeReplies.get(ticket.id);
    if (!pending || !ticket.channelId || stopped) return;
    intakeReplies.delete(ticket.id);
    clearTimeout(pending.timer);
    const task = pending.interaction
      .editReply(intakeReply(ticket))
      .catch(() =>
        console.error("Ticket channel link reply could not be updated."),
      )
      .finally(() => intakeReplyTasks.delete(task));
    intakeReplyTasks.add(task);
  }
  async function acknowledgeIntake(interaction, ticket) {
    const current = service.get(ticket.id);
    await interaction.editReply(intakeReply(current));
    if (current.channelId || stopped) return;
    const remaining = Math.max(
      0,
      14 * 60000 -
        Math.max(0, Date.now() - (interaction.createdTimestamp || Date.now())),
    );
    if (!remaining) return;
    const timer = setTimeout(() => intakeReplies.delete(ticket.id), remaining);
    timer.unref();
    intakeReplies.set(ticket.id, { interaction, timer });
    finishIntakeReply(service.get(ticket.id));
  }
  function input(id, label, style, min, max, value, required = true) {
    const field = new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(style)
      .setRequired(required)
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
    const [, action, selectedId, closureId] = interaction.customId.split(":");
    const id = action === "mine-choice" ? interaction.values[0] : selectedId;
    try {
      if (action === "mine") {
        const mine = service
          .all()
          .filter(
            (ticket) =>
              ticket.owner.id === interaction.user.id &&
              ticket.type !== "partnership",
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 25);
        return await interaction.reply({
          content: mine.length
            ? "Choose your ticket. Feedback and reopen options are private."
            : "You do not have any tickets yet.",
          components: mine.length
            ? [
                new ActionRowBuilder().addComponents(
                  new StringSelectMenuBuilder()
                    .setCustomId("ticket:mine-choice")
                    .setPlaceholder("Choose your ticket")
                    .addOptions(
                      mine.map((ticket) => ({
                        label:
                          `${ticket.ign} · ${ticketStatusLabel(ticket)} · ${ticket.id.slice(0, 8)}`.slice(
                            0,
                            100,
                          ),
                        value: ticket.id,
                      })),
                    ),
                ),
              ]
            : [],
          flags: 64,
        });
      }
      if (action === "type") {
        const type = interaction.values[0];
        const form = ticketIntake(type);
        if (!form) throw new AuthError("invalid_ticket", 400);
        return await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`ticket:intake:${type}`)
            .setTitle(form.title)
            .addComponents(
              ...form.fields.map((field) =>
                input(
                  field.id,
                  field.label,
                  field.multiline
                    ? TextInputStyle.Paragraph
                    : TextInputStyle.Short,
                  field.min,
                  field.max,
                  undefined,
                  field.required !== false,
                ),
              ),
            ),
        );
      }
      if (action === "intake") {
        const form = ticketIntake(id);
        if (!form) throw new AuthError("invalid_ticket", 400);
        await interaction.deferReply({ flags: 64 });
        const ticket = service.create(
          actor(interaction.user, interaction.member),
          {
            type: id,
            ...Object.fromEntries(
              form.fields.map((field) => [
                field.id,
                interaction.fields.getTextInputValue(field.id),
              ]),
            ),
            requestId: randomUUID(),
          },
          "discord",
        );
        return await acknowledgeIntake(interaction, ticket);
      }
      const ticket = service.get(id),
        owner = interaction.user.id === ticket.owner.id;
      if (
        [
          "mine-choice",
          "takeover-approve",
          "takeover-deny",
          "takeover-submit",
          "claim",
          "notes",
          "takeover",
          "rate",
          "rating",
          "reopen",
          "delete",
          "delete-confirm",
        ].includes(action)
      )
        await interaction.deferReply({ flags: 64 });
      const staffIdentity =
        !owner ||
        [
          "claim",
          "takeover-request",
          "takeover-submit",
          "takeover-approve",
          "takeover-deny",
          "notes",
          "close",
          "resolve",
          "takeover",
          "delete",
          "delete-confirm",
        ].includes(action)
          ? await staffUser(interaction.user.id)
          : null;
      const user = staffIdentity || actor(interaction.user, interaction.member);
      if (!owner) service.staff(user || { roles: [] }, ticket);
      if (action === "takeover-request") {
        service.staff(user, ticket, "tickets.takeover");
        return await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`ticket:takeover-submit:${id}:${closureId}`)
            .setTitle("Request a ticket takeover")
            .addComponents(
              input(
                "reason",
                "Why do you need to take over?",
                TextInputStyle.Paragraph,
                1,
                1000,
              ),
            ),
        );
      }
      if (action === "notes") {
        service.staff(user, ticket);
        const url = service.notes(user, id).discordUrl;
        return await interaction.editReply({
          content: url
            ? `Private staff discussion: ${url}\nStaff panel: ${config.staffOrigin}/tickets/${id}#notes`
            : `The private staff discussion is syncing to Discord. You can use the staff panel now: ${config.staffOrigin}/tickets/${id}#notes`,
          allowedMentions: { parse: [] },
        });
      }
      if (
        [
          "rate",
          "rating",
          "reopen",
          "delete",
          "delete-confirm",
          ...(closureId ? ["close"] : []),
        ].includes(action) &&
        (closureId ? ticket.closureId !== closureId : ticket.reopenedCount)
      )
        throw new AuthError("ticket_feedback_expired", 409);
      if (
        action === "resolve" &&
        (closureId === undefined
          ? ticket.reopenedCount
          : closureId !== String(ticket.reopenedCount || 0))
      )
        throw new AuthError("ticket_feedback_expired", 409);
      if (action === "mine-choice") {
        service.authorize(user, ticket);
        return await interaction.editReply({
          content: ["closed", "awaiting_resolution"].includes(ticket.status)
            ? feedbackQuestion(ticket)
            : "Your ticket is still open. Continue in your private ticket.",
          components: ["closed", "awaiting_resolution"].includes(ticket.status)
            ? controls(ticket)
            : [
                {
                  type: 1,
                  components: [
                    {
                      type: 2,
                      style: 5,
                      label: "View ticket",
                      url: `${config.applications.publicOrigin}${ticketPath(ticket)}`,
                    },
                  ],
                },
              ],
          allowedMentions: { parse: [] },
        });
      }
      if (
        action === "close" &&
        (!owner ||
          (staffIdentity?.capabilities["tickets.close"] &&
            (ticket.type !== "staff" || rolePolicy.isManager(staffIdentity))))
      ) {
        service.staff(user, ticket, "tickets.close");
        if (ticket.status === "closed")
          return await interaction.reply({
            content:
              "The resolution for this closure is already saved. No further resolution is needed.",
            flags: 64,
          });
        return await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`ticket:resolve:${id}:${ticket.reopenedCount || 0}`)
            .setTitle("Record the ticket resolution")
            .addComponents(
              input(
                "summary",
                "What did you do to resolve the issue?",
                TextInputStyle.Paragraph,
                1,
                4000,
              ),
              input(
                "commands",
                "Commands run (enter None if none)",
                TextInputStyle.Paragraph,
                1,
                2000,
              ),
            ),
        );
      }
      if (action === "delete") {
        service.staff(user, ticket, "tickets.delete");
        if (!["closed", "awaiting_resolution"].includes(ticket.status))
          throw new AuthError("ticket_close_first", 409);
        return await interaction.editReply({
          content:
            "Delete this closed Discord channel? Its messages, history and saved transcript remain in the staff dashboard.",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 4,
                  label: "Delete channel",
                  custom_id: feedbackId("delete-confirm", ticket),
                },
              ],
            },
          ],
          allowedMentions: { parse: [] },
        });
      }
      if (action === "rate") {
        service.authorize(user, ticket);
        if (!["closed", "awaiting_resolution"].includes(ticket.status))
          throw new AuthError("ticket_feedback_expired", 409);
        if (ticket.rating !== null)
          throw new AuthError("ticket_already_rated", 409);
        return await interaction.editReply({
          content: feedbackQuestion(ticket),
          components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(feedbackId("rating", ticket))
                .setPlaceholder("Choose 1–5 stars")
                .addOptions(
                  [1, 2, 3, 4, 5].map((value) => ({
                    label: `${value} ${value === 1 ? "star" : "stars"}`,
                    value: String(value),
                  })),
                ),
            ),
          ],
          allowedMentions: { parse: [] },
        });
      }
      if (!interaction.deferred) await interaction.deferReply({ flags: 64 });
      if (action === "claim") service.claim(user, id);
      else if (action === "takeover") {
        try {
          await service.takeover(user, id, closureId);
        } catch (error) {
          if (error.code !== "ticket_takeover_approval_required") throw error;
          return await interaction.editReply({
            content:
              "Manager approval is required. Add a reason to request this ticket.",
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 1,
                    label: "Request takeover",
                    custom_id: `ticket:takeover-request:${id}:${closureId}`,
                  },
                ],
              },
            ],
            allowedMentions: { parse: [] },
          });
        }
      } else if (action === "takeover-submit")
        service.requestTakeover(user, id, {
          claimedBy: closureId,
          reason: interaction.fields.getTextInputValue("reason"),
        });
      else if (["takeover-approve", "takeover-deny"].includes(action))
        await service.reviewTakeover(
          user,
          id,
          closureId,
          action === "takeover-approve",
        );
      else if (action === "close") service.closeTicket(user, id, {}, false);
      else if (action === "resolve")
        service.closeTicket(
          user,
          id,
          {
            summary: interaction.fields.getTextInputValue("summary"),
            commands: interaction.fields.getTextInputValue("commands"),
            cycle: closureId === undefined ? 0 : Number(closureId),
          },
          true,
        );
      else if (action === "rating")
        service.rate(user, id, Number(interaction.values[0]), closureId);
      else if (action === "reopen")
        await service.reopen(user, id, !owner, closureId);
      else if (action === "delete-confirm")
        await service.deleteChannel(user, id, closureId);
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
        action === "claim" || action === "takeover"
          ? `${ticketStatusLabel(service.get(id))}. Updates are syncing to Discord and the website.`
          : action === "takeover-submit"
            ? "Your request is saved in the private staff notes thread for Manager approval."
            : action === "takeover-approve"
              ? "Takeover approved. The requester is now assigned to the ticket."
              : action === "takeover-deny"
                ? "Takeover request denied. The assignment has not changed."
                : action === "close"
                  ? `Ticket closed. Staff will add the resolution record. Rating and transcript downloads remain available on your private ticket: ${config.applications.publicOrigin}${ticketPath(ticket)}`
                  : action === "rating"
                    ? "Thank you. Your private rating has been saved."
                    : action === "delete-confirm"
                      ? "Channel deletion requested. The transcript will be saved before removal; dashboard history is kept."
                      : action === "reopen"
                        ? "Ticket reopened. Staff can claim it again."
                        : "Ticket updated.",
      );
    } catch (error) {
      const message =
        {
          ticket_takeover_manager_required:
            "Only Managers and Founders with access to this ticket can approve or deny a takeover.",
          ticket_takeover_request_expired:
            "This takeover request is no longer current. Check the ticket's assignment.",
          ticket_takeover_request_pending:
            "A takeover request is already waiting for Manager review in the private notes thread.",
          ticket_takeover_requester_unavailable:
            "The requester is no longer an eligible staff member.",
          ticket_takeover_self_approval:
            "Another Manager or Founder must review your request.",
          invalid_takeover_reason:
            "Provide a nonblank reason, up to 1,000 characters.",
          ticket_already_claimed:
            "Another staff member already claimed this ticket.",
          ticket_assignment_changed:
            "This ticket's assignment changed. Use its current Take over button.",
          ticket_closed:
            "This ticket is closed. Reopen it before claiming or taking it over.",
          ticket_access_denied: "You do not have permission to do that.",
          ticket_limit:
            "You already have three open tickets. Continue in an existing ticket.",
          invalid_ticket:
            "Check your Minecraft username and provide detailed information.",
          invalid_report_target:
            "Enter the username or Discord user ID of the person you are reporting.",
          ticket_close_first:
            "Close the ticket before deleting its Discord channel.",
          ticket_already_rated: "You have already rated this ticket.",
          ticket_feedback_expired:
            "These options belong to an earlier closure. Use My tickets in the ticket panel for current options.",
          ticket_reopen_pending:
            "The transcript is still being saved. Try reopening again shortly.",
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
    webhooks.clear();
    setup = null;
    void recover();
  };
  service.registerCleanupWaiter?.(() =>
    Promise.allSettled([recovering, refreshing]),
  );
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
      for (const pending of intakeReplies.values()) clearTimeout(pending.timer);
      intakeReplies.clear();
      await notes.close();
      clearInterval(timer);
      client.off("messageCreate", handleMessage);
      client.off("raw", handleRaw);
      client.off("interactionCreate", handleInteraction);
      client.off("clientReady", handleReady);
      client.off("shardResume", handleReady);
      await Promise.allSettled([recovering, refreshing, ...intakeReplyTasks]);
      webhooks.clear();
    },
  };
}
