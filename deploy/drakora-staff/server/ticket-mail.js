import { bridgeMailTransport } from "./bridge-mail.js";
import { hash } from "./store.js";
import { randomBytes } from "node:crypto";
import { ticketStatusLabel } from "../shared/tickets.js";

export function ticketMail(config, service, suppliedTransport) {
  const smtp = config.applications?.smtp;
  const transport = suppliedTransport || (smtp && bridgeMailTransport(smtp));
  let running,
    timer,
    stopped = false;
  async function pump() {
    if (!transport || stopped || running) return running;
    running = Promise.resolve()
      .then(async () => {
        const jobs = service.store
          .entries("ticket-email-outbox")
          .sort(
            ([, a], [, b]) =>
              a.ticketId.localeCompare(b.ticketId) || a.revision - b.revision,
          );
        const blocked = new Set();
        let sent = 0;
        for (const [key, job] of jobs) {
          if (stopped || sent >= 20) break;
          if (blocked.has(job.ticketId)) continue;
          if (job.after > Date.now()) {
            blocked.add(job.ticketId);
            continue;
          }
          if (service.store.get("ticket", job.ticketId)?.erasingAt) continue;
          const ticket = service.get(job.ticketId);
          if (!ticket.contactEmail) {
            service.store.delete("ticket-email-outbox", key);
            continue;
          }
          const subject =
            job.event === "opened"
              ? "Your ticket is open"
              : job.event === "message"
                ? `Staff replied to your ticket${job.actor?.name ? `: ${job.actor.name}` : ""}`
                : job.event === "claimed"
                  ? `${job.actor?.name || "A staff member"} claimed your ticket`
                  : job.event === "taken_over"
                    ? `${job.actor?.name || "A staff member"} took over your ticket`
                    : `Ticket update: ${ticketStatusLabel(job)}`;
          try {
            sent++;
            if (!job.accessToken) {
              job.accessToken = randomBytes(32).toString("base64url");
              service.store.transaction(() => {
                service.store.set(
                  "ticket-email-access",
                  hash(job.accessToken),
                  { ticketId: ticket.id },
                  Date.now() + 7 * 86400000,
                );
                service.store.set(
                  "ticket-email-outbox",
                  key,
                  job,
                  Number.MAX_SAFE_INTEGER,
                );
              });
            }
            const result = await transport.sendMail({
              from: { name: "Drakora Support", address: smtp.from },
              replyTo: smtp.replyTo,
              to: { address: ticket.contactEmail },
              subject: `Drakora · ${subject}`,
              messageId: `<ticket-${hash(key)}@${smtp.from.split("@")[1]}>`,
              text: `${subject}\n\nTicket for ${ticket.ign}\nReference: ${ticket.id}\n\nOpen your private conversation:\n${config.applications.publicOrigin}/help/access/${job.accessToken}\n\nThis private link can be used once and expires after seven days. Keep it private. Reply on the ticket page. You requested email updates when opening this ticket.`,
              disableFileAccess: true,
              disableUrlAccess: true,
            });
            if (
              !result.accepted?.some(
                (email) =>
                  email.toLowerCase() === ticket.contactEmail.toLowerCase(),
              )
            )
              throw Object.assign(new Error("Recipient not accepted"), {
                responseCode: 550,
              });
            service.store.transaction(() => {
              service.store.set(
                "ticket-email-delivery",
                key,
                { sentAt: Date.now() },
                Number.MAX_SAFE_INTEGER,
              );
              service.store.delete("ticket-email-outbox", key);
            });
          } catch (error) {
            blocked.add(job.ticketId);
            job.attempts++;
            const failed = job.attempts >= 8 || error.responseCode >= 500;
            if (failed) {
              service.store.set(
                "ticket-email-delivery",
                key,
                { failedAt: Date.now() },
                Number.MAX_SAFE_INTEGER,
              );
              service.store.delete("ticket-email-outbox", key);
            } else {
              job.after =
                Date.now() + Math.min(600000, 1000 * 2 ** job.attempts);
              service.store.set(
                "ticket-email-outbox",
                key,
                job,
                Number.MAX_SAFE_INTEGER,
              );
            }
            console.error(
              "Ticket email delivery is pending:",
              failed ? "recipient_or_retry_limit" : "mail_unavailable",
            );
          }
        }
      })
      .finally(() => {
        running = null;
      });
    return running;
  }
  service.registerCleanupWaiter?.(() => running);
  const changed = () => {
    void pump();
  };
  return {
    pump,
    start() {
      service.events.on("changed", changed);
      timer = setInterval(changed, 5000);
      timer.unref();
      changed();
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      service.events.off("changed", changed);
      await running;
      transport?.close();
    },
  };
}
