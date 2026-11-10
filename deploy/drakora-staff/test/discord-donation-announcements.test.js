import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { discordDonationPublisher } from "../server/discord-donation-announcements.js";
import {
  acknowledgeRankAnnouncements,
  cancelCoinAnnouncement,
  queueCoinAnnouncement,
  queueRankAnnouncement,
  rankAnnouncementService,
} from "../server/rank-announcements.js";
import { hash, openStore } from "../server/store.js";

const channelId = "123456789012345678";
const names = { buyer: "Buyer_One", recipient: "Recipient", gift: true };
const uuid = "12345678-1234-4234-8234-123456789012";
const buyerUuid = "12345678-1234-4234-8234-123456789013";
const buyerDiscordId = "123456789012345670";
const recipientDiscordId = "123456789012345671";
const coinKind = "store-coin-announcement";
const rankKind = "store-rank-announcement";
const settings = {
  enabled: true,
  redisUrlFile: "/private/redis",
  channel: "chat:announcements",
};

function fixture(t, { minecraft = true, discord = true } = {}) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const sent = { minecraft: [], discord: [], failures: [] };
  const outage = { minecraft: false, discord: false };
  const client = new EventEmitter();
  client.connect = async () => { client.isOpen = client.isReady = true; };
  client.destroy = () => { client.isOpen = client.isReady = false; };
  client.withCommandOptions = () => ({
    eval: async (_script, { arguments: [, json] }) => {
      if (outage.minecraft) throw new Error("Unavailable");
      sent.minecraft.push(JSON.parse(json));
      return 1;
    },
  });
  const rest = { post: async (route, { body }) => {
    sent.discord.push({ route, body });
    if (outage.discord) throw new Error("Unavailable");
  } };
  const service = rankAnnouncementService(store, minecraft ? settings : undefined, {
    client,
    discord: discord ? discordDonationPublisher(rest, channelId, store) : undefined,
    log: (name) => sent.failures.push(name),
  });
  t.after(async () => { await service.close(); store.close(); });
  function coin(key, options = names, cents = 125000) {
    const receipt = { uuid, active: true, coins: cents };
    store.set("supporter-receipt", key, receipt, Number.MAX_SAFE_INTEGER);
    queueCoinAnnouncement(store, key, receipt, options, Date.now());
  }
  return { store, sent, outage, service, coin };
}

function link(store, playerUuid, discordId, kind) {
  store.set("minecraft-owner", playerUuid, {
    [`${kind}Linked`]: true,
    discord: { id: discordId },
  });
  store.set("minecraft-discord-owner", discordId, { uuid: playerUuid });
}

test("Discord mirrors a paid coin gift and its goal without triggering mentions", async (t) => {
  const { store, sent, service, coin } = fixture(t);
  coin("gift");
  await service.flush();
  assert.equal(sent.minecraft.length, 1);
  assert.match(sent.minecraft[0].message, /Buyer_One has just gifted Recipient/);
  assert.match(sent.minecraft[0].subtitle, />50%<\/color>/);
  assert.equal(sent.discord.length, 1);
  const [{ route, body }] = sent.discord;
  assert.equal(route, `/channels/${channelId}/messages`);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.enforce_nonce, true);
  assert.match(body.nonce, /^[A-Za-z0-9_-]{25}$/);
  assert.match(body.embeds[0].description, /Buyer\\_One has just gifted Recipient Appreciation Coins!/);
  assert.match(body.embeds[0].fields[0].value, /^🟩{6}⬛{6}\n\*\*50% funded\*\* · \$1,250\.00 \/ \$2,500\.00 USD/u);
  assert.match(body.embeds[0].fields[0].value, /https:\/\/store\.drakora\.org\/goal/);
  assert.equal(store.entries(coinKind).length, 0);
  await service.flush();
  assert.equal(sent.discord.length, 1);
});

test("Discord retries retain the purchase identity and original goal without resending to Minecraft", async (t) => {
  const { store, sent, outage, service, coin } = fixture(t);
  outage.discord = true;
  coin("gift");
  await service.flush();
  await service.flush();
  assert.equal(sent.minecraft.length, 1);
  assert.deepEqual(sent.failures, ["Discord"]);
  assert.equal(store.get(coinKind, "gift").minecraftSent, true);
  store.set("supporter-receipt", "later", { active: true, coins: 125000 }, Number.MAX_SAFE_INTEGER);
  outage.discord = false;
  await service.flush();
  assert.equal(sent.minecraft.length, 1);
  assert.equal(sent.discord.length, 3);
  assert.deepEqual(sent.discord[2], sent.discord[0]);
  assert.equal(store.entries(coinKind).length, 0);
});

