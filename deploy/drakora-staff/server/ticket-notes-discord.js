import { createHash } from "node:crypto";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { ticketCategory } from "../shared/tickets.js";

const forever = Number.MAX_SAFE_INTEGER;
const title = (id) => `ticket-${id}-internal-notes`;
const footer = (id) => `Drakora internal note ${id}`;

export function ticketNotesDiscord(
  config,
  service,
  client,
  { staffUser, staffMembers, overwrites, ready, bytes },
) {
  let running,
    stopped = false;
  const store = service.store;
  const save = (kind, id, value) => store.set(kind, id, value, forever);
  const guild = () => client.guilds.fetch(config.guildId);
  const linked = (id) => {
    const ref = store.get("ticket-notes-channel", id);
    return ref ? service.get(ref.ticketId) : null;
  };
  function permissions(members, category) {
    return overwrites(members, null, category).map((entry) => {
      if (entry.id === config.tickets.guildId)
        return {
          ...entry,
          id: config.guildId,
          deny: [
            ...entry.deny,
            P.ManageThreads,
            P.CreatePublicThreads,
            P.CreatePrivateThreads,
          ],
        };
      if (entry.id === client.user.id)
        return {
          ...entry,
          allow: [
            ...entry.allow,
            P.CreatePrivateThreads,
            P.SendMessagesInThreads,
            P.ManageThreads,
          ],
        };
      const reply = entry.allow.includes(P.SendMessages);
      return {
        ...entry,
        allow: entry.allow
          .filter((bit) => bit !== P.SendMessages)
          .concat(reply ? [P.SendMessagesInThreads] : []),
        deny: [
          ...entry.deny,
          P.SendMessages,
          P.ManageThreads,
          P.CreatePublicThreads,
          P.CreatePrivateThreads,
          ...(reply ? [] : [P.SendMessagesInThreads]),
        ],
      };
    });
  }
  async function parent(ticket, members) {
    const category = ticketCategory(ticket),
      main = await guild();
    const settings = store.get("ticket-notes-settings", "parents") || {};
    const channels = await main.channels.fetch();
    const topic = `Drakora staff-only ${category} ticket notes.`;
    let target =
      channels.get(settings[category]) ||
      [...channels.values()].find((value) => value?.topic === topic);
    if (
      target &&
      (target.guildId !== config.guildId ||
        target.type !== ChannelType.GuildText ||
        target.topic !== topic)
    )
      throw new Error("Internal notes parent ownership does not match");
    if (!target)
      target = await main.channels.create({
        name: `${category}-internal-notes`,
        type: ChannelType.GuildText,
        topic,
        permissionOverwrites: permissions(members, category),
      });
    await target.permissionOverwrites.set(permissions(members, category));
    settings[category] = target.id;
    save("ticket-notes-settings", "parents", settings);
    return target;
  }
  function owned(target, ticket, state) {
    if (
      target.guildId !== config.guildId ||
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
    const allowed = new Set(
      members
        .filter((user) => {
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
  async function thread(ticket, create = true, batch) {
    await ready();
    const members = batch?.members || (await staffMembers());
    const category = ticketCategory(ticket);
    if (batch && !batch.parents.has(category))
      batch.parents.set(category, parent(ticket, members));
    const target = batch
      ? await batch.parents.get(category)
      : await parent(ticket, members);
    let state = store.get("ticket-notes-discord", ticket.id) || {
      ticketId: ticket.id,
      parentId: target.id,
    };
    if (state.parentId !== target.id) {
      let previous;
      try {
        previous = await (await guild()).channels.fetch(state.parentId);
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
      if (previous) throw new Error("Internal notes parent changed");
      if (state.threadId) store.delete("ticket-notes-channel", state.threadId);
      state = { ticketId: ticket.id, parentId: target.id };
      save("ticket-notes-discord", ticket.id, state);
    }
    let result;
    if (state.threadId) {
      try {
        result = await (await guild()).channels.fetch(state.threadId);
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
      if (!result) {
        store.delete("ticket-notes-channel", state.threadId);
        state = { ticketId: ticket.id, parentId: target.id };
        save("ticket-notes-discord", ticket.id, state);
      }
    }
    if (!result) {
      save("ticket-notes-discord", ticket.id, state);
      result = await findThread(target, ticket, state);
      if (result?.pending) return result;
      if (!result && !create) return null;
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
  async function send(ticket, message, attachments) {
    if (!message.internal)
      throw new Error("Only internal notes can use the staff thread");
    const target = await thread(ticket);
    if (target.pending) return target;
    if (target.archived) await target.setArchived(false);
    const key = `note:${message.id}`;
    let intent = store.get("ticket-send", key);
    if (intent?.threadId !== target.id) intent = null;
    if (intent?.acknowledgedId) return { id: intent.acknowledgedId };
    function acknowledge(sent) {
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
    const sent = await target.send({
      embeds: [
        {
          title: `${message.actor.name.slice(0, 80)} · Internal staff note`,
          description: message.content || undefined,
          footer: { text: footer(message.id) },
          url: `${config.staffOrigin}/tickets/${ticket.id}`,
          timestamp: new Date(message.at).toISOString(),
        },
      ],
      files,
      allowedMentions: { parse: [] },
      nonce: createHash("sha256").update(key).digest("hex").slice(0, 25),
      enforceNonce: true,
    });
    return acknowledge(sent);
  }
  async function observe(message) {
    if (
      stopped ||
      message.author?.bot ||
      message.system ||
      message.webhookId ||
      message.guildId !== config.guildId
    )
      return;
    const ticket = linked(message.channelId);
    if (!ticket) return;
    const user = await staffUser(message.author.id);
    try {
      service.staff(user || { roles: [] }, ticket, "tickets.reply");
    } catch (error) {
      if (error.code === "ticket_access_denied") return;
      throw error;
    }
    service.ingest(ticket.id, {
      id: message.id,
      channelId: message.channelId,
      actor: user,
      staff: true,
      internal: true,
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
  async function refreshPermissions() {
    const members = await staffMembers();
    const parents = store.get("ticket-notes-settings", "parents") || {};
    for (const [category, id] of Object.entries(parents)) {
      const target = await (await guild()).channels.fetch(id);
      if (target)
        await target.permissionOverwrites.set(permissions(members, category));
    }
    for (const [, state] of store.entries("ticket-notes-discord")) {
      const ticket = service.get(state.ticketId);
      if (!state.threadId) continue;
      let target;
      try {
        target = await (await guild()).channels.fetch(state.threadId);
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
      if (target) {
        owned(target, ticket, state);
        await synchronize(target, ticket, members);
      }
    }
  }
  async function recover() {
    if (stopped || running || !client.isReady()) return running;
    running = (async () => {
      if (!store.entries("ticket-notes-discord").length) return;
      const context = { members: await staffMembers(), parents: new Map() };
      for (const [, state] of store.entries("ticket-notes-discord")) {
        let ticket;
        try {
          ticket = service.get(state.ticketId);
          const target = await thread(ticket, false, context);
          if (!target || target.pending) continue;
          let after = state.after || target.id;
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
  async function erase(ticket) {
    const state = store.get("ticket-notes-discord", ticket.id);
    if (!state) return;
    let target;
    if (state.threadId) {
      try {
        target = await (await guild()).channels.fetch(state.threadId);
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
    } else {
      let parent;
      try {
        parent = await (await guild()).channels.fetch(state.parentId);
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
      event.d?.guild_id !== config.guildId ||
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
    if (event.t !== "MESSAGE_UPDATE") {
      for (const id of event.d.ids || [event.d.id])
        service.ingest(ticket.id, { id, deleted: true, internal: true });
    } else
      void (async () => {
        const target = await (await guild()).channels.fetch(event.d.channel_id);
        await observe(await target.messages.fetch(event.d.id));
      })().catch(() =>
        console.error("Internal ticket note edit recovery is pending."),
      );
  };
  client.on("messageCreate", onMessage);
  client.on("raw", onRaw);
  service.registerCleanupWaiter(() => running);
  return {
    send,
    recover,
    refreshPermissions,
    erase,
    async close() {
      stopped = true;
      client.off("messageCreate", onMessage);
      client.off("raw", onRaw);
      await running;
    },
  };
}
