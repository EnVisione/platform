import { hash } from "./store.js";
import { applicationRoles } from "../shared/application-form.js";

const permanent = Number.MAX_SAFE_INTEGER;
const events = ["received", "reviewing", "approved", "denied"];
const escape = (value) => value.replace(/([\\*_~`|<>@])/g, "\\$1");
const keyFor = (id, event) => `${id}:${event}`;
const staffKeyFor = (id, event) =>
  event === "received" ? id : `${id}:staff:${event}`;
const mentions = { parse: [], users: [], roles: [], replied_user: false };
const colors = {
  received: 0x2dd4bf,
  reviewing: 0x5865f2,
  approved: 0x3ba55c,
  denied: 0xed4245,
};
function priority(pending) {
  const event = events.indexOf(pending.event ?? "received");
  return (
    event + (pending.event && pending.target !== "staff" ? 0 : events.length)
  );
}

export function applicationNotifications(config, store, fetcher) {
  let timer;
  let running;
  let closed = false;
  let offset = 0;

  function queueStaff(record, event = "received") {
    const key = staffKeyFor(record.id, event);
    store.set(
      "application-notification",
      key,
      {
        key,
        id: record.id,
        target: "staff",
        event: event === "received" ? undefined : event,
        payload: event === "received" ? undefined : staffPayload(record, event),
        attempts: 0,
        nextAt: Date.now(),
      },
      permanent,
    );
  }
  function queueApplicant(record, event) {
    if (!record.discord) return;
    const label = applicationRoles[record.role].label;
    const name = escape(record.answers.displayName);
    const descriptions = {
      received: `Thanks for applying, **${name}**! Your **${label}** application is safely with the Drakora team.\n\nWe're glad you want to help our community. We'll keep you updated right here when your review starts and when a decision is made.`,
      reviewing: `Hi **${name}**! The team is now taking a closer look at your **${label}** application.\n\nThanks for your patience. We'll send another update here when we have a decision.`,
      approved: `Congratulations, **${name}**! Your **${label}** application has been approved. We're excited to welcome you to the Drakora team!\n\nThe team will reach out to help you get started.`,
      denied: `Thank you for applying, **${name}**. Your **${label}** application wasn't accepted this time.\n\nWe appreciate the time you put into it. You can apply for this role again after the date below, or explore other teams you're eligible for.`,
    };
    const fields = [
      { name: "📋 Applied for", value: label, inline: true },
      {
        name: "📍 Status",
        value: {
          received: "Received",
          reviewing: "In review",
          approved: "Approved",
          denied: "Not accepted this time",
        }[event],
        inline: true,
      },
    ];
    if (event === "denied") {
      const timestamp = Math.ceil(record.decision.reapplyAfter / 1000);
      fields.push({
        name: "🗓️ Apply for this role again",
        value: `<t:${timestamp}:F> · <t:${timestamp}:R>\nMinimum wait: ${record.decision.reapplyDays} days.`,
      });
    }
    const embeds = [
      {
        author: { name: "Drakora · Staff Applications" },
        title: {
          received: "📬 We received your application!",
          reviewing: "🔎 Your application is under review",
          approved: "🎉 Welcome to the Drakora team!",
          denied: "💬 An update on your application",
        }[event],
        color: colors[event],
        thumbnail: record.discord.avatar
          ? { url: record.discord.avatar }
          : undefined,
        description: descriptions[event],
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: `Drakora · Application reference ${record.id}` },
      },
    ];
    const feedback =
      event === "approved" || event === "denied"
        ? escape(record.decision?.reason ?? "")
        : "";
    if (feedback)
      embeds.push({
        title:
          event === "denied"
            ? "💬 Feedback from the team"
            : "💬 A message from the team",
        color: colors[event],
        description: feedback,
      });
    const key = keyFor(record.id, event);
    store.set(
      "application-notification",
      key,
      {
        key,
        id: record.id,
        event,
        attempts: 0,
        nextAt: Date.now(),
        payload: { embeds },
      },
      permanent,
    );
  }
  function status(id) {
    return events.flatMap((event) => {
      const key = keyFor(id, event);
      const delivered = store.get("application-dm-delivery", key);
      if (delivered) return [{ event, ...delivered }];
      return store.get("application-notification", key)
        ? [{ event, pending: true }]
        : [];
    });
  }
  async function post(path, payload) {
    const response = await fetcher(`https://discord.com/api/v10${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = new Error("Discord delivery failed");
      error.status = response.status;
      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        const seconds = Number(
          body.retry_after ?? response.headers.get("retry-after"),
        );
        const delay = Math.ceil(seconds * 1000);
        if (delay > 0 && Number.isSafeInteger(Date.now() + delay))
          error.retryAfter = delay;
      }
      throw error;
    }
    const result = await response.json();
    if (typeof result.id !== "string" || !result.id)
      throw new Error("Invalid Discord delivery response");
    return result;
  }
  function applicationLink(id) {
    return [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Click to view",
            url: `${config.staffOrigin}/applications/${id}`,
          },
        ],
      },
    ];
  }
  function staffPayload(record, event) {
    const name = escape(record.answers.displayName).replace(/[\r\n]/g, " ");
    const applicant = `${name}${record.discord ? ` (<@${record.discord.id}>)` : ""}`;
    const label = applicationRoles[record.role].label;
    if (!event)
      return {
        content: `${applicant} just filled out a ${label} application.`,
        components: applicationLink(record.id),
      };
    const author =
      event === "reviewing" ? record.review.author : record.decision.author;
    const actor = `<@${author.id}>`;
    const fields = [{ name: "Application type", value: label }];
    if (event === "denied") {
      const timestamp = Math.ceil(record.decision.reapplyAfter / 1000);
      fields.push({
        name: "Can reapply for this role",
        value: `<t:${timestamp}:F> · <t:${timestamp}:R>\nMinimum wait: ${record.decision.reapplyDays} days.`,
      });
    }
    return {
      content: {
        reviewing: `${actor} started reviewing ${applicant}'s ${label} application.`,
        approved: `${actor} accepted ${applicant}'s ${label} application. Welcome to the staff team!`,
        denied: `${actor} denied ${applicant}'s ${label} application.`,
      }[event],
      embeds: [
        {
          title: {
            reviewing: "Application under review",
            approved: "Application accepted",
            denied: "Application denied",
          }[event],
          color: colors[event],
          description:
            event === "reviewing"
              ? undefined
              : escape(record.decision.reason) || undefined,
          fields,
          footer: { text: `Drakora · Reference ${record.id}` },
        },
      ],
      components: applicationLink(record.id),
    };
  }
  function applicantUpdate(record, event) {
    if (!record.discord)
      return "No Discord account linked. Use the contact details to follow up.";
    const delivery = store.get(
      "application-dm-delivery",
      keyFor(record.id, event),
    );
    if (delivery?.sentAt) return "Applicant notified by DM.";
    if (delivery?.failedAt)
      return "Could not deliver the applicant's DM. Use the contact details to follow up.";
    return "Applicant DM queued for delivery.";
  }
  async function deliver() {
    if (store.get("application-discord-limit", "pause")) return;
    const page = store.page("application-notification", 20, offset);
    offset = offset + 20 < page.total ? offset + 20 : 0;
    for (const pending of page.items.sort(
      (a, b) => priority(a) - priority(b),
    )) {
      if (closed || pending.nextAt > Date.now()) continue;
      const key = pending.key ?? pending.id;
      const applicant = Boolean(pending.event && pending.target !== "staff");
      const record = store.get("application", pending.id);
      if (!record || (applicant && !record.discord)) {
        store.delete("application-notification", key);
        continue;
      }
      if (
        pending.event &&
        events
          .slice(0, events.indexOf(pending.event))
          .some((event) =>
            store.get(
              "application-notification",
              applicant
                ? keyFor(record.id, event)
                : staffKeyFor(record.id, event),
            ),
          )
      )
        continue;
      const deliveryKind = applicant
        ? "application-dm-delivery"
        : "application-delivery";
      try {
        let channelId = config.applications.notificationChannelId;
        if (applicant) {
          if (!pending.channelId) {
            const channel = await post("/users/@me/channels", {
              recipient_id: record.discord.id,
            });
            if (!/^\d{1,20}$/.test(channel.id))
              throw new Error("Invalid Discord DM channel");
            pending.channelId = channel.id;
            store.set("application-notification", key, pending, permanent);
          }
          channelId = pending.channelId;
        }
        let payload = pending.payload ?? staffPayload(record);
        if (!applicant && pending.event) {
          payload = {
            ...payload,
            embeds: payload.embeds.map((embed) => ({
              ...embed,
              fields: [
                ...embed.fields,
                {
                  name: "Applicant update",
                  value: applicantUpdate(record, pending.event),
                },
              ],
            })),
          };
        }
        const message = await post(`/channels/${channelId}/messages`, {
          ...payload,
          allowed_mentions: mentions,
          nonce: hash(key).slice(0, 24),
          enforce_nonce: true,
        });
        store.transaction(() => {
          store.set(
            deliveryKind,
            key,
            { messageId: message.id, sentAt: Date.now() },
            permanent,
          );
          store.delete("application-notification", key);
        });
      } catch (error) {
        pending.attempts++;
        const terminal =
          error.status >= 400 && error.status < 500 && error.status !== 429;
        if (terminal || pending.attempts >= 8) {
          store.transaction(() => {
            store.set(
              deliveryKind,
              key,
              { failedAt: Date.now(), blocked: error.status === 403 },
              permanent,
            );
            store.delete("application-notification", key);
          });
          console.error(
            "Application notification could not be delivered:",
            key,
          );
        } else {
          const delay = Math.max(
            Math.min(3600000, 30000 * 2 ** pending.attempts),
            error.retryAfter ?? 0,
          );
          pending.nextAt = Date.now() + delay;
          store.set("application-notification", key, pending, permanent);
        }
        if (error.status === 429) {
          const until = Math.max(
            pending.nextAt,
            Date.now() + Math.max(60000, error.retryAfter ?? 0),
          );
          store.set("application-discord-limit", "pause", { until }, until);
          break;
        }
      }
    }
  }
  function tick() {
    if (!running && !closed)
      running = deliver().finally(() => {
        running = undefined;
      });
    return running;
  }
  return {
    queueStaff,
    queueApplicant,
    status,
    delivery: tick,
    start() {
      const scheduled = () =>
        tick()?.catch(() => {
          console.error("Application notification worker failed.");
        });
      timer = setInterval(scheduled, 15000);
      timer.unref();
      scheduled();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
