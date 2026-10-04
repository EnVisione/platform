import { applicationChannels } from "./application-channels.js";
import { hash } from "./store.js";
import { applicationRoles } from "../shared/application-form.js";
import { applicationMail } from "./application-mail.js";
import { applicationControls } from "./application-onboarding.js";

const permanent = Number.MAX_SAFE_INTEGER;
const events = ["received", "reviewing", "approved", "denied"];
const escape = (value) => value.replace(/([\\*_~`|<>@])/g, "\\$1");
const keyFor = (id, event) => `${id}:${event}`;
const staffKeyFor = (id, event) =>
  event === "received" ? id : `${id}:staff:${event}`;
export const notificationMode = (record) =>
  record.discord && record.notificationPreference !== "email"
    ? "discord"
    : "email";
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

export function applicationNotifications(
  config,
  store,
  fetcher,
  mailer = applicationMail(config),
) {
  let timer;
  let running;
  let closed = false;
  let offset = 0;
  let emailOffset = 0;
  let controlsKeys;
  const controlsVersion = config.roleSync ? 2 : 1;
  const fallback = applicationChannels(config, store, request);

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
        thumbnail: record.discord?.avatar
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
    if (notificationMode(record) === "email") {
      queueEmail(record, event, { embeds });
      return;
    }
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
  function queueEmail(record, event, payload) {
    const key = keyFor(record.id, event);
    if (store.get("application-dm-delivery", key)?.sentAt) return;
    store.set(
      "application-email-notification",
      key,
      {
        id: record.id,
        event,
        recipient: record.contactEmail,
        queuedAt: Date.now(),
        payload,
        attempts: 0,
        nextAt: Date.now(),
      },
      permanent,
    );
    store.delete("application-notification", key);
  }
  async function preferencesChanged(change) {
    // Finish any in-flight delivery before cancelling queued Discord updates.
    if (running) await running;
    return change();
  }
  function reconcile(record) {
    for (const event of events) {
      const key = keyFor(record.id, event);
      const pending = store.get("application-notification", key);
      const email = store.get("application-email-notification", key);
      if (notificationMode(record) === "email") {
        if (pending) queueEmail(record, event, pending.payload);
        else if (email)
          store.set(
            "application-email-notification",
            key,
            { ...email, recipient: record.contactEmail },
            permanent,
          );
      } else if (email) {
        store.delete("application-email-notification", key);
        if (!store.get("application-dm-delivery", key)?.sentAt)
          store.set(
            "application-notification",
            key,
            {
              key,
              id: record.id,
              event,
              payload: email.payload,
              attempts: 0,
              nextAt: Date.now(),
            },
            permanent,
          );
      }
    }
  }
  function status(id) {
    return events.flatMap((event) => {
      const key = keyFor(id, event);
      const email = store.get("application-email-notification", key);
      if (email)
        return [
          {
            event,
            route: "email",
            awaitingSetup: !mailer,
            pending: Boolean(mailer),
            queuedAt: email.queuedAt,
          },
        ];
      const pending = store.get("application-notification", key);
      if (pending)
        return [{ event, pending: true, route: pending.route ?? "discord" }];
      const delivered = store.get("application-dm-delivery", key);
      return delivered ? [{ event, ...delivered }] : [];
    });
  }
  async function request(path, method = "GET", payload) {
    const response = await fetcher(`https://discord.com/api/v10${path}`, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = new Error("Discord delivery failed");
      error.status = response.status;
      const body = await response.json().catch(() => ({}));
      error.code = body.code;
      if (response.status === 429) {
        const seconds = Number(
          body.retry_after ?? response.headers.get("retry-after"),
        );
        const delay = Math.ceil(seconds * 1000);
        if (delay > 0 && Number.isSafeInteger(Date.now() + delay))
          error.retryAfter = delay;
      }
      throw error;
    }
    return response.status === 204 ? undefined : response.json();
  }
  async function post(path, payload) {
    const result = await request(path, "POST", payload);
    if (typeof result.id !== "string" || !result.id)
      throw new Error("Invalid Discord delivery response");
    return result;
  }
  function staffPayload(record, event) {
    const name = escape(record.answers.displayName).replace(/[\r\n]/g, " ");
    const applicant = `${name}${record.discord ? ` (<@${record.discord.id}>)` : ""}`;
    const label = applicationRoles[record.role].label;
    if (!event)
      return {
        content: `${applicant} just filled out a ${label} application.`,
        components: applicationControls(config, record),
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
      components: applicationControls(config, record, event),
    };
  }
  function applicantUpdate(record, event) {
    if (notificationMode(record) === "email") {
      const update = status(record.id).find((update) => update.event === event);
      if (update?.sentAt)
        return "Applicant update accepted by the email service.";
      if (update?.failedAt)
        return "Could not send the applicant email. Use the contact email to follow up.";
      return mailer
        ? "Applicant email queued for delivery."
        : "Email selected. Automatic email is awaiting SMTP setup; follow up manually using the contact email.";
    }
    const pending = store.get(
      "application-notification",
      keyFor(record.id, event),
    );
    if (pending)
      return pending.route === "private"
        ? "Private channel update queued for delivery."
        : "Applicant DM queued for delivery.";
    const delivery = store.get(
      "application-dm-delivery",
      keyFor(record.id, event),
    );
    if (delivery?.sentAt)
      return delivery.route === "private"
        ? `Applicant notified in a private channel: ${delivery.channelUrl}`
        : "Applicant notified by DM.";
    if (delivery?.failedAt)
      return "Could not deliver the applicant's Discord update. Use the contact details to follow up.";
    return "Applicant update is not scheduled.";
  }
  async function deliverEmail() {
    if (!mailer) return;
    const page = store.page("application-email-notification", 20, emailOffset);
    emailOffset = emailOffset + 20 < page.total ? emailOffset + 20 : 0;
    for (const pending of page.items.sort(
      (a, b) => priority(a) - priority(b),
    )) {
      if (closed || pending.nextAt > Date.now()) continue;
      const key = keyFor(pending.id, pending.event);
      const record = store.get("application", pending.id);
      if (
        !record ||
        record.erasingAt ||
        notificationMode(record) !== "email" ||
        store.get("application-dm-delivery", key)?.sentAt
      ) {
        store.delete("application-email-notification", key);
        continue;
      }
      if (
        events
          .slice(0, events.indexOf(pending.event))
          .some((event) =>
            store.get(
              "application-email-notification",
              keyFor(record.id, event),
            ),
          )
      )
        continue;
      try {
        const result = await mailer.send(record, pending.event);
        if (
          !result.accepted?.some(
            (address) =>
              address.toLowerCase() === record.contactEmail.toLowerCase(),
          )
        )
          throw Object.assign(new Error("Recipient not accepted"), {
            responseCode: 550,
          });
        store.transaction(() => {
          store.set(
            "application-dm-delivery",
            key,
            { route: "email", messageId: result.messageId, sentAt: Date.now() },
            permanent,
          );
          store.delete("application-email-notification", key);
        });
      } catch (error) {
        pending.attempts = (pending.attempts ?? 0) + 1;
        if (
          pending.attempts >= 8 ||
          (error.responseCode >= 500 && error.code !== "EAUTH")
        ) {
          store.transaction(() => {
            store.set(
              "application-dm-delivery",
              key,
              {
                route: "email",
                failedAt: Date.now(),
                reason: "email_delivery_failed",
              },
              permanent,
            );
            store.delete("application-email-notification", key);
          });
          console.error("Application email could not be sent:", key);
        } else {
          pending.nextAt =
            Date.now() + Math.min(3600000, 30000 * 2 ** pending.attempts);
          store.set("application-email-notification", key, pending, permanent);
        }
      }
    }
  }
  async function deliver() {
    await deliverEmail();
    if (store.get("application-discord-limit", "pause")) return;
    await refreshApprovedControls();
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
      if (!record || record.erasingAt || (applicant && !record.discord)) {
        store.delete("application-notification", key);
        continue;
      }
      if (applicant && notificationMode(record) === "email") {
        queueEmail(record, pending.event, pending.payload);
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
        if (
          applicant &&
          (pending.route === "private" ||
            store.get("application-private-channel", record.discord.id))
        ) {
          pending.route = "private";
          const channel = await fallback.channel(record.discord.id);
          pending.channelId = channel.id;
          pending.channelUrl = channel.url;
          store.set("application-notification", key, pending, permanent);
          channelId = channel.id;
        } else if (applicant) {
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
        if (!applicant)
          payload = {
            ...payload,
            components: applicationControls(config, record, pending.event),
          };
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
        const send = (destination) =>
          post(`/channels/${destination}/messages`, {
            ...payload,
            allowed_mentions: mentions,
            nonce: hash(key).slice(0, 24),
            enforce_nonce: true,
          });
        let message;
        try {
          message = await send(channelId);
        } catch (error) {
          if (
            !applicant ||
            pending.route === "private" ||
            !config.applications.fallback ||
            error.status !== 403 ||
            (error.code !== undefined && error.code !== 50007)
          )
            throw error;
          pending.route = "private";
          delete pending.channelId;
          store.set("application-notification", key, pending, permanent);
          const channel = await fallback.channel(record.discord.id);
          pending.channelId = channel.id;
          pending.channelUrl = channel.url;
          store.set("application-notification", key, pending, permanent);
          channelId = channel.id;
          message = await send(channel.id);
        }
        store.transaction(() => {
          store.set(
            deliveryKind,
            key,
            {
              messageId: message.id,
              channelId,
              sentAt: Date.now(),
              ...(applicant
                ? {
                    route: pending.route ?? "discord",
                    channelUrl: pending.channelUrl,
                  }
                : pending.event === "approved" && config.office
                  ? { onboardingControlsVersion: controlsVersion }
                  : {}),
            },
            permanent,
          );
          store.delete("application-notification", key);
        });
      } catch (error) {
        if (
          applicant &&
          pending.route !== "private" &&
          config.applications.fallback &&
          error.status === 403 &&
          (error.code === undefined || error.code === 50007)
        ) {
          pending.route = "private";
          delete pending.channelId;
          pending.nextAt = Date.now();
          store.set("application-notification", key, pending, permanent);
          continue;
        }
        pending.attempts++;
        const terminal =
          error.status >= 400 && error.status < 500 && error.status !== 429;
        if (terminal || pending.attempts >= 8) {
          store.transaction(() => {
            store.set(
              deliveryKind,
              key,
              {
                failedAt: Date.now(),
                blocked: error.status === 403,
                route: pending.route ?? "discord",
                reason:
                  typeof error.code === "string"
                    ? error.code
                    : "delivery_failed",
              },
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
  async function refreshApprovedControls() {
    if (!config.office) return;
    controlsKeys ??= store
      .entries("application-delivery")
      .filter(
        ([key, delivery]) =>
          key.endsWith(":staff:approved") &&
          delivery.messageId &&
          delivery.onboardingControlsVersion !== controlsVersion,
      )
      .map(([key]) => key);
    const batch = controlsKeys.splice(0, 10);
    for (const [index, key] of batch.entries()) {
      if (closed) return;
      const delivery = store.get("application-delivery", key);
      if (!delivery || delivery.onboardingControlsVersion === controlsVersion)
        continue;
      if (delivery.controlsNextAt > Date.now()) {
        controlsKeys.push(key);
        continue;
      }
      const id = key.slice(0, -":staff:approved".length);
      const record = store.get("application", id);
      if (!record || record.erasingAt || record.status !== "Approved") continue;
      try {
        await request(
          `/channels/${delivery.channelId ?? config.applications.notificationChannelId}/messages/${delivery.messageId}`,
          "PATCH",
          { components: applicationControls(config, record, "approved") },
        );
        store.set(
          "application-delivery",
          key,
          {
            ...delivery,
            onboardingControlsVersion: controlsVersion,
          },
          permanent,
        );
      } catch (error) {
        const attempts = (delivery.controlsAttempts ?? 0) + 1;
        const terminal =
          attempts >= 8 ||
          (error.status >= 400 && error.status < 500 && error.status !== 429);
        store.set(
          "application-delivery",
          key,
          {
            ...delivery,
            controlsAttempts: attempts,
            ...(terminal
              ? {
                  onboardingControlsVersion: controlsVersion,
                  controlsFailedAt: Date.now(),
                }
              : {
                  controlsNextAt:
                    Date.now() +
                    Math.max(
                      Math.min(3600000, 30000 * 2 ** attempts),
                      error.retryAfter ?? 0,
                    ),
                }),
          },
          permanent,
        );
        if (!terminal) controlsKeys.push(key);
        if (error.status === 429) {
          const until = Date.now() + Math.max(60000, error.retryAfter ?? 0);
          store.set("application-discord-limit", "pause", { until }, until);
          controlsKeys.push(...batch.slice(index + 1));
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
    async erase(record) {
      await running;
      for (const kind of ["application-delivery", "application-dm-delivery"]) {
        for (const [key, value] of store.entries(kind)) {
          if (
            !(key === record.id || key.startsWith(`${record.id}:`)) ||
            !value.messageId ||
            value.route === "email"
          )
            continue;
          let channelId =
            value.route === "private" && value.channelUrl
              ? value.channelUrl.split("/").at(-1)
              : value.channelId;
          if (!channelId && kind === "application-delivery")
            channelId = config.applications.notificationChannelId;
          if (!channelId && value.channelUrl)
            channelId = value.channelUrl.split("/").at(-1);
          if (!channelId && record.discord)
            channelId = (
              await post("/users/@me/channels", {
                recipient_id: record.discord.id,
              })
            ).id;
          if (!channelId)
            throw new Error("Application notification destination unavailable");
          try {
            await request(
              `/channels/${channelId}/messages/${value.messageId}`,
              "DELETE",
            );
          } catch (error) {
            if (error.status !== 404) throw error;
          }
        }
      }
      if (
        record.discord &&
        !store
          .entries("application")
          .some(
            ([, other]) =>
              other.id !== record.id && other.discord?.id === record.discord.id,
          )
      )
        await fallback.erase(record.discord.id);
    },
    queueStaff,
    queueApplicant,
    preferencesChanged,
    reconcile,
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
      mailer?.close();
    },
  };
}
