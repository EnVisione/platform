import { randomBytes } from "node:crypto";
import { AuthError } from "./discord.js";
import { canHost } from "./roles.js";

export function meetingService(config, store, transport) {
  const locks = new Map();
  const get = (id) => store.get("meeting", id) ?? { status: "closed" };
  const set = (id, value) =>
    store.set("meeting", id, value, Number.MAX_SAFE_INTEGER);
  async function exclusive(id, action) {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(id, next);
    try {
      return await next;
    } finally {
      if (locks.get(id) === next) locks.delete(id);
    }
  }
  async function start(id, user) {
    if (!canHost(config, user)) throw new AuthError("meeting_host_required");
    return exclusive(id, async () => {
      const room = config.office.rooms.find(
        (item) => item.id === id && item.kind === "meeting",
      );
      if (!room) throw new AuthError("unknown_meeting_room", 404);
      const current = get(id);
      if (current.status === "live") return current;
      if (current.status === "ending" || current.status === "error")
        throw new AuthError("meeting_recovery_required", 409);
      const pending = {
        status: "starting",
        startedAt: Date.now(),
        hostId: user.id,
        nonce: randomBytes(12).toString("hex"),
      };
      set(id, pending);
      try {
        await transport.setOpen(room, true);
        const messageId = await transport.invite(room, user, pending.nonce);
        const live = { ...pending, status: "live", messageId };
        set(id, live);
        return live;
      } catch (error) {
        try {
          await transport.setOpen(room, false);
          set(id, { ...pending, status: "closed" });
        } catch {
          set(id, { ...pending, status: "error" });
        }
        throw error;
      }
    });
  }
  async function end(id, user) {
    if (!canHost(config, user)) throw new AuthError("meeting_host_required");
    return exclusive(id, async () => {
      const room = config.office.rooms.find(
        (item) => item.id === id && item.kind === "meeting",
      );
      if (!room) throw new AuthError("unknown_meeting_room", 404);
      const current = get(id);
      if (current.status === "closed") return current;
      set(id, { ...current, status: "ending" });
      await transport.setOpen(room, false);
      if (current.messageId) await transport.endInvite(room, current.messageId);
      const closed = { ...current, status: "closed", endedAt: Date.now() };
      set(id, closed);
      return closed;
    });
  }
  async function reconcile() {
    for (const room of config.office.rooms.filter(
      (item) => item.kind === "meeting",
    )) {
      await exclusive(room.id, async () => {
        const current = get(room.id);
        await transport.setOpen(room, current.status === "live");
        if (current.status !== "live" && current.status !== "closed") {
          if (current.messageId)
            await transport.endInvite(room, current.messageId);
          set(room.id, { ...current, status: "closed" });
        }
      });
    }
  }
  return { get, start, end, reconcile };
}
