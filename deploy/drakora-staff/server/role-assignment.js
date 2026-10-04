import { PermissionFlagsBits, Routes } from "discord.js";
import { randomUUID } from "node:crypto";
import { AuthError } from "./discord.js";
import { discordAvatar } from "./avatar.js";
import { hash } from "./store.js";

export function discordRoleAdministration(config, client) {
  const guildIds = [config.guildId, config.roleSync?.guildId].filter(Boolean);
  const snapshot = (guildId, member) => ({
    guildId,
    id: member.user.id,
    name: member.nick || member.user.global_name || member.user.username,
    avatar: discordAvatar(member.user, guildId, member.avatar),
    roles: member.roles,
    bot: member.user.bot,
    pending: member.pending,
  });
  async function member(guildId, id) {
    try {
      return snapshot(
        guildId,
        await client.rest.get(Routes.guildMember(guildId, id)),
      );
    } catch (error) {
      if (error.code === 10007) return null;
      throw new AuthError("discord_unavailable", 503);
    }
  }
  return {
    async lookup(id) {
      return (
        await Promise.all(guildIds.map((guildId) => member(guildId, id)))
      ).filter(Boolean);
    },
    async search(query) {
      const found = new Set();
      for (const guildId of guildIds) {
        const guild = await client.guilds.fetch(guildId);
        const members = query
          ? await guild.members.search({ query, limit: 50 })
          : guild.members.cache;
        for (const member of members.values())
          if (!member.user.bot) found.add(member.id);
      }
      return [...found].slice(0, 100);
    },
    async metadata(roleIds) {
      const guild = await client.guilds.fetch(config.guildId);
      await guild.roles.fetch();
      const me = await guild.members.fetchMe({ force: true });
      return roleIds.map((id) => {
        const role = guild.roles.cache.get(id);
        return {
          id,
          name: role?.name ?? null,
          color: role?.hexColor ?? null,
          assignable: Boolean(
            role &&
            !role.managed &&
            role.id !== guild.id &&
            role.editable &&
            me.permissions.has(PermissionFlagsBits.ManageRoles),
          ),
        };
      });
    },
    async change(id, roleId, add) {
      const metadata = await this.metadata([roleId]);
      if (!metadata[0].assignable)
        throw new AuthError("discord_role_hierarchy_required", 409);
      try {
        const route = Routes.guildMemberRole(config.guildId, id, roleId);
        const options = {
          reason: "update staff roles from the staff dashboard",
        };
        if (add) await client.rest.put(route, options);
        else await client.rest.delete(route, options);
      } catch {
        throw new AuthError("discord_unavailable", 503);
      }
    },
  };
}

