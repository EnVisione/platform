import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { createClient } from "@redis/client";
import { readPrivateKey } from "./private-key.js";
import { storeRanks } from "../shared/storefront.js";
import { goalAnnouncementBar } from "../shared/store-goal.js";
import { storeGoalSnapshot } from "./store-goal.js";
import { hash } from "./store.js";

const lifetime = 86400000;
const kind = "store-rank-announcement";
const coinKind = "store-coin-announcement";
const username = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_]{3,16}$/.test(value);
const colours = {
  wyrm: "<color:#57d99a>",
  drake: "<color:#65d6f4>",
  wyvern: "<color:#b58aff>",
  dragon: "<gradient:#ff8756:#ffb85c:#ffe38a>",
  archwyrm: "<gradient:#276b42:#6e9e60:#b2ce8c>",
  archdrake: "<gradient:#3155ff:#00d8ff>",
  archwyvern: "<gradient:#ff493b:#ff612f:#ff7526>",
  archdragon: "<gradient:#ff176b:#ef22c5:#b83cff>",
};

export function validateRankAnnouncements(settings) {
  if (settings === undefined) return;
  if (
    !settings ||
    Array.isArray(settings) ||
    typeof settings !== "object" ||
    Object.keys(settings).some(
      (key) => !["enabled", "redisUrlFile", "channel"].includes(key),
    ) ||
    typeof settings.enabled !== "boolean" ||
    (settings.enabled &&
      (typeof settings.redisUrlFile !== "string" ||
        !isAbsolute(settings.redisUrlFile) ||
        typeof settings.channel !== "string" ||
        !/^[A-Za-z0-9:_-]{1,120}:announcements$/.test(settings.channel)))
  )
    throw new Error(
      "Configure the private Redis connection and chat channel for rank announcements",
    );
}

export function queueRankAnnouncement(store, receiptKey, receipt, names, now) {
  if (!username(names?.buyer) || !username(names?.recipient)) return;
  store.set(
    kind,
    receiptKey,
    {
      id: randomUUID(),
      receiptKey,
      uuid: receipt.uuid,
      rank: receipt.rank,
      scope: receipt.scope,
      buyer: names.buyer,
      recipient: names.recipient,
      gift: names.gift === true,
      ready: false,
      discordPending: true,
      createdAt: now,
    },
    now + lifetime,
  );
}

export function queueCoinAnnouncement(store, receiptKey, receipt, names, now) {
  if (!receipt.active || receipt.refunded || receipt.disputed ||
      !username(names?.buyer) || !username(names?.recipient)) return;
  if (store.get(coinKind, receiptKey)) return;
  store.set(coinKind, receiptKey, {
    id: randomUUID(), receiptKey, uuid: receipt.uuid,
    buyer: names.buyer, recipient: names.recipient,
    gift: names.gift === true, ready: true, discordPending: true, createdAt: now,
  }, now + lifetime);
}

export function cancelCoinAnnouncement(store, receiptKey) {
  store.delete(coinKind, receiptKey);
}

export function coinAnnouncementMessage(item, timestamp, goal) {
  if (!username(item.buyer) || !username(item.recipient))
    throw new Error("Invalid coin announcement");
  return {
    id: item.id, timestamp, scope: "network", player: null, author: "Store",
    message: item.gift
      ? `${item.buyer} has just gifted ${item.recipient} <color:#f4ce79>Appreciation Coins</color>!`
      : `${item.buyer} has just bought <color:#f4ce79>Appreciation Coins</color>!`,
    title: false, subtitle: goal ? goalAnnouncementBar(goal) : "",
    subtitleBelow: Boolean(goal), anonymous: true, preference: "",
  };
}

function paidAnnouncementReceipt(store, queueKind, item) {
  if (queueKind === kind) {
    const receipt = store.get("store-purchase-receipt", item.receiptKey);
    return receipt?.state === "paid" ? receipt : undefined;
  }
  const receipt = store.get("supporter-receipt", item.receiptKey);
  return receipt?.active === true && !receipt.refunded && !receipt.disputed
    ? receipt
    : undefined;
}

function announcementBuyerUuid(store, queueKind, item, receipt) {
  if (!item.gift) return receipt.uuid;
  let credit = receipt;
  if (queueKind === kind) {
    if (typeof receipt.transactionId !== "string") return undefined;
    credit = store.get("supporter-receipt", hash(receipt.transactionId));
  }
  if (credit?.uuid === item.uuid && credit.buyerUuid !== item.uuid)
    return credit.buyerUuid;
}

export function acknowledgeRankAnnouncements(store, uuid, deliveredRanks) {
  for (const [key, item] of store.entries(kind)) {
    if (item.uuid !== uuid || item.ready) continue;
    if (store.get("store-purchase-receipt", key)?.state !== "paid") {
      store.delete(kind, key);
      continue;
    }
    const delivered = deliveredRanks.find((rank) => rank.scope === item.scope);
    if (
      !delivered ||
      storeRanks.findIndex((rank) => rank.id === delivered.rank) <
        storeRanks.findIndex((rank) => rank.id === item.rank)
    )
      continue;
    store.set(kind, key, { ...item, ready: true }, item.createdAt + lifetime);
  }
}

export function cancelRankAnnouncement(store, receiptKey) {
  store.delete(kind, receiptKey);
}

