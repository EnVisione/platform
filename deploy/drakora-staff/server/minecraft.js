import { AuthError } from "./discord.js";

const expires = Number.MAX_SAFE_INTEGER;
const validName = /^[A-Za-z0-9_]{3,16}$/;

export function minecraftRegistry(store) {
  const get = (id) => store.get("minecraft-link", id);

  function nameFrom(value) {
    if (typeof value !== "string" || !validName.test(value))
      throw new AuthError("invalid_minecraft_name", 400);
    return value;
  }

  function available(name, exceptId) {
    const normalized = name.toLowerCase();
    for (const [id, link] of store.entries("minecraft-link")) {
      if (id === exceptId) continue;
      if (
        link.name.toLowerCase() === normalized ||
        link.changeRequest?.name.toLowerCase() === normalized
      )
        throw new AuthError("minecraft_name_taken", 409);
    }
  }

  function register(id, value) {
    if (get(id)) throw new AuthError("minecraft_name_locked", 409);
    const name = nameFrom(value);
    available(name, id);
    const link = { name, status: "pending", submittedAt: Date.now() };
    store.set("minecraft-link", id, link, expires);
    return link;
  }

  function requestChange(id, value) {
    const link = get(id);
    if (!link) throw new AuthError("minecraft_name_required", 428);
    const name = nameFrom(value);
    if (name.toLowerCase() === link.name.toLowerCase())
      throw new AuthError("minecraft_name_unchanged", 400);
    available(name, id);
    link.changeRequest = { name, requestedAt: Date.now() };
    store.set("minecraft-link", id, link, expires);
    return link;
  }

  function decide(id, approve) {
    const link = get(id);
    if (!link?.changeRequest)
      throw new AuthError("minecraft_change_not_found", 404);
    if (approve) {
      available(link.changeRequest.name, id);
      link.name = link.changeRequest.name;
      link.status = "pending";
      link.submittedAt = Date.now();
    }
    delete link.changeRequest;
    store.set("minecraft-link", id, link, expires);
    return link;
  }

  return {
    get,
    register,
    requestChange,
    decide,
    entries: () => store.entries("minecraft-link"),
  };
}
