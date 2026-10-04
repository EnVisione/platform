import express from "express";
import { rateLimit } from "express-rate-limit";
import {
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { AuthError } from "./discord.js";
import { ticketTranscript } from "./ticket-transcript.js";
import {
  ticketPath,
  ticketTypes,
  ticketUploadLimit,
} from "../shared/tickets.js";

const save = (req) =>
  new Promise((resolve, reject) =>
    req.session.save((error) => (error ? reject(error) : resolve())),
  );
const allowedTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/zip",
  "text/plain",
]);
const names = /\.(png|jpe?g|webp|gif|pdf|zip|txt|log)$/i;
function uploadType(bytes, name, type) {
  if (!names.test(name) || !allowedTypes.has(type))
    throw new AuthError("unsupported_attachment", 400);
  const match =
    type === "image/png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : type === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : type === "image/gif"
          ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
          : type === "image/webp"
            ? bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP"
            : type === "application/pdf"
              ? bytes.subarray(0, 5).toString() === "%PDF-"
              : type === "application/zip"
                ? bytes.subarray(0, 2).toString() === "PK"
                : !bytes.includes(0);
  if (!match) throw new AuthError("unsupported_attachment", 400);
}

export function ticketRouter(
  config,
  service,
  transport,
  { staffView = false, authorize, mutation, dist, database, macros },
) {
  const router = express.Router();
  const prefix = staffView ? "/api/tickets" : "/help/api/tickets";
  const identities = (session) => [
    ...(session.ticketUntil > Date.now() && session.ticketIdentity
      ? [session.ticketIdentity]
      : []),
    ...(session.ticketGuestUntil > Date.now() && session.ticketGuestIdentity
      ? [session.ticketGuestIdentity]
      : []),
  ];
  const identity = async (req) => {
    if (staffView) return authorize(req);
    const users = identities(req.session);
    const user = req.params.id
      ? users.find((user) => service.get(req.params.id).owner.id === user.id)
      : users[0];
    if (!users.length) throw new AuthError("ticket_identity_required", 401);
    if (!user) throw new AuthError("ticket_not_found", 404);
    return user;
  };
  const checkMutation = staffView
    ? mutation
    : (req) => {
        const actual = req.headers["x-csrf-token"],
          expected = req.session.csrf;
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
    prefix,
    rateLimit({ windowMs: 60000, limit: 180, legacyHeaders: false }),
  );
  if (staffView && macros) {
    router.use(
      "/api/ticket-macros",
      rateLimit({ windowMs: 60000, limit: 120, legacyHeaders: false }),
    );
    router.get("/api/ticket-macros", async (req, res) => {
      res.json(macros.list(await identity(req), req.query.category));
    });
    router.post(
      "/api/ticket-macros",
      express.json({ limit: "16kb" }),
      async (req, res) => {
        checkMutation(req);
        res.status(201).json(macros.save(await identity(req), null, req.body));
      },
    );
    router.put(
      "/api/ticket-macros/:macroId",
      express.json({ limit: "16kb" }),
      async (req, res) => {
        checkMutation(req);
        res.json(
          macros.save(await identity(req), req.params.macroId, req.body),
        );
      },
    );
    router.delete(
      "/api/ticket-macros/:macroId",
      express.json({ limit: "16kb" }),
      async (req, res) => {
        checkMutation(req);
        macros.remove(
          await identity(req),
          req.params.macroId,
          req.body?.revision,
        );
        res.json({ ok: true });
      },
    );
  }
  if (!staffView) {
    router.get("/help/api/session", async (req, res) => {
      req.session.csrf ??= randomBytes(32).toString("base64url");
      await save(req);
      res.json({
        csrf: req.session.csrf,
        identity: identities(req.session)[0] || null,
        types: ticketTypes.filter((type) => type.id !== "partnership"),
        minecraftEnabled: false,
      });
    });
    router.post(
      "/help/api/connect",
      rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
      express.json({ limit: "2kb" }),
      async (req, res) => {
        checkMutation(req);
        const path =
          typeof req.body.returnPath === "string" &&
          (req.body.returnPath === "/partners" ||
            /^\/help\/[A-Za-z0-9_]{3,16}\/[a-f0-9-]{36}$/.test(
              req.body.returnPath,
            ))
            ? req.body.returnPath
            : "/help/new";
        const challenge = service.challenge(req.sessionID, path);
        res.json({
          url: `${config.staffOrigin}/auth/discord?purpose=ticket&challenge=${challenge}`,
        });
      },
    );
    router.get("/help/auth/consume", async (req, res) => {
      const handoff = service.consume(req.query.handoff, req.sessionID);
      const guest = req.session.ticketGuestIdentity;
      const guestUntil = req.session.ticketGuestUntil;
      await new Promise((resolve, reject) =>
        req.session.regenerate((error) => (error ? reject(error) : resolve())),
      );
      req.session.ticketIdentity = handoff.identity;
      req.session.ticketGuestIdentity = guest;
      req.session.ticketGuestUntil = guestUntil;
      req.session.ticketUntil = Date.now() + 7 * 86400000;
      req.session.csrf = randomBytes(32).toString("base64url");
      await save(req);
      res.redirect(handoff.returnPath);
    });
    router.post(
      "/help/api/email-access",
      rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
      express.json({ limit: "2kb" }),
      async (req, res) => {
        checkMutation(req);
        const access = service.consumeEmailAccess(req.body.key);
        const discordIdentity = req.session.ticketIdentity;
        const discordUntil = req.session.ticketUntil;
        await new Promise((resolve, reject) =>
          req.session.regenerate((error) =>
            error ? reject(error) : resolve(),
          ),
        );
        req.session.ticketIdentity = discordIdentity;
        req.session.ticketUntil = discordUntil;
        req.session.ticketGuestIdentity = access.identity;
        req.session.ticketGuestUntil = Date.now() + 7 * 86400000;
        req.session.csrf = randomBytes(32).toString("base64url");
        await save(req);
        res.json({ path: access.returnPath });
      },
    );
    router.post(
      "/help/api/disconnect",
      express.json({ limit: "2kb" }),
      async (req, res) => {
        checkMutation(req);
        delete req.session.ticketIdentity;
        delete req.session.ticketUntil;
        await save(req);
        res.json({ ok: true });
      },
    );
    router.get(
      [
        "/help/new",
        /^\/help\/[A-Za-z0-9_]{3,16}\/[a-f0-9-]{36}$/,
        /^\/help\/access\/[A-Za-z0-9_-]{43}$/,
      ],
      (req, res) => res.sendFile(`${dist}/public.html`),
    );
    router.post(
      prefix,
      rateLimit({ windowMs: 60000, limit: 5, legacyHeaders: false }),
      express.json({ limit: "8kb" }),
      async (req, res) => {
        checkMutation(req);
        let user = identities(req.session)[0];
        if (!user) {
          if (!/^[A-Za-z0-9_]{3,16}$/.test(req.body.ign || ""))
            throw new AuthError("invalid_ticket", 400);
          user = {
            id: `guest:${randomUUID()}`,
            name: req.body.ign,
            guest: true,
          };
          req.session.ticketGuestIdentity = user;
          req.session.ticketGuestUntil = Date.now() + 7 * 86400000;
          await save(req);
        }
        if (!user.guest) await transport.assertMember(user.id);
        const network = user.guest
          ? createHmac("sha256", config.sessionSecret)
              .update(`ticket-network:${req.ip}`)
              .digest("hex")
          : undefined;
        const ticket = service.create(user, req.body, "web", network);
        res.status(201).json({ path: ticketPath(ticket) });
      },
    );
    router.post(
      "/partners/api/requests",
      rateLimit({ windowMs: 60000, limit: 5, legacyHeaders: false }),
      express.json({ limit: "12kb" }),
      async (req, res) => {
        checkMutation(req);
        let user =
          identities(req.session).find((entry) => !entry.guest) ||
          req.session.partnerIdentity;
        if (!user) {
          user = {
            id: `guest:${randomUUID()}`,
            name: String(req.body.name || "").slice(0, 80),
            guest: true,
          };
          req.session.partnerIdentity = user;
          await save(req);
        }
        if (req.body.preference === "discord" && !user.guest)
          await transport.assertMember(user.id);
        const network = createHmac("sha256", config.sessionSecret)
          .update(`partnership-network:${req.ip}`)
          .digest("hex");
        const ticket = service.createPartnership(user, req.body, network);
        res.status(201).json({
          reference: ticket.id,
          preference: ticket.partnership.preference,
        });
      },
    );
    router.get(prefix, async (req, res) => {
      await identity(req);
      const owners = new Set(identities(req.session).map((user) => user.id));
      res.json({
        items: service
          .all()
          .filter(
            (ticket) =>
              ticket.type !== "partnership" && owners.has(ticket.owner.id),
          )
          .map((ticket) => ({
            id: ticket.id,
            ign: ticket.ign,
            status: ticket.status,
            path: ticketPath(ticket),
            createdAt: ticket.createdAt,
          })),
      });
    });
  } else {
    router.get(prefix, async (req, res) => {
      const user = await identity(req),
        offset = Number(req.query.offset ?? 0);
      const closed = req.query.closed === "1";
      if (closed && !user.capabilities["logs.view"])
        throw new AuthError("ticket_access_denied");
      res.json(
        service.list(user, {
          closed,
          offset,
          category: req.query.category,
          query: req.query.query,
          status: req.query.status,
          type: req.query.type,
          assignment: req.query.assignment,
          staff: req.query.staff,
          sort: req.query.sort,
          from: req.query.from,
          to: req.query.to,
        }),
      );
    });
    router.get(
      ["/tickets", "/tickets/:id", "/logs"],
      async (req, res, next) => {
        try {
          const user = await identity(req);
          service.staff(user);
          if (req.path === "/logs" && !user.capabilities["logs.view"])
            throw new AuthError("ticket_access_denied");
          res.sendFile(`${dist}/index.html`);
        } catch (error) {
          if (error.status === 401)
            res.redirect(`/login?next=${encodeURIComponent(req.path)}`);
          else next(error);
        }
      },
    );
  }
  const streams = new Map();
  const stream = async (req, res) => {
    const user = await identity(req),
      id = req.params.id;
    if (id) service.authorize(user, service.get(id), staffView);
    else if (staffView) service.staff(user);
    if ((streams.get(user.id) || 0) >= 5)
      throw new AuthError("too_many_ticket_views", 429);
    streams.set(user.id, (streams.get(user.id) || 0) + 1);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const send = (event) => {
      if (res.writableLength > 65536) return res.end();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const receive = (event) => {
      try {
        service.authorize(user, service.get(event.id), staffView);
        send({ changed: true });
      } catch {}
    };
    const unwatch = id
      ? service.watch(id, user, staffView, send)
      : (() => {
          service.events.on("changed", receive);
          return () => service.events.off("changed", receive);
        })();
    const shutdown = () => res.end();
    const revoked = (id) => {
      if (staffView && id === user.id) res.end();
    };
    service.events.on("staff-access-revoked", revoked);
    service.events.once("shutdown", shutdown);
    let checking = false,
      ended = false;
    const heartbeat = setInterval(async () => {
      if (checking || ended) return;
      checking = true;
      try {
        const current = database.get("session", req.sessionID);
        if (staffView) {
          if (!current || current.until <= Date.now())
            throw new Error("Session expired");
          const fresh = await authorize(req);
          service.staff(fresh, id ? service.get(id) : null);
          Object.assign(user, fresh);
        } else if (
          !current ||
          !identities(current).some((identity) => identity.id === user.id)
        )
          throw new Error("Session expired");
        res.write(": heartbeat\n\n");
      } catch {
        res.end();
      } finally {
        checking = false;
      }
    }, 15000);
    heartbeat.unref();
    send({ changed: true });
    res.on("close", () => {
      ended = true;
      clearInterval(heartbeat);
      unwatch();
      service.events.off("shutdown", shutdown);
      service.events.off("staff-access-revoked", revoked);
      const remaining = (streams.get(user.id) || 1) - 1;
      if (remaining) streams.set(user.id, remaining);
      else streams.delete(user.id);
    });
  };
  router.get(`${prefix}/events`, stream);
  router.get(`${prefix}/:id/events`, stream);
  router.get(`${prefix}/:id`, async (req, res) => {
    if (req.query.before !== undefined && !/^\d{1,12}$/.test(req.query.before))
      throw new AuthError("invalid_request", 400);
    res.json(
      service.view(
        await identity(req),
        req.params.id,
        staffView,
        req.query.before,
      ),
    );
  });
  if (staffView) {
    router.post(
      `${prefix}/:id/decision`,
      express.json({ limit: "4kb" }),
      async (req, res) => {
        checkMutation(req);
        service.decidePartnership(await identity(req), req.params.id, req.body);
        res.json({ ok: true });
      },
    );
    router.get(`${prefix}/:id/notes`, async (req, res) => {
      if (
        req.query.before !== undefined &&
        !/^\d{1,12}$/.test(req.query.before)
      )
        throw new AuthError("invalid_request", 400);
      res.json(
        service.notes(await identity(req), req.params.id, req.query.before),
      );
    });
    router.post(
      `${prefix}/:id/notes`,
      express.json({ limit: "8kb" }),
      async (req, res) => {
        checkMutation(req);
        service.addNote(await identity(req), req.params.id, req.body);
        res.status(201).json({ ok: true });
      },
    );
  }
  router.post(
    `${prefix}/:id/messages`,
    express.json({ limit: "8kb" }),
    async (req, res) => {
      checkMutation(req);
      service.reply(await identity(req), req.params.id, req.body, staffView);
      res.status(201).json({ ok: true });
    },
  );
  if (staffView)
    router.post(
      `${prefix}/:id/claim`,
      express.json({ limit: "2kb" }),
      async (req, res) => {
        checkMutation(req);
        service.claim(await identity(req), req.params.id);
        res.json({ ok: true });
      },
    );
  if (staffView)
    router.post(
      `${prefix}/:id/takeover`,
      express.json({ limit: "2kb" }),
      async (req, res) => {
        checkMutation(req);
        await service.takeover(
          await identity(req),
          req.params.id,
          req.body?.claimedBy,
        );
        res.json({ ok: true });
      },
    );
  if (staffView) {
    router.post(
      `${prefix}/:id/takeover-request`,
      express.json({ limit: "4kb" }),
      async (req, res) => {
        checkMutation(req);
        service.requestTakeover(await identity(req), req.params.id, req.body);
        res.status(201).json({ ok: true });
      },
    );
    router.post(
      `${prefix}/:id/takeover-review`,
      express.json({ limit: "2kb" }),
      async (req, res) => {
        checkMutation(req);
        if (typeof req.body?.approve !== "boolean")
          throw new AuthError("invalid_request", 400);
        await service.reviewTakeover(
          await identity(req),
          req.params.id,
          req.body.requestId,
          req.body.approve,
        );
        res.json({ ok: true });
      },
    );
  }
  if (staffView)
    router.post(
      `${prefix}/:id/delete-channel`,
      express.json({ limit: "2kb" }),
      async (req, res) => {
        checkMutation(req);
        await service.deleteChannel(
          await identity(req),
          req.params.id,
          req.body.closureId,
        );
        res.json({ ok: true });
      },
    );
  router.post(
    `${prefix}/:id/reopen`,
    express.json({ limit: "2kb" }),
    async (req, res) => {
      checkMutation(req);
      await service.reopen(
        await identity(req),
        req.params.id,
        staffView,
        req.body.closureId,
      );
      res.json({ ok: true });
    },
  );
  router.post(
    `${prefix}/:id/close`,
    express.json({ limit: "16kb" }),
    async (req, res) => {
      checkMutation(req);
      service.closeTicket(
        await identity(req),
        req.params.id,
        req.body,
        staffView,
      );
      res.json({ ok: true });
    },
  );
  if (!staffView)
    router.post(
      `${prefix}/:id/rating`,
      express.json({ limit: "2kb" }),
      async (req, res) => {
        checkMutation(req);
        service.rate(
          await identity(req),
          req.params.id,
          req.body.rating,
          req.body.closureId,
        );
        res.json({ ok: true });
      },
    );
  router.post(
    `${prefix}/:id/attachments`,
    rateLimit({ windowMs: 60000, limit: 15, legacyHeaders: false }),
    async (req, _res, next) => {
      try {
        checkMutation(req);
        req.ticketUser = await identity(req);
        service.authorize(
          req.ticketUser,
          service.get(req.params.id),
          staffView,
          req.query.internal === "1" && req.query.notes !== "1"
            ? "tickets.close"
            : "tickets.reply",
        );
        next();
      } catch (error) {
        next(error);
      }
    },
    express.raw({ type: "application/octet-stream", limit: ticketUploadLimit }),
    async (req, res) => {
      let name;
      try {
        name = decodeURIComponent(req.headers["x-file-name"] || "");
      } catch {
        throw new AuthError("invalid_attachment", 400);
      }
      if (
        !name ||
        name.length > 120 ||
        /[\r\n\0/\\]/.test(name) ||
        !Buffer.isBuffer(req.body) ||
        !req.body.length
      )
        throw new AuthError("invalid_attachment", 400);
      const type = req.headers["x-file-type"] || "text/plain";
      uploadType(req.body, name, type);
      res
        .status(201)
        .json(
          await service.upload(
            req.ticketUser,
            req.params.id,
            req.body,
            name,
            type,
            staffView,
            staffView && req.query.internal === "1",
            staffView && req.query.notes === "1",
          ),
        );
    },
  );
  router.get(`${prefix}/:id/attachments/:fileId`, async (req, res) => {
    const file = service.media(
      await identity(req),
      req.params.id,
      req.params.fileId,
      staffView,
    );
    const bytes = await transport.bytes(file);
    // download other files. never execute player files on the portal origin.
    res
      .set({
        "Content-Type": /^image\/(png|jpeg|webp|gif)$/.test(file.type)
          ? file.type
          : "application/octet-stream",
        "Content-Disposition": `${/^image\/(png|jpeg|webp|gif)$/.test(file.type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Content-Security-Policy":
          "default-src 'none'; sandbox allow-downloads",
        "Cache-Control": "private, no-store",
      })
      .send(bytes);
  });
  router.get(
    `${prefix}/:id/transcript`,
    rateLimit({ windowMs: 60000, limit: 5, legacyHeaders: false }),
    async (req, res) => {
      const user = await identity(req),
        staffCopy = staffView && req.query.copy !== "player";
      if (staffView && !user.capabilities["logs.view"])
        throw new AuthError("ticket_access_denied");
      const html = await ticketTranscript(
        service,
        user,
        req.params.id,
        staffCopy,
        transport.bytes,
        {
          authorizeAsStaff: staffView,
        },
      );
      res
        .set({
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="drakora-${staffCopy ? "staff-" : ""}ticket-${req.params.id}.html"`,
          "Content-Security-Policy":
            "default-src 'none'; sandbox allow-downloads",
        })
        .send(html);
    },
  );
  router.use((error, req, res, next) => {
    if (!req.path.startsWith(prefix) && !req.path.startsWith("/help/"))
      return next(error);
    if (res.headersSent) return res.end();
    const status =
      error instanceof AuthError
        ? error.status
        : error.type === "entity.too.large"
          ? 413
          : error.type === "entity.parse.failed"
            ? 400
            : 503;
    res.status(status).json({
      error:
        error instanceof AuthError
          ? error.code
          : status === 413
            ? "attachment_too_large"
            : status === 400
              ? "invalid_request"
              : "ticket_service_unavailable",
    });
  });
  return router;
}