export function rankAnnouncementMessage(item, timestamp, goal) {
  const rank = storeRanks.find((rank) => rank.id === item.rank);
  if (
    !rank ||
    !colours[item.rank] ||
    !username(item.buyer) ||
    !username(item.recipient) ||
    !["network", "prom2", "rh"].includes(item.scope)
  )
    throw new Error("Invalid rank announcement");
  const name = `${colours[item.rank]}${rank.name}</${colours[item.rank].startsWith("<gradient") ? "gradient" : "color"}>`;
  const scope =
    item.scope === "network"
      ? ""
      : ` for ${item.scope === "prom2" ? "Prominence II" : "Restless Horizons"}`;
  return {
    id: item.id,
    timestamp,
    scope: "network",
    player: null,
    author: "Store",
    message: item.gift
      ? `${item.buyer} has just gifted ${item.recipient} ${name}${scope}!`
      : `${item.buyer} has just bought ${name}${scope}!`,
    title: false,
    subtitle: goal ? goalAnnouncementBar(goal) : "",
    subtitleBelow: Boolean(goal),
    anonymous: true,
    preference: "",
  };
}

// The deduplication key and publication share one Redis operation so an ambiguous reply can be retried safely.
export const publishRankAnnouncement = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
local delivered = redis.call('PUBLISH', ARGV[1], ARGV[2])
if delivered == 0 then return 0 end
redis.call('SET', KEYS[1], '1', 'PX', ARGV[3])
return 1
`;

export function rankAnnouncementService(store, settings, options = {}) {
  validateRankAnnouncements(settings);
  const minecraft = settings?.enabled === true;
  const discord = options.discord;
  if (!minecraft && !discord) return undefined;
  const now = options.now ?? Date.now;
  const log =
    options.log ??
    ((destination) =>
      console.error(
        `Store donation announcements are pending; ${destination} delivery is unavailable.`,
      ));
  const client = minecraft && (
    options.client ??
    createClient({
      url: readPrivateKey(settings.redisUrlFile, "rank announcement Redis URL"),
      disableOfflineQueue: true,
      disableClientInfo: true,
      commandsQueueMaxLength: 16,
      socket: {
        connectTimeout: 4000,
        socketTimeout: 5000,
        reconnectStrategy: false,
      },
    }));
  if (client) client.on("error", () => {});
  let timer, stopped = false;

  function disconnectMinecraft() {
    if (client?.isOpen) client.destroy();
  }

  async function publishMinecraft(message) {
    if (!client.isReady) {
      disconnectMinecraft();
      await client.connect();
    }
    const result = await client
      .withCommandOptions({ abortSignal: AbortSignal.timeout(4000) })
      .eval(publishRankAnnouncement, {
        keys: [`drakora:store:rank-announcement:${message.id}`],
        arguments: [settings.channel, JSON.stringify(message), String(lifetime * 2)],
      });
    if (result !== 1) throw new Error("No chat subscribers");
  }

  function destination(name, field, waiting, complete, publish, onError) {
    let running, warned = false;
    function pending(item) {
      return item?.ready && waiting(item[field]);
    }
    return function flushDestination() {
      if (stopped || running) return running;
      running = (async () => {
        for (const queueKind of [kind, coinKind]) {
          const { items } = store.page(queueKind, 16, 0, pending);
          for (const item of items) {
            if (stopped) return;
            const current = store.get(queueKind, item.receiptKey);
            if (!pending(current) || current.id !== item.id ||
                current.createdAt + lifetime <= now())
              continue;
            const receipt = paidAnnouncementReceipt(store, queueKind, current);
            if (!receipt) {
              store.delete(queueKind, current.receiptKey);
              continue;
            }
            const goal = current.goal ?? storeGoalSnapshot(store);
            const expires = current.createdAt + lifetime;
            if (discord && current.discordPending && !current.goal)
              store.set(queueKind, current.receiptKey, { ...current, goal }, expires);
            const render = queueKind === kind ? rankAnnouncementMessage : coinAnnouncementMessage;
            await publish(render(current, now(), goal), goal, current, queueKind, receipt);
            const latest = store.get(queueKind, current.receiptKey);
            if (latest?.id !== current.id) continue;
            const updated = { ...latest, [field]: complete };
            if ((!minecraft || updated.minecraftSent) && (!discord || !updated.discordPending))
              store.delete(queueKind, current.receiptKey);
            else
              store.set(queueKind, current.receiptKey, updated, expires);
            warned = false;
          }
        }
      })().catch(() => {
        if (!warned && !stopped) log(name);
        warned = true;
        onError?.();
      }).finally(() => {
        running = undefined;
      });
      return running;
    };
  }

  const flushMinecraft = minecraft ? destination(
    "Minecraft", "minecraftSent", (sent) => !sent, true, publishMinecraft, disconnectMinecraft,
  ) : undefined;
  const flushDiscord = discord ? destination(
    "Discord", "discordPending", (pending) => pending === true, false,
    (message, goal, item, queueKind, receipt) => discord(message, goal, {
      buyer: item.buyer,
      buyerUuid: announcementBuyerUuid(store, queueKind, item, receipt),
    }),
  ) : undefined;
  const flush = () => Promise.all([flushMinecraft?.(), flushDiscord?.()]);
  return {
    flush,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => void flush(), 5000);
      timer.unref();
      void flush();
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      const active = flush();
      disconnectMinecraft();
      await active;
    },
  };
}
