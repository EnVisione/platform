import { monthsAfter, inactivityMonths } from "../shared/privacy.js";

const forever = Number.MAX_SAFE_INTEGER;
const day = 86400000;
export const inactiveAt = (at, now) =>
  Number.isFinite(at) && at > 0 && monthsAfter(at, inactivityMonths) <= now;

export function privacyActivity(store, id, at = Date.now()) {
  if (!/^\d{1,20}$/.test(id || "")) return;
  store.set("privacy-activity", id, { at }, forever);
  const user = store.get("user", id);
  if (user) store.set("user", id, { ...user, lastActiveAt: at }, forever);
}

export function retentionService(
  config,
  store,
  { tickets, applications, applicationStore, now = Date.now } = {},
) {
  let timer,
    running,
    stopped = false;
  function lastActive(record, discordId) {
    return Math.max(
      record.lastActiveAt || record.createdAt || 0,
      store.get("privacy-activity", discordId || "")?.at || 0,
      store.get("user", discordId || "")?.lastActiveAt || 0,
    );
  }
  async function sweep() {
    if (!config.privacy?.retentionEnabled || stopped) return;
    if (running) return running;
    running = Promise.resolve()
      .then(async () => {
        let removed = 0,
          failed = 0,
          attempted = 0;
        for (const [id, user] of store.entries("user")) {
          if (!store.get("privacy-activity", id))
            privacyActivity(store, id, user.lastActiveAt || now());
        }
        const candidates = [];
        for (const [, ticket] of tickets?.store.entries("ticket") || []) {
          const at = lastActive(
            ticket,
            ticket.owner.guest ? null : ticket.owner.id,
          );
          if (
            (ticket.erasingAt || inactiveAt(at, now())) &&
            !tickets.store.get("privacy-hold", ticket.id)
          )
            candidates.push(() => {
              const current = tickets.store.get("ticket", ticket.id);
              if (!current) return false;
              const latest = lastActive(
                current,
                current.owner.guest ? null : current.owner.id,
              );
              return current.erasingAt || inactiveAt(latest, now())
                ? tickets.eraseInactive(ticket.id, latest)
                : false;
            });
        }
        for (const [, record] of applicationStore?.entries("application") ||
          []) {
          const at = lastActive(record, record.discord?.id);
          if (
            (record.erasingAt || inactiveAt(at, now())) &&
            !applicationStore.get("privacy-hold", record.id)
          )
            candidates.push(() => {
              const current = applicationStore.get("application", record.id);
              if (!current) return false;
              const latest = lastActive(current, current.discord?.id);
              return current.erasingAt || inactiveAt(latest, now())
                ? applications.eraseInactive(record.id, latest)
                : false;
            });
        }
        const cursor = store.get("privacy-retention", "cursor")?.offset || 0;
        for (let i = 0; i < Math.min(50, candidates.length); i++) {
          try {
            if (await candidates[(cursor + i) % candidates.length]()) removed++;
          } catch {
            failed++;
          }
          attempted++;
        }
        store.set(
          "privacy-retention",
          "cursor",
          {
            offset: candidates.length
              ? (cursor + attempted) % candidates.length
              : 0,
          },
          forever,
        );
        for (const [id, user] of store.entries("user")) {
          if (
            !inactiveAt(lastActive(user, id), now()) ||
            store.get("privacy-hold", id)
          )
            continue;
          store.transaction(() => {
            for (const kind of [
              "user",
              "minecraft-link",
              "time-preferences",
              "member-activity",
            ])
              store.delete(kind, id);
            for (const [key, value] of store.entries("session"))
              if (value.userId === id) store.delete("session", key);
          });
          removed++;
        }
        for (const [id, value] of store.entries("privacy-activity"))
          if (inactiveAt(value.at, now())) store.delete("privacy-activity", id);
        for (const kind of ["role-audit", "mail-response"])
          for (const [key, value] of store.entries(kind))
            if (inactiveAt(value.at || value.sentAt, now()))
              store.delete(kind, key);
        store.set(
          "privacy-retention",
          "last",
          { at: now(), removed, failed },
          now() + 30 * day,
        );
        if (failed)
          console.error("Privacy deletion has pending external cleanup.");
        return { removed, failed };
      })
      .finally(() => {
        running = null;
      });
    return running;
  }
  return {
    touch: (id) => privacyActivity(store, id, now()),
    sweep,
    start() {
      const run = () =>
        void sweep().catch(() =>
          console.error("Privacy retention sweep failed."),
        );
      timer = setInterval(run, day);
      timer.unref();
      run();
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
