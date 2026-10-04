import { PermissionFlagsBits, Routes } from "discord.js";

export function discordRoleTransport(config, client) {
  const settings = config.roleSync;
  const guildIds = [config.guildId, settings.guildId];
  const guilds = new Map();
  const memberSnapshot = (guildId, member) => ({
    guildId,
    id: member.user.id,
    bot: member.user.bot,
    roles: member.roles,
    pending: member.pending,
    joinedAt: member.joined_at,
  });
  return {
    async validate() {
      for (const id of guildIds) {
        const guild = await client.guilds.fetch(id);
        await guild.roles.fetch();
        const me = await guild.members.fetchMe({ force: true });
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
          throw new Error("discord_role_permission_required");
        const field = id === config.guildId ? "staffId" : "mainId";
        for (const mapping of settings.roles) {
          const role = guild.roles.cache.get(mapping[field]);
          if (!role || role.managed || role.id === id)
            throw new Error("discord_role_mapping_invalid");
        }
        guilds.set(id, guild);
      }
    },
    async members(guildId) {
      const members = [];
      let after;
      for (;;) {
        const query = new URLSearchParams({ limit: "1000" });
        if (after) query.set("after", after);
        const page = await client.rest.get(Routes.guildMembers(guildId), {
          query,
        });
        members.push(...page.map((member) => memberSnapshot(guildId, member)));
        if (page.length < 1000) return members;
        after = page.at(-1).user.id;
      }
    },
    async member(guildId, id) {
      try {
        const member = await client.rest.get(Routes.guildMember(guildId, id));
        return memberSnapshot(guildId, member);
      } catch (error) {
        if (error.code === 10007) return undefined;
        throw error;
      }
    },
    async change(guildId, id, roleId, add) {
      if (!guilds.get(guildId)?.roles.cache.get(roleId)?.editable)
        throw new Error("discord_role_hierarchy_required");
      const route = Routes.guildMemberRole(guildId, id, roleId);
      const options = { reason: "synchronize staff ranks" };
      if (add) await client.rest.put(route, options);
      else await client.rest.delete(route, options);
    },
    async prepareChanges(guildId, changes) {
      const guild = guilds.get(guildId);
      if (
        changes.some(
          ([role]) =>
            !guild?.roles.cache.get(
              role[guildId === config.guildId ? "staffId" : "mainId"],
            )?.editable,
        )
      )
        throw new Error("discord_role_hierarchy_required");
    },
  };
}

