import express from "express";
import { rateLimit } from "express-rate-limit";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AuthError } from "./discord.js";

export function applicationRouter(config, applications, dist) {
  const router = express.Router();
  const save = (req) =>
    new Promise((resolve, reject) =>
      req.session.save((error) => (error ? reject(error) : resolve())),
    );
  const mutation = (req) => {
    const actual = req.headers["x-csrf-token"];
    const expected = req.session.csrf;
    if (
      req.headers.origin !== config.applications.publicOrigin ||
      typeof actual !== "string" ||
      typeof expected !== "string" ||
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw new AuthError("invalid_request");
  };
  router.use(
    "/apply/api",
    rateLimit({ windowMs: 60000, limit: 60, legacyHeaders: false }),
    express.json({ limit: "1mb" }),
  );
  router.get("/", (_req, res) => res.redirect("/apply"));
  router.get(["/apply", "/apply/", "/apply/start"], (_req, res) =>
    res.sendFile(`${dist}/index.html`),
  );
  router.get("/apply/api/draft", async (req, res) => {
    req.session.csrf ??= randomBytes(32).toString("base64url");
    await save(req);
    res.json({ ...applications.view(req.sessionID), csrf: req.session.csrf });
  });
  router.get("/apply/api/history", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(
      applications.history(req.sessionID, Number(req.query.offset ?? 0)),
    );
  });
  router.patch("/apply/api/draft", (req, res) => {
    mutation(req);
    res.json(applications.patch(req.sessionID, req.body));
  });
  router.put("/apply/api/notifications", async (req, res) => {
    mutation(req);
    res.json(await applications.updateNotifications(req.sessionID, req.body));
  });
  router.post("/apply/api/new", (req, res) => {
    mutation(req);
    res.json(applications.restart(req.sessionID));
  });
  router.post("/apply/api/discord/disconnect", (req, res) => {
    mutation(req);
    res.json(applications.disconnect(req.sessionID));
  });
  router.post("/apply/api/discord/start", (req, res) => {
    mutation(req);
    const challenge = applications.challenge(req.sessionID);
    res.json({
      url: `${config.staffOrigin}/auth/discord?purpose=application&challenge=${challenge}`,
    });
  });
  router.get("/apply/auth/complete", (req, res) => {
    applications.complete(req.sessionID, req.query.code);
    res.redirect("/apply/start");
  });
  router.get("/apply/api/minecraft/:name", async (req, res) =>
    res.json(await applications.minecraftProfile(req.params.name)),
  );
  router.get("/apply/api/head/:name", async (req, res) => {
    if (
      !/^[A-Za-z0-9_]{3,16}$/.test(req.params.name) &&
      !/^[a-f0-9]{32}$/i.test(req.params.name)
    )
      return res.status(400).end();
    const response = await fetch(
      `https://mc-heads.net/avatar/${encodeURIComponent(req.params.name)}/64`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (
      !response.ok ||
      !/^image\/(png|jpeg)$/.test(response.headers.get("content-type") ?? "")
    )
      return res.status(404).end();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256000) return res.status(502).end();
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    res
      .set("Cache-Control", "private, max-age=3600")
      .type(response.headers.get("content-type"))
      .send(Buffer.concat(chunks));
  });
  router.post(
    "/apply/api/submit",
    rateLimit({ windowMs: 3600000, limit: 5, legacyHeaders: false }),
    async (req, res) => {
      mutation(req);
      const result = await applications.submit(req.sessionID);
      res.status(result.errors ? 422 : 200).json(result);
    },
  );
  router.use(
    "/__staff/assets",
    express.static(`${dist}/assets`, { immutable: true, maxAge: "1y" }),
  );
  router.use((_req, res) => res.status(404).send("Page not found."));
  router.use((error, req, res, _next) => {
    const code =
      error instanceof AuthError ? error.code : "service_unavailable";
    const status =
      error instanceof AuthError
        ? error.status
        : error.type === "entity.too.large"
          ? 413
          : 503;
    if (req.path.startsWith("/apply/api/"))
      return res.status(status).json({ error: code });
    res.redirect(`/apply/start?error=${encodeURIComponent(code)}`);
  });
  return router;
}
