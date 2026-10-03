import { createHmac } from "node:crypto";
import { syncProjectRoles } from "./project-roles.js";
import { syncAvatar } from "./profile.js";

export function hulyClient(config, store, fetcher = fetch) {
  function accountToken(account, until) {
    if (!account || !Number.isFinite(until) || until <= Date.now())
      throw new Error("Workspace session expired");
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({ typ: "JWT", alg: "HS256" })}.${encode({
      account,
      workspace: config.hulyWorkspace,
      extra: {},
      exp: Math.floor(until / 1000),
    })}`;
    return `${body}.${createHmac("sha256", config.hulySecret).update(body).digest("base64url")}`;
  }
  function serviceToken(account = config.hulyOwner) {
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({ typ: "JWT", alg: "HS256" })}.${encode({
      account,
      workspace: config.hulyWorkspace,
      extra: { service: "tool" },
      exp: Math.floor(Date.now() / 1000) + 120,
    })}`;
    return `${body}.${createHmac("sha256", config.hulySecret).update(body).digest("base64url")}`;
  }
  async function rpc(method, params) {
    const response = await fetcher(config.hulyAccounts, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken()}`,
      },
      body: JSON.stringify({ method, params }),
    });
    if (!response.ok)
      throw new Error(`Huly ${method} failed with HTTP ${response.status}`);
    const result = await response.json();
    if (result.error)
      throw new Error(
        `Huly ${method} failed: ${result.error.code ?? "RPC error"}`,
      );
    return result.result;
  }
  const locks = new Map();
  async function sync(user) {
    if (locks.has(user.id)) return locks.get(user.id);
    const action = reconcile(user).finally(() => locks.delete(user.id));
    locks.set(user.id, action);
    return action;
  }
  async function reconcile(user) {
    let account;
    if (user.permissions.dashboard) {
      const created = await rpc("ensureStaffAccount", {
        discordId: user.id,
        email: user.email,
        name: user.name,
        expectedAccount: user.hulyAccount,
      });
      account = created?.account;
      if (!account) throw new Error("Huly account creation failed");
    } else {
      account = await rpc("findPersonBySocialKey", {
        socialString: `oidc:discord:${user.id}`,
        requireAccount: true,
      });
    }
    if (!account) return user;
    if (user.hulyAccount && user.hulyAccount !== account)
      throw new Error("Huly identity conflict");
    const members = await rpc("getWorkspaceMembers", {});
    const current = members.find(
      (member) => member.person === account || member.account === account,
    );
    if (user.permissions.todo) {
      if (!current)
        await rpc("assignWorkspace", {
          email: user.email,
          workspaceUuid: config.hulyWorkspace,
          role: user.permissions.hulyRole,
        });
      if (
        account !== config.hulyOwner ||
        user.permissions.hulyRole === "OWNER"
      ) {
        await rpc("updateWorkspaceRole", {
          targetAccount: account,
          targetRole: user.permissions.hulyRole,
        });
      }
    } else if (current && account !== config.hulyOwner) {
      await rpc("leaveWorkspace", { account });
    }
    let syncedAvatar = user.syncedAvatar;
    if (
      user.permissions.todo &&
      user.avatar &&
      user.syncedAvatar !== user.avatar
    ) {
      if (await syncAvatar(config, serviceToken(), account, user.avatar))
        syncedAvatar = user.avatar;
    }
    const projectRanks = user.permissions.todo
      ? user.permissions.hulyRanks
      : [];
    if (JSON.stringify(user.projectRanks) !== JSON.stringify(projectRanks)) {
      await syncProjectRoles(config, serviceToken(), account, projectRanks);
    }
    const saved = {
      ...store.get("user", user.id),
      ...user,
      hulyAccount: account,
      syncedAt: user.checkedAt,
      syncedPolicyRevision: user.policyRevision,
      projectRanks,
      syncedAvatar,
    };
    store.set("user", user.id, saved, Number.MAX_SAFE_INTEGER);
    return saved;
  }
  async function invite(user) {
    return rpc("createInvite", {
      exp: 600000,
      email: user.email,
      limit: 1,
      role: user.permissions.hulyRole,
    });
  }
  return { rpc, sync, invite, serviceToken, accountToken };
}
