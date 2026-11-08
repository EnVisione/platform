import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { openStore } from "../server/store.js";
import { ticketService } from "../server/tickets.js";
import { ticketRouter } from "../server/ticket-routes.js";
import { rolePermissions } from "../server/role-permissions.js";
import { config as fixture } from "./fixture.js";

test("skipped attachments download an explicit notice and keep ticket authorization", async (t) => {
  const config = {
    ...fixture,
    applications: { publicOrigin: "https://example.invalid" },
    tickets: { guildId: "2" },
  };
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const service = ticketService(config, store, rolePermissions(config, store));
  let user = { id: "100", name: "Player" };
  const ticket = service.create(user, {
    requestId: randomUUID(),
    ign: "Player",
    type: "general",
    location: "Discord",
    description: "A closed ticket with an attachment Discord cannot archive.",
  });
  const file = {
    id: randomUUID(),
    ticketId: ticket.id,
    uploader: user.id,
    used: true,
    name: "latest.log",
    type: "text/plain",
    size: 67 * 1024 * 1024,
    expiresAt: Date.now() + 86400000,
    archiveSkipped: { reason: "attachment_too_large", at: Date.now() },
  };
  store.set("ticket-media", file.id, file, Number.MAX_SAFE_INTEGER);
  const app = express();
  app.use((req, _res, next) => {
    req.session = {
      ticketIdentity: user,
      ticketUntil: Date.now() + 60000,
    };
    next();
  });
  app.use(
    ticketRouter(
      config,
      service,
      {
        async bytes() {
          assert.fail("A skipped attachment must not be fetched from Discord.");
        },
      },
      { database: store, dist: "/does-not-exist" },
    ),
  );
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.code });
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await service.stop();
    store.close();
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/help/api/tickets/${ticket.id}/attachments/${file.id}`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-disposition"),
    /latest.log.not-archived.txt/,
  );
  assert.match(await response.text(), /This attachment was not archived/);
  user = { id: "another-player", name: "Other player" };
  assert.equal((await fetch(url)).status, 404);
  user = null;
  assert.equal((await fetch(url)).status, 401);
});
