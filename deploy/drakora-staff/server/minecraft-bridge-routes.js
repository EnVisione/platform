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
      if (["snapshot", "poll", "ack"].includes(operation) && proxy !== "na")
        throw bridgeFailure("proxy_writer_required", 403);
      const actions = {
        begin: () => links.begin(input),
        status: () => links.status(input),
        confirm: () => links.confirm(input),
        snapshot: () => ranks.snapshot(input),
        poll: () => ranks.poll(),
        ack: () => ranks.ack(input),
      };
      if (!Object.hasOwn(actions, operation))
        throw bridgeFailure("invalid_proxy_operation");
      res.json(await actions[operation]());
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
      res.json(await links.approve(req.body.challenge, actor, isStaff(req)));
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
