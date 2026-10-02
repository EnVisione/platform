const activeStatuses = new Set(["online", "idle", "dnd"]);
const retention = 90 * 24 * 60 * 60 * 1000;

export function memberActivity(
  store,
  { guildIds = [], isMember = () => false } = {},
) {
  const allowedGuilds = new Set(guildIds);
  function record(id, at, interval = 0) {
    const now = Date.now();
    if (
      typeof id !== "string" ||
      !/^\d{1,20}$/.test(id) ||
      !Number.isSafeInteger(at) ||
      at <= now - retention ||
      at > now + 60000
    )
      return;
    const previous = store.get("member-activity", id)?.lastActiveAt;
    if (previous !== undefined && (at <= previous || at - previous < interval))
      return;
    store.set("member-activity", id, { lastActiveAt: at }, at + retention);
  }
  return {
    observe(id, status, at = Date.now()) {
      if (!activeStatuses.has(status)) return;
      record(id, at, 60000);
    },
    observeMessage(message) {
      if (
        !allowedGuilds.has(message.guildId) ||
        !message.author ||
        message.author.bot ||
        message.webhookId ||
        message.system ||
        !isMember(message.author.id)
      )
        return;
      record(message.author.id, message.createdTimestamp);
    },
    lastActiveAt(id) {
      return store.get("member-activity", id)?.lastActiveAt;
    },
  };
}
