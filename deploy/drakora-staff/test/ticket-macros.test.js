import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import { openStore } from "../server/store.js";
import { rolePermissions } from "../server/role-permissions.js";
import { ticketMacros } from "../server/ticket-macros.js";
import { ticketRouter } from "../server/ticket-routes.js";
import { AuthError } from "../server/discord.js";
import { config } from "./fixture.js";

const manager = { id: "200", roles: ["10", "28"] };
const helper = { id: "201", roles: ["10", "23"] };
const founder = { id: "202", roles: ["10", "20"] };

function setup(t) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  const policy = rolePermissions(config, store);
  return { store, policy, macros: ticketMacros(store, policy) };
}

test("shared macros follow live category permissions and protect concurrent edits", (t) => {
  const { macros, policy, store } = setup(t);
  const support = macros.save(manager, null, {
    category: "support",
    name: "Joining help",
    content: "Please check the pack version.",
  });
  const billing = macros.save(founder, null, {
    category: "billing",
    name: "Purchase help",
    content: "Please provide your transaction reference.",
  });
  assert.deepEqual(
    macros.list(helper).items.map((item) => item.id),
    [support.id],
  );
  assert.throws(() => macros.list(manager, "billing"), {
    code: "ticket_access_denied",
  });
  assert.throws(
    () =>
      macros.save(helper, null, {
        category: "support",
        name: "Denied",
        content: "No",
      }),
    { code: "ticket_access_denied" },
  );
  assert.throws(() => macros.remove(manager, billing.id, billing.revision), {
    code: "ticket_access_denied",
  });
  assert.throws(
    () => macros.save(manager, support.id, { ...support, category: "billing" }),
    { code: "ticket_access_denied" },
  );
  const updated = macros.save(manager, support.id, {
    ...support,
    content: "Check your pack and game version.",
  });
  assert.throws(
    () =>
      macros.save(manager, support.id, { ...support, content: "Stale update" }),
    { code: "ticket_macro_changed" },
  );
  assert.throws(() => macros.remove(manager, support.id, support.revision), {
    code: "ticket_macro_changed",
  });
  assert.equal(macros.list(helper).items[0].content, updated.content);
  const permissions = policy.read(founder);
  policy.save(founder, {
    revision: permissions.revision,
    roles: permissions.roles
      .filter((role) => role.id)
      .map((role) => ({
        id: role.id,
        permissions: {
          ...role.permissions,
          ...(role.id === "23"
            ? { "tickets.category.support.reply": false }
            : {}),
        },
      })),
  });
  assert.equal(macros.list(helper).items.length, 0);
  assert.throws(() => macros.list(helper, "support"), {
    code: "ticket_access_denied",
  });
  macros.remove(manager, support.id, updated.revision);
  assert.equal(store.get("ticket-macro", support.id), undefined);
  assert.equal(store.entries("ticket-macro").length, 1);
});

test("macro mutations require a staff identity and mutation protection through the HTTP router", async (t) => {
  const { store, macros } = setup(t);
  let identity = manager;
  const app = express();
  app.use(
    ticketRouter(config, {}, null, {
      staffView: true,
      database: store,
      macros,
      authorize: async () => {
        if (!identity) throw new AuthError("unauthorized", 401);
        return identity;
      },
      mutation: (req) => {
        if (
          req.headers.origin !== "https://staff.example.invalid" ||
          req.headers["x-csrf-token"] !== "fixture"
        )
          throw new AuthError("invalid_request");
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.code || "error" }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = "GET", body, csrf = "fixture") =>
    fetch(url + path, {
      method,
      headers: {
        Origin: "https://staff.example.invalid",
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const draft = {
    category: "support",
    name: "Help",
    content: "Check your version.",
  };
  assert.equal(
    (await call("/api/ticket-macros", "POST", draft, "wrong")).status,
    403,
  );
  let response = await call("/api/ticket-macros", "POST", draft);
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(
    (await call("/api/ticket-macros", "POST", { ...draft, content: "   " }))
      .status,
    400,
  );
  identity = helper;
  assert.equal((await call("/api/ticket-macros", "POST", draft)).status, 403);
  assert.equal(
    (await (await call("/api/ticket-macros?category=support")).json()).items[0]
      .id,
    saved.id,
  );
  assert.equal((await call("/api/ticket-macros?category=billing")).status, 403);
  identity = manager;
  assert.equal(
    (
      await call(`/api/ticket-macros/${saved.id}`, "PUT", {
        ...saved,
        name: "Updated",
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(`/api/ticket-macros/${saved.id}`, "DELETE", saved)).status,
    409,
  );
  response = await call("/api/ticket-macros");
  const current = (await response.json()).items[0];
  assert.equal(
    (await call(`/api/ticket-macros/${saved.id}`, "DELETE", current)).status,
    200,
  );
  identity = null;
  assert.equal((await call("/api/ticket-macros")).status, 401);
});
