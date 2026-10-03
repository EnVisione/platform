import { randomBytes, createHash } from "node:crypto";
import { AuthError } from "./discord.js";

const hash = (code) => createHash("sha256").update(code).digest("hex");

export function workspaceSessions(store) {
  function validate(staffSession, userId) {
    const parent = store.get("session", staffSession);
    const user = store.get("user", userId);
    if (
      !parent ||
      parent.userId !== userId ||
      parent.until <= Date.now() ||
      (parent.accessEpoch || 0) !== (user?.accessEpoch || 0)
    )
      throw new AuthError("login_required", 401);
    return parent;
  }
  return {
    validate,
    issue(staffSession, userId, view) {
      const code = randomBytes(32).toString("base64url");
      store.set(
        "workspace-handoff",
        hash(code),
        { staffSession, userId, view },
        Date.now() + 60000,
      );
      return code;
    },
    take(code) {
      if (typeof code !== "string" || !/^[\w-]{43}$/.test(code))
        throw new AuthError("invalid_handoff");
      const handoff = store.take("workspace-handoff", hash(code));
      if (!handoff) throw new AuthError("invalid_handoff");
      const parent = validate(handoff.staffSession, handoff.userId);
      return { ...handoff, until: parent.until };
    },
  };
}
