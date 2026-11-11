import { isIP } from "node:net";
import { AuthError } from "./discord.js";
import { bridgeUuid } from "./minecraft-bridge.js";
import { moderationScopes } from "../shared/moderation.js";
import { canonicalModerationIP } from "./moderation-targets.js";

const retention = 90 * 86400000;
const time = (value) => Number.isSafeInteger(value) && value >= 0;
export function playerActivity(store, { now = Date.now } = {}) {
  const freshReport = (report) =>
    Boolean(report && now() - report.observedAt < 30000);
  const authorize = (actor, capability) => {
    if (!actor?.permissions?.dashboard || !actor.capabilities?.[capability])
      throw new AuthError("players_access_denied");
  };
  function view(value, actor) {
    const reporter = store.get("players-proxy", value.proxy);
    const online = freshReport(reporter) && reporter.uuids.includes(value.uuid);
    return {
      uuid: value.uuid,
      name: value.name,
      nickname:
        online &&
        value.reportedAt === reporter.observedAt &&
        typeof value.nickname === "string"
          ? value.nickname
          : "",
      proxy: value.proxy,
      server: value.server,
      online: Boolean(online),
      stale: !freshReport(reporter),
      sessionStartedAt: value.sessionStartedAt,
      lastSeen: value.lastSeen,
      reportedAt: value.reportedAt,
      firstJoinedAt: value.firstJoinedAt ?? null,
      lastLoginAt: value.sessionStartedAt,
      playtimeSeconds: value.playtimeSeconds,
      perServerSeconds: value.perServerSeconds,
      ...(actor.capabilities["moderation.ip"] &&
      now() - (value.ipObservedAt ?? 0) < 30 * 86400000
        ? { ip: value.ip ?? null }
        : {}),
    };
  }
  return {
    proxyConnections() {
      return ["na", "eu"].map((proxy) => {
        const report = store.get("players-proxy", proxy);
        const fresh = freshReport(report);
        return {
          proxy,
          players: fresh ? report.uuids.length : null,
          observedAt: report?.observedAt ?? null,
          state: fresh ? "fresh" : report ? "stale" : "unavailable",
        };
      });
    },
    observe(proxy, input) {
      if (
        !["na", "eu"].includes(proxy) ||
        !input ||
        !time(input.observedAt) ||
        input.observedAt > now() + 5000 ||
        input.observedAt < now() - 30000 ||
        typeof input.snapshotId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(input.snapshotId) ||
        !Number.isSafeInteger(input.part) ||
        input.part < 0 ||
        input.part > 31 ||
        typeof input.complete !== "boolean" ||
        !Array.isArray(input.players) ||
        input.players.length > 32
      )
        throw new AuthError("invalid_players_snapshot", 400);
      const previous = store.get("players-proxy", proxy);
      if (previous?.snapshotId === input.snapshotId)
        return { ok: true, duplicate: true };
      if (previous && previous.observedAt >= input.observedAt)
        throw new AuthError("stale_players_snapshot", 409);
      const seen = new Set();
      const players = input.players.map((value) => {
        const uuid = bridgeUuid(value.uuid);
        const nickname = value.nickname === undefined ? "" : value.nickname;
        if (
          !uuid ||
          seen.has(uuid) ||
          !/^[A-Za-z0-9_]{3,16}$/.test(value.name ?? "") ||
          typeof nickname !== "string" ||
          Array.from(nickname).length > 64 ||
          (nickname !== "" && !/^[\p{L}\p{Nd}_-]+$/u.test(nickname)) ||
          !moderationScopes.includes(value.server) ||
          ["network", "rh", "prom2"].includes(value.server) ||
          typeof value.sessionId !== "string" ||
          value.sessionId.length > 120 ||
          !value.sessionId ||
          !time(value.sessionStartedAt) ||
          value.sessionStartedAt > input.observedAt ||
          !time(value.lastSeen) ||
          value.lastSeen > input.observedAt + 5000 ||
          value.lastSeen < input.observedAt - 30000 ||
          !time(value.playtimeSeconds) ||
          (value.firstJoinedAt !== undefined &&
            (!time(value.firstJoinedAt) ||
              value.firstJoinedAt > value.sessionStartedAt)) ||
          (value.ip !== undefined &&
            (typeof value.ip !== "string" || !isIP(value.ip)))
        )
          throw new AuthError("invalid_players_snapshot", 400);
        const perServerSeconds = value.perServerSeconds ?? {};
        if (
          !perServerSeconds ||
          typeof perServerSeconds !== "object" ||
          Array.isArray(perServerSeconds) ||
          Object.entries(perServerSeconds).some(
            ([id, seconds]) =>
              !["eclipse", "void", "luna", "terra", "sol", "hub"].includes(
                id,
              ) || !time(seconds),
          )
        )
          throw new AuthError("invalid_players_snapshot", 400);
        seen.add(uuid);
        return {
          uuid,
          name: value.name,
          nickname,
          proxy,
          server: value.server,
          sessionId: value.sessionId,
          sessionStartedAt: value.sessionStartedAt,
          lastSeen: value.lastSeen,
          reportedAt: input.observedAt,
          playtimeSeconds: value.playtimeSeconds,
          perServerSeconds,
          ...(value.firstJoinedAt !== undefined
            ? { firstJoinedAt: value.firstJoinedAt }
            : {}),
          ...(value.ip ? { ip: value.ip, ipObservedAt: input.observedAt } : {}),
        };
      });
      const stageKey = `${proxy}:${input.snapshotId}`;
      const stage = store.get("players-staging", stageKey) ?? {
        observedAt: input.observedAt,
        parts: [],
      };
      if (
        stage.observedAt !== input.observedAt ||
        input.part > stage.parts.length
      )
        throw new AuthError("players_snapshot_part_missing", 409);
      if (input.part < stage.parts.length) {
        if (JSON.stringify(stage.parts[input.part]) !== JSON.stringify(players))
          throw new AuthError("players_snapshot_part_conflict", 409);
        return { ok: true, duplicate: true };
      }
      const priorPlayers = stage.parts.flat();
      if (
        priorPlayers.length + players.length > 1000 ||
        players.some((value) =>
          priorPlayers.some((prior) => prior.uuid === value.uuid),
        )
      )
        throw new AuthError("invalid_players_snapshot", 400);
      stage.parts.push(players);
      if (!input.complete) {
        store.set("players-staging", stageKey, stage, now() + 30000);
        return { ok: true, staged: true, part: input.part, serverTime: now() };
      }
      const complete = stage.parts.flat();
      store.transaction(() => {
        for (const value of complete) {
          const prior = store.get("player-activity", value.uuid);
          if (prior && prior.lastSeen > value.lastSeen) continue;
          const record = { ...prior, ...value };
          if (
            record.ip &&
            input.observedAt - record.ipObservedAt >= 30 * 86400000
          ) {
            delete record.ip;
            delete record.ipObservedAt;
          }
          store.set("player-activity", value.uuid, record, now() + retention);
        }
        store.set(
          "players-proxy",
          proxy,
          {
            snapshotId: input.snapshotId,
            observedAt: input.observedAt,
            uuids: complete.map((value) => value.uuid),
          },
          now() + retention,
        );
        store.delete("players-staging", stageKey);
      });
      return { ok: true, accepted: complete.length, serverTime: now() };
    },
    list(actor, input = {}) {
      authorize(actor, "players.view");
      if (
        typeof (input.query ?? "") !== "string" ||
        Array.from(input.query ?? "").length > 100 ||
        !Number.isSafeInteger(Number(input.offset ?? 0)) ||
        Number(input.offset ?? 0) < 0 ||
        Number(input.offset ?? 0) > 100000
      )
        throw new AuthError("invalid_request", 400);
      const query = (input.query ?? "").toLowerCase(),
        offset = Number(input.offset ?? 0);
      const values = store
        .entries("player-activity")
        .map(([, value]) => view(value, actor))
        .filter(
          (value) =>
            (!query ||
              value.name.toLowerCase().includes(query) ||
              value.nickname.toLowerCase().includes(query) ||
              value.uuid.includes(query)) &&
            (input.online !== "true" || value.online) &&
            (!input.server ||
              input.server === "all" ||
              value.server === input.server),
        )
        .sort(
          (a, b) =>
            Number(b.online) - Number(a.online) ||
            b.lastSeen - a.lastSeen ||
            a.name.localeCompare(b.name),
        );
      return {
        items: values.slice(offset, offset + 50),
        total: values.length,
        pageSize: 50,
        reporters: ["na", "eu"].map((proxy) => ({
          proxy,
          observedAt: store.get("players-proxy", proxy)?.observedAt ?? null,
        })),
        serverTime: now(),
      };
    },
    get(actor, uuid) {
      authorize(actor, "players.view");
      const value = store.get("player-activity", bridgeUuid(uuid));
      if (!value) throw new AuthError("player_not_found", 404);
      return view(value, actor);
    },
    ipFor(uuid) {
      const value = store.get("player-activity", bridgeUuid(uuid));
      return value?.ip && value.ipObservedAt > now() - 30 * 86400000
        ? value.ip
        : undefined;
    },
    alts(actor, target) {
      authorize(actor, "moderation.alts");
      if (target.ip !== undefined) authorize(actor, "moderation.ip");
      const ip = canonicalModerationIP(target.ip ?? this.ipFor(target.uuid));
      if (!ip) throw new AuthError("player_ip_unavailable", 409);
      return {
        matches: store
          .entries("player-activity")
          .map(([, value]) => value)
          .filter(
            (value) =>
              canonicalModerationIP(value.ip) === ip &&
              value.ipObservedAt > now() - 30 * 86400000,
          )
          .map((value) => ({
            uuid: value.uuid,
            name: value.name,
            lastSeen: value.lastSeen,
            reportedAt: value.reportedAt,
          })),
        warning:
          "A shared IP is a possible association, not proof of alternate ownership or wrongdoing. No punishment is applied.",
      };
    },
  };
}
