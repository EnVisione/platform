import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import express from "express";
import { roleRouter } from "../server/role-routes.js";
import { rolePermissions } from "../server/role-permissions.js";
import { openStore } from "../server/store.js";
import { AuthError } from "../server/discord.js";
import { config as fixture } from "./fixture.js";

test("role endpoints require staff host, current Manager or Founder access, CSRF and valid JSON", async (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const policy = rolePermissions(fixture, store);
  let rank = "20",
    signedIn = true,
    updates = 0;
  const app = express();
  app.use(
    "/api/roles",
    roleRouter({
      policy,
      staffHost: "staff.example.invalid",
      authorize() {
        if (!signedIn) throw new AuthError("login_required", 401);
        return { id: "42", name: "Fixture", roles: ["10", rank] };
      },
      requireMutation(req) {
        if (
          req.headers.origin !== "https://staff.example.invalid" ||
          req.headers["x-csrf-token"] !== "fixture"
        )
          throw new AuthError("invalid_request");
      },
      onPolicyChange() {
        updates++;
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status ?? 503).json({ error: error.code ?? "unexpected" }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const headers = {
    Host: "staff.example.invalid",
    Origin: "https://staff.example.invalid",
    "X-CSRF-Token": "fixture",
    "Content-Type": "application/json",
  };
  const call = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        `http://127.0.0.1:${server.address().port}/api/roles${path}`,
        {
          method: options.method ?? "GET",
          headers: { ...headers, ...options.headers },
        },
        (res) => {
          const parts = [];
          res.on("data", (chunk) => parts.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              data: res.headers["content-type"]?.includes("application/json")
                ? JSON.parse(Buffer.concat(parts).toString())
                : null,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  assert.equal(
    (await call("/history?from=2026-10-04&to=2026-10-03")).status,
    400,
  );
  assert.equal((await call("/history?action=unknown")).status, 400);
  const catalog = await call("/");
  assert.equal(catalog.status, 200);
  assert.equal(
    (await call("/", { headers: { Host: "drakora.org" } })).status,
    404,
  );
  signedIn = false;
  assert.equal((await call("/history")).status, 401);
  signedIn = true;
  rank = "21";
  assert.equal((await call("/")).status, 403);
  rank = "28";
  const body = JSON.stringify({
    revision: catalog.data.revision,
    roles: catalog.data.roles
      .filter((role) => role.id)
      .map((role) => ({ id: role.id, permissions: role.permissions })),
  });
  assert.equal(
    (
      await call("/", {
        method: "PUT",
        headers: { "X-CSRF-Token": "wrong" },
        body,
      })
    ).status,
    403,
  );
  assert.equal((await call("/", { method: "PUT", body: "{" })).status, 400);
  assert.equal((await call("/", { method: "PUT", body })).status, 200);
  assert.equal(updates, 1);
  assert.equal((await call("/", { method: "PUT", body })).status, 409);
  assert.equal((await call("/members")).status, 503);
});
