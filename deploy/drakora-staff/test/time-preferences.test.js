import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomBytes } from "node:crypto";
import { openStore } from "../server/store.js";
import { AuthError } from "../server/discord.js";
import {
  timePreferences,
  timePreferenceRouter,
} from "../server/time-preferences.js";
import { validTimeZone, timeFormatter } from "../shared/time.js";

test("local clocks handle different zones, daylight saving and midnight in both formats", () => {
  for (const value of [
    null,
    {},
    "+03:00",
    "Imaginary/City",
    "UTC; color:red",
    "a".repeat(101),
  ])
    assert.equal(validTimeZone(value), null);
  assert.equal(validTimeZone("America/Chicago"), "America/Chicago");
  assert.ok(validTimeZone("Etc/GMT+5"));
  const hour = (value, zone, format = "24") =>
    timeFormatter(format, zone)
      .formatToParts(new Date(value))
      .find((p) => p.type === "hour").value;
  assert.equal(hour("2026-01-02T12:00:00Z", "America/Chicago"), "06");
  assert.equal(hour("2026-07-02T12:00:00Z", "America/Chicago"), "07");
  assert.equal(hour("2026-07-02T12:00:00Z", "Asia/Tokyo"), "21");
  assert.equal(hour("2026-07-02T00:00:00Z", "UTC"), "00");
  assert.equal(hour("2026-07-02T00:00:00Z", "UTC", "12"), "12");
  assert.equal(
    timeFormatter("12", "UTC")
      .formatToParts(new Date("2026-07-02T13:00:00Z"))
      .some((p) => p.type === "dayPeriod"),
    true,
  );
});

test("time preferences persist independently of expiring Discord identity and preserve format during timezone refresh", (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  const preferences = timePreferences(store);
  assert.deepEqual(preferences.get("new"), { format: "12", timeZone: null });
  preferences.update("member", { format: "24", timeZone: "America/Chicago" });
  store.set("user", "member", {}, 0);
  preferences.update("member", { timeZone: "Asia/Tokyo" });
  assert.deepEqual(timePreferences(store).get("member"), {
    format: "24",
    timeZone: "Asia/Tokyo",
  });
  for (const input of [
    null,
    [],
    { format: null },
    { format: 24 },
    { format: "25" },
    { timeZone: "bad" },
  ])
    assert.throws(() => preferences.update("member", input), {
      code: "invalid_time_preferences",
    });
  assert.deepEqual(preferences.get("member"), {
    format: "24",
    timeZone: "Asia/Tokyo",
  });
});

test("preference endpoint requires sign-in and mutation checks, and writes only the session owner's settings", async (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const preferences = timePreferences(store);
  const app = express();
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    store.close();
  });
  app.use(
    "/api/preferences/time",
    timePreferenceRouter(
      preferences,
      async (req) => {
        if (req.headers.authorization !== "fixture")
          throw new AuthError("login_required", 401);
        return { id: "owner" };
      },
      (req) => {
        if (
          req.headers.origin !== "https://staff.example.invalid" ||
          req.headers["x-csrf-token"] !== "fixture"
        )
          throw new AuthError("invalid_request");
      },
    ),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status ?? 500).json({ error: error.code }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/preferences/time`;
  const headers = {
    authorization: "fixture",
    origin: "https://staff.example.invalid",
    "x-csrf-token": "fixture",
    "content-type": "application/json",
  };
  const call = (changes = {}) =>
    fetch(url, {
      method: "POST",
      headers: { ...headers, ...changes },
      body: JSON.stringify({ format: "24", timeZone: "UTC", id: "victim" }),
    });
  assert.equal((await call({ authorization: "" })).status, 401);
  assert.equal((await call({ "x-csrf-token": "" })).status, 403);
  assert.equal((await call({ origin: "https://evil.invalid" })).status, 403);
  assert.equal(preferences.get("owner").timeZone, null);
  const response = await call();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).preferences, {
    format: "24",
    timeZone: "UTC",
  });
  assert.equal(preferences.get("victim").timeZone, null);
  assert.equal(preferences.get("owner").format, "24");
});
