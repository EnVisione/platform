import express from "express";
import { rateLimit } from "express-rate-limit";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { bridgeFailure } from "./minecraft-bridge.js";

export function minecraftBridgeRouter(
  config,
  links,
  ranks,
  authenticate,
  options,
) {
  const router = express.Router();
  const staffHost = new URL(config.staffOrigin).host;
  const memberHost = new URL(config.storefront.origin).host;
  const isStaff = (req) => req.headers.host === staffHost;
  const hostAllowed = (req) =>
    [staffHost, memberHost].includes(req.headers.host);
  const origin = (req) =>
    isStaff(req) ? config.staffOrigin : config.storefront.origin;
  const save = (req) =>
    new Promise((resolve, reject) =>
      req.session.save((e) => (e ? reject(e) : resolve())),
    );
  async function identity(req) {
    if (isStaff(req)) {
      const user = await options.signedIn(req, {
        allowUnlinked: true,
        syncHuly: false,
        forceDiscord: true,
      });
      return { id: user.id, name: user.name };
    }
    const value = req.session.storeIdentity;
    if (!value) throw bridgeFailure("discord_login_required", 401);
    return { id: value.id, name: value.name };
  }
  function mutation(req) {
    const actual = req.headers["x-csrf-token"],
      expected = isStaff(req) ? req.session.csrf : req.session.storeCsrf;
    if (
      req.headers.origin !== origin(req) ||
      typeof actual !== "string" ||
      typeof expected !== "string" ||
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw bridgeFailure("invalid_request", 403);
  }
  function preview(req, approval = false) {
    const value = links.preview(req.body?.challenge);
    if (
      (value.kind === "staff" && !isStaff(req)) ||
      (value.kind === "member" && approval && isStaff(req))
    )
      throw bridgeFailure("link_origin_mismatch", 403);
    return value;
  }
  const attempts = rateLimit({
    windowMs: 60000,
    limit: 40,
    legacyHeaders: false,
    standardHeaders: "draft-8",
    handler: (_req, res) =>
      res.status(429).json({ ok: false, error: "link_rate_limited" }),
  });
  router.post(
    "/api/minecraft/proxy",
    rateLimit({
      windowMs: 60000,
      limit: 600,
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({ ok: false, error: "proxy_rate_limited" }),
    }),
    express.raw({ type: "application/json", limit: "32kb" }),
    async (req, res) => {
      if (!isStaff(req)) throw bridgeFailure("not_found", 404);
      const proxy = authenticate(req.headers, req.body);
      let input;
      try {
        input = JSON.parse(req.body.toString("utf8"));
      } catch {
        throw bridgeFailure("invalid_proxy_request");
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw bridgeFailure("invalid_proxy_request");
      const operation = input.operation;
      if (
        [
          "snapshot",
          "poll",
          "ack",
          "purchase-poll",
          "purchase-ack",
          "moderation-poll",
          "moderation-ack",
        ].includes(operation) &&
        proxy !== "na"
      )
        throw bridgeFailure("proxy_writer_required", 403);
      const moderation = () => {
        if (!options.moderation)
          throw bridgeFailure("moderation_unavailable", 503);
        return options.moderation;
      };
      const actions = {
        begin: () => links.begin(input),
        status: () => {
          const status = links.status(input);
          if (input.kind !== "member" || !options.plus) return status;
          const { plus, serverTime, recheckAfter } =
            options.plus.snapshot(input);
          return { ...status, plus, serverTime, recheckAfter };
        },
        plus: () => {
          if (!options.plus) throw bridgeFailure("plus_unavailable", 503);
          const status = options.plus.snapshot(input);
          return {
            ...status,
            ...(options.donators
              ? { donators: options.donators.snapshot(input, status.plus) }
              : {}),
          };
        },
        "supporter-leaderboard": () => {
          if (!options.supporterCoins)
            throw bridgeFailure("supporter_coins_unavailable", 503);
          return options.supporterCoins.leaderboard();
        },
        "supporter-coins": () => {
          if (!options.supporterCoins)
            throw bridgeFailure("supporter_coins_unavailable", 503);
          return options.supporterCoins.snapshot(input);
        },
        "plus-grant": () => {
          if (!options.plus) throw bridgeFailure("plus_unavailable", 503);
          return options.plus.grant(input, proxy);
        },
        "plus-revoke": () => {
          if (!options.plus) throw bridgeFailure("plus_unavailable", 503);
          return options.plus.revoke(input, proxy);
        },
        "plus-claim": () => {
          if (!options.plus) throw bridgeFailure("plus_unavailable", 503);
          return options.plus.claim(input, proxy);
        },
        "purchase-poll": () => {
          if (!options.purchases)
            throw bridgeFailure("purchase_delivery_disabled", 503);
          return options.purchases.poll({
            bundles:
              Array.isArray(input.features) &&
              input.features.includes("bundles-v1"),
          });
        },
        "purchase-ack": () => {
          if (!options.purchases)
            throw bridgeFailure("purchase_delivery_disabled", 503);
          return options.purchases.ack(input);
        },
        confirm: () => links.confirm(input),
        snapshot: () => ranks.snapshot(input),
        poll: () => ranks.poll(),
        ack: () => ranks.ack(input),
        "staffnote-create": async () => ({
          note: await options.staffNotes.create(
            await moderation().actor(input.actorUuid),
            input,
          ),
        }),
        "staffnote-list": async () =>
          options.staffNotes.list(
            await moderation().actor(input.actorUuid),
            input,
          ),
        "staffnote-clear": async () =>
          options.staffNotes.clear(
            await moderation().actor(input.actorUuid),
            input,
          ),
        "staffnote-poll": () => options.staffNotes.poll(input, proxy),
        "staffnote-ack": () => options.staffNotes.acknowledge(input, proxy),
        "staffnote-delivered": () => options.staffNotes.delivered(input, proxy),
        "moderation-create": async () => {
          const service = moderation();
          return {
            case: await service.create(await service.actor(input.actorUuid), {
              ...input,
              platform: "minecraft",
            }),
          };
        },
        "moderation-revoke": async () => {
          const service = moderation();
          const actor = await service.actor(input.actorUuid);
          const current = service.get(input.caseId, actor);
          if (current.platform !== "minecraft")
            throw bridgeFailure("moderation_platform_mismatch", 403);
          return {
            case: await service.revoke(actor, input.caseId, {
              reason: input.reason,
              revision: current.revision,
            }),
          };
        },
        "moderation-alts": async () => {
          const service = moderation();
          const actor = await service.actor(input.actorUuid);
          service.authorize(actor, "moderation.alts");
          if (!options.players) throw bridgeFailure("players_unavailable", 503);
          return options.players.alts(
            actor,
            await service.resolveMinecraftTarget(actor, input.target ?? {}),
          );
        },
        "moderation-poll": () => moderation().poll(),
        "moderation-ack": () => moderation().ack(input),
        "moderation-snapshot": () => moderation().snapshot(input),
        "moderation-capabilities": () => ({
          capabilities: moderation().capabilities(),
        }),
        "players-snapshot": () => {
          if (!options.players) throw bridgeFailure("players_unavailable", 503);
          return options.players.observe(proxy, input);
        },
      };
      if (!Object.hasOwn(actions, operation))
        throw bridgeFailure("invalid_proxy_operation");
      res.json({ ok: true, ...(await actions[operation]()) });
    },
  );
  router.get("/minecraft/link", (req, res, next) => {
    if (!hostAllowed(req)) return next();
    res.sendFile(`${options.dist}/${isStaff(req) ? "index" : "public"}.html`);
  });
  router.use(
    "/api/minecraft/link",
    (req, _res, next) => {
      if (!hostAllowed(req)) return next("router");
      next();
    },
    attempts,
  );
  router.get("/api/minecraft/link/session", async (req, res) => {
    let actor = null;
    try {
      actor = await identity(req);
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    if (!isStaff(req))
      req.session.storeCsrf ??= randomBytes(32).toString("base64url");
    await save(req);
    res.json({
      ok: true,
      identity: actor,
      csrf: isStaff(req) ? req.session.csrf : req.session.storeCsrf,
      kind: isStaff(req) ? "staff" : "member",
    });
  });
  router.post(
    "/api/minecraft/link/preview",
    express.json({ limit: "1kb" }),
    (req, res) => {
      const value = preview(req);
      res.json({
        ok: true,
        ...value,
        ...(value.kind === "member" && isStaff(req)
          ? {
              continueUrl: `${config.storefront.origin}/minecraft/link#challenge=${req.body.challenge}`,
            }
          : {}),
      });
    },
  );
  router.post(
    "/api/minecraft/link/approve",
    express.json({ limit: "1kb" }),
    async (req, res) => {
      mutation(req);
      preview(req, true);
      const actor = await identity(req);
      res.json(
        await links.approve(
          req.body.challenge,
          actor,
          isStaff(req),
          req.body.verifyStaff === true,
        ),
      );
    },
  );
  router.use((error, _req, res, _next) => {
    const tooLarge = error.type === "entity.too.large";
    res.status(tooLarge ? 413 : (error.status ?? 503)).json({
      ok: false,
      error: tooLarge
        ? "request_too_large"
        : (error.code ?? "minecraft_bridge_unavailable"),
    });
  });
  return router;
}
