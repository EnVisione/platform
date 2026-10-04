import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import session from "express-session";
import { openStore, hash } from "../server/store.js";
import { ticketService } from "../server/tickets.js";
import { ticketRouter } from "../server/ticket-routes.js";
import { rolePermissions } from "../server/role-permissions.js";
import { config as fixture } from "./fixture.js";
import { AuthError } from "../server/discord.js";

test("ticket HTTP endpoints protect owner data, upload boundaries, staff evidence and live streams", async (t) => {
  const config = {
    ...fixture,
    staffOrigin: "https://staff.example.invalid",
    applications: { publicOrigin: "https://example.invalid" },
    tickets: { guildId: "2" },
  };
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const policy = rolePermissions(config, store),
    service = ticketService(config, store, policy);
  const player = { id: "100", name: "Player" },
    helper = policy.apply({ id: "200", name: "Helper", roles: ["10", "23"] });
  let staffIdentity = helper,
    signedIn = true,
    uploads = 0;
  const transport = {
    async assertMember() {},
    async create(ticket) {
      service.bind(ticket.id, `channel-${ticket.id}`);
    },
    async status() {
      return { deleted: true };
    },
    async feedback() {
      return { id: randomUUID() };
    },
    async message() {
      return { id: randomUUID() };
    },
    async upload(bytes, name, type) {
      uploads++;
      return {
        name,
        type,
        size: bytes.length,
        channelId: "400",
        messageId: "500",
        attachmentId: "600",
      };
    },
    async bytes() {
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    },
  };
  service.attach(transport);
  const app = express();
  app.set("trust proxy", 1);
  app.use((req, _res, next) => {
    req.sessionID = "fixture";
    req.session = {
      ticketIdentity: signedIn ? player : null,
      ticketUntil: Date.now() + 60000,
      csrf: "fixture",
      save: (callback) => callback(),
    };
    next();
  });
  app.use(
    ticketRouter(config, service, transport, {
      database: store,
      dist: "/does-not-exist",
    }),
  );
  app.use(
    ticketRouter(config, service, transport, {
      staffView: true,
      database: store,
      dist: "/does-not-exist",
      authorize: async () => staffIdentity,
      mutation: (req) => {
        if (
          req.headers.origin !== config.staffOrigin ||
          req.headers["x-csrf-token"] !== "fixture"
        )
          throw new AuthError("invalid_request");
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await service.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, body, extra = {}) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: config.applications.publicOrigin,
        "X-CSRF-Token": "fixture",
        "Content-Type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await call("/api/tickets?from=2026-02-30")).status, 400);
  assert.equal((await call("/api/tickets?assignment=other")).status, 400);
  assert.equal((await call("/api/tickets?offset=1.5")).status, 400);
  const data = {
    requestId: randomUUID(),
    type: "general",
    ign: "Jojo",
    location: "Void",
    description: "A detailed description of the issue and how to reproduce it.",
  };
  const listResponse = await call("/help/api/tickets");
  assert.equal(listResponse.status, 200);
  assert.ok(Array.isArray((await listResponse.json()).items));
  let response = await call("/help/api/tickets", data, {
    "X-CSRF-Token": "wrong",
  });
  assert.equal(response.status, 403);
  response = await call("/help/api/tickets", data);
  assert.equal(response.status, 201);
  const id = (await response.json()).path.split("/").at(-1);
  signedIn = false;
  response = await call(`/help/api/tickets/${id}`);
  assert.equal(response.status, 401);
  signedIn = true;
  const other = service.create(
    { id: "999", name: "Other" },
    { ...data, requestId: randomUUID() },
  );
  assert.equal((await call(`/help/api/tickets/${other.id}`)).status, 404);
  response = await call(`/help/api/tickets/${id}/messages`, {
    content: "Hello from the owner",
    requestId: randomUUID(),
  });
  assert.equal(response.status, 201);
  const staffHeaders = { Origin: config.staffOrigin };
  response = await call(
    `/api/tickets/${id}/messages`,
    {
      content: "I am checking the issue now.",
      requestId: randomUUID(),
    },
    staffHeaders,
  );
  assert.equal(response.status, 201);
  assert.equal(service.get(id).status, "claimed");
  assert.equal(
    (await call(`/api/tickets/${id}/claim`, {}, staffHeaders)).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/api/tickets/${id}/takeover`,
        { claimedBy: helper.id },
        staffHeaders,
      )
    ).status,
    403,
  );
  staffIdentity = policy.apply({
    id: "201",
    name: "Admin",
    roles: ["10", "21"],
  });
  assert.equal(
    (await call(`/api/tickets/${id}/takeover`, { claimedBy: helper.id }))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        `/api/tickets/${id}/takeover`,
        { claimedBy: "stale-assignee" },
        staffHeaders,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/api/tickets/${id}/takeover`,
        { claimedBy: helper.id },
        staffHeaders,
      )
    ).status,
    200,
  );
  assert.equal(service.get(id).claimedBy.id, "201");
  assert.equal(
    (await call(`/help/api/tickets/${id}/takeover`, { claimedBy: "201" }))
      .status,
    404,
  );
  staffIdentity = helper;
  const attachment = (
    bytes,
    name,
    type,
    path = `/help/api/tickets/${id}/attachments`,
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        Origin: path.startsWith("/api")
          ? config.staffOrigin
          : config.applications.publicOrigin,
        "X-CSRF-Token": "fixture",
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(name),
        "X-File-Type": type,
      },
      body: bytes,
    });
  assert.equal(
    (
      await attachment(
        Buffer.from("<script>steal()</script>"),
        "proof.png",
        "image/png",
      )
    ).status,
    400,
  );
  assert.equal(
    (await attachment(Buffer.from("payload"), "../secret.txt", "text/plain"))
      .status,
    400,
  );
  assert.equal(uploads, 0);
  const proofResponse = await attachment(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "proof.png",
    "image/png",
    `/api/tickets/${id}/attachments?internal=1`,
  );
  assert.equal(proofResponse.status, 201);
  const proof = await proofResponse.json();
  assert.equal(
    (await call(`/help/api/tickets/${id}/attachments/${proof.id}?staff=1`))
      .status,
    404,
  );
  assert.equal(
    (await call(`/api/tickets/${id}/attachments/${proof.id}`)).status,
    200,
  );
  const controller = new AbortController();
  const stream = await fetch(`${base}/help/api/tickets/${id}/events`, {
    signal: controller.signal,
  });
  assert.ok(stream.headers.get("content-type").startsWith("text/event-stream"));
  const reader = stream.body.getReader();
  await reader.read();
  service.reply(player, id, {
    requestId: randomUUID(),
    content: "Live update",
  });
  const event = await reader.read();
  assert.ok(new TextDecoder().decode(event.value).includes("data:"));
  const staffStream = await fetch(`${base}/api/tickets/${id}/events`, {
    signal: controller.signal,
  });
  const staffReader = staffStream.body.getReader();
  await staffReader.read();
  service.events.emit("staff-access-revoked", "999");
  service.reply(player, id, {
    requestId: randomUUID(),
    content: "Staff view still open",
  });
  assert.equal((await staffReader.read()).done, false);
  await reader.read();
  service.events.emit("staff-access-revoked", helper.id);
  assert.equal((await staffReader.read()).done, true);
  service.reply(player, id, {
    requestId: randomUUID(),
    content: "Player view remains open",
  });
  assert.equal((await reader.read()).done, false);
  assert.equal(service.events.listenerCount("staff-access-revoked"), 1);
  controller.abort();
  await reader.cancel().catch(() => {});
  response = await call(
    `/api/tickets/${id}/close`,
    {
      summary:
        "PRIVATE: restored the affected player and confirmed the issue is resolved.",
      commands: "None",
      attachments: [proof.id],
    },
    { Origin: config.staffOrigin },
  );
  assert.equal(response.status, 200);
  response = await call(`/help/api/tickets/${id}`);
  const playerView = await response.json();
  assert.equal(playerView.resolution, undefined);
  response = await call(`/help/api/tickets/${id}/rating`, { rating: 5 });
  assert.equal(response.status, 200);
  assert.equal(
    (
      await call(
        `/api/tickets/${id}/delete-channel`,
        {},
        { Origin: config.staffOrigin },
      )
    ).status,
    403,
  );
  await service.pump();
  assert.equal(
    (await call(`/help/api/tickets/${other.id}/reopen`, {})).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/help/api/tickets/${id}/reopen`,
        {},
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/help/api/tickets/${id}/reopen`, {
        closureId: playerView.closureId,
      })
    ).status,
    200,
  );
  assert.equal(service.get(id).status, "pending");
  assert.equal(service.view(player, id).previousResolutions, undefined);
  assert.match(
    service.view(helper, id, true).previousResolutions[0].resolution.summary,
    /PRIVATE/,
  );
  response = await call(`/help/api/tickets/${id}/transcript`);
  assert.match(
    response.headers.get("content-security-policy"),
    /sandbox allow-downloads/,
  );
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(response.status, 200);
  assert.ok(
    response.headers.get("content-disposition").startsWith("attachment;"),
  );
  assert.ok(!(await response.text()).includes("PRIVATE:"));
  response = await call(`/api/tickets/${id}/transcript`);
  assert.ok((await response.text()).includes("PRIVATE:"));
  response = await call(`/help/api/tickets/${id}/rating`, { rating: 5 });
  assert.equal(response.status, 400);
});

