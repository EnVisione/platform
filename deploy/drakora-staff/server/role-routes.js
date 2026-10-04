import express from "express";
import { rateLimit } from "express-rate-limit";
import { AuthError } from "./discord.js";

export function roleRouter({
  policy,
  assignments,
  authorize,
  requireMutation,
  staffHost,
  onPolicyChange = () => {},
}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.headers.host !== staffHost) return res.sendStatus(404);
    next();
  });
  router.use(rateLimit({ windowMs: 60000, limit: 60, legacyHeaders: false }));
  router.use(async (req, _res, next) => {
    req.roleUser = await authorize(req);
    policy.authorize(req.roleUser, "roles.view");
    next();
  });
  router.get("/", async (req, res) =>
    res.json({
      ...policy.read(req.roleUser),
      discordRoles: assignments ? await assignments.metadata(req.roleUser) : [],
      assignmentEnabled: Boolean(assignments),
    }),
  );
  router.get("/members", async (req, res) => {
    if (!assignments) throw new AuthError("role_sync_unavailable", 503);
    res.json(
      await assignments.list(
        req.roleUser,
        req.query.name ?? "",
        Number(req.query.offset ?? 0),
      ),
    );
  });
  router.get("/history", (req, res) =>
    res.json(
      policy.history(req.roleUser, Number(req.query.offset ?? 0), {
        query: req.query.query,
        action: req.query.action,
        from: req.query.from,
        to: req.query.to,
      }),
    ),
  );
  router.use((req, _res, next) => {
    requireMutation(req);
    next();
  });
  router.put("/", express.json({ limit: "32kb" }), (req, res) => {
    const result = policy.save(req.roleUser, req.body);
    onPolicyChange();
    res.json(result);
  });
  router.post(
    "/members/:id",
    rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
    express.json({ limit: "8kb" }),
    async (req, res) => {
      if (!assignments) throw new AuthError("role_sync_unavailable", 503);
      res.json(await assignments.assign(req.roleUser, req.params.id, req.body));
    },
  );
  router.use((error, _req, res, next) => {
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "invalid_role_request" });
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "invalid_role_request" });
    next(error);
  });
  return router;
}
