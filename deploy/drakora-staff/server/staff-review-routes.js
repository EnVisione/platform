import express from "express";
import { rateLimit } from "express-rate-limit";
export function staffReviewRouter({
  reviews,
  authorize,
  mutation,
  staffHost,
  dist,
}) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (req.headers.host !== staffHost) return res.sendStatus(404);
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(rateLimit({ windowMs: 60000, limit: 90, legacyHeaders: false }));
  router.use(async (req, res, next) => {
    try {
      req.reviewUser = await authorize(req);
      reviews.authorize(req.reviewUser);
      next();
    } catch (error) {
      if (error.status === 401 && req.path.startsWith("/staff-reviews/"))
        return res.redirect(`/login?next=${encodeURIComponent(req.path)}`);
      next(error);
    }
  });
  router.get("/staff-reviews/:id", (req, res) => {
    reviews.get(req.params.id);
    res.sendFile(`${dist}/index.html`);
  });
  router.get("/api/staff-reviews", (req, res) =>
    res.json(
      reviews.list(req.reviewUser, {
        query: req.query.query || "",
        status: req.query.status || "",
        offset: Number(req.query.offset || 0),
      }),
    ),
  );
  router.get("/api/staff-reviews/:id", (req, res) =>
    res.json(reviews.detail(req.reviewUser, req.params.id)),
  );
  router.get("/api/staff-reviews/:id/roles", async (req, res) =>
    res.json({
      roles: await reviews.promotionOptions(req.reviewUser, req.params.id),
    }),
  );
  router.use((req, _res, next) => {
    mutation(req);
    next();
  });
  router.use(express.json({ limit: "12kb" }));
  router.post("/api/staff-reviews/start/:id", async (req, res) =>
    res.json({
      review: await reviews.startEarly(req.reviewUser, req.params.id),
    }),
  );
  router.post("/api/staff-reviews/:id/messages", async (req, res) => {
    if (
      typeof req.body?.requestId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(req.body.requestId)
    )
      return res.status(400).json({ error: "invalid_review_message" });
    const message = reviews.comment(
      req.reviewUser,
      req.params.id,
      req.body?.body,
      "panel",
      req.body?.requestId,
    );
    await reviews.sync();
    res.json({ message });
  });
  router.post("/api/staff-reviews/:id/decision", async (req, res) =>
    res.json({
      review: await reviews.decide(req.reviewUser, req.params.id, req.body),
    }),
  );
  router.use((error, _req, res, next) => {
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "invalid_review_request" });
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "invalid_review_request" });
    next(error);
  });
  return router;
}
