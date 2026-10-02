import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import session from "express-session";
import { randomBytes } from "node:crypto";
import { openStore } from "../server/store.js";
import { applicationService } from "../server/applications.js";
import { applicationRouter } from "../server/application-routes.js";
import { config as fixture } from "./fixture.js";

test("public form mutations require its browser session, CSRF token, and origin", async (t) => {
  const config = {
    ...fixture,
    staffOrigin: "https://staff.example.com",
    applications: {
      publicOrigin: "https://example.com",
      specialistRoles: { builder: "51", artist: "52", developer: "25" },
    },
  };
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  const applications = applicationService(config, database.store);
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    session({
      name: "__Host-drakora_apply",
      secret: randomBytes(32).toString("base64url"),
      store: database.sessions,
      resave: false,
      saveUninitialized: false,
      cookie: { secure: true, httpOnly: true, sameSite: "lax", maxAge: 60000 },
    }),
  );
  app.use(applicationRouter(config, applications, "/unused-test-assets"));
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await applications.close();
    database.store.close();
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = await fetch(`${origin}/apply/api/draft`, {
    headers: { "X-Forwarded-Proto": "https" },
  });
  const cookie = first.headers.get("set-cookie");
  assert.match(cookie, /^__Host-drakora_apply=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Domain=/);
  const { csrf } = await first.json();
  const headers = {
    Cookie: cookie.split(";")[0],
    "X-Forwarded-Proto": "https",
    "Content-Type": "application/json",
    Origin: config.applications.publicOrigin,
    "X-CSRF-Token": csrf,
  };
  const request = (overrides) =>
    fetch(`${origin}/apply/api/draft`, {
      method: "PATCH",
      headers: { ...headers, ...overrides },
      body: JSON.stringify({
        role: "community",
        answers: { displayName: "Synthetic applicant" },
      }),
    });
  assert.equal(
    (await request({ Origin: "https://other.example.com" })).status,
    403,
  );
  assert.equal((await request({ "X-CSRF-Token": "wrong-token" })).status, 403);
  assert.equal((await request({ Cookie: "" })).status, 403);
  const accepted = await request({});
  assert.equal(accepted.status, 200);
  assert.equal(
    (await accepted.json()).answers.displayName,
    "Synthetic applicant",
  );
  assert.equal(
    (await fetch(`${origin}/api/applications`, { headers })).status,
    404,
  );
  assert.equal(
    (await fetch(`${origin}/auth/discord`, { headers })).status,
    404,
  );
});
