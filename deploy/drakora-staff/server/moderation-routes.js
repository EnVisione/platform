import express from "express";
import { AuthError } from "./discord.js";

export function moderationRouter({
  history,
  authorize,
  applications,
  tickets,
  staffHost,
  dist,
}) {
  const router = express.Router();
  const requireStaff = async (req) => {
    if (req.headers.host !== staffHost)
      throw new AuthError("moderation_access_denied");
    const user = await authorize(req);
    if (!user.permissions.dashboard || !user.capabilities["moderation.view"])
      throw new AuthError("moderation_access_denied");
    return user;
  };
  const options = (req) => ({
    offset: Number(req.query.offset ?? 0),
    action: req.query.action ?? "all",
    query: req.query.query ?? "",
    from: req.query.from,
    to: req.query.to,
  });
  router.get("/api/moderation", async (req, res) => {
    await requireStaff(req);
    res.json(history.list(options(req)));
  });
  router.get("/api/moderation/:id", async (req, res) => {
    await requireStaff(req);
    res.json(history.get(req.params.id));
  });
  router.get("/api/applications/:id/moderation", async (req, res) => {
    const user = await requireStaff(req);
    if (!applications || !user.capabilities["applications.view"])
      throw new AuthError("application_review_role_required");
    const record = applications.get(req.params.id);
    if (!record) throw new AuthError("application_not_found", 404);
    res.json(
      history.list({ ...options(req), userId: record.discord?.id ?? null }),
    );
  });
  router.get("/api/tickets/:id/moderation", async (req, res) => {
    const user = await requireStaff(req);
    if (!tickets) throw new AuthError("ticket_not_found", 404);
    const ticket = tickets.get(req.params.id);
    tickets.authorize(user, ticket, true);
    res.json(
      history.list({
        ...options(req),
        userId: ticket.owner.guest ? null : ticket.owner.id,
      }),
    );
  });
  router.get(["/moderation", "/moderation/:id"], async (req, res, next) => {
    try {
      await requireStaff(req);
      res.sendFile(`${dist}/index.html`);
    } catch (error) {
      if (error.status === 401)
        return res.redirect(`/login?next=${encodeURIComponent(req.path)}`);
      if (error.code === "minecraft_name_required")
        return res.redirect(`/minecraft?next=${encodeURIComponent(req.path)}`);
      next(error);
    }
  });
  return router;
}
