import { isIP } from "node:net";
import { AuthError } from "./discord.js";

const validName = (name) =>
  typeof name === "string" && /^[A-Za-z0-9_]{3,16}$/.test(name);

export function moderationUUID(value) {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(
      value,
    )
  )
    return null;
  const compact = value.replaceAll("-", "").toLowerCase();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

export function canonicalModerationIP(value) {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (address.includes("%")) return null;
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;
  const normalized = new URL("http://[" + address + "]/").hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [
    Math.floor(high / 256),
    high % 256,
    Math.floor(low / 256),
    low % 256,
  ].join(".");
}

export function moderationTargetResolver(
  store,
  { fetcher = fetch, now = Date.now } = {},
) {
  async function profile(key, url) {
    const cached = store.get("moderation-profile", key);
    if (cached) return cached;
    let response;
    try {
      response = await fetcher(url, {
        signal: AbortSignal.timeout(8000),
        redirect: "error",
        headers: { Accept: "application/json" },
      });
    } catch {
      throw new AuthError("minecraft_profile_unavailable", 503);
    }
    if ([204, 404].includes(response.status))
      throw new AuthError("minecraft_profile_not_found", 404);
    if (!response.ok) throw new AuthError("minecraft_profile_unavailable", 503);
    let result;
    try {
      const body = await response.json();
      const uuid = moderationUUID(body.id);
      if (!uuid || !validName(body.name)) throw new Error("invalid_profile");
      result = { uuid, name: body.name };
    } catch {
      throw new AuthError("minecraft_profile_unavailable", 503);
    }
    if (key.startsWith("uuid:") && result.uuid !== key.slice(5))
      throw new AuthError("minecraft_profile_unavailable", 503);
    store.set(
      "moderation-profile",
      "name:" + result.name.toLowerCase(),
      result,
      now() + 21600000,
    );
    store.set(
      "moderation-profile",
      "uuid:" + result.uuid,
      result,
      now() + 21600000,
    );
    return result;
  }
  return async (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new AuthError("invalid_moderation_target", 400);
    if (input.ip !== undefined) {
      const ip = canonicalModerationIP(input.ip);
      if (!ip || input.uuid !== undefined || input.name !== undefined)
        throw new AuthError("invalid_moderation_ip", 400);
      return { uuid: null, name: ip, ip };
    }
    if (input.uuid !== undefined) {
      const uuid = moderationUUID(input.uuid);
      if (!uuid) throw new AuthError("invalid_moderation_target", 400);
      if (input.name !== undefined) {
        if (!validName(input.name))
          throw new AuthError("invalid_minecraft_name", 400);
        return { uuid, name: input.name };
      }
      return profile(
        "uuid:" + uuid,
        "https://sessionserver.mojang.com/session/minecraft/profile/" +
          uuid.replaceAll("-", ""),
      );
    }
    const name =
      typeof input.name === "string" ? input.name.trim() : input.name;
    if (!validName(name)) throw new AuthError("invalid_minecraft_name", 400);
    return profile(
      "name:" + name.toLowerCase(),
      "https://api.mojang.com/users/profiles/minecraft/" +
        encodeURIComponent(name),
    );
  };
}
