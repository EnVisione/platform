import express from "express";
import { AuthError } from "./discord.js";
import { validTimeZone } from "../shared/time.js";

export function timePreferences(store) {
  const get = (id) => ({
    format: "12",
    timeZone: null,
    ...store.get("time-preferences", id),
  });
  function update(id, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new AuthError("invalid_time_preferences", 400);
    const current = get(id);
    const format = input.format === undefined ? current.format : input.format;
    const timeZone =
      input.timeZone === undefined
        ? current.timeZone
        : validTimeZone(input.timeZone);
    if (
      !["12", "24"].includes(format) ||
      (input.timeZone !== undefined && !timeZone)
    )
      throw new AuthError("invalid_time_preferences", 400);
    const value = { format, timeZone };
    store.set("time-preferences", id, value, Number.MAX_SAFE_INTEGER);
    return value;
  }
  return { get, update };
}

export function timePreferenceRouter(preferences, signedIn, requireMutation) {
  const router = express.Router();
  router.post("/", express.json({ limit: "1kb" }), async (req, res) => {
    const user = await signedIn(req, { allowUnlinked: true, syncHuly: false });
    requireMutation(req);
    res.json({ preferences: preferences.update(user.id, req.body) });
  });
  return router;
}
