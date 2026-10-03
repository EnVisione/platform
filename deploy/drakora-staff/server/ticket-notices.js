export function ticketNotices(
  config,
  service,
  transport,
  { now = Date.now } = {},
) {
  const store = service.store;
  let running,
    timer,
    stopped = false;
  const save = (kind, key, value) =>
    store.set(kind, key, value, Number.MAX_SAFE_INTEGER);

  function finish(key, job, result) {
    store.transaction(() => {
      save("ticket-notice-delivery", key, {
        ticketId: job.ticketId,
        event: job.event,
        channelId: job.channelId,
        at: now(),
        ...result,
      });
      store.delete("ticket-notice-outbox", key);
      store.delete("ticket-notice-send", key);
    });
  }
  function pump() {
    if (running || stopped || !config.tickets.staffChannelId) return running;
    running = Promise.resolve()
      .then(async () => {
        let processed = 0;
        for (const [key, job] of store.entries("ticket-notice-outbox")) {
          if (stopped || processed >= 20) break;
          const ticket = service.get(job.ticketId);
          if (
            ["closed", "awaiting_resolution"].includes(ticket.status) ||
            (job.event === "unclaimed" &&
              (ticket.status !== "pending" || ticket.claimedBy))
          ) {
            finish(key, job, { status: "cancelled" });
            continue;
          }
          if (job.failed || job.after > now() || !ticket.channelId) continue;
          if (store.get("ticket-outbox", `${ticket.id}:create:${ticket.id}`))
            continue;
          if (
            job.event === "unclaimed" &&
            store.get("ticket-notice-delivery", `${ticket.id}:opened`)
              ?.status !== "sent"
          )
            continue;
          processed++;
          try {
            const sent = await transport.notice(ticket, job, key);
            if (sent.pending) {
              save("ticket-notice-outbox", key, {
                ...job,
                after: now() + 5000,
              });
              continue;
            }
            finish(
              key,
              job,
              sent.cancelled
                ? { status: "cancelled" }
                : { status: "sent", messageId: sent.id },
            );
          } catch (error) {
            job.attempts++;
            job.after = now() + Math.min(60000, 1000 * 2 ** job.attempts);
            job.failed = job.attempts >= 20;
            save("ticket-notice-outbox", key, job);
            console.error(
              `Ticket staff notice ${job.failed ? "failed" : "retry"} ${error.code || error.name || "Error"}`,
            );
          }
        }
      })
      .finally(() => {
        running = null;
      });
    return running;
  }
  const changed = () => void pump();
  return {
    pump,
    start() {
      if (!config.tickets.staffChannelId) return;
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
    },
  };
}
