import { randomUUID } from "node:crypto";
import { hash } from "./store.js";
import { bridgeFailure, bridgePlayer, bridgeUuid } from "./minecraft-bridge.js";

const forever = Number.MAX_SAFE_INTEGER;
const keyOf = (rank) => `${rank.rank}:${rank.scope}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const applyErrors = new Set([
  "proxy_apply_failed",
  "rank_store_unavailable",
  "rank_assignment_failed",
  "rank_expired",
  "unsupported_rank",
  "stale_revision",
  "player_unavailable",
  "game_storage_unavailable",
  "rank_job_conflict",
]);
export function minecraftRankBridge(
  config,
  store,
  links,
  transport,
  staffSync,
  now = Date.now,
) {
  const settings = config.minecraftBridge;
  const staff = settings.staffMappings ?? [],
    shop = settings.storeMappings ?? [];
  const mappings = { staff, store: shop };
  const enabled = settings.rankSyncEnabled === true;
  const mappingVersion = hash(JSON.stringify(shop));
  const locks = new Map();
  const recovered = new Set();
  let stopped = false;
  const empty = (uuid) => ({
    uuid,
    revision: 0,
    snapshotRevision: -1,
    snapshot: null,
    desiredStore: null,
    observedStore: null,
    memberReady: false,
    refresh: false,
    jobs: {},
    mappingVersion,
  });
  const state = (uuid) => store.get("minecraft-ranks", uuid) ?? empty(uuid);
  const save = (value) =>
    store.set("minecraft-ranks", value.uuid, value, forever);
  const audit = (event, value) =>
    store.set(
      "minecraft-rank-audit",
      randomUUID(),
      {
        event,
        uuid: value.uuid,
        revision: value.revision,
        category: value.category,
        ...(value.error ? { error: value.error } : {}),
        at: now(),
      },
      now() + 90 * 86400000,
    );
  for (const [uuid, owner] of links.entries()) {
    const saved = store.get("minecraft-ranks", uuid);
    const value = saved ?? empty(uuid);
    const changed = saved && value.mappingVersion !== mappingVersion;
    const bootstrapStaff = owner.staffLinked && !value.staffSyncInitialized;
    if (!changed && !bootstrapStaff && saved) continue;
    store.transaction(() => {
      if (changed) {
        value.mappingVersion = mappingVersion;
        value.memberReady = false;
        value.desiredStore = null;
        value.observedStore = null;
        value.refresh = enabled;
        value.echoes = [];
        delete value.pendingStore;
        delete value.pendingStoreRoles;
        delete value.jobs.store;
        store.delete("minecraft-rank-job", `${uuid}:store`);
      }
      if (bootstrapStaff) {
        value.staffBootstrap = true;
        value.refresh = enabled;
      }
      save(value);
    });
  }
  const positive = (r) =>
    r.expiresAt === null || r.expiresAt > Math.floor(now() / 1000);
  function normalize(ranks) {
    if (!Array.isArray(ranks) || ranks.length > 64)
      throw bridgeFailure("invalid_rank_snapshot");
    const seen = new Set();
    return ranks
      .map((r) => {
        if (
          !r ||
          typeof r.rank !== "string" ||
          !/^[a-z][a-z0-9_]{0,63}$/.test(r.rank) ||
          !["network", "rh", "prom2"].includes(r.scope) ||
          !(
            r.expiresAt === null ||
            (Number.isSafeInteger(r.expiresAt) && r.expiresAt > 0)
          ) ||
          seen.has(keyOf(r))
        )
          throw bridgeFailure("invalid_rank_snapshot");
        seen.add(keyOf(r));
        return { rank: r.rank, scope: r.scope, expiresAt: r.expiresAt };
      })
      .filter(positive)
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }
  const categoryRanks = (ranks, category) =>
    ranks.filter((r) => mappings[category].some((m) => keyOf(m) === keyOf(r)));
  const scopes = ["network", "rh", "prom2"];
  const scopeRanks = (ranks, category, scope) =>
    categoryRanks(ranks, category).filter((r) => r.scope === scope);
  const jobKey = (uuid, category) => `${uuid}:${category}`;
  function reducesStaffRights(current) {
    const held = new Map(
      categoryRanks(state(current.uuid).gameRanks ?? [], "staff")
        .filter(positive)
        .map((r) => [keyOf(r), r]),
    );
    return current.assignments.filter(positive).every((desired) => {
      const existing = held.get(keyOf(desired));
      return (
        existing &&
        (existing.expiresAt === null ||
          (desired.expiresAt !== null &&
            desired.expiresAt <= existing.expiresAt))
      );
    });
  }
  function writeJob(value, category, assignments) {
    value.revision++;
    const next = {
      id: randomUUID(),
      uuid: value.uuid,
      revision: value.revision,
      category,
      assignments,
      status: "pending",
      attempts: 0,
      nextAt: now(),
      leaseUntil: 0,
    };
    value.jobs[category] = next.id;
    store.set(
      "minecraft-rank-job",
      jobKey(value.uuid, category),
      next,
      forever,
    );
    save(value);
    audit("queued", next);
  }
  function job(uuid, category, assignments) {
    if (!enabled || stopped) return;
    const value = state(uuid),
      current = store.get("minecraft-rank-job", jobKey(uuid, category));
    if (
      current &&
      same(current.assignments, assignments) &&
      current.status !== "failed" &&
      (current.status !== "done" ||
        same(categoryRanks(value.snapshot ?? [], category), assignments))
    )
      return;
    store.transaction(() => {
      writeJob(value, category, assignments);
    });
  }
  function errorState(uuid, code) {
    const value = state(uuid);
    const safeCode =
      typeof code === "string" && /^[a-z0-9_]{1,80}$/.test(code)
        ? code
        : "bridge_retry_pending";
    if (value.error !== safeCode) audit("retry", { ...value, error: safeCode });
    value.error = safeCode;
    value.retryAt = now() + 60000;
    value.attempts = Math.min(10, (value.attempts ?? 0) + 1);
    save(value);
  }
  async function exclusive(uuid, action) {
    const previous = locks.get(uuid) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    locks.set(uuid, pending);
    try {
      return await pending;
    } finally {
      if (locks.get(uuid) === pending) locks.delete(uuid);
    }
  }
  const storeRoles = (roles) =>
    shop.filter((m) => roles.includes(m.roleId)).map((m) => m.roleId);
  async function reconcile(uuid) {
    const owner = links.owner(uuid);
    if (stopped || !owner) return;
    let value = state(uuid);
    try {
      if (owner.memberLinked && !value.pendingStore) {
        const member = await transport.member(owner.discord.id);
        if (!member || member.pending || member.bot)
          throw bridgeFailure("member_unavailable", 503);
        if (!recovered.has(uuid)) {
          if (enabled && value.memberReady) {
            await transport.validate(shop.map((m) => m.roleId));
            const actual = storeRoles(member.roles);
            const copied = (value.echoes ?? []).some(
              (e) => e.expiresAt > now() && same(e.roles, actual),
            );
            if (!copied && !same(actual, value.observedStore)) {
              recordStoreIntent(value, actual);
              await applyPendingStore(owner, member);
              value = state(uuid);
            }
          }
          recovered.add(uuid);
        }
        const expected =
          value.desiredStore === null
            ? null
            : shop
                .filter((m) =>
                  value.desiredStore.some(
                    (r) => keyOf(r) === keyOf(m) && positive(r),
                  ),
                )
                .map((m) => m.roleId);
        const desired = new Set([
          ...(expected ?? storeRoles(member.roles)),
          settings.linkedRoleId,
        ]);
        const managed =
          expected === null || !enabled
            ? [settings.linkedRoleId]
            : [settings.linkedRoleId, ...shop.map((m) => m.roleId)];
        await transport.validate(managed);
        const present = new Set(member.roles);
        const revision = value.revision;
        for (const roleId of managed) {
          if (stopped || state(uuid).revision !== revision) return;
          if (present.has(roleId) === desired.has(roleId)) continue;
          if (desired.has(roleId)) present.add(roleId);
          else present.delete(roleId);
          value = state(uuid);
          value.echoStore = storeRoles([...present]);
          value.echoUntil = now() + 300000;
          const echo = {
            id: randomUUID(),
            roles: value.echoStore,
            expiresAt: value.echoUntil,
          };
          if (roleId !== settings.linkedRoleId)
            value.echoes = [
              ...(value.echoes ?? []).filter((e) => e.expiresAt > now()),
              echo,
            ].slice(-32);
          save(value);
          try {
            await transport.change(
              owner.discord.id,
              roleId,
              desired.has(roleId),
            );
          } catch (error) {
            if (error.definiteFailure) {
              const latest = state(uuid);
              latest.echoes = (latest.echoes ?? []).filter(
                (e) => e.id !== echo.id,
              );
              save(latest);
            }
            throw error;
          }
        }
        value = state(uuid);
        if (value.revision !== revision) return;
        value.observedStore = storeRoles([...present]);
        if (expected !== null && enabled) value.memberReady = true;
        save(value);
      }
      value = state(uuid);
      if (enabled && owner.staffLinked && value.staffBootstrap) {
        const member = await transport.assertStaff(owner.discord.id);
        const intended =
          store.get("discord-role-sync", owner.discord.id)?.roles ??
          member.roles;
        job(
          uuid,
          "staff",
          staff
            .filter((m) => intended.includes(m.roleId))
            .map((m) => ({ rank: m.rank, scope: m.scope, expiresAt: null }))
            .sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
        );
        value = state(uuid);
        value.staffBootstrap = false;
        value.staffSyncInitialized = true;
        save(value);
      } else if (enabled && owner.staffLinked && value.snapshot !== null) {
        await transport.assertStaff(owner.discord.id);
        const pending = store.get("minecraft-rank-job", jobKey(uuid, "staff"));
        const source =
          pending && pending.status !== "done"
            ? pending.assignments
            : value.snapshot;
        const desired = staff
          .filter((m) =>
            source.some((r) => keyOf(r) === keyOf(m) && positive(r)),
          )
          .map((m) => m.roleId);
        const previous =
          store.get("discord-role-sync", owner.discord.id)?.roles ?? [];
        const mapped = new Set(staff.map((m) => m.roleId));
        const next = config.roleSync.roles
          .filter(
            (r) =>
              desired.includes(r.staffId) ||
              (!mapped.has(r.staffId) && previous.includes(r.staffId)),
          )
          .map((r) => r.staffId);
        if (!same(previous, next))
          await staffSync.setDesired(
            owner.discord.id,
            next,
            `minecraft:${uuid}`,
          );
      }
      value = state(uuid);
      delete value.error;
      delete value.retryAt;
      value.attempts = 0;
      save(value);
    } catch (error) {
      errorState(uuid, error.code ?? "discord_unavailable");
    }
  }
  const unsubscribe = staffSync.onIntent((intent) => {
    if (
      !enabled ||
      (typeof intent.origin === "string" &&
        intent.origin.startsWith("minecraft:"))
    )
      return;
    const linked = links.byDiscord(intent.id),
      owner = linked && links.owner(linked.uuid);
    if (!owner?.staffLinked) return;
    const current = new Map(
      (state(owner.uuid).snapshot ?? [])
        .filter(positive)
        .map((r) => [keyOf(r), r]),
    );
    const assignments = staff
      .filter((m) => intent.roles.includes(m.roleId))
      .map((m) => ({
        rank: m.rank,
        scope: m.scope,
        expiresAt: current.get(keyOf(m))?.expiresAt ?? null,
      }))
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    job(owner.uuid, "staff", assignments);
  });
  function recordStoreIntent(value, actual) {
    value.pendingStore = actual;
    value.pendingStoreRoles = shop
      .filter(
        (m) =>
          actual.includes(m.roleId) !==
          (value.observedStore ?? []).includes(m.roleId),
      )
      .map((m) => m.roleId);
    value.revision++;
    save(value);
  }
  async function applyPendingStore(owner, checkedMember) {
    const value = state(owner.uuid);
    if (!value.pendingStore) return;
    const member = checkedMember ?? (await transport.member(owner.discord.id));
    if (!member || member.pending || member.bot)
      throw bridgeFailure("member_unavailable", 503);
    await transport.validate(shop.map((m) => m.roleId));
    const actual = value.pendingStore;
    const changed = new Set(
      value.pendingStoreRoles ?? shop.map((m) => m.roleId),
    );
    const current = new Map(
      (value.desiredStore ?? []).map((r) => [keyOf(r), r]),
    );
    const assignments = normalize([
      ...(value.desiredStore ?? []).filter(
        (r) =>
          !shop.some((m) => keyOf(m) === keyOf(r) && changed.has(m.roleId)),
      ),
      ...shop
        .filter((m) => changed.has(m.roleId) && actual.includes(m.roleId))
        .map((m) => {
          const existing = current.get(keyOf(m));
          return {
            rank: m.rank,
            scope: m.scope,
            expiresAt:
              existing && positive(existing) ? existing.expiresAt : null,
          };
        }),
    ]);
    value.observedStore = [
      ...(value.observedStore ?? []).filter((id) => !changed.has(id)),
      ...shop
        .filter((m) => changed.has(m.roleId) && actual.includes(m.roleId))
        .map((m) => m.roleId),
    ].sort(
      (a, b) =>
        shop.findIndex((m) => m.roleId === a) -
        shop.findIndex((m) => m.roleId === b),
    );
    value.desiredStore = assignments;
    delete value.pendingStore;
    delete value.pendingStoreRoles;
    store.transaction(() => {
      save(value);
      writeJob(value, "store", assignments);
    });
  }
  return {
    async linked(owner, kind, firstConsent = true) {
      const value = state(owner.uuid);
      value.refresh = enabled;
      if (kind === "staff" && firstConsent) value.staffBootstrap = true;
      if (kind === "member" && firstConsent) {
        value.desiredStore = null;
        value.memberReady = false;
      }
      save(value);
      await exclusive(owner.uuid, () => reconcile(owner.uuid));
    },
    async snapshot(input) {
      const player = bridgePlayer(input.player, true),
        ranks = normalize(input.ranks);
      if (!Number.isSafeInteger(input.revision) || input.revision < 0)
        throw bridgeFailure("invalid_rank_revision");
      return exclusive(player.uuid, async () => {
        let value = state(player.uuid);
        const owner = links.owner(player.uuid);
        if (!owner) return { ok: true };
        const bootstrap = owner?.memberLinked && value.desiredStore === null;
        if (input.revision < value.snapshotRevision) return { ok: true };
        if (input.revision === value.snapshotRevision) {
          if (!same(ranks, normalize(value.snapshotInput ?? value.snapshot)))
            throw bridgeFailure("rank_revision_conflict", 409);
          if (!bootstrap) return { ok: true };
        }
        if (bootstrap && !categoryRanks(ranks, "store").length) {
          const member = await transport.member(owner.discord.id);
          if (!member || member.pending || storeRoles(member.roles).length) {
            value.refresh = true;
            save(value);
            return { ok: true };
          }
        }
        const priorGame = normalize(
          value.gameRanks ?? value.snapshotInput ?? value.snapshot ?? [],
        );
        const firstSnapshot = value.snapshot === null;
        const updates = [];
        let projected = ranks.filter(
          (r) => ![...staff, ...shop].some((m) => keyOf(m) === keyOf(r)),
        );
        for (const category of ["staff", "store"]) {
          const pending = store.get(
            "minecraft-rank-job",
            jobKey(player.uuid, category),
          );
          const active = pending && pending.status !== "done";
          const changed = scopes.filter(
            (scope) =>
              firstSnapshot ||
              !same(
                scopeRanks(priorGame, category, scope),
                scopeRanks(ranks, category, scope),
              ),
          );
          const desired =
            category === "store"
              ? (value.desiredStore ?? categoryRanks(priorGame, category))
              : active
                ? pending.assignments.filter(positive)
                : categoryRanks(ranks, category);
          const merged = normalize(
            scopes.flatMap((scope) => {
              if (category === "staff" && active && firstSnapshot)
                return scopeRanks(desired, category, scope);
              if (
                (category === "store" && bootstrap) ||
                changed.includes(scope) ||
                (!active && category === "staff")
              )
                return scopeRanks(ranks, category, scope);
              return scopeRanks(desired, category, scope);
            }),
          );
          if (category === "store") {
            value.desiredStore = merged;
            if (value.pendingStore) {
              value.pendingStoreRoles = (
                value.pendingStoreRoles ?? shop.map((m) => m.roleId)
              ).filter((id) => {
                const mapping = shop.find((m) => m.roleId === id);
                return (
                  mapping &&
                  same(
                    priorGame.find((r) => keyOf(r) === keyOf(mapping)),
                    ranks.find((r) => keyOf(r) === keyOf(mapping)),
                  )
                );
              });
              if (!value.pendingStoreRoles.length) {
                delete value.pendingStore;
                delete value.pendingStoreRoles;
              }
            }
          }
          projected.push(...merged);
          if (active) {
            if (same(merged, categoryRanks(ranks, category)))
              updates.push({ category, complete: true });
            else if (!same(pending.assignments.filter(positive), merged))
              updates.push({ category, assignments: merged });
          }
        }
        value.snapshotRevision = input.revision;
        value.snapshot = normalize(projected);
        value.snapshotInput = ranks;
        value.gameRanks = ranks;
        value.refresh = false;
        value.lastRefreshAt = now();
        store.transaction(() => {
          for (const { category, complete, assignments } of updates) {
            if (assignments) {
              writeJob(value, category, assignments);
              continue;
            }
            if (!complete) continue;
            const key = jobKey(player.uuid, category),
              pending = store.get("minecraft-rank-job", key);
            if (pending && pending.status !== "done") {
              pending.status = "done";
              pending.superseded = true;
              pending.leaseUntil = 0;
              store.set("minecraft-rank-job", key, pending, forever);
            }
          }
          save(value);
          if (!same(priorGame, ranks))
            audit("snapshot", { uuid: player.uuid, revision: input.revision });
        });
        if (
          bootstrap ||
          firstSnapshot ||
          value.staffBootstrap ||
          updates.length ||
          !same(priorGame, ranks)
        )
          await reconcile(player.uuid);
        return { ok: true };
      });
    },
    async observe(packet) {
      if (
        !enabled ||
        stopped ||
        packet.t !== "GUILD_MEMBER_UPDATE" ||
        packet.d?.guild_id !== config.roleSync.guildId ||
        packet.d.pending ||
        !Array.isArray(packet.d.roles) ||
        !packet.d.user?.id ||
        packet.d.user.bot
      )
        return;
      const linked = links.byDiscord(packet.d.user.id),
        owner = linked && links.owner(linked.uuid);
      if (!owner?.memberLinked) return;
      const value = state(owner.uuid);
      const actual = storeRoles(packet.d.roles);
      value.echoes = (value.echoes ?? []).filter((e) => e.expiresAt > now());
      const copied = value.echoes.findIndex((e) => same(e.roles, actual));
      if (copied !== -1) {
        value.echoes.splice(copied, 1);
        value.observedStore = actual;
        save(value);
        return;
      }
      if (!value.memberReady) return;
      if (same(actual, value.observedStore)) return;
      recordStoreIntent(value, actual);
      await exclusive(owner.uuid, async () => {
        try {
          await applyPendingStore(owner);
        } catch (error) {
          errorState(owner.uuid, error.code ?? "discord_unavailable");
        }
        await reconcile(owner.uuid);
      });
    },
    async poll() {
      const jobs = [],
        refresh = [];
      if (!enabled) return { ok: true, jobs, refresh };
      for (const [key, value] of store.entries("minecraft-rank-job")) {
        if (jobs.length >= 32) break;
        if (
          value.status === "done" ||
          value.nextAt > now() ||
          value.leaseUntil > now()
        )
          continue;
        const owner = links.owner(value.uuid);
        if (
          !owner?.[value.category === "staff" ? "staffLinked" : "memberLinked"]
        )
          continue;
        if (value.category === "staff") {
          try {
            if (!reducesStaffRights(value))
              await transport.assertStaff(owner.discord.id);
          } catch (error) {
            errorState(value.uuid, error.code ?? "discord_unavailable");
            continue;
          }
        } else {
          try {
            const member = await transport.member(owner.discord.id);
            if (!member || member.pending || member.bot)
              throw bridgeFailure("member_unavailable", 503);
            await transport.validate(shop.map((m) => m.roleId));
          } catch (error) {
            errorState(value.uuid, error.code ?? "discord_unavailable");
            continue;
          }
        }
        const current = store.get("minecraft-rank-job", key);
        if (
          current.id !== value.id ||
          current.revision !== value.revision ||
          current.status === "done" ||
          current.nextAt > now() ||
          current.leaseUntil > now()
        )
          continue;
        current.leaseUntil = now() + 30000;
        store.set("minecraft-rank-job", key, current, forever);
        jobs.push({
          id: current.id,
          uuid: current.uuid,
          revision: current.revision,
          category: current.category,
          assignments: current.assignments.filter(positive),
        });
      }
      const candidates = links
        .entries()
        .map(([uuid]) => uuid)
        .sort();
      const cursor = store.get("minecraft-refresh", "cursor")?.lastUuid ?? "";
      const next = candidates.findIndex((uuid) => uuid > cursor);
      let lastUuid;
      for (let i = 0; i < candidates.length; i++) {
        if (jobs.length + refresh.length >= 32) break;
        const uuid =
          candidates[((next === -1 ? 0 : next) + i) % candidates.length];
        const value = state(uuid);
        if (
          (value.refreshAfter ?? 0) > now() ||
          (!value.refresh && (value.lastRefreshAt ?? 0) > now() - 60000)
        )
          continue;
        refresh.push(uuid);
        value.lastRefreshAt = now();
        value.refreshAfter = now() + 60000;
        save(value);
        lastUuid = uuid;
      }
      if (lastUuid)
        store.set("minecraft-refresh", "cursor", { lastUuid }, forever);
      return { ok: true, jobs, refresh };
    },
    async ack(input) {
      return store.transaction(() => {
        const uuid = bridgeUuid(input.uuid),
          value = state(uuid);
        const category = Object.keys(value.jobs).find(
          (c) => value.jobs[c] === input.id,
        );
        const key = category && jobKey(uuid, category),
          current = key && store.get("minecraft-rank-job", key);
        if (
          !current ||
          current.revision !== input.revision ||
          typeof input.success !== "boolean"
        )
          throw bridgeFailure("rank_job_not_found", 409);
        const ranks = normalize(input.ranks);
        if (current.status === "done") {
          if (current.superseded) return { ok: true };
          if (
            !input.success ||
            !same(
              categoryRanks(ranks, category),
              current.assignments.filter(positive),
            )
          )
            throw bridgeFailure("rank_ack_conflict", 409);
          return { ok: true };
        }
        if (
          input.success &&
          !same(
            categoryRanks(ranks, category),
            current.assignments.filter(positive),
          )
        )
          throw bridgeFailure("rank_ack_mismatch", 409);
        if (!input.success) {
          const previousError = current.error;
          current.attempts = Math.min(10, current.attempts + 1);
          current.error = applyErrors.has(input.error)
            ? input.error
            : "proxy_apply_failed";
          current.nextAt =
            now() + Math.min(3600000, 5000 * 2 ** current.attempts);
          current.leaseUntil = 0;
          current.status = "failed";
          if (current.error !== previousError) audit("apply_failed", current);
        } else {
          current.status = "done";
          current.leaseUntil = 0;
          delete current.error;
          value.snapshot = [
            ...(value.snapshot ?? []).filter(
              (r) => !mappings[category].some((m) => keyOf(m) === keyOf(r)),
            ),
            ...categoryRanks(ranks, category),
          ].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
          if (category === "store")
            value.desiredStore = categoryRanks(value.snapshot, "store");
          value.gameRanks = [
            ...(value.gameRanks ?? []).filter(
              (r) => !mappings[category].some((m) => keyOf(m) === keyOf(r)),
            ),
            ...categoryRanks(ranks, category),
          ].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
          save(value);
          audit("applied", current);
        }
        store.set("minecraft-rank-job", key, current, forever);
        return { ok: true };
      });
    },
    async retry() {
      for (const [, owner] of links.entries()) {
        if (stopped) return;
        await exclusive(owner.uuid, async () => {
          try {
            await applyPendingStore(owner);
          } catch (error) {
            errorState(owner.uuid, error.code ?? "discord_unavailable");
            return;
          }
          const value = state(owner.uuid);
          if (!store.get("minecraft-ranks", owner.uuid)) {
            value.refresh = enabled;
            value.staffBootstrap = owner.staffLinked;
          }
          if (value.desiredStore)
            value.desiredStore = value.desiredStore.filter(positive);
          if (value.snapshot) value.snapshot = value.snapshot.filter(positive);
          if (value.gameRanks)
            value.gameRanks = value.gameRanks.filter(positive);
          save(value);
          await reconcile(owner.uuid);
        });
      }
    },
    async close() {
      stopped = true;
      unsubscribe();
      await Promise.allSettled([...locks.values()]);
    },
  };
}
