import { ChannelType, Routes } from "discord.js";
import { discordText } from "./todo-comments.js";
import { createHash } from "node:crypto";
import { staffReviewAccess } from "./staff-reviews.js";

const nonce = (key) =>
  createHash("sha256").update(key).digest("hex").slice(0, 25);
export function staffReviewDiscord(config, store, office, reviews, member) {
  const client = office.gateway;
  const tasks = new Set();
  let running,
    stopped = false;
  const parentId = config.staffReviews.channelId;
  const url = (review) => `${config.staffOrigin}/staff-reviews/${review.id}`;
  const embed = (title, description, key) => ({
    embeds: [
      {
        title: discordText(
          title,
          config.todoPublicTextExclusions,
          "Staff review",
        ),
        description: discordText(
          description,
          config.todoPublicTextExclusions,
          "Staff update. Please contact your Manager for details.",
        ),
        color: 0xd0ba86,
        footer: { text: `Staff review · ${key}` },
      },
    ],
    allowed_mentions: { parse: [] },
    nonce: nonce(key),
    enforce_nonce: true,
  });
  function persist(review) {
    const current = reviews.get(review.id);
    current.discord = { ...current.discord, ...review.discord };
    reviews.save(current);
  }
  async function parent() {
    const channel = await client.rest.get(Routes.channel(parentId));
    if (
      channel.guild_id !== config.guildId ||
      channel.type !== ChannelType.GuildText
    )
      throw new Error(
        "Staff review channel must be a staff server text channel.",
      );
    return channel;
  }
  async function send(channelId, payload, key) {
    const recent = await client.rest.get(Routes.channelMessages(channelId), {
      query: new URLSearchParams({ limit: "100" }),
    });
    const existing = recent.find(
      (message) =>
        message.author.id === client.user.id &&
        (String(message.nonce) === nonce(key) ||
          message.embeds?.some(
            (item) => item.footer?.text === `Staff review · ${key}`,
          )),
    );
    return (
      existing ||
      client.rest.post(Routes.channelMessages(channelId), { body: payload })
    );
  }
  async function thread(review) {
    if (review.discord.threadId) {
      try {
        const target = await client.rest.get(
          Routes.channel(review.discord.threadId),
        );
        if (
          target.parent_id !== parentId ||
          target.type !== ChannelType.PrivateThread
        )
          throw new Error("Staff review thread must stay private.");
        if (target.thread_metadata?.archived && review.status === "open")
          await client.rest.patch(Routes.channel(target.id), {
            body: { archived: false, locked: false, invitable: false },
          });
        return target;
      } catch (error) {
        if (error.code !== 10003) throw error;
      }
    }
    const active = await client.rest.get(
      Routes.guildActiveThreads(config.guildId),
    );
    const previous = active.threads.find(
      (item) =>
        item.parent_id === parentId &&
        item.type === ChannelType.PrivateThread &&
        item.name.endsWith(review.id),
    );
    const target =
      previous ||
      (await client.rest.post(Routes.threads(parentId), {
        body: {
          name: `${review.member.name.slice(0, 40)} · ${review.id}`,
          type: ChannelType.PrivateThread,
          invitable: false,
          auto_archive_duration: 10080,
        },
      }));
    review.discord.threadId = target.id;
    persist(review);
    return target;
  }
  async function membership(target) {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild?.available) throw new Error("Staff roster unavailable.");
    const wanted = new Set(
      [...guild.members.cache.values()]
        .filter(
          (person) =>
            !person.user.bot &&
            config.ranks.some(
              (rank) =>
                ["Founder", "Manager"].includes(rank.name) &&
                person.roles.cache.has(rank.id),
            ),
        )
        .map((person) => person.id),
    );
    const current = await client.rest.get(Routes.threadMembers(target.id));
    for (const entry of current)
      if (entry.user_id !== client.user.id && !wanted.has(entry.user_id))
        await client.rest.delete(
          Routes.threadMembers(target.id, entry.user_id),
        );
    if (target.thread_metadata?.archived) return;
    for (const id of wanted)
      if (!current.some((entry) => entry.user_id === id))
        await client.rest.put(Routes.threadMembers(target.id, id));
  }
  async function importMessage(message, review) {
    if (
      message.author?.bot ||
      message.webhook_id ||
      !message.author?.id ||
      review.status !== "open"
    )
      return;
    const author = await member(message.author.id);
    if (!staffReviewAccess(config, author)) return;
    const attachments = (message.attachments || [])
      .filter(
        (item) =>
          typeof item.url === "string" &&
          /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(item.url),
      )
      .map((item) => `${item.filename}: ${item.url}`);
    const body = [message.content, ...attachments]
      .filter(Boolean)
      .join("\n")
      .slice(0, 4000);
    if (!body.trim()) return;
    const previous = store.get(
      `staff-review-messages:${review.id}`,
      message.id,
    );
    if (previous?.body === body) return;
    reviews.comment(
      author,
      review.id,
      body,
      "discord",
      message.id,
      Date.parse(message.timestamp),
    );
  }
  async function recover(review) {
    let cursor = review.discord.cursor || review.discord.threadId;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("after", cursor);
      const messages = await client.rest.get(
        Routes.channelMessages(review.discord.threadId),
        { query },
      );
      for (const message of [...messages].sort((a, b) =>
        BigInt(a.id) < BigInt(b.id) ? -1 : 1,
      )) {
        await importMessage(message, review);
        if (!cursor || BigInt(message.id) > BigInt(cursor)) cursor = message.id;
      }
      if (cursor) {
        review.discord.cursor = cursor;
        persist(review);
      }
      if (messages.length < 100) break;
    }
  }
  async function flush() {
    if (stopped || !client.isReady()) return;
    if (running) return running;
    running = (async () => {
      await parent();
      for (let review of reviews.records()) {
        if (review.discord.completed && review.status !== "open") continue;
        try {
          const target = await thread(review);
          await membership(target);
          if (!review.discord.announcement) {
            const announcement = await send(
              parentId,
              embed(
                "Staff review started",
                `${review.member.name}'s staff review is ready. [Open review](${url(review)}) · <#${target.id}>`,
                `${review.id}:start`,
              ),
              `${review.id}:start`,
            );
            review.discord.announcement = announcement.id;
            persist(review);
          }
          if (!review.discord.seed) {
            const seed = await send(
              target.id,
              embed(
                "Staff review",
                `Review ${review.member.name}'s progress, work quality and readiness for promotion. Discuss here or [open the panel](${url(review)}).\n\nOnly Managers and Founders can participate.`,
                `${review.id}:seed`,
              ),
              `${review.id}:seed`,
            );
            review.discord.seed = seed.id;
            persist(review);
          }
          if (review.status === "open") await recover(review);
          review = reviews.get(review.id);
          for (const [key, message] of store.entries(
            `staff-review-messages:${review.id}`,
          )) {
            if (message.origin !== "panel" || message.discordId) continue;
            const sent = await send(
              target.id,
              embed(
                message.author.name,
                message.body,
                `${review.id}:${message.id}`,
              ),
              `${review.id}:${message.id}`,
            );
            store.set(
              `staff-review-messages:${review.id}`,
              key,
              { ...message, discordId: sent.id },
              Number.MAX_SAFE_INTEGER,
            );
          }
          if (!["open", "promotion_pending"].includes(review.status)) {
            const title =
              review.status === "promoted"
                ? "Staff member promoted"
                : review.status === "continued"
                  ? "Continue observing"
                  : "Review cancelled";
            await send(
              target.id,
              embed(
                title,
                `${review.decision?.roleName ? `Promoted to ${review.decision.roleName}.\n\n` : ""}${review.decision?.assessment || "The review is complete."}\n\n[View decision](${url(review)})`,
                `${review.id}:decision`,
              ),
              `${review.id}:decision`,
            );
            if (review.status === "promoted" && !review.discord.dm) {
              try {
                const dm = await client.rest.post(Routes.userChannels(), {
                  body: { recipient_id: review.member.id },
                });
                await send(
                  dm.id,
                  embed(
                    "Congratulations on your promotion!",
                    review.decision.message ||
                      `Congratulations, ${review.member.name}! You have been promoted to ${review.decision.roleName}. Thank you for your work and dedication to Drakora.`,
                    `${review.id}:promotion`,
                  ),
                  `${review.id}:promotion`,
                );
                review.discord.dm = "sent";
              } catch (error) {
                if (error.code !== 50007) throw error;
                review.discord.dm = "blocked";
              }
              persist(review);
            }
            await client.rest.patch(Routes.channel(target.id), {
              body: { archived: true, locked: true, invitable: false },
            });
            review.discord.completed = true;
            persist(review);
          }
          review.discord.error = null;
          persist(review);
        } catch {
          review.discord.error = "Discord synchronization is pending.";
          persist(review);
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }
  const track = (work) => {
    tasks.add(work);
    work
      .catch(() =>
        console.error("Staff review message synchronization is pending."),
      )
      .finally(() => tasks.delete(work));
  };
  const create = (message) => {
    const review = reviews
      .records()
      .find((item) => item.discord.threadId === message.channelId);
    if (!review) return;
    track(
      (async () => {
        const raw = await client.rest.get(
          Routes.channelMessage(message.channelId, message.id),
        );
        await importMessage(raw, review);
      })(),
    );
  };
  const update = (_old, message) => create(message);
  const remove = (message) => {
    const review = reviews
      .records()
      .find((item) => item.discord.threadId === message.channelId);
    if (review && review.status === "open") {
      for (const [key, saved] of store.entries(
        `staff-review-messages:${review.id}`,
      ))
        if (key === message.id || saved.discordId === message.id)
          store.delete(`staff-review-messages:${review.id}`, key);
    }
  };
  client.on("messageCreate", create);
  client.on("messageUpdate", update);
  client.on("messageDelete", remove);
  return {
    flush,
    async erase(review) {
      if (review.discord.threadId)
        try {
          const target = await client.rest.get(
            Routes.channel(review.discord.threadId),
          );
          if (
            target.parent_id !== parentId ||
            target.type !== ChannelType.PrivateThread ||
            !target.name.endsWith(review.id)
          )
            throw new Error("Staff review cleanup ownership check failed.");
          await client.rest.delete(Routes.channel(target.id));
        } catch (error) {
          if (error.code !== 10003) throw error;
        }
      if (review.discord.announcement)
        try {
          const notice = await client.rest.get(
            Routes.channelMessage(parentId, review.discord.announcement),
          );
          if (
            notice.author.id !== client.user.id ||
            !notice.embeds?.some(
              (item) =>
                item.footer?.text === `Staff review · ${review.id}:start`,
            )
          )
            throw new Error("Staff review notice ownership check failed.");
          await client.rest.delete(Routes.channelMessage(parentId, notice.id));
        } catch (error) {
          if (error.code !== 10008) throw error;
        }
    },
    async close() {
      stopped = true;
      client.off("messageCreate", create);
      client.off("messageUpdate", update);
      client.off("messageDelete", remove);
      await running;
      await Promise.allSettled([...tasks]);
    },
  };
}
