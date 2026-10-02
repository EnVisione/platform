import express from "express";
import { rateLimit } from "express-rate-limit";

export function applicationFormRouter(forms, authorize, requireMutation) {
  const router = express.Router();
  router.get("/api/application-forms", async (req, res) => {
    res.json(forms.read(await authorize(req)));
  });
  router.put(
    "/api/application-forms",
    rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
    express.json({ limit: "1mb" }),
    async (req, res) => {
      requireMutation(req);
      res.json(forms.save(await authorize(req), req.body));
    },
  );
  return router;
}
