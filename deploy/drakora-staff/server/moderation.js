import { AuthError } from "./discord.js";

const day = 86400000;
const actions = ["warn", "timeout", "ban"];
const identity = /^\d{1,20}$/;

export function moderationHistory(store) {
  function record(value) {
    return {
      id: value.id,
      userId: value.userId,
      name: value.name || value.username || `Discord user ${value.userId}`,
      username: value.username || null,
      action: value.action,
      source: "Honeypot",
      reason:
        value.reason ||
        (value.action === "ban"
          ? "Honeypot. Repeat post in the clearly marked spam trap. Permanent ban."
          : value.action === "timeout"
            ? "Honeypot. First post in the clearly marked spam trap. 24 hour timeout."
            : "Honeypot. Posting in the clearly marked spam trap."),
      at: value.at,
      timeoutUntil: value.timeoutUntil || null,
      guildId: value.guildId,
      channelId: value.channelId,
      expiresAt: value.at + 90 * day,
    };
  }
  const recorded = (value) =>
    value.result === "applied" &&
    actions.includes(value.action) &&
    identity.test(value.userId) &&
    Number.isFinite(value.at) &&
    value.at + 90 * day > Date.now();
  return {
    list(input = {}) {
      const { offset = 0, action = "all", query = "" } = input;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 100000 ||
        !["all", ...actions].includes(action) ||
        typeof query !== "string" ||
        query.length > 100
      )
        throw new AuthError("invalid_request", 400);
      const scoped = Object.hasOwn(input, "userId");
      const matched = !scoped || identity.test(input.userId ?? "");
      const term = query.trim().toLowerCase();
      const values = matched
        ? store
            .entries("honeypot-audit")
            .map(([, value]) => value)
            .filter(
              (value) =>
                recorded(value) &&
                (!scoped || value.userId === input.userId) &&
                (!term ||
                  [value.userId, value.name, value.username].some(
                    (text) =>
                      typeof text === "string" &&
                      text.toLowerCase().includes(term),
                  )),
            )
        : [];
      const counts = Object.fromEntries(actions.map((action) => [action, 0]));
      for (const value of values) counts[value.action]++;
      const filtered = values
        .filter((value) => action === "all" || value.action === action)
        .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
      return {
        items: filtered.slice(offset, offset + 25).map(record),
        total: filtered.length,
        pageSize: 25,
        counts,
        matched,
        retentionDays: 90,
      };
    },
    get(id) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
        throw new AuthError("moderation_not_found", 404);
      const value = store.page(
        "honeypot-audit",
        1,
        0,
        (entry) => entry.id === id && recorded(entry),
      ).items[0];
      if (!value) throw new AuthError("moderation_not_found", 404);
      return record(value);
    },
  };
}
