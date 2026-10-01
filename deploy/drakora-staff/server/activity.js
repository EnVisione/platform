const activeStatuses = new Set(["online", "idle", "dnd"]);
const retention = 90 * 24 * 60 * 60 * 1000;

export function memberActivity(store) {
  return {
    observe(id, status, at = Date.now()) {
      if (!activeStatuses.has(status)) return;
      const previous = store.get("member-activity", id)?.lastActiveAt;
      if (previous !== undefined && at - previous < 60000) return;
      store.set("member-activity", id, { lastActiveAt: at }, at + retention);
    },
    lastActiveAt(id) {
      return store.get("member-activity", id)?.lastActiveAt;
    },
  };
}
