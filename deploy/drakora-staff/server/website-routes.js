import express from "express";
import { rateLimit } from "express-rate-limit";
import { ruleSections } from "../shared/website.js";

export function publicWebsiteRouter(service, status, dist) {
  const router = express.Router();
  router.get("/site/api/content", (_req, res) =>
    res
      .set("Cache-Control", "public, max-age=15")
      .json(service.publicContent()),
  );
  router.get(
    "/site/api/status",
    rateLimit({ windowMs: 60000, limit: 60, legacyHeaders: false }),
    async (_req, res) =>
      res.set("Cache-Control", "public, max-age=15").json(await status()),
  );
  router.use(
    "/__staff/assets",
    express.static(`${dist}/assets`, { immutable: true, maxAge: "1y" }),
  );
  router.get("/discord", (_req, res) =>
    res.redirect(service.publicContent().discordInvite),
  );
  router.get(["/", "/servers", "/rules", "/help"], (_req, res) =>
    res.sendFile(`${dist}/public.html`),
  );
  router.get("/apply", (req, res) => {
    if (typeof req.query.error === "string")
      return res.redirect(
        `/apply/start?error=${encodeURIComponent(req.query.error)}`,
      );
    res.sendFile(`${dist}/public.html`);
  });
  router.get("/rules/:section", (req, res) =>
    res
      .status(
        ruleSections.some((section) => section.id === req.params.section)
          ? 200
          : 404,
      )
      .sendFile(`${dist}/public.html`),
  );
  router.get("/servers/:slug", (req, res) =>
    res
      .status(
        service
          .publicContent()
          .servers.some((server) => server.slug === req.params.slug)
          ? 200
          : 404,
      )
      .sendFile(`${dist}/public.html`),
  );
  router.use((error, req, res, next) => {
    if (req.path.startsWith("/site/api/"))
      res.status(503).json({ error: "website_unavailable" });
    else next(error);
  });
  return router;
}

export function websiteEditorRouter(service, authorize, requireMutation, dist) {
  const router = express.Router();
  router.get("/api/website", async (req, res) =>
    res.json(service.read(await authorize(req))),
  );
  router.put(
    "/api/website",
    rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
    express.json({ limit: "256kb" }),
    async (req, res) => {
      requireMutation(req);
      res.json(service.save(await authorize(req), req.body));
    },
  );
  router.get("/website", async (req, res, next) => {
    try {
      service.read(await authorize(req));
      res.sendFile(`${dist}/index.html`);
    } catch (error) {
      if (error.status === 401) res.redirect("/login?next=%2Fwebsite");
      else if (error.code === "minecraft_name_required")
        res.redirect("/minecraft?next=%2Fwebsite");
      else next(error);
    }
  });
  router.use((error, _req, res, next) => {
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "website_content_too_large" });
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "invalid_website_content" });
    next(error);
  });
  return router;
}
