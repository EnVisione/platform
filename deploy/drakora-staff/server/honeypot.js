import { createHmac, randomUUID } from "node:crypto";

const day = 86400000;
const permanent = Number.MAX_SAFE_INTEGER;
const profileText = (value) =>
  typeof value === "string"
    ? value.replace(/\p{C}/gu, "").trim().slice(0, 80)
    : undefined;

export function honeypotService(
  config,
  store,
  transport,
  { now = Date.now } = {},
) {
  const settings = config.honeypot;
  let stopped = false;
  let running;
  let timer;
  const key = (value) =>
    createHmac("sha256", config.sessionSecret)
      .update(`honeypot:${settings.guildId}:${value}`)
      .digest("hex");
  const state = () =>
    store.get("honeypot-state", settings.guildId) ?? {
      paused: false,
      caught: 0,
      timeouts: 0,
      bans: 0,
    };
  const enabled = () =>
    settings.enabled && !stopped && !state().paused && transport.ready();
  function audit(job, result, code) {
    const record = {
      id: job.id,
      userId: job.userId,
      name: job.name,
      username: job.username,
      messageId: job.messageId,
      guildId: settings.guildId,
      channelId: settings.channelId,
      action: job.action,
      timeoutUntil: job.until,
      reason:
        job.action === "timeout"
          ? "Honeypot. First post in the clearly marked spam trap. 24 hour timeout."
          : job.action === "ban"
            ? "Honeypot. Repeat post in the clearly marked spam trap within 365 days. Permanent ban."
            : undefined,
      actorId: job.actorId,
      result,
      code,
      at: now(),
    };
    store.set(
      "honeypot-audit",
      `${record.at}:${record.id}`,
      record,
      now() + 90 * day,
    );
    store.set(
      "honeypot-alert",
      job.id,
      { ...record, attempts: 0, nextAt: now() },
      now() + 7 * day,
    );
  }
  function finish(job, result, code) {
    store.transaction(() => {
      if (result === "applied") {
        const current = state();
        current.caught++;
        current[job.action === "timeout" ? "timeouts" : "bans"]++;
        store.set("honeypot-state", settings.guildId, current, permanent);
        store.set(
          "honeypot-strike",
          job.subject,
          {
            appliedAt: now(),
            timeoutUntil: job.until,
            action: job.action,
            firstMessageId: job.messageId,
          },
          now() + 365 * day,
        );
      }
      audit(job, result, code);
      store.delete("honeypot-pending", job.subject);
    });
  }
  function observe(message) {
    if (
      !enabled() ||
      message.guildId !== settings.guildId ||
      message.channelId !== settings.channelId ||
      message.bot ||
      message.webhook ||
      message.system ||
      !/^\d{1,20}$/.test(message.userId ?? "") ||
      !/^\d{1,20}$/.test(message.id ?? "") ||
      !Number.isFinite(message.createdAt)
    )
      return false;
    const subject = key(`member:${message.userId}`);
    return store.transaction(() => {
      const messageKey = key(`message:${message.id}`);
      if (store.get("honeypot-seen", messageKey)) return false;
      store.set("honeypot-seen", messageKey, true, now() + 7 * day);
      const strike = store.get("honeypot-strike", subject);
      // Delayed events from the first burst must not turn a timeout into a ban.
      if (
        strike &&
        (message.createdAt <= strike.appliedAt || strike.action === "ban")
      )
        return false;
      if (store.get("honeypot-pending", subject)) return false;
      if (store.page("honeypot-pending", 1).total >= 500) return false;
      store.set(
        "honeypot-pending",
        subject,
        {
          id: randomUUID(),
          subject,
          userId: message.userId,
          name: profileText(message.name),
          username: profileText(message.username),
          messageId: message.id,
          createdAt: message.createdAt,
          attempts: 0,
          nextAt: now(),
        },
        now() + day,
      );
      return true;
    });
  }
  async function handle(job) {
    try {
      const member = await transport.member(job.userId);
      if (!enabled()) return;
      if (
        !member &&
        job.action === "ban" &&
        (await transport.isBanned(job.userId, job.id))
      )
        return finish(job, "applied");
      if (!member || member.protected)
        return finish(
          job,
          "skipped",
          member ? "protected_member" : "member_absent",
        );
      const strike = store.get("honeypot-strike", job.subject);
      if (!job.action) {
        job.name = profileText(member.name) || job.name;
        job.username = profileText(member.username) || job.username;
        job.action = strike ? "ban" : "timeout";
        job.until = job.action === "timeout" ? now() + day : undefined;
        store.set("honeypot-pending", job.subject, job, now() + day);
      }
      if (job.action === "timeout") {
        if (!member.moderatable)
          return finish(job, "failed", "timeout_permission_or_hierarchy");
        if ((member.timeoutUntil ?? 0) < job.until - 1000)
          await transport.timeout(job.userId, job.until);
      } else {
        if (!member.bannable)
          return finish(job, "failed", "ban_permission_or_hierarchy");
        await transport.ban(job.userId, job.id);
      }
      let cleanup;
      try {
        await transport.removeMessage(job.messageId);
      } catch {
        cleanup = "message_cleanup_failed";
      }
      finish(job, "applied", cleanup);
    } catch (error) {
      if (error.code === "protected_member")
        return finish(job, "skipped", error.code);
      if (
        job.action === "ban" &&
        (await transport.isBanned(job.userId, job.id).catch(() => false))
      )
        return finish(job, "applied");
      job.attempts++;
      if (job.attempts >= 5)
        return finish(job, "failed", "discord_unavailable");
      job.nextAt = now() + Math.min(60000, 1000 * 2 ** job.attempts);
      store.set("honeypot-pending", job.subject, job, now() + day);
    }
  }
  async function alerts() {
    for (const [id, alert] of store.entries("honeypot-alert").slice(0, 20)) {
      if (stopped || alert.nextAt > now()) continue;
      try {
        const delivery = await transport.alert(alert);
        if (delivery)
          store.set(
            "honeypot-alert-message",
            id,
            { ...delivery, reference: id, at: alert.at },
            permanent,
          );
        store.delete("honeypot-alert", id);
      } catch {
        alert.attempts++;
        if (alert.attempts >= 8) store.delete("honeypot-alert", id);
        else {
          alert.nextAt = now() + Math.min(60000, 1000 * 2 ** alert.attempts);
          store.set("honeypot-alert", id, alert, alert.at + 7 * day);
        }
      }
    }
  }
  async function expireAlerts() {
    for (const [id, receipt] of store
      .entries("honeypot-alert-message")
      .filter(([, receipt]) => receipt.at + 90 * day <= now())
      .slice(0, 20)) {
      if (stopped) break;
      try {
        await transport.removeAlert(receipt);
        store.delete("honeypot-alert-message", id);
      } catch {
        console.error("Honeypot alert retention cleanup is pending.");
        break;
      }
    }
  }
  function pump() {
    if (stopped) return Promise.resolve();
    if (!running)
      running = (async () => {
        if (enabled()) {
          const jobs = store
            .entries("honeypot-pending")
            .filter(([, job]) => job.nextAt <= now())
            .slice(0, 20);
          for (let i = 0; i < jobs.length; i += 4) {
            if (!enabled()) break;
            await Promise.all(
              jobs.slice(i, i + 4).map(([, job]) => handle(job)),
            );
          }
        }
        await alerts();
        await expireAlerts();
      })().finally(() => {
        running = undefined;
      });
    return running;
  }
  return {
    observe,
    pump,
    state,
    enabled,
    logs() {
      return store.page("honeypot-audit", 10).items;
    },
    async pause(value, actorId) {
      const current = state();
      current.paused = value;
      store.set("honeypot-state", settings.guildId, current, permanent);
      if (actorId)
        audit(
          {
            id: randomUUID(),
            userId: actorId,
            action: value ? "pause" : "resume",
          },
          "applied",
        );
      if (value) {
        await running;
        for (const [id] of store.entries("honeypot-pending"))
          store.delete("honeypot-pending", id);
      }
    },
    async reset(userId, actorId) {
      const subject = key(`member:${userId}`);
      if (store.get("honeypot-pending", subject))
        throw new Error("A moderation action is pending for this member");
      store.delete("honeypot-strike", subject);
      if (actorId)
        audit(
          { id: randomUUID(), userId, action: "reset", actorId },
          "applied",
        );
    },
    start() {
      if (!timer) {
        timer = setInterval(
          () =>
            void pump().catch(() =>
              console.error("Honeypot processing failed."),
            ),
          1000,
        );
        timer.unref();
      }
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