export function staffRoleSync(config, store, transport) {
  const settings = config.roleSync;
  const guildIds = [config.guildId, settings.guildId];
  const workers = new Map();
  const specialistIds = new Set(
    Object.values(config.applications?.specialistRoles ?? {}),
  );
  const mappedIds = settings.roles.map((role) => role.staffId);
  let initialization;
  let initialized = false;
  let stopped = false;
  const kind = "discord-role-sync";
  const canonical = (member) => {
    const ids = new Set(member.roles);
    const field = member.guildId === config.guildId ? "staffId" : "mainId";
    return settings.roles
      .filter((role) => ids.has(role[field]))
      .map((role) => role.staffId);
  };
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const valid = (member) =>
    !stopped &&
    member &&
    !member.bot &&
    guildIds.includes(member.guildId) &&
    /^\d{1,20}$/.test(member.id) &&
    Array.isArray(member.roles);
  const save = (state) =>
    store.set(kind, state.id, state, Number.MAX_SAFE_INTEGER);
  const observation = (member, previous) => ({
    roles: canonical(member),
    joinedAt: member.joinedAt ?? previous?.joinedAt,
  });
  const echoes = (state) =>
    (state.echoes ?? []).filter((echo) => echo.expiresAt > Date.now());
  function remember(state, guildId, roles) {
    state.echoes = [
      ...echoes(state),
      { guildId, roles, expiresAt: Date.now() + 300000 },
    ];
    save(state);
  }
  function intent(state, guildId, roles) {
    state.roles = roles;
    state.sourceGuildId = guildId;
    state.version++;
    state.delivery = {};
  }
  function mark(id, guildId, version, status, member, error) {
    const state = store.get(kind, id);
    if (state.version !== version) return;
    state.delivery[guildId] = {
      status,
      ...(error ? { error, retryAt: Date.now() + 60000 } : {}),
    };
    if (member)
      state.observed[guildId] = observation(member, state.observed[guildId]);
    save(state);
  }
  async function synchronize(id) {
    while (!stopped) {
      const current = store.get(kind, id);
      if (!current || current.roles === null) return;
      const version = current.version;
      for (const guildId of guildIds) {
        if (stopped || store.get(kind, id).version !== version) break;
        try {
          const member = await transport.member(guildId, id);
          if (stopped || store.get(kind, id).version !== version) break;
          if (!member || member.pending) {
            mark(
              id,
              guildId,
              version,
              member ? "waiting_screening" : "waiting_member",
              member,
            );
            continue;
          }
          const field = guildId === config.guildId ? "staffId" : "mainId";
          const desired = new Set(current.roles);
          const present = new Set(member.roles);
          const changes = settings.roles
            .filter(
              (role) => present.has(role[field]) && !desired.has(role.staffId),
            )
            .map((role) => [role, false]);
          changes.push(
            ...settings.roles
              .filter(
                (role) =>
                  !present.has(role[field]) && desired.has(role.staffId),
              )
              .map((role) => [role, true]),
          );
          await transport.prepareChanges?.(guildId, changes);
          for (const [role, add] of changes) {
            if (stopped || store.get(kind, id).version !== version) break;
            if (add) present.add(role[field]);
            else present.delete(role[field]);
            const expected = canonical({ guildId, roles: [...present] });
            remember(store.get(kind, id), guildId, expected);
            try {
              await transport.change(guildId, id, role[field], add);
            } catch (error) {
              if (
                error.message === "discord_role_hierarchy_required" ||
                (error.status >= 400 && error.status < 500)
              ) {
                const latest = store.get(kind, id);
                const index = latest.echoes.findLastIndex(
                  (echo) =>
                    echo.guildId === guildId && equal(echo.roles, expected),
                );
                if (index !== -1) latest.echoes.splice(index, 1);
                save(latest);
              }
              throw error;
            }
          }
          if (stopped) return;
          if (store.get(kind, id).version !== version) break;
          mark(id, guildId, version, "synced", {
            ...member,
            roles: [...present],
          });
        } catch (error) {
          mark(
            id,
            guildId,
            version,
            "retry",
            undefined,
            String(error.code ?? error.message ?? "unavailable"),
          );
        }
      }
      if (store.get(kind, id).version === version) return;
    }
  }
  function queue(id) {
    if (stopped) return Promise.resolve();
    if (!workers.has(id))
      workers.set(
        id,
        synchronize(id).finally(() => workers.delete(id)),
      );
    return workers.get(id);
  }
  function newState(id) {
    return {
      id,
      mappedIds,
      roles: null,
      version: 0,
      observed: {},
      delivery: {},
      echoes: [],
    };
  }
  function consumeEcho(state, guildId, roles) {
    state.echoes = echoes(state);
    const index = state.echoes.findIndex(
      (echo) => echo.guildId === guildId && equal(echo.roles, roles),
    );
    if (index === -1) return false;
    state.echoes.splice(index, 1);
    return true;
  }
  function update(member) {
    if (!valid(member)) return Promise.resolve();
    const roles = canonical(member);
    const state = store.get(kind, member.id) ?? newState(member.id);
    if (!roles.length && !state.version && state.roles === null)
      return Promise.resolve();
    const previous = state.observed[member.guildId]?.roles;
    const copied = consumeEcho(state, member.guildId, roles);
    state.observed[member.guildId] = observation(
      member,
      state.observed[member.guildId],
    );
    if (copied || equal(previous, roles)) {
      save(state);
      return !member.pending &&
        state.delivery[member.guildId]?.status === "waiting_screening"
        ? queue(member.id)
        : Promise.resolve();
    }
    intent(state, member.guildId, roles);
    save(state);
    return queue(member.id);
  }
  async function join(member) {
    if (!valid(member)) return;
    let state = store.get(kind, member.id);
    if (!state) {
      const peer = await transport.member(
        guildIds.find((id) => id !== member.guildId),
        member.id,
      );
      if (stopped) return;
      state = store.get(kind, member.id) ?? newState(member.id);
      if (!state.version) {
        const source = peer && canonical(peer).length ? peer : member;
        const roles = new Set(canonical(source));
        for (const entry of [member, peer].filter(Boolean))
          for (const id of canonical(entry))
            if (specialistIds.has(id)) roles.add(id);
        if (!roles.size) return;
        intent(
          state,
          source.guildId,
          mappedIds.filter((id) => roles.has(id)),
        );
      }
    }
    state.observed[member.guildId] = observation(
      member,
      state.observed[member.guildId],
    );
    save(state);
    await queue(member.id);
  }
  async function initialize() {
    if (stopped) return;
    if (initialization) return initialization;
    initialization = (async () => {
      const versions = new Map(
        store.entries(kind).map(([id, state]) => [id, state.version]),
      );
      await transport.validate();
      const snapshots = new Map();
      for (const guildId of guildIds) {
        const members = await transport.members(guildId);
        if (stopped) return;
        snapshots.set(
          guildId,
          new Map(
            members
              .filter((member) => !member.bot)
              .map((member) => [member.id, member]),
          ),
        );
      }
      const ids = new Set(store.entries(kind).map(([id]) => id));
      for (const members of snapshots.values())
        for (const member of members.values())
          if (canonical(member).length) ids.add(member.id);
      for (const id of ids) {
        if (stopped) return;
        const state = store.get(kind, id) ?? newState(id);
        if (state.version !== (versions.get(id) ?? 0)) continue;
        const members = guildIds
          .map((guildId) => snapshots.get(guildId).get(id))
          .filter(Boolean);
        const knownIds = new Set(
          !state.version
            ? mappedIds.filter((id) => !specialistIds.has(id))
            : (state.mappedIds ??
                mappedIds.filter(
                  (id) =>
                    !specialistIds.has(id) ||
                    state.roles?.includes(id) ||
                    Object.values(state.observed).some((entry) =>
                      entry.roles.includes(id),
                    ),
                )),
        );
        const knownRoles = (roles) => roles.filter((id) => knownIds.has(id));
        const observedRoles = (member) => knownRoles(canonical(member));
        const changed = members.filter((member) => {
          const previous = state.observed[member.guildId];
          return (
            previous &&
            previous.joinedAt === member.joinedAt &&
            !equal(knownRoles(previous.roles), observedRoles(member)) &&
            !consumeEcho(state, member.guildId, canonical(member))
          );
        });
        let source;
        if (state.version && changed.length === 1) source = changed[0];
        else if (!state.version || changed.length > 1) {
          const preferred =
            settings.initialSource === "staff"
              ? config.guildId
              : settings.initialSource === "main"
                ? settings.guildId
                : undefined;
          source = members.find(
            (member) =>
              member.guildId === preferred &&
              (state.version || observedRoles(member).length),
          );
          if (
            !source &&
            (members.length === 1 ||
              equal(observedRoles(members[0]), observedRoles(members[1])))
          )
            source = members[0];
          if (
            !source &&
            members.filter((member) => observedRoles(member).length).length ===
              1
          )
            source = members.find((member) => observedRoles(member).length);
          if (!source) {
            state.roles = null;
            state.version++;
          }
        }
        const desired = source ? observedRoles(source) : state.roles;
        if (desired !== null) {
          const roles = new Set(desired);
          for (const member of members)
            for (const id of canonical(member))
              if (!knownIds.has(id)) roles.add(id);
          const merged = mappedIds.filter((id) => roles.has(id));
          if (source || !equal(state.roles, merged))
            intent(state, source?.guildId ?? state.sourceGuildId, merged);
        }
        state.mappedIds = mappedIds;
        for (const member of members)
          state.observed[member.guildId] = observation(
            member,
            state.observed[member.guildId],
          );
        save(state);
        if (state.roles !== null) await queue(id);
      }
      initialized = true;
    })().finally(() => {
      initialization = undefined;
    });
    return initialization;
  }
  return {
    initialize,
    update,
    join,
    async assign(id, roles) {
      if (
        stopped ||
        !/^\d{1,20}$/.test(id) ||
        !Array.isArray(roles) ||
        new Set(roles).size !== roles.length ||
        roles.some((id) => !settings.roles.some((role) => role.staffId === id))
      )
        throw new Error("discord_role_mapping_invalid");
      if (!initialized) await initialize();
      const state = store.get(kind, id) ?? newState(id);
      intent(
        state,
        config.guildId,
        settings.roles
          .filter((role) => roles.includes(role.staffId))
          .map((role) => role.staffId),
      );
      save(state);
      await queue(id);
      return store.get(kind, id);
    },
    async retry(force = false) {
      if (stopped) return;
      if (!initialized) return initialize();
      await transport.validate();
      for (const [id, state] of store.entries(kind))
        if (
          state.roles !== null &&
          guildIds.some((guildId) => {
            const delivery = state.delivery[guildId];
            return (
              !delivery ||
              (delivery.status === "retry" &&
                (force || delivery.retryAt <= Date.now()))
            );
          })
        )
          await queue(id);
    },
    async close() {
      stopped = true;
      await initialization?.catch(() => {});
      await Promise.allSettled([...workers.values()]);
    },
  };
}
