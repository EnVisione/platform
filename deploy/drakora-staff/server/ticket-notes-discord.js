import { createHash } from "node:crypto";
import { ChannelType } from "discord.js";
import { discordMembers } from "./discord-members.js";

const forever = Number.MAX_SAFE_INTEGER;
const title = (id) => `ticket-${id}-internal-notes`;
const footer = (id) => `Drakora internal note ${id}`;

export function ticketNotesDiscord(
  config,
  service,
  client,
  { staffUser, staffMembers, ticketOverwrites, ready, bytes, retainMedia },
) {
  let running,
    stopped = false;
  const store = service.store;
  const pendingThreads = new Map();
  const save = (kind, id, value) => store.set(kind, id, value, forever);
  const guild = (id = config.tickets.guildId) => client.guilds.fetch(id);
  const stateGuild = (state) => state?.guildId || config.guildId;
  const linked = (id) => {
    const ref = store.get("ticket-notes-channel", id);
    return ref ? service.get(ref.ticketId) : null;
  };
  async function parent(ticket, members) {
    if (ticket.type === "partnership" || !ticket.channelId) return null;
    let target;
    try {
      target = await (await guild()).channels.fetch(ticket.channelId);
    } catch (error) {
      if (error.code !== 10003) throw error;
    }
    if (!target) return null;
    if (
      target.guildId !== config.tickets.guildId ||
      target.type !== ChannelType.GuildText ||
      target.topic !== `Drakora ticket ${ticket.id}`
    )
      throw new Error("Internal notes ticket channel ownership does not match");
    await target.permissionOverwrites.set(ticketOverwrites(ticket, members));
    return target;
  }
  function owned(target, ticket, state) {
    if (
      target.guildId !== stateGuild(state) ||
      target.type !== ChannelType.PrivateThread ||
      target.parentId !== state.parentId ||
      target.ownerId !== client.user.id ||
      target.name !== title(ticket.id)
    )
      throw new Error("Internal notes thread ownership does not match");
  }
  async function findThread(target, ticket, state) {
    const match = (threads) =>
      [...threads.values()].find(
        (value) =>
          value.name === title(ticket.id) && value.ownerId === client.user.id,
      );
    let found = match((await target.threads.fetchActive()).threads);
    if (found) return found;
    for (let page = 0; page < 5; page++) {
      const batch = await target.threads.fetchArchived({
        type: "private",
        limit: 100,
        ...(state.searchBefore ? { before: state.searchBefore } : {}),
      });
      found = match(batch.threads);
      if (found) return found;
      if (!batch.hasMore) {
        delete state.searchBefore;
        return null;
      }
      state.searchBefore = [...batch.threads.values()].at(-1)?.archiveTimestamp;
      if (!state.searchBefore)
        throw new Error("Internal notes archive cursor unavailable");
      save("ticket-notes-discord", ticket.id, state);
    }
    return { pending: true };
  }
  async function synchronize(target, ticket, members) {
    const present = await discordMembers(client, await guild());
    const allowed = new Set(
      members
        .filter((user) => {
          if (!present.has(user.id)) return false;
          try {
            service.staff(user, ticket);
            return true;
          } catch {
            return false;
          }
        })
        .map((user) => user.id),
    );
    allowed.add(client.user.id);
    const current = await target.members.fetch();
    const removals = [...current.keys()].filter((id) => !allowed.has(id));
    const additions = [...allowed].filter((id) => !current.has(id));
    if (removals.length || additions.length) {
      if (target.archived) await target.setArchived(false);
      for (const id of removals) await target.members.remove(id);
      for (const id of additions) await target.members.add(id);
    }
    if (target.invitable !== false) await target.setInvitable(false);
  }
  async function thread(ticket, batch) {
    await ready();
    if (stopped) return { pending: true };
    const members = batch?.members || (await staffMembers());
    const target = await parent(ticket, members);
    const existing = store.get("ticket-notes-discord", ticket.id);
    if (!target) {
      if (
        ticket.type !== "partnership" &&
        ["pending", "claimed"].includes(ticket.status)
      )
        return { pending: true };
      if (existing && (await retire(ticket, existing))?.pending)
        return { pending: true };
      return null;
    }
    let state = store.get("ticket-notes-discord", ticket.id) || {
      ticketId: ticket.id,
      parentId: target.id,
      guildId: config.tickets.guildId,
    };
    if (
      state.parentId !== target.id ||
      stateGuild(state) !== config.tickets.guildId
    ) {
      if ((await retire(ticket, state))?.pending) return { pending: true };
      state = {
        ticketId: ticket.id,
        parentId: target.id,
        guildId: config.tickets.guildId,
      };
      save("ticket-notes-discord", ticket.id, state);
    }
    let result;
    if (state.threadId) {
      try {
        result = await (
          await guild(stateGuild(state))
        ).channels.fetch(state.threadId);
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
      if (!result) {
        store.delete("ticket-notes-channel", state.threadId);
        state = {
          ticketId: ticket.id,
          parentId: target.id,
          guildId: config.tickets.guildId,
        };
        save("ticket-notes-discord", ticket.id, state);
      }
    }
    if (!result) {
      save("ticket-notes-discord", ticket.id, state);
      result = await findThread(target, ticket, state);
      if (result?.pending) return result;
      if (!result)
        result = await target.threads.create({
          name: title(ticket.id),
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: 1440,
          reason: "Private internal ticket discussion",
        });
    }
    owned(result, ticket, state);
    state.threadId = result.id;
    delete state.searchBefore;
    save("ticket-notes-discord", ticket.id, state);
    save("ticket-notes-channel", result.id, { ticketId: ticket.id });
    await synchronize(result, ticket, members);
    return result;
  }
  function ensure(ticket, batch) {
    if (!pendingThreads.has(ticket.id))
      pendingThreads.set(
        ticket.id,
        thread(service.get(ticket.id), batch).finally(() =>
          pendingThreads.delete(ticket.id),
        ),
      );
    return pendingThreads.get(ticket.id);
  }
  async function send(ticket, message, attachments) {
    if (!message.internal)
      throw new Error("Only internal notes can use the staff thread");
    const target = await ensure(ticket);
    if (!target) return { local: true };
    if (target.pending) return target;
    if (target.archived) await target.setArchived(false);
    const takeover = () =>
      message.takeoverRequestId &&
      service.takeoverRequestView(service.get(ticket.id));
    function payload() {
      const request = takeover();
      const matching = Boolean(
        request &&
        message.takeoverRequestId &&
        request.id === message.takeoverRequestId,
      );
      const pending = matching && request.status === "pending";
      return {
        content: "",
        embeds: [
          {
            title: matching
              ? "Ticket takeover request"
              : `${message.actor.name.slice(0, 80)} · Internal staff note`,
            description: matching
              ? `${request.requester.name} requests this ticket from ${request.previousStaff.name}.\n\n${request.reason}`
              : message.content || undefined,
            ...(matching
              ? {
                  fields: [
                    {
                      name: "Decision",
                      value: `${request.status}${request.reviewer ? ` by ${request.reviewer.name}` : ""}`,
                    },
                  ],
                }
              : {}),
            footer: { text: footer(message.id) },
            url: `${config.staffOrigin}/tickets/${ticket.id}#notes`,
            timestamp: new Date(message.at).toISOString(),
          },
        ],
        components: pending
          ? [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 3,
                    label: "Approve · Manager+",
                    custom_id: `ticket:takeover-approve:${ticket.id}:${request.id}`,
                  },
                  {
                    type: 2,
                    style: 4,
                    label: "Deny · Manager+",
                    custom_id: `ticket:takeover-deny:${ticket.id}:${request.id}`,
                  },
                ],
              },
            ]
          : [],
        allowedMentions: { parse: [] },
      };
    }
    if (message.takeoverRequestId && message.discordId) {
      try {
        const existing = await target.messages.fetch(message.discordId);
        await existing.edit(payload());
        return { id: existing.id };
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
    }
    const key = `note:${message.id}`;
    let intent = store.get("ticket-send", key);
    if (intent?.threadId !== target.id) intent = null;
    if (intent?.acknowledgedId) {
      if (message.takeoverRequestId)
        return acknowledge(await target.messages.fetch(intent.acknowledgedId));
      return { id: intent.acknowledgedId };
    }
    async function acknowledge(sent) {
      if (message.takeoverRequestId) await sent.edit(payload());
      save("ticket-send", key, { ...intent, acknowledgedId: sent.id });
      for (const file of attachments)
        save("ticket-media", file.id, {
          ...file,
          mirrorChannelId: target.id,
          mirrorMessageId: sent.id,
        });
      return { id: sent.id };
    }
    if (intent) {
      for (let page = 0; page < 5; page++) {
        const batch = await target.messages.fetch({
          limit: 100,
          ...(intent.before ? { before: intent.before } : {}),
        });
        const found = [...batch.values()].find(
          (value) =>
            value.author.id === client.user.id &&
            value.embeds?.some(
              (embed) => embed.footer?.text === footer(message.id),
            ),
        );
        if (found) return acknowledge(found);
        const oldest = [...batch.keys()].sort((a, b) =>
          BigInt(a) < BigInt(b) ? -1 : 1,
        )[0];
        if (batch.size < 100 || BigInt(oldest) <= BigInt(intent.after)) {
          delete intent.before;
          break;
        }
        intent.before = oldest;
        save("ticket-send", key, intent);
        if (page === 4) return { pending: true };
      }
    } else {
      const latest = await target.messages.fetch({ limit: 1 });
      intent = {
        ticketId: ticket.id,
        threadId: target.id,
        after: latest.first()?.id || "0",
      };
      save("ticket-send", key, intent);
    }
    const files = [];
    for (const file of attachments)
      if (!file.purged && file.expiresAt > Date.now())
        files.push({ attachment: await bytes(file), name: file.name });
    service.get(ticket.id);
    const request = takeover();
    const managers =
      request?.status === "pending"
        ? (await staffMembers())
            .filter((user) => {
              try {
                service.staff(user, ticket, "tickets.takeover");
              } catch {
                return false;
              }
              return user.roles?.some((id) =>
                config.ranks.some(
                  (rank) =>
                    rank.id === id &&
                    ["Founder", "Manager"].includes(rank.name),
                ),
              );
            })
            .map((user) => user.id)
            .slice(0, 100)
        : [];
    service.get(ticket.id);
    const sent = await target.send({
      ...payload(),
      ...(managers.length
        ? {
            content: managers.map((id) => `<@${id}>`).join(" "),
            allowedMentions: { parse: [], users: managers },
          }
        : {}),
      files,
      nonce: createHash("sha256").update(key).digest("hex").slice(0, 25),
      enforceNonce: true,
    });
    return acknowledge(sent);
  }
  async function observe(message, closing = false) {
    if (stopped || message.author?.bot || message.system || message.webhookId)
      return;
    const ticket = linked(message.channelId);
    if (!ticket) return;
    const state = store.get("ticket-notes-discord", ticket.id);
    if (!state || message.guildId !== stateGuild(state)) return;
    const user = await staffUser(message.author.id);
    try {
      service.staff(user || { roles: [] }, ticket, "tickets.reply");
    } catch (error) {
      if (error.code === "ticket_access_denied") return;
      throw error;
    }
    service.ingest(
      ticket.id,
      {
        id: message.id,
        channelId: message.channelId,
        actor: user,
        staff: true,
        internal: true,
        guildId: message.guildId,
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
  async function refreshPermissions() {
    const members = await staffMembers();
    for (const [, state] of store.entries("ticket-notes-discord")) {
      const ticket = service.get(state.ticketId);
      await ensure(ticket, { members });
    }
  }
  async function recover() {
    if (stopped || running || !client.isReady()) return running;
    running = (async () => {
      if (!store.entries("ticket-notes-discord").length) return;
      const context = { members: await staffMembers() };
      for (const [, state] of store.entries("ticket-notes-discord")) {
        let ticket;
        try {
          ticket = service.get(state.ticketId);
          const target = await ensure(ticket, context);
          if (!target || target.pending) continue;
          let after =
            store.get("ticket-notes-discord", ticket.id)?.after || target.id;
          for (let page = 0; page < 5; page++) {
            const batch = await target.messages.fetch({ limit: 100, after });
            const sorted = [...batch.values()].sort((a, b) =>
              BigInt(a.id) < BigInt(b.id) ? -1 : 1,
            );
            for (const message of sorted) await observe(message);
            if (sorted.length) {
              after = sorted.at(-1).id;
              save("ticket-notes-discord", ticket.id, {
                ...store.get("ticket-notes-discord", ticket.id),
                after,
              });
            }
            if (batch.size < 100) break;
          }
          const current = store.get("ticket-notes-discord", ticket.id);
          const batch = await target.messages.fetch({
            limit: 100,
            ...(current.before ? { before: current.before } : {}),
          });
          for (const message of batch.values()) await observe(message);
          const oldest = [...batch.keys()].sort((a, b) =>
            BigInt(a) < BigInt(b) ? -1 : 1,
          )[0];
          for (const message of service
            .messages(ticket.id)
            .filter(
              (value) =>
                value.internal &&
                value.notesThreadId === target.id &&
                value.origin === "discord" &&
                !value.deleted,
            )) {
            if (
              current.before &&
              BigInt(message.discordId) >= BigInt(current.before)
            )
              continue;
            if (
              batch.size === 100 &&
              BigInt(message.discordId) < BigInt(oldest)
            )
              continue;
            if (!batch.has(message.discordId))
              service.ingest(ticket.id, {
                id: message.discordId,
                internal: true,
                deleted: true,
              });
          }
          save("ticket-notes-discord", ticket.id, {
            ...store.get("ticket-notes-discord", ticket.id),
            before: batch.size === 100 ? oldest : null,
          });
        } catch {
          if (!ticket?.erasingAt)
            console.error("Internal ticket notes recovery is pending.");
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }
  async function retire(
    ticket,
    state = store.get("ticket-notes-discord", ticket.id),
  ) {
    if (!state) return;
    let target;
    try {
      const main = await guild(stateGuild(state));
      if (state.threadId) target = await main.channels.fetch(state.threadId);
      else {
        const previous = await main.channels.fetch(state.parentId);
        if (previous) target = await findThread(previous, ticket, state);
      }
    } catch (error) {
      if (error.code !== 10003) throw error;
    }
    if (target?.pending) return target;
    if (target) {
      owned(target, ticket, state);
      state.threadId = target.id;
      save("ticket-notes-channel", target.id, { ticketId: ticket.id });
      if (!target.locked) await target.setLocked(true);
      if (!target.archived) await target.setArchived(true);
      for (let page = 0; !state.historySaved && page < 5; page++) {
        const messages = await target.messages.fetch({
          limit: 100,
          ...(state.captureBefore ? { before: state.captureBefore } : {}),
        });
        for (const message of messages.values()) await observe(message, true);
        state.captureBefore =
          messages.size === 100
            ? [...messages.keys()].sort((a, b) =>
                BigInt(a) < BigInt(b) ? -1 : 1,
              )[0]
            : null;
        state.historySaved = !state.captureBefore;
        save("ticket-notes-discord", ticket.id, state);
      }
      if (!state.historySaved || !(await retainMedia(ticket, target.id)))
        return { pending: true };
      try {
        await target.delete("Internal notes preserved in the ticket dashboard");
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
    }
    if (state.threadId) store.delete("ticket-notes-channel", state.threadId);
    store.delete("ticket-notes-discord", ticket.id);
  }
  async function deleteThread(ticket) {
    await pendingThreads.get(ticket.id);
    return retire(ticket);
  }
  async function erase(ticket) {
    const state = store.get("ticket-notes-discord", ticket.id);
    if (!state) return;
    let target;
    if (state.threadId) {
      try {
        target = await (
          await guild(stateGuild(state))
        ).channels.fetch(state.threadId);
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
    } else {
      let parent;
      try {
        parent = await (
          await guild(stateGuild(state))
        ).channels.fetch(state.parentId);
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
      if (parent) target = await findThread(parent, ticket, state);
    }
    if (target?.pending)
      throw new Error("Internal notes erasure discovery is pending");
    if (target) {
      owned(target, ticket, state);
      await target.delete("Ticket inactivity retention expired");
    }
  }
  const onMessage = (message) => {
    void observe(message).catch(() =>
      console.error("Internal ticket note ingestion is pending."),
    );
  };
  const onRaw = (event) => {
    if (
      !["MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK"].includes(
        event.t,
      )
    )
      return;
    let ticket;
    try {
      ticket = linked(event.d.channel_id);
    } catch {
      return;
    }
    if (!ticket) return;
    const state = store.get("ticket-notes-discord", ticket.id);
    if (!state || event.d.guild_id !== stateGuild(state)) return;
    if (event.t !== "MESSAGE_UPDATE") {
      for (const id of event.d.ids || [event.d.id])
        service.ingest(ticket.id, { id, deleted: true, internal: true });
    } else
      void (async () => {
        const target = await (
          await guild(stateGuild(state))
        ).channels.fetch(event.d.channel_id);
        await observe(await target.messages.fetch(event.d.id));
      })().catch(() =>
        console.error("Internal ticket note edit recovery is pending."),
      );
  };
  client.on("messageCreate", onMessage);
  client.on("raw", onRaw);
  service.registerCleanupWaiter(() =>
    Promise.allSettled([running, ...pendingThreads.values()]),
  );
  return {
    ensure,
    send,
    recover,
    refreshPermissions,
    deleteThread,
    erase,
    async close() {
      stopped = true;
      client.off("messageCreate", onMessage);
      client.off("raw", onRaw);
      await Promise.allSettled([running, ...pendingThreads.values()]);
    },
  };
}
