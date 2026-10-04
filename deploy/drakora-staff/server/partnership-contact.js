import { createHash } from "node:crypto";

const forever = Number.MAX_SAFE_INTEGER;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sendId = (value) => {
  const hex = digest(value).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const address = "partners@drakora.org";

export function partnershipContact(
  tickets,
  mail,
  client,
  { now = Date.now } = {},
) {
  const store = tickets.store;
  let running,
    timer,
    stopped = false;
  const save = (kind, key, value) => store.set(kind, key, value, forever);
  const notify = (ticket) =>
    tickets.events.emit("changed", {
      id: ticket.id,
      revision: ticket.revision,
    });
  function content(ticket, job) {
    const decision = ticket.partnership.decision;
    const body =
      job.kind === "opened"
        ? `Thanks for applying, ${ticket.owner.name}. We received your modpack partnership request for ${ticket.partnership.packUrl}. Our partnerships team will review it and notify you of its decision.`
        : decision.outcome === "accepted"
          ? `Good news, ${ticket.owner.name}! We accepted your modpack partnership request. Our partnerships team will be in touch with more information and next steps. This approval does not automatically provision a server.`
          : `Thank you for applying, ${ticket.owner.name}. We are unable to accept your modpack partnership request at this time. We appreciate the time you put into your proposal.`;
    return [
      body,
      ...(job.kind === "decision" && decision.reason ? [decision.reason] : []),
      `Reference: ${ticket.id}`,
    ].join("\n\n");
  }
  async function email(ticket, job) {
    if (
      !mail.identities.some(
        (identity) => identity.address.toLowerCase() === address,
      )
    )
      throw Object.assign(new Error("Partnership inbox is unavailable"), {
        code: "partnership_inbox_unavailable",
      });
    const id = `<partnership-${ticket.id}-${digest(job.id + job.generation).slice(0, 24)}@drakora.org>`;
    const result = await mail.send(
      `partnership:${ticket.id}`,
      {
        sendId: sendId(job.id + job.generation),
        from: address,
        to: ticket.contactEmail,
        subject: `Drakora modpack partnership · ${ticket.id.slice(0, 8)}`,
        text: `${content(ticket, job)}\n\nQuestions? Contact partners@drakora.org.`,
        attachments: [],
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
  async function deliver(ticket, job) {
    if (
      ticket.partnership.preference !== "discord" ||
      ticket.partnership.emailFallback
    )
      return email(ticket, job);
    if (!client.isReady())
      throw Object.assign(new Error("Discord unavailable"), {
        code: "discord_unavailable",
      });
    try {
      const user = await client.users.fetch(ticket.partnership.discordId);
      const channel = await user.createDM();
      const body = content(ticket, job);
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
              channelId: channel.id,
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
          nonce: digest(key).slice(0, 25),
          enforceNonce: true,
          allowedMentions: { parse: [] },
        });
        save("partnership-dm-send", key, {
          at: now(),
          messageId: sent.id,
          channelId: channel.id,
        });
        last = sent.id;
      }
      return { id: last, via: "discord" };
    } catch (error) {
      if (error.code !== 50007) throw error;
      const current = tickets.get(ticket.id);
      current.partnership.emailFallback = true;
      save("ticket", ticket.id, current);
      return email(current, job);
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
          processed++;
          if (store.get("ticket", job.ticketId)?.erasingAt) continue;
          const ticket = tickets.get(job.ticketId);
          if (!["opened", "decision"].includes(job.kind)) {
            if (job.kind === "message") {
              const message = store.get(
                `ticket-messages:${ticket.id}`,
                job.ref,
              );
              if (message?.delivery === "pending") {
                message.delivery = "cancelled";
                save(`ticket-messages:${ticket.id}`, job.ref, message);
              }
            }
            store.delete("partnership-outbox", key);
            ticket.revision++;
            save("ticket", ticket.id, ticket);
            notify(ticket);
            continue;
          }
          if (
            job.kind === "decision" &&
            ticket.partnership.decision?.id !== job.ref
          ) {
            store.delete("partnership-outbox", key);
            continue;
          }
          if (blocked.has(job.ticketId)) continue;
          if (job.after > now() || job.failed) {
            blocked.add(job.ticketId);
            continue;
          }
          try {
            const result = await deliver(ticket, job);
            store.transaction(() => {
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
            ) {
              store.transaction(() => {
                save("partnership-outbox", key, job);
                const current = tickets.get(ticket.id);
                current.revision++;
                save("ticket", current.id, current);
                notify(current);
              });
            }
            console.error("Partnership delivery pending:", job.failure);
          }
        }
      })
      .finally(() => {
        running = null;
      });
    return running;
  }
  tickets.registerCleanupWaiter?.(() => running);
  const changed = () => void pump();
  return {
    pump,
    start() {
      if (timer || stopped) return;
      tickets.events.on("changed", changed);
      timer = setInterval(changed, 1000);
      timer.unref();
      changed();
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      tickets.events.off("changed", changed);
      await running;
    },
  };
}
