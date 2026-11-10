import { createHash } from "node:crypto";
import { escapeMarkdown, Routes } from "discord.js";

const goalUrl = "https://store.drakora.org/goal";
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const barLength = 12;

export function discordDonationPublisher(rest, channelId) {
  if (!rest || !/^[0-9]{17,20}$/.test(channelId))
    throw new Error("Configure a Discord bot and channel for store donation announcements");

  return (announcement, goal) => {
    const colour = announcement.message.match(/<(?:color|gradient):#([\da-f]{6})/i);
    const plain = announcement.message.replace(/<\/?(?:color|gradient)(?::[^>]+)?>/g, "");
    const filled = goal.percent === 100
      ? barLength
      : Math.min(barLength - 1, Math.round(goal.raisedCents * barLength / goal.targetCents));
    const bar = "🟩".repeat(filled) + "⬛".repeat(barLength - filled);
    return rest.post(Routes.channelMessages(channelId), {
      signal: AbortSignal.timeout(8000),
      body: {
        nonce: createHash("sha256").update(`store-donation:${announcement.id}`).digest("base64url").slice(0, 25),
        enforce_nonce: true,
        allowed_mentions: { parse: [] },
        embeds: [{
          title: "Thank you for supporting Drakora!",
          description: escapeMarkdown(plain),
          color: colour ? Number.parseInt(colour[1], 16) : 0xf4ce79,
          fields: [{
            name: goal.title,
            value: `${bar}\n**${goal.percent}% funded** · ${dollars.format(goal.raisedCents / 100)} / ${dollars.format(goal.targetCents / 100)} USD\n[View the goal](${goalUrl})`,
          }],
        }],
      },
    });
  };
}
