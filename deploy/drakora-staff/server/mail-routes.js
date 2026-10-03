import express from "express";
import { rateLimit } from "express-rate-limit";
import { AuthError } from "./discord.js";

export function mailRouter({ service, authorize, requireMutation, staffHost }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.headers.host !== staffHost) return res.sendStatus(404);
    if (!service) throw new AuthError("mail_unavailable", 503);
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 90,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  router.use(async (req, _res, next) => {
    req.mailUser = await authorize(req);
    next();
  });
  router.get("/", (_req, res) => res.json({ identities: service.identities }));
  router.get("/folders", async (_req, res) =>
    res.json({ folders: await service.folders() }),
  );
  router.get("/messages", async (req, res) => {
    if (
      (req.query.unread !== undefined &&
        !["true", "false"].includes(req.query.unread)) ||
      (req.query.offset !== undefined && !/^\d{1,7}$/.test(req.query.offset))
    )
      throw new AuthError("invalid_mail_request", 400);
    res.json(
      await service.list({
        folder: req.query.folder,
        search: req.query.search ?? "",
        identity: req.query.identity ?? "",
        unread: req.query.unread === "true",
        offset: Number(req.query.offset ?? 0),
      }),
    );
  });
  router.get("/messages/:uid", async (req, res) =>
    res.json(
      await service.detail({
        uid: req.params.uid,
        folder: req.query.folder,
        validity: req.query.validity,
      }),
    ),
  );
  router.get("/messages/:uid/attachments/:part", async (req, res) => {
    await authorize(req, "mail.attachments");
    const attachment = await service.attachment({
      uid: req.params.uid,
      folder: req.query.folder,
      validity: req.query.validity,
      part: req.params.part,
    });
    res.attachment(attachment.filename).type("application/octet-stream");
    res.set("Content-Security-Policy", "sandbox; default-src 'none'");
    res.send(attachment.content);
  });
  router.use((req, _res, next) => {
    requireMutation(req);
    next();
  });
  router.post("/messages/:uid/open", async (req, res) =>
    res.json(
      await service.detail(
        {
          uid: req.params.uid,
          folder: req.query.folder,
          validity: req.query.validity,
        },
        Boolean(req.mailUser.capabilities?.["mail.flags"]),
      ),
    ),
  );
  router.post("/trash", express.json({ limit: "8kb" }), async (req, res) => {
    await authorize(req, "mail.delete");
    res.json(await service.trash(req.body));
  });
  router.post("/flags", express.json({ limit: "8kb" }), async (req, res) => {
    await authorize(req, "mail.flags");
    res.json(await service.flags(req.body));
  });
  router.post(
    "/send",
    rateLimit({
      windowMs: 3600000,
      limit: 30,
      keyGenerator: (req) => req.mailUser.id,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    express.json({ limit: "15mb" }),
    async (req, res) => {
      await authorize(req, "mail.send");
      res.json(await service.send(req.mailUser.id, req.body));
    },
  );
  router.use((error, _req, res, next) => {
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "mail_too_large" });
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "invalid_mail_request" });
    next(error);
  });
  return router;
}
