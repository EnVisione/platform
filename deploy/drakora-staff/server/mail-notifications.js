import { inboxPermission } from "../shared/staff-permissions.js";
import { createHash } from "node:crypto";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { discordMembers } from "./discord-members.js";

const topic =
  "Private shared mailbox alerts. Access follows the dashboard View email permission.";
const forever = Number.MAX_SAFE_INTEGER;
const digest = (value) => createHash("sha256").update(value).digest("hex");
export function mailAlertMessage(config, item, nonce) {
  const recipients = [
    ...new Set(
      [...item.to, ...item.cc].map(({ address }) => address.toLowerCase()),
    ),
  ].filter((address) =>
    config.mail.identities.some(
      (identity) => identity.address.toLowerCase() === address,
    ),
  );
  return {
    embeds: [
      {
        title: "📬 New email received",
        color: 0x5865f2,
        description:
          "A new message is ready in the shared Drakora inbox. Open the mailbox to read it and follow up.",
        fields: [
          {
            name: "Mailbox",
            value: (recipients.join(", ") || "Shared Drakora inbox").slice(
              0,
              500,
            ),
          },
        ],
        footer: { text: `Drakora mail · ${nonce}` },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Open mailbox",
            url: `${config.staffOrigin}/email`,
          },
        ],
      },
    ],
    allowedMentions: { parse: [] },
    nonce,
    enforceNonce: true,
  };
}

export function discordMailTransport(config, store, policy, client) {
  const channelsByScope = new Map();
  async function ensure(scope) {
    const all = config.mail.identities
      .map(({ address }) => address.toLowerCase())
      .sort();
    const addresses = scope
      ? [...new Set(scope)].filter((address) => all.includes(address)).sort()
      : all;
    if (!addresses.length) throw new Error("Mail channel scope unavailable");
    const scoped = addresses.join(",") !== all.join(",");
    const key = scoped
      ? `${config.guildId}:${digest(addresses.join(","))}`
      : config.guildId;
    const channelTopic = scoped
      ? `${topic} Mailboxes: ${addresses.join(", ")}.`
      : topic;
    let channel = channelsByScope.get(key);
    if (!client.isReady()) throw new Error("Discord unavailable");
    const guild = await client.guilds.fetch(config.guildId);
    const members = await discordMembers(client, guild);
    const viewers = [...members.values()].filter(
      (member) =>
        !member.user.bot &&
        policy.apply({ roles: [...member.roles.cache.keys()] }).capabilities[
          "mail.view"
        ] &&
        addresses.every(
          (address) =>
            policy.apply({ roles: [...member.roles.cache.keys()] })
              .capabilities[inboxPermission(address)],
        ),
    );
    const view =
      PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
    const overwrites = [
      {
        id: guild.id,
        type: 0,
        deny:
          view |
          PermissionFlagsBits.SendMessages |
          PermissionFlagsBits.CreatePublicThreads |
          PermissionFlagsBits.CreatePrivateThreads |
          PermissionFlagsBits.SendMessagesInThreads,
      },
      {
        id: client.user.id,
        type: 1,
        allow:
          view |
          PermissionFlagsBits.SendMessages |
          PermissionFlagsBits.EmbedLinks,
      },
    ];
    // Keep the channel closed if Discord's overwrite limit would be exceeded.
    if (viewers.length <= 98)
      overwrites.push(
        ...viewers.map((member) => ({ id: member.id, type: 1, allow: view })),
      );
    const desired = JSON.stringify(
      overwrites
        .map((entry) => [
          entry.id,
          entry.type,
          String(entry.allow ?? 0),
          String(entry.deny ?? 0),
        ])
        .sort(),
    );
    const saved = store.get("mail-alert-channel", key);
    if (saved) {
      const found = await guild.channels.fetch(saved.id).catch((error) => {
        if (error.code === 10003) return null;
        throw error;
      });
      if (
        found &&
        (found.type !== ChannelType.GuildText || found.topic !== channelTopic)
      )
        throw new Error("Mail channel ownership changed");
      channel = found;
    }
    if (!channel) {
      const channels = await guild.channels.fetch();
      const matches = [...channels.values()].filter(
        (entry) =>
          entry?.type === ChannelType.GuildText && entry.topic === channelTopic,
      );
      if (matches.length > 1) throw new Error("Ambiguous mail channel");
      channel =
        matches[0] ??
        (await guild.channels.create({
          name: scoped ? `email-${addresses[0].split("@")[0]}` : "email",
          type: ChannelType.GuildText,
          parent: config.mail.notifications.categoryId,
          topic: channelTopic,
          permissionOverwrites: overwrites,
          reason: "Private shared mailbox notifications",
        }));
      store.set(
        "mail-alert-channel",
        key,
        { id: channel.id, addresses },
        forever,
      );
    }
    const actual = JSON.stringify(
      [...channel.permissionOverwrites.cache.values()]
        .map((entry) => [
          entry.id,
          entry.type,
          String(entry.allow.bitfield),
          String(entry.deny.bitfield),
        ])
        .sort(),
    );
    if (actual !== desired) {
      await channel.permissionOverwrites.set(
        overwrites,
        "Match dashboard email access",
      );
    }
    if (viewers.length > 98)
      throw new Error("Mail channel access capacity exceeded");
    channelsByScope.set(key, channel);
    return channel.id;
  }
  return {
    available: () => client.isReady(),
    async ensure() {
      await ensure();
      for (const [key, entry] of store.entries("mail-alert-channel"))
        if (key.startsWith(`${config.guildId}:`) && entry.addresses)
          await ensure(entry.addresses);
    },
    async send(item, nonce, retry) {
      const recipients = [
        ...new Set(
          [...item.to, ...item.cc].map(({ address }) => address.toLowerCase()),
        ),
      ].filter((address) =>
        config.mail.identities.some(
          (identity) => identity.address.toLowerCase() === address,
        ),
      );
      const channelId = await ensure(
        recipients.length ? recipients : undefined,
      );
      const channel = await (
        await client.guilds.fetch(config.guildId)
      ).channels.fetch(channelId);
      if (retry) {
        const recent = await channel.messages.fetch({ limit: 100 });
        if (
          [...recent.values()].some(
            (message) =>
              message.author.id === client.user.id &&
              message.embeds.some(
                (embed) => embed.footer?.text === `Drakora mail · ${nonce}`,
              ),
          )
        )
          return;
      }
      await channel.send(mailAlertMessage(config, item, nonce));
    },
  };
}

