import { permissions } from "./roles.js";
import { discordAvatar } from "./avatar.js";

export class AuthError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function discordClient(
  config,
  store,
  fetcher = fetch,
  applyPermissions = (user) => user,
  membership,
) {
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
    const previous = store.get("user", profile.id);
    const user = {
      ...previous,
      id: profile.id,
      returning: Boolean(previous),
      email: profile.email.toLowerCase(),
      name: profile.global_name || profile.username,
      username: profile.username,
      avatar: discordAvatar(profile),
      tokens,
      tokenExpires: Date.now() + tokens.expires_in * 1000,
      checkedAt: 0,
      lastActiveAt: Date.now(),
    };
    store.set("user", user.id, user, Number.MAX_SAFE_INTEGER);
    const admitted = await check(user.id, true);
    if (!admitted.staffMember) throw new AuthError("staff_server_required");
    if (!admitted.permissions.dashboard)
      throw new AuthError("dashboard_role_required");
    return admitted;
  }
  async function refresh(id) {
    const user = store.get("user", id);
    if (!user?.tokens) throw new AuthError("discord_login_required", 401);
    const revision = user.accessRevision || 0;
    if (user.tokenExpires < Date.now() + 30000) {
      user.tokens = await token({
        grant_type: "refresh_token",
        refresh_token: user.tokens.refresh_token,
      });
      user.tokenExpires = Date.now() + user.tokens.expires_in * 1000;
    }
    const member = membership
      ? await membership.member(id)
      : await api(
          `/users/@me/guilds/${config.guildId}/member`,
          user.tokens.access_token,
        );
    const latest = store.get("user", id);
    if (!latest) throw new AuthError("discord_login_required", 401);
    user.lastActiveAt = Math.max(
      user.lastActiveAt || 0,
      latest.lastActiveAt || 0,
    );
    if ((latest?.accessRevision || 0) !== revision) return latest;
    user.staffMember = Boolean(member && !member.pending);
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
    if (membership && !membership.available())
      throw new AuthError("discord_unavailable", 503);
    const cached = store.get("user", id);
    if (
      !force &&
      cached?.staffMember !== undefined &&
      Date.now() - cached.checkedAt < 60000
    )
      return applyPermissions(cached);
    if (!pending.has(id))
      pending.set(
        id,
        refresh(id).finally(() => pending.delete(id)),
      );
    const user = await pending.get(id);
    const latest = store.get("user", id);
    return applyPermissions(
      (latest?.accessRevision || 0) !== (user.accessRevision || 0)
        ? latest
        : user,
    );
  }
  function observe(packet) {
    const member = packet.d;
    if (
      member?.guild_id !== config.guildId ||
      !member.user?.id ||
      ![
        "GUILD_MEMBER_ADD",
        "GUILD_MEMBER_UPDATE",
        "GUILD_MEMBER_REMOVE",
      ].includes(packet.t) ||
      (packet.t !== "GUILD_MEMBER_REMOVE" && !Array.isArray(member.roles))
    )
      return;
    const user = store.get("user", member.user.id);
    const roles =
      packet.t === "GUILD_MEMBER_REMOVE" || member.pending ? [] : member.roles;
    const current = applyPermissions({
      ...(user || {}),
      id: member.user.id,
      roles,
      permissions: permissions(config, roles),
    });
    const revoked = !current.permissions.dashboard;
    if (user) {
      Object.assign(user, {
        roles,
        permissions: current.permissions,
        staffMember: packet.t !== "GUILD_MEMBER_REMOVE" && !member.pending,
        checkedAt: 0,
        accessRevision: (user.accessRevision || 0) + 1,
        accessEpoch: (user.accessEpoch || 0) + Number(revoked),
      });
      store.set("user", user.id, user, Number.MAX_SAFE_INTEGER);
    }
    if (revoked)
      for (const [id, session] of store.entries("session"))
        if (session.userId === member.user.id) store.delete("session", id);
    return { id: member.user.id, revoked };
  }
  async function identity(code) {
    const tokens = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${config.staffOrigin}/auth/discord/callback`,
    });
    const profile = await api("/users/@me", tokens.access_token);
    if (!profile?.id) throw new AuthError("discord_login_required", 401);
    const member = await api(
      `/users/@me/guilds/${config.guildId}/member`,
      tokens.access_token,
    );
    const roles = new Set(member?.pending ? [] : (member?.roles ?? []));
    const specialistIds = new Set(
      Object.values(config.applications?.specialistRoles ?? {}),
    );
    const specialistMappings = (config.roleSync?.roles ?? []).filter((role) =>
      specialistIds.has(role.staffId),
    );
    if (specialistMappings.length) {
      const mainMember = await api(
        `/users/@me/guilds/${config.roleSync.guildId}/member`,
        tokens.access_token,
      );
      if (mainMember && !mainMember.pending)
        for (const role of specialistMappings)
          if (mainMember.roles.includes(role.mainId)) roles.add(role.staffId);
    }
    return {
      id: profile.id,
      name: profile.global_name || profile.username,
      username: profile.username,
      avatar: discordAvatar(profile),
      email:
        profile.verified && profile.email ? profile.email.toLowerCase() : null,
      roles: [...roles],
    };
  }
  return { login, check, identity, observe };
}
