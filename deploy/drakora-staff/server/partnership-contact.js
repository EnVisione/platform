import { createHash } from "node:crypto";
import { ticketUploadLimit, ticketMediaDays } from "../shared/tickets.js";

const forever = Number.MAX_SAFE_INTEGER;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sendId = (value) => {
  const hex = digest(value).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const address = "partners@drakora.org";

export function partnershipContact(
  config,
  tickets,
  mail,
  client,
  media,
  { now = Date.now } = {},
) {
  const store = tickets.store;
  let running,
    incoming,
    timer,
    inboxTimer,
    stopped = false;
  const save = (kind, key, value) => store.set(kind, key, value, forever);
  const notify = (ticket) =>
    tickets.events.emit("changed", {
      id: ticket.id,
      revision: ticket.revision,
    });
  function content(ticket, job, message) {
    const reference = ticket.id;
    if (job.kind === "message")
      return `${message.actor.name} · Drakora partnerships\n\n${message.content}`;
    if (job.kind === "opened")
      return `Thanks for reaching out, ${ticket.owner.name}. We received your modpack partnership request for ${ticket.partnership.packUrl}. Our partnerships team will review it and reply here.\n\nReference: ${reference}`;
    if (ticket.status === "closed")
      return `Our team has finished reviewing your partnership request and closed it.\n\nReference: ${reference}`;
    return `${ticket.claimedBy?.name || "Our partnerships team"} is reviewing your modpack partnership request.\n\nReference: ${reference}`;
  }
  async function email(ticket, job, message, files) {
    if (
      !mail.identities.some(
        (identity) => identity.address.toLowerCase() === address,
      )
    )
      throw Object.assign(new Error("Partnership inbox is unavailable"), {
        code: "partnership_inbox_unavailable",
      });
    if (!store.get("partnership-mail", "cursor")) {
      await poll();
      if (!store.get("partnership-mail", "cursor"))
        throw Object.assign(new Error("Inbox sync unavailable"), {
          code: "mail_unavailable",
        });
    }
    const id = `<partnership-${ticket.id}-${digest(job.id + job.generation).slice(0, 24)}@drakora.org>`;
    save("partnership-email-reference", digest(id), { ticketId: ticket.id });
    const result = await mail.send(
      `partnership:${ticket.id}`,
      {
        sendId: sendId(job.id + job.generation),
        from: address,
        to: ticket.contactEmail,
        subject: `Drakora modpack partnership · ${ticket.id.slice(0, 8)}`,
        text: `${content(ticket, job, message)}\n\nReply to this email to reach our partnerships team.`,
        attachments: files.map(({ name, bytes }) => ({
          filename: name,
          content: bytes.toString("base64"),
        })),
        ...(ticket.partnership.lastEmail
          ? { reply: { kind: "reply", ...ticket.partnership.lastEmail } }
          : {}),
      },
      undefined,
      { messageId: id },
    );
    if (
      !result.accepted.some(
        (recipient) =>
          recipient.toLowerCase() === ticket.contactEmail.toLowerCase(),
      )
    )
      throw Object.assign(new Error("Email recipient was rejected"), {
        code: "partnership_email_rejected",
      });
    return { id: result.messageId, via: "email" };
  }
  async function deliver(ticket, job, message) {
    const files = [];
    for (const id of message?.attachments || []) {
      const file = store.get("ticket-media", id);
      files.push({ name: file.name, bytes: await media.bytes(file) });
    }
    if (
      ticket.partnership.preference !== "discord" ||
      ticket.partnership.emailFallback
    )
      return email(ticket, job, message, files);
    if (!client.isReady())
      throw Object.assign(new Error("Discord unavailable"), {
        code: "discord_unavailable",
      });
    try {
      const user = await client.users.fetch(ticket.partnership.discordId);
      const channel = await user.createDM();
      const body = content(ticket, job, message);
      const parts = body.match(/[\s\S]{1,1850}/g) || [""];
      let last;
      for (let part = 0; part < parts.length; part++) {
        const key = `${job.id}:${job.generation}:${part}`;
        const marker = `Request ${ticket.id.slice(0, 8)} · ${digest(key).slice(0, 10)}${parts.length > 1 ? ` · ${part + 1}/${parts.length}` : ""}`;
        const intent = store.get("partnership-dm-send", key);
        if (intent?.messageId) {
          last = intent.messageId;
          continue;
        }
        if (intent) {
          const recent = await channel.messages.fetch({ limit: 100 });
          const found = recent.find(
            (entry) =>
              entry.author.id === client.user.id &&
              entry.content.endsWith(marker),
          );
          if (found) {
            save("partnership-dm-send", key, {
              ...intent,
              messageId: found.id,
            });
            last = found.id;
            continue;
          }
          if (
            recent.size === 100 &&
            [...recent.values()].every(
              (entry) => entry.createdTimestamp > intent.at,
            )
          )
            throw Object.assign(
              new Error("DM delivery requires reconciliation"),
              { code: "partnership_delivery_uncertain" },
            );
        }
        save("partnership-dm-send", key, { at: now() });
        const sent = await channel.send({
          content: `${parts[part]}\n\n${marker}`,
          files:
            part === 0
              ? files.map((file) => ({
                  attachment: file.bytes,
                  name: file.name,
                }))
              : [],
          nonce: digest(key).slice(0, 25),
          enforceNonce: true,
          allowedMentions: { parse: [] },
        });
        save("partnership-dm-send", key, { at: now(), messageId: sent.id });
        last = sent.id;
      }
      return { id: last, via: "discord" };
    } catch (error) {
      if (error.code !== 50007) throw error;
      const current = tickets.get(ticket.id);
      current.partnership.emailFallback = true;
      save("ticket", ticket.id, current);
      return email(current, job, message, files);
    }
  }
  function pump() {
    if (running || stopped) return running;
    running = Promise.resolve()
      .then(async () => {
        const blocked = new Set();
        let processed = 0;
        for (const [key, job] of store
          .entries("partnership-outbox")
          .sort(
            ([, a], [, b]) =>
              a.ticketId.localeCompare(b.ticketId) ||
              (a.kind === "opened"
                ? -1
                : b.kind === "opened"
                  ? 1
                  : a.ref.localeCompare(b.ref)),
          )) {
          if (stopped || processed >= 10) break;
          if (blocked.has(job.ticketId)) continue;
          if (job.after > now() || job.failed) {
            blocked.add(job.ticketId);
            continue;
          }
          processed++;
          const ticket = tickets.get(job.ticketId);
          const message =
            job.kind === "message"
              ? store.get(`ticket-messages:${ticket.id}`, job.ref)
              : null;
          try {
            const result = await deliver(ticket, job, message);
            store.transaction(() => {
              if (message) {
                message.delivery = "delivered";
                message.deliveredVia = result.via;
                save(`ticket-messages:${ticket.id}`, job.ref, message);
              }
              save("partnership-delivery", key + job.generation, {
                ...result,
                at: now(),
                ticketId: ticket.id,
              });
              if (
                store.get("partnership-outbox", key)?.generation ===
                job.generation
              )
                store.delete("partnership-outbox", key);
              const current = tickets.get(ticket.id);
              current.revision++;
              save("ticket", current.id, current);
              notify(current);
            });
          } catch (error) {
            blocked.add(ticket.id);
            job.attempts++;
            job.failure = error.code || "contact_unavailable";
            job.failed =
              [
                "mail_send_uncertain",
                "partnership_delivery_uncertain",
                "partnership_email_rejected",
              ].includes(job.failure) || job.attempts >= 8;
            job.after = now() + Math.min(300000, 2000 * 2 ** job.attempts);
            if (
              store.get("partnership-outbox", key)?.generation ===
              job.generation
            )
              save("partnership-outbox", key, job);
            if (message) {
              message.delivery = job.failed ? "failed" : "pending";
              save(`ticket-messages:${ticket.id}`, job.ref, message);
            }
            console.error("Partnership delivery pending:", job.failure);
            notify(tickets.get(ticket.id));
          }
        }
      })
      .finally(() => {
        running = null;
      });
    return running;
  }
  async function ingestEmail(item, validity) {
    const message = await mail.detail({
      folder: "INBOX",
      uid: item.uid,
      validity,
    });
    const ticketId = [message.inReplyTo, ...message.references]
      .map(
        (ref) =>
          ref &&
          store.get("partnership-email-reference", digest(ref))?.ticketId,
      )
      .find(Boolean);
    if (!ticketId) return;
    const ticket = tickets.get(ticketId);
    if (
      ticket.type !== "partnership" ||
      ticket.status === "closed" ||
      !message.from.some(
        (entry) =>
          entry.address.toLowerCase() === ticket.contactEmail.toLowerCase(),
      ) ||
      ![
        ...message.to,
        ...message.cc,
        ...(message.mailboxes || []).map((address) => ({ address })),
      ].some((entry) => entry.address.toLowerCase() === address)
    )
      return;
    const id = `email:${message.messageId || `${validity}:${item.uid}`}`;
    if (store.get("ticket-discord-message", id)) return;
    const attachments = [];
    for (const file of message.attachments.slice(0, 5)) {
      if (
        file.size > ticketUploadLimit ||
        !/\.(png|jpe?g|webp|gif|pdf|zip|txt|log)$/i.test(file.filename)
      )
        continue;
      const data = await mail.attachment({
        folder: "INBOX",
        uid: item.uid,
        validity,
        part: file.part,
      });
      if (data.content.length > ticketUploadLimit) continue;
      const uploaded = await media.upload(
        data.content,
        data.filename,
        file.type,
        ticket,
      );
      attachments.push(tickets.importMedia(ticket.id, ticket.owner, uploaded));
    }
    tickets.ingest(ticket.id, {
      id,
      actor: ticket.owner,
      at: now(),
      content: message.replyText || "Email attachment received",
      attachments,
      origin: "email",
    });
    const current = tickets.get(ticket.id);
    current.partnership.lastEmail = {
      folder: "INBOX",
      uid: item.uid,
      validity,
    };
    save("ticket", ticket.id, current);
  }
  function poll() {
    if (incoming || stopped) return incoming;
    incoming = Promise.resolve()
      .then(async () => {
        const cursor = store.get("partnership-mail", "cursor");
        const result = await mail.incoming(cursor);
        for (const item of result.items) {
          if (stopped) return;
          if (
            [...item.to, ...item.cc].some(
              (entry) => entry.address.toLowerCase() === address,
            )
          )
            await ingestEmail(item, result.validity);
          save("partnership-mail", "cursor", {
            validity: result.validity,
            uid: item.uid,
          });
        }
        save("partnership-mail", "cursor", {
          validity: result.validity,
          uid: result.through,
        });
        await recoverDms();
      })
      .catch((error) => {
        console.error(
          "Partnership inbox sync pending:",
          error.code || "mail_unavailable",
        );
      })
      .finally(() => {
        incoming = null;
      });
    return incoming;
  }
  const dmRequests = new Map();
  async function ingestDm(message) {
    if (stopped || message.guildId || message.author.bot) return;
    const candidates = tickets
      .all()
      .filter(
        (ticket) =>
          ticket.type === "partnership" &&
          ticket.partnership.preference === "discord" &&
          ticket.partnership.discordId === message.author.id &&
          ["pending", "claimed"].includes(ticket.status),
      );
    if (candidates.length !== 1) return;
    const ticket = candidates[0];
    if (store.get("ticket-discord-message", message.id)) return;
    const attachments = [];
    for (const file of [...message.attachments.values()].slice(0, 5)) {
      if (
        file.size > ticketUploadLimit ||
        !/\.(png|jpe?g|webp|gif|pdf|zip|txt|log)$/i.test(file.name)
      )
        continue;
      const bytes = await media.bytes({
        channelId: message.channelId,
        messageId: message.id,
        attachmentId: file.id,
        directMessage: true,
        expiresAt: now() + ticketMediaDays * 86400000,
      });
      attachments.push(
        tickets.importMedia(
          ticket.id,
          ticket.owner,
          await media.upload(
            bytes,
            file.name,
            file.contentType || "application/octet-stream",
            ticket,
          ),
        ),
      );
    }
    tickets.ingest(ticket.id, {
      id: message.id,
      actor: ticket.owner,
      at: message.createdTimestamp,
      content: message.content,
      attachments,
    });
  }
  function receiveDm(message) {
    if (dmRequests.has(message.id)) return dmRequests.get(message.id);
    const pending = ingestDm(message).finally(() =>
      dmRequests.delete(message.id),
    );
    dmRequests.set(message.id, pending);
    return pending;
  }
  async function recoverDms() {
    if (!client.isReady()) return;
    for (const ticket of tickets
      .all()
      .filter(
        (ticket) =>
          ticket.type === "partnership" &&
          ticket.partnership.preference === "discord" &&
          ["pending", "claimed"].includes(ticket.status),
      )) {
      if (stopped) return;
      const channel = await (
        await client.users.fetch(ticket.partnership.discordId)
      ).createDM();
      const key = ticket.id;
      const after =
        store.get("partnership-dm-cursor", key)?.id ||
        String(BigInt(Math.max(0, ticket.createdAt - 1420070400000)) << 22n);
      const recent = await channel.messages.fetch({ limit: 100, after });
      const ordered = [...recent.values()].sort((a, b) =>
        BigInt(a.id) < BigInt(b.id) ? -1 : 1,
      );
      for (const message of ordered) {
        await receiveDm(message);
        save("partnership-dm-cursor", key, { id: message.id });
      }
    }
  }
  const changed = () => void pump();
  const dm = (message) => {
    void receiveDm(message).catch((error) =>
      console.error(
        "Partnership DM sync pending:",
        error.code || "discord_unavailable",
      ),
    );
  };
  return {
    pump,
    poll,
    receiveDm,
    start() {
      tickets.events.on("changed", changed);
      client.on("messageCreate", dm);
      timer = setInterval(changed, 1000);
      timer.unref();
      inboxTimer = setInterval(() => void poll(), 30000);
      inboxTimer.unref();
      changed();
      void poll();
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      clearInterval(inboxTimer);
      tickets.events.off("changed", changed);
      client.off("messageCreate", dm);
      await Promise.allSettled([running, incoming, ...dmRequests.values()]);
    },
  };
}