test("website guests use private sessions, required email and a shared IP open-ticket quota", async (t) => {
  const config = {
    ...fixture,
    sessionSecret: randomBytes(32).toString("hex"),
    applications: { publicOrigin: "https://example.invalid" },
    tickets: { guildId: "2" },
  };
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  const service = ticketService(
    config,
    database.store,
    rolePermissions(config, database.store),
  );
  let memberChecks = 0;
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    session({
      secret: config.sessionSecret,
      store: database.sessions,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 7 * 86400000 },
    }),
  );
  app.use(
    ticketRouter(
      config,
      service,
      {
        async assertMember() {
          memberChecks++;
        },
      },
      { database: database.store, dist: "/does-not-exist" },
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await service.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    database.store.close();
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function browser(ip) {
    const response = await fetch(base + "/help/api/session");
    const data = await response.json();
    assert.equal(data.identity, null);
    let cookie = response.headers.get("set-cookie").split(";")[0];
    return async (path, body, forwarded = ip) => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: config.applications.publicOrigin,
          "X-CSRF-Token": data.csrf,
          "Content-Type": "application/json",
          "X-Forwarded-For": forwarded,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      return response;
    };
  }
  const first = await browser("192.0.2.1"),
    second = await browser("192.0.2.1"),
    other = await browser("192.0.2.2");
  const data = {
    requestId: randomUUID(),
    ign: "Jojo",
    type: "general",
    location: "Void",
    description: "Detailed website ticket without any Discord account.",
    email: "jojo@example.invalid",
  };
  assert.equal(
    (await first("/help/api/tickets", { ...data, email: "" })).status,
    400,
  );
  const response = await first("/help/api/tickets", data);
  assert.equal(response.status, 201);
  const id = (await response.json()).path.split("/").at(-1);
  assert.equal((await first("/help/api/tickets", data)).status, 201);
  assert.equal(
    (
      await second(
        "/help/api/tickets",
        { ...data, requestId: randomUUID() },
        "198.51.100.99, 192.0.2.1",
      )
    ).status,
    409,
  );
  assert.equal(
    (await other("/help/api/tickets", { ...data, requestId: randomUUID() }))
      .status,
    201,
  );
  assert.equal(memberChecks, 0);
  assert.equal((await second(`/help/api/tickets/${id}`)).status, 404);
  const snapshot = await (await first(`/help/api/tickets/${id}`)).json();
  assert.equal(snapshot.contactEmail, undefined);
  assert.equal(snapshot.guestNetwork, undefined);
  assert.equal(snapshot.owner.guest, true);
  assert.equal(
    (
      await first(`/help/api/tickets/${id}/messages`, {
        requestId: randomUUID(),
        content: "Hello without Discord",
      })
    ).status,
    201,
  );
  assert.equal((await first(`/help/api/tickets/${id}/close`, {})).status, 200);
  assert.equal(
    (await second("/help/api/tickets", { ...data, requestId: randomUUID() }))
      .status,
    201,
  );
  const key = randomBytes(32).toString("base64url");
  database.store.set("ticket-email-access", hash(key), { ticketId: id });
  const access = await second("/help/api/email-access", { key });
  assert.equal(access.status, 200);
  assert.equal((await access.json()).path, `/help/Jojo/${id}`);
  assert.equal((await second(`/help/api/tickets/${id}`)).status, 200);
  assert.equal((await first("/help/api/email-access", { key })).status, 400);
});