export function mailNotifications(
  config,
  store,
  mail,
  transport,
  reportError = () =>
    console.error("Shared email Discord notifications are pending."),
) {
  const key = digest(
    JSON.stringify([
      config.guildId,
      config.mail.imapSocketPath,
      [
        ...config.mail.identities.map((entry) => entry.address.toLowerCase()),
      ].sort(),
    ]),
  );
  let active;
  let timer;
  let stopped = false;
  let permissionsRequested = false;
  async function run(poll) {
    if (!transport.available()) return;
    await transport.ensure();
    if (!poll || stopped) return;
    let cursor = store.get("mail-alert-cursor", key);
    const batch = await mail.incoming(cursor);
    if (stopped) return;
    if (!cursor || cursor.validity !== batch.validity)
      cursor = { validity: batch.validity, uid: batch.through };
    for (const item of batch.items) {
      if (stopped) return;
      const nonce = digest(`${key}:${batch.validity}:${item.uid}`).slice(0, 24);
      const retry = cursor.pending === nonce;
      cursor = { validity: batch.validity, uid: cursor.uid, pending: nonce };
      store.set("mail-alert-cursor", key, cursor, forever);
      await transport.send(item, nonce, retry);
      cursor = { validity: batch.validity, uid: item.uid };
      store.set("mail-alert-cursor", key, cursor, forever);
    }
    store.set(
      "mail-alert-cursor",
      key,
      { validity: batch.validity, uid: batch.through },
      forever,
    );
  }
  function schedule(poll) {
    if (stopped) return Promise.resolve();
    if (active) {
      if (!poll) permissionsRequested = true;
      return active;
    }
    active = run(poll)
      .catch(reportError)
      .finally(() => {
        active = undefined;
        if (permissionsRequested && !stopped) {
          permissionsRequested = false;
          void schedule(false);
        }
      });
    return active;
  }
  return {
    tick: () => schedule(true),
    refreshPermissions: () => schedule(false),
    start() {
      if (timer || stopped) return;
      void schedule(true);
      timer = setInterval(() => void schedule(true), 60000).unref();
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
