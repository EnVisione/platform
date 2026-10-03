import {
  inboxPermission,
  visibleInboxes,
} from "../shared/staff-permissions.js";
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
  async function checkAccess(req, capability) {
    req.mailUser = await authorize(req, capability);
    req.mailScope = visibleInboxes(req.mailUser, service.identities).map(
      (address) => address.toLowerCase(),
    );
    if (!req.mailScope.length) throw new AuthError("mail_role_required");
  }
  router.use(async (req, _res, next) => {
    await checkAccess(req);
    next();
  });
  router.get("/", (req, res) =>
    res.json({
      identities: service.identities
        .filter(({ address }) => req.mailScope.includes(address.toLowerCase()))
        .map((identity) => ({
          ...identity,
          permissions: {
            send: Boolean(
              req.mailUser.capabilities[
                inboxPermission(identity.address, "send")
              ],
            ),
            reply: Boolean(
              req.mailUser.capabilities[
                inboxPermission(identity.address, "reply")
              ],
            ),
          },
        })),
    }),
  );
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
      await service.list(
        {
          folder: req.query.folder,
          search: req.query.search ?? "",
          identity: req.query.identity ?? "",
          unread: req.query.unread === "true",
          offset: Number(req.query.offset ?? 0),
        },
        req.mailScope,
      ),
    );
  });
  router.get("/messages/:uid", async (req, res) =>
    res.json(
      await service.detail(
        {
          uid: req.params.uid,
          folder: req.query.folder,
          validity: req.query.validity,
        },
        false,
        req.mailScope,
      ),
    ),
  );
  router.get("/messages/:uid/attachments/:part", async (req, res) => {
    await checkAccess(req, "mail.attachments");
    const attachment = await service.attachment(
      {
        uid: req.params.uid,
        folder: req.query.folder,
        validity: req.query.validity,
        part: req.params.part,
      },
      req.mailScope,
    );
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
        req.mailScope,
      ),
    ),
  );
  router.post("/trash", express.json({ limit: "8kb" }), async (req, res) => {
    await checkAccess(req, "mail.delete");
    res.json(await service.trash(req.body, req.mailScope));
  });
  router.post("/flags", express.json({ limit: "8kb" }), async (req, res) => {
    await checkAccess(req, "mail.flags");
    res.json(await service.flags(req.body, req.mailScope));
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
      await checkAccess(req, "mail.send");
      res.json(
        await service.send(req.mailUser.id, req.body, {
          view: req.mailScope,
          ...Object.fromEntries(
            ["send", "reply"].map((action) => [
              action,
              service.identities
                .filter(
                  ({ address }) =>
                    req.mailScope.includes(address.toLowerCase()) &&
                    req.mailUser.capabilities[inboxPermission(address, action)],
                )
                .map(({ address }) => address.toLowerCase()),
            ]),
          ),
        }),
      );
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
