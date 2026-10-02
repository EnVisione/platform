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
  const connect = (overrides = {}) =>
    fetch(`${origin}/apply/api/discord/start`, {
      method: "POST",
      headers: { ...headers, ...overrides },
      body: "{}",
    });
  assert.equal((await connect({ "X-CSRF-Token": "wrong-token" })).status, 403);
  assert.equal((await connect({ Cookie: "" })).status, 403);
  const login = await connect();
  assert.equal(login.status, 200);
  const destination = new URL((await login.json()).url);
  assert.equal(destination.origin, config.staffOrigin);
  assert.equal(destination.pathname, "/auth/discord");
  assert.equal(destination.searchParams.get("purpose"), "application");
  assert.ok(
    applications.getChallenge(destination.searchParams.get("challenge")),
  );
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
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/YQAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = (body = png, overrides = {}) =>
    fetch(`${origin}/apply/api/evidence/images`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "image/png",
        "X-File-Name": "Evidence.png",
        ...overrides,
      },
      body,
    });
  assert.equal(
    (await upload(png, { "X-CSRF-Token": "wrong-token" })).status,
    403,
  );
  assert.equal(
    (await upload(png, { Origin: "https://other.example.com" })).status,
    403,
  );
  assert.equal(
    (await upload(Buffer.from("<html>Not an image</html>"))).status,
    400,
  );
  assert.equal((await upload(Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
  const uploaded = await upload();
  assert.equal(uploaded.status, 201);
  const { evidenceImages } = await uploaded.json();
  const imageUrl = `${origin}/apply/api/evidence/images/${evidenceImages[0].id}`;
  assert.equal(
    (await fetch(imageUrl, { headers: { "X-Forwarded-Proto": "https" } }))
      .status,
    404,
  );
  const image = await fetch(imageUrl, { headers });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("Content-Type"), "image/png");
  assert.equal(image.headers.get("Cache-Control"), "private, no-store");
  assert.equal(image.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(image.headers.get("Content-Security-Policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal(
    (
      await fetch(imageUrl, {
        method: "DELETE",
        headers: { ...headers, "X-CSRF-Token": "wrong-token" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(imageUrl, { method: "DELETE", headers })).status,
    200,
  );
  assert.equal((await fetch(imageUrl, { headers })).status, 404);
  assert.equal(
    (await fetch(`${origin}/api/applications`, { headers })).status,
    404,
  );
  assert.equal(
    (await fetch(`${origin}/auth/discord`, { headers })).status,
    404,
  );
});
