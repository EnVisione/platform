import { permissions } from "./roles.js";
import { discordAvatar } from "./avatar.js";

export class AuthError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function discordClient(config, store, fetcher = fetch) {
  const pending = new Map();
  async function token(params) {
    const response = await fetcher("https://discord.com/api/oauth2/token", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        ...params,
      }),
    });
    if (!response.ok) throw new AuthError("discord_login_required", 401);
    return response.json();
  }
  async function api(path, accessToken) {
    const response = await fetcher(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401)
      throw new AuthError("discord_login_required", 401);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new AuthError("discord_unavailable", 503);
    return response.json();
  }
  async function login(code) {
    const tokens = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${config.staffOrigin}/auth/discord/callback`,
    });
    const profile = await api("/users/@me", tokens.access_token);
    if (!profile?.verified || !profile.email)
      throw new AuthError("verified_email_required");
    const user = {
      ...store.get("user", profile.id),
      id: profile.id,
      email: profile.email.toLowerCase(),
      name: profile.global_name || profile.username,
      username: profile.username,
      avatar: discordAvatar(profile),
      tokens,
      tokenExpires: Date.now() + tokens.expires_in * 1000,
      checkedAt: 0,
    };
    store.set("user", user.id, user, Number.MAX_SAFE_INTEGER);
    return check(user.id, true);
  }
  async function refresh(id, force) {
    const user = store.get("user", id);
    if (!user?.tokens) throw new AuthError("discord_login_required", 401);
    if (!force && Date.now() - user.checkedAt < 60000) return user;
    if (user.tokenExpires < Date.now() + 30000) {
      user.tokens = await token({
        grant_type: "refresh_token",
        refresh_token: user.tokens.refresh_token,
      });
      user.tokenExpires = Date.now() + user.tokens.expires_in * 1000;
    }
    const member = await api(
      `/users/@me/guilds/${config.guildId}/member`,
      user.tokens.access_token,
    );
    user.roles = member?.pending ? [] : (member?.roles ?? []);
    user.permissions = permissions(config, user.roles);
    if (member?.user) {
      user.avatar = discordAvatar(member.user, config.guildId, member.avatar);
      user.name =
        member.nick || member.user.global_name || member.user.username;
    }
    user.checkedAt = Date.now();
    store.set("user", id, user, Number.MAX_SAFE_INTEGER);
    return user;
  }
  async function check(id, force = false) {
    if (!pending.has(id))
      pending.set(
        id,
        refresh(id, force).finally(() => pending.delete(id)),
      );
    return pending.get(id);
  }
  return { login, check };
}