test("Discord sends while Minecraft is unavailable and waits for acknowledged rank delivery", async (t) => {
  const { store, sent, outage, service } = fixture(t);
  const receipt = { uuid, rank: "archdragon", scope: "network", state: "paid" };
  store.set("store-purchase-receipt", "rank", receipt, Number.MAX_SAFE_INTEGER);
  queueRankAnnouncement(store, "rank", receipt, names, Date.now());
  await service.flush();
  assert.equal(sent.discord.length, 0);
  acknowledgeRankAnnouncements(store, uuid, [{ rank: "archdragon", scope: "network" }]);
  outage.minecraft = true;
  await service.flush();
  assert.equal(sent.minecraft.length, 0);
  assert.equal(sent.discord[0].body.embeds[0].color, 0xff176b);
  assert.match(sent.discord[0].body.embeds[0].description, /gifted Recipient ArchDragon!/);
  assert.equal(store.get(rankKind, "rank").discordPending, false);
  outage.minecraft = false;
  await service.flush();
  assert.equal(sent.minecraft.length, 1);
  assert.equal(sent.discord.length, 1);
  assert.equal(store.entries(rankKind).length, 0);
});

test("Legacy queued notices are not replayed to Discord, and cancelled or disputed notices are not sent", async (t) => {
  const { store, sent, service, coin } = fixture(t);
  coin("legacy");
  const { discordPending, ...legacy } = store.get(coinKind, "legacy");
  store.set(coinKind, "legacy", legacy, legacy.createdAt + 86400000);
  coin("refund");
  cancelCoinAnnouncement(store, "refund");
  coin("dispute");
  store.set("supporter-receipt", "dispute", { active: true, disputed: true }, Number.MAX_SAFE_INTEGER);
  await service.flush();
  assert.equal(sent.minecraft.length, 1);
  assert.equal(sent.discord.length, 0);
  assert.equal(store.entries(coinKind).length, 0);
});

test("Discord can deliver alone and caps a fully funded progress bar", async (t) => {
  const { store, sent, service, coin } = fixture(t, { minecraft: false });
  coin("full", { buyer: "Buyer", recipient: "Buyer" }, 275000);
  await service.flush();
  assert.equal(sent.minecraft.length, 0);
  const embed = sent.discord[0].body.embeds[0];
  assert.equal(embed.description, "Buyer has just bought Appreciation Coins!");
  assert.match(embed.fields[0].value, /^🟩{12}\n\*\*100% funded\*\*/u);
  assert.equal(store.entries(coinKind).length, 0);
});

test("Discord tags the verified buyer of a rank or coin gift and leaves the recipient as a Minecraft name", async (t) => {
  const { store, sent, service } = fixture(t);
  link(store, buyerUuid, buyerDiscordId, "staff");
  link(store, uuid, recipientDiscordId, "member");

  const transactionId = "rank-gift";
  const credit = { uuid, buyerUuid, active: true, coins: 2500 };
  const rankReceipt = { uuid, transactionId, rank: "archdragon", scope: "network", state: "paid" };
  store.set("supporter-receipt", hash(transactionId), credit);
  store.set("store-purchase-receipt", "rank", rankReceipt);
  queueRankAnnouncement(store, "rank", rankReceipt, names, Date.now());
  acknowledgeRankAnnouncements(store, uuid, [{ rank: "archdragon", scope: "network" }]);
  store.set("supporter-receipt", "coin-gift", credit);
  queueCoinAnnouncement(store, "coin-gift", credit, names, Date.now());
  await service.flush();

  assert.equal(sent.discord.length, 2);
  const products = ["ArchDragon", "Appreciation Coins"];
  for (const [i, { body }] of sent.discord.entries()) {
    const product = products[i];
    assert.equal(body.content, `<@${buyerDiscordId}> has just gifted Recipient ${product}!`);
    assert.deepEqual(body.allowed_mentions, { parse: [], users: [buyerDiscordId] });
    assert.equal(body.embeds[0].description, undefined);
  }
  assert.equal(sent.minecraft.length, 2);
  for (const message of sent.minecraft)
    assert.match(message.message, /^Buyer_One has just gifted Recipient /);
});

test("Discord falls back to the Minecraft name when the link does not point back to the payer", async (t) => {
  const { store, sent, service, coin } = fixture(t);
  link(store, uuid, buyerDiscordId, "member");
  store.set("minecraft-discord-owner", buyerDiscordId, { uuid: buyerUuid });
  coin("unverified", { buyer: "Buyer_One", recipient: "Buyer_One" });
  await service.flush();
  const [{ body }] = sent.discord;
  assert.equal(body.content, undefined);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.match(body.embeds[0].description, /^Buyer\\_One has just bought /);
});
