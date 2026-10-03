import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import session from "express-session";
import { randomBytes } from "node:crypto";
import { openStore, hash } from "../server/store.js";
import { applicationService } from "../server/applications.js";
import { applicationRouter } from "../server/application-routes.js";
import { config as fixture } from "./fixture.js";

test("Minecraft head proxy accepts names and UUIDs and rejects unsafe images", async (t) => {
  const app = express();
  app.use(applicationRouter(fixture, {}, "/unused-test-assets"));
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const calls = [];
  let image = new Uint8Array([137, 80, 78, 71]);
  let contentType = "image/png";
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (String(url).startsWith(origin)) return originalFetch(url, options);
    const destination = new URL(url);
    assert.equal(destination.origin, "https://mc-heads.net");
    calls.push(destination.pathname);
    return Promise.resolve(
      new Response(image, { headers: { "Content-Type": contentType } }),
    );
  });
  for (const identifier of ["rarara", "c206df67643e485cb691a896594fc272"]) {
    const response = await fetch(`${origin}/apply/api/head/${identifier}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(
      response.headers.get("cache-control"),
      "private, max-age=3600",
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  }
  assert.equal(calls.length, 2);
  const invalid = await fetch(
    `${origin}/apply/api/head/${encodeURIComponent("https://private.invalid")}`,
  );
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 2);
  contentType = "image/svg+xml";
  assert.equal((await fetch(`${origin}/apply/api/head/rarara`)).status, 404);
  contentType = "image/png";
  image = new Uint8Array(256001);
  assert.equal((await fetch(`${origin}/apply/api/head/rarara`)).status, 502);
});

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
  const sessionId = database.store
    .entries("session")
    .find(([, value]) => value.csrf === csrf)[0];
  for (const [id, owner] of [
    ["own", sessionId],
    ["other", "other-session"],
  ])
    database.store.set(
      "application-summary",
      id,
      {
        id,
        role: "builder",
        ign: "Test_Player",
        createdAt: 123,
        status: "Received",
        discordId: null,
        browserSessionHash: hash(owner),
      },
      Number.MAX_SAFE_INTEGER,
    );
  const history = await fetch(`${origin}/apply/api/history?discordId=other`, {
    headers,
  });
  assert.equal(history.status, 200);
  assert.equal(history.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    (await history.json()).items.map((item) => item.id),
    ["own"],
  );
  const stranger = await fetch(`${origin}/apply/api/history`, {
    headers: { "X-Forwarded-Proto": "https" },
  });
  assert.equal((await stranger.json()).total, 0);
  assert.equal(
    (await fetch(`${origin}/apply/api/history?offset=-1`, { headers })).status,
    400,
  );
  const preferences = (overrides = {}) =>
    fetch(`${origin}/apply/api/notifications`, {
      method: "PUT",
      headers: { ...headers, ...overrides },
      body: JSON.stringify({
        preference: "email",
        email: "fixture@example.com",
      }),
    });
  assert.equal(
    (await preferences({ Origin: "https://other.example.com" })).status,
    403,
  );
  assert.equal(
    (await preferences({ "X-CSRF-Token": "wrong-token" })).status,
    403,
  );
  assert.equal((await preferences({ Cookie: "" })).status, 403);
  assert.equal((await preferences()).status, 404);
  const upload = await fetch(`${origin}/apply/api/evidence/images`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "image/png" },
    body: Buffer.from("image upload disabled"),
  });
  assert.equal(upload.status, 404);
  assert.equal(
    (await fetch(`${origin}/apply/api/evidence/images/any-image`, { headers }))
      .status,
    404,
  );
  assert.deepEqual(database.store.entries("application-image"), []);
  assert.equal(
    (await fetch(`${origin}/api/applications`, { headers })).status,
    404,
  );
  assert.equal(
    (await fetch(`${origin}/auth/discord`, { headers })).status,
    404,
  );
  const handoff = new URL(
    applications.handoff(destination.searchParams.get("challenge"), {
      id: "synthetic",
      name: "Synthetic applicant",
      username: "fixture",
      email: "fixture@example.com",
      roles: [],
    }),
  );
  const completed = await fetch(origin + handoff.pathname + handoff.search, {
    headers,
    redirect: "manual",
  });
  assert.equal(completed.status, 302);
  assert.equal(completed.headers.get("location"), "/apply/start");
  assert.equal(
    applications.view(sessionId).answers.displayName,
    "Synthetic applicant",
  );
  const repeated = await fetch(origin + handoff.pathname + handoff.search, {
    headers,
    redirect: "manual",
  });
  assert.equal(
    repeated.headers.get("location"),
    "/apply/start?error=invalid_login_state",
  );
});