export function roleAssignments(config, store, policy, transport, sync) {
  const locks = new Map();
  let stopped = false;
  const managed = policy.roles.filter((role) => role.id);
  const mappedIds = new Set(
    (config.roleSync?.roles ?? []).map((role) => role.staffId),
  );
  const syncRoles = (request) =>
    [request.rank, ...request.extraRoles].filter((id) => mappedIds.has(id));
  const mainRole = (id) =>
    config.roleSync?.roles.find((role) => role.mainId === id)?.staffId;
  const staffRoles = (members) =>
    members.find((member) => member.guildId === config.guildId)?.roles ??
    members
      .find((member) => member.guildId === config.roleSync?.guildId)
      ?.roles.map(mainRole)
      .filter(Boolean) ??
    [];
  const version = (members) =>
    hash(
      JSON.stringify(
        members
          .map((member) => [
            member.guildId,
            [...member.roles].sort(),
            Boolean(member.pending),
          ])
          .sort(),
      ),
    );
  const set = (value) =>
    store.set("role-assignment", value.id, value, Number.MAX_SAFE_INTEGER);
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
  function status(id) {
    const request = store.get("role-assignment", id);
    const ranks = store.get("discord-role-sync", id);
    return {
      request: request
        ? {
            status: request.status,
            error: request.error,
            requestedAt: request.requestedAt,
            actor: request.actor,
          }
        : null,
      discord: Object.fromEntries(
        [
          ["Staff server", config.guildId],
          ["Main server", config.roleSync.guildId],
        ]
          .filter(([, id]) => ranks?.delivery?.[id])
          .map(([name, id]) => [name, ranks.delivery[id]]),
      ),
      minecraft: "Not connected",
    };
  }
  async function summarize(id, members) {
    if (!members.length || members.some((member) => member.bot)) return null;
    const roles = staffRoles(members);
    const user =
      members.find((member) => member.guildId === config.guildId) ?? members[0];
    return {
      id,
      name: user.name,
      avatar: user.avatar,
      roles: managed
        .filter((role) => roles.includes(role.id))
        .map((role) => role.id),
      access: {
        dashboard: roles.includes(config.accessRoles.dashboard),
        todo: roles.includes(config.accessRoles.todo),
      },
      inStaff: members.some((member) => member.guildId === config.guildId),
      inMain: members.some(
        (member) => member.guildId === config.roleSync?.guildId,
      ),
      version: version(members),
      ...status(id),
    };
  }
  async function reconcile(id) {
    return exclusive(id, async () => {
      const request = store.get("role-assignment", id);
      if (stopped || !request || request.status === "applied") return;
      try {
        const roles = syncRoles(request);
        if (
          !request.rankQueued ||
          JSON.stringify(request.syncedRoles) !== JSON.stringify(roles)
        ) {
          await sync.assign(id, roles);
          request.rankQueued = true;
          request.syncedRoles = roles;
          set(request);
        }
        const members = await transport.lookup(id);
        const member = members.find(
          (member) => member.guildId === config.guildId,
        );
        if (!member || member.pending) {
          set({
            ...request,
            status: member ? "waiting_screening" : "waiting_member",
            error: null,
          });
          return;
        }
        const extraIds = [
          ...managed
            .filter((role) => role.specialist && !mappedIds.has(role.id))
            .map((role) => role.id),
          ...Object.values(config.accessRoles),
        ];
        const desired = new Set(request.extraRoles);
        const changes = extraIds.filter(
          (role) => member.roles.includes(role) !== desired.has(role),
        );
        const metadata = await transport.metadata(changes);
        if (metadata.some((role) => !role.assignable)) {
          set({
            ...request,
            status: "waiting_hierarchy",
            error: "discord_role_hierarchy_required",
          });
          return;
        }
        for (const role of changes)
          await transport.change(id, role, desired.has(role));
        const user = store.get("user", id);
        if (user)
          store.set(
            "user",
            id,
            { ...user, checkedAt: 0 },
            Number.MAX_SAFE_INTEGER,
          );
        set({ ...request, status: "applied", error: null });
      } catch (error) {
        set({
          ...request,
          status: "pending",
          error:
            error.code === "discord_role_hierarchy_required"
              ? error.code
              : "discord_unavailable",
        });
      }
    });
  }
  async function assign(user, id, input, addRole) {
    const current = policy.authorize(user, "roles.assign");
    if (
      !/^\d{1,20}$/.test(id) ||
      !input ||
      typeof input.version !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.version) ||
      (!addRole &&
        ((input.rank !== null &&
          !managed.some(
            (role) => !role.specialist && role.id === input.rank,
          )) ||
          !Array.isArray(input.specialists) ||
          input.specialists.length > 3 ||
          new Set(input.specialists).size !== input.specialists.length ||
          input.specialists.some(
            (id) => !managed.some((role) => role.specialist && role.id === id),
          ) ||
          typeof input.access?.dashboard !== "boolean" ||
          typeof input.access?.todo !== "boolean")) ||
      (addRole &&
        ![
          ...managed.map((role) => role.id),
          config.accessRoles.dashboard,
        ].includes(addRole))
    )
      throw new AuthError("invalid_role_assignment", 400);
    return exclusive(id, async () => {
      const members = await transport.lookup(id);
      if (!members.length || members.some((member) => member.bot))
        throw new AuthError("discord_member_required", 404);
      if (version(members) !== input.version)
        throw new AuthError("discord_roles_changed", 409);
      const roles = staffRoles(members);
      if (addRole) {
        const queued = store.get("role-assignment", id);
        const pending = queued && queued.status !== "applied";
        const extras = new Set(pending ? queued.extraRoles : roles);
        const selected = managed.find((role) => role.id === addRole);
        if (selected?.specialist || addRole === config.accessRoles.dashboard)
          extras.add(addRole);
        input = {
          version: input.version,
          rank:
            selected && !selected.specialist
              ? selected.id
              : pending
                ? queued.rank
                : (managed.find(
                    (role) => !role.specialist && roles.includes(role.id),
                  )?.id ?? null),
          specialists: managed
            .filter((role) => role.specialist && extras.has(role.id))
            .map((role) => role.id),
          access: {
            dashboard: extras.has(config.accessRoles.dashboard),
            todo: extras.has(config.accessRoles.todo),
          },
        };
        if (
          pending &&
          !policy.isFounder(current) &&
          queued.rank !== input.rank &&
          managed.some(
            (role) =>
              ["Founder", "Manager"].includes(role.name) &&
              role.id === queued.rank,
          )
        )
          throw new AuthError("founder_role_required");
      }
      const desiredRank = managed.find((role) => role.id === input.rank);
      const protectedRoles = managed.filter((role) =>
        ["Founder", "Manager"].includes(role.name),
      );
      if (
        !policy.isFounder(current) &&
        (protectedRoles.some(
          (role) => roles.includes(role.id) !== (input.rank === role.id),
        ) ||
          (roles.some((id) => protectedRoles.some((role) => role.id === id)) &&
            (input.access.dashboard !==
              roles.includes(config.accessRoles.dashboard) ||
              input.access.todo !== roles.includes(config.accessRoles.todo))))
      )
        throw new AuthError("founder_role_required");
      if (
        policy.isFounder(current) &&
        current.id === id &&
        (desiredRank?.name !== "Founder" || !input.access.dashboard)
      )
        throw new AuthError("founder_access_protected", 400);
      if (!sync) throw new AuthError("role_sync_unavailable", 503);
      const extraRoles = [
        ...input.specialists,
        ...(input.access.dashboard ? [config.accessRoles.dashboard] : []),
        ...(input.access.todo ? [config.accessRoles.todo] : []),
      ];
      const request = {
        id,
        operationId: randomUUID(),
        requestedAt: Date.now(),
        actor: { id: user.id, name: user.name },
        extraRoles,
        rank: input.rank,
        status: "pending",
        error: null,
      };
      set(request);
      policy.audit(user, "assignment", {
        memberId: id,
        rank: input.rank,
        specialists: input.specialists,
        access: input.access,
      });
      const syncedRoles = syncRoles(request);
      await sync.assign(id, syncedRoles);
      set({ ...request, rankQueued: true, syncedRoles });
      return { queued: true, id, ...status(id) };
    }).then(async (result) => {
      await reconcile(id);
      return { ...result, ...status(id) };
    });
  }
  return {
    status,
    async list(user, query = "", offset = 0) {
      policy.authorize(user, "roles.view");
      if (
        typeof query !== "string" ||
        query.length > 80 ||
        /[\r\n\0]/.test(query) ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw new AuthError("invalid_request", 400);
      const ids = /^\d{1,20}$/.test(query)
        ? [query]
        : await transport.search(query.trim());
      const members = [];
      for (const id of ids.slice(offset, offset + 25)) {
        const item = await summarize(id, await transport.lookup(id));
        if (item) members.push(item);
      }
      return {
        members: members.sort((a, b) => a.name.localeCompare(b.name)),
        total: ids.length,
        offset,
        limited: ids.length >= 100,
      };
    },
    async metadata(user) {
      policy.authorize(user, "roles.view");
      const roles = await transport.metadata(managed.map((role) => role.id));
      return roles.map((role) => ({
        ...role,
        syncsToMain: mappedIds.has(role.id),
      }));
    },
    assign,
    grant(user, id, version, roleId) {
      return assign(user, id, { version }, roleId);
    },
    reconcile,
    async retry() {
      for (const [id, request] of store
        .entries("role-assignment")
        .filter(([, request]) => request.status !== "applied")
        .slice(0, 50)) {
        if (stopped) return;
        await reconcile(id);
      }
    },
    async close() {
      stopped = true;
      await Promise.allSettled([...locks.values()]);
    },
  };
}
