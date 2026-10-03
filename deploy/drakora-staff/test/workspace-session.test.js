import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openStore } from "../server/store.js";
import { workspaceSessions } from "../server/workspace-session.js";
import { dashboardDestination } from "../shared/dashboard-navigation.js";

test("embedded access is single use, expires, and follows the parent staff session", (t) => {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => store.close());
  const sessions = workspaceSessions(store);
  const until = Date.now() + 60000;
  store.set("session", "parent", { userId: "staff", until }, until);
  const code = sessions.issue("parent", "staff", "calendar");
  assert.deepEqual(sessions.take(code), {
    staffSession: "parent",
    userId: "staff",
    view: "calendar",
    until,
  });
  assert.throws(() => sessions.take(code), /invalid_handoff/);
  const revoked = sessions.issue("parent", "staff", "tracker");
  store.delete("session", "parent");
  assert.throws(() => sessions.take(revoked), /login_required/);
  store.set("session", "parent", { userId: "other", until }, until);
  assert.throws(
    () => sessions.take(sessions.issue("parent", "staff", "tracker")),
    /login_required/,
  );
  store.set(
    "session",
    "parent",
    { userId: "staff", until: Date.now() - 1 },
    until,
  );
  assert.throws(
    () => sessions.take(sessions.issue("parent", "staff", "tracker")),
    /login_required/,
  );
  for (const value of [undefined, {}, "", "x".repeat(43)])
    assert.throws(() => sessions.take(value), /invalid_handoff/);
  const expired = sessions.issue("parent", "staff", "tracker");
  for (const [key, record] of store.entries("workspace-handoff"))
    store.set("workspace-handoff", key, record, Date.now() - 1);
  assert.throws(() => sessions.take(expired), /invalid_handoff/);
});

test("dashboard history keeps supported pages local and leaves external and download links alone", () => {
  const origin = "https://staff.example.invalid";
  for (const path of [
    "/",
    "/tracker",
    "/calendar",
    "/email",
    "/settings",
    "/accounts",
    "/roles",
    "/applications",
    "/applications/editor",
    "/applications/12345678-1234-1234-1234-123456789012?name=Staff",
  ])
    assert.equal(dashboardDestination(path, origin), path);
  for (const path of [
    "//evil.invalid/tracker",
    "https://evil.invalid/calendar",
    "/api/mail/attachment",
    "/login",
    "/auth/discord",
    "javascript:alert(1)",
    "http://[",
    null,
    {},
  ])
    assert.equal(dashboardDestination(path, origin), null);
});
