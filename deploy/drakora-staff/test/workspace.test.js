import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import express from "express";
import {
  workspaceAllowed,
  workspacePath,
  workspaceHtml,
  workspaceHtmlProxy,
  isWorkspacePage,
} from "../server/workspace.js";

const config = {
  staffOrigin: "https://staff.example.invalid",
  workspaceUrl: "staff / team",
};

test("only workspace shell navigations use HTML decoration, downloads and APIs keep streaming", () => {
  const request = (path, mode = "navigate") => ({
    path,
    method: "GET",
    headers: { "sec-fetch-mode": mode },
  });
  for (const path of ["/", "/login", "/workbench/staff/tracker"])
    assert.equal(isWorkspacePage(request(path)), true);
  for (const path of [
    "/files/large.zip",
    "/bundle.js",
    "/config.json",
    "/_accounts",
    "/_collaborator",
    "/__staff/assets/asset.js",
  ])
    assert.equal(isWorkspacePage(request(path)), false);
  assert.equal(
    isWorkspacePage(request("/workbench/staff/tracker", "cors")),
    false,
  );
});

test("workspace destinations retain staff permission checks and exclude the removed Office", () => {
  assert.equal(
    workspacePath(config, "tracker"),
    "/workbench/staff%20%2F%20team/tracker",
  );
  assert.equal(
    workspacePath(config, "calendar"),
    "/workbench/staff%20%2F%20team/time",
  );
  assert.equal(workspacePath(config, "office"), null);
  for (const view of [
    "constructor",
    "__proto__",
    "//evil.invalid",
    "../../",
    "unknown",
  ]) {
    assert.equal(workspacePath(config, view), null);
    assert.equal(
      workspaceAllowed({ permissions: { todo: true }, capabilities: {} }, view),
      false,
    );
  }
  const user = { permissions: { todo: true }, capabilities: {} };
  assert.equal(workspaceAllowed(user, "tracker"), true);
  assert.equal(workspaceAllowed(user, "calendar"), true);
  assert.equal(workspaceAllowed(user, "office"), false);
  user.capabilities["office.view"] = true;
  assert.equal(workspaceAllowed(user, "office"), false);
  user.permissions.todo = false;
  for (const view of ["tracker", "calendar", "office"])
    assert.equal(workspaceAllowed(user, view), false);
});

test("native HTML keeps application scripts and escapes workspace metadata", () => {
  const html = workspaceHtml(
    { ...config, workspaceUrl: '\"><script>bad()</script>' },
    '<html><head><script src="/native.js"></script></head><body>Native menus</body></html>',
  );
  assert.match(html, /src="\/native.js"/);
  assert.match(html, /Native menus/);
  assert.match(
    html,
    /data-workspace="&quot;&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;"/,
  );
  assert.equal(html.includes("<script>bad()"), false);
});

test("HTML proxy permits only the staff ancestor and retains upstream security and redirects", async (t) => {
  const upstream = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/login" }).end();
      return;
    }
    if (req.url === "/binary") {
      res
        .writeHead(200, { "Content-Type": "application/octet-stream" })
        .end(Buffer.from([0, 255, 42]));
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy":
          "script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY",
      })
      .end("<html><head></head><body>Native workspace</body></html>");
  });
  const servers = [upstream];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const app = express();
  app.use((req, _res, next) => {
    req.workspaceUrl = config.workspaceUrl;
    next();
  });
  app.use(
    workspaceHtmlProxy(config, {
      target: `http://127.0.0.1:${upstream.address().port}`,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin);
  const policy = response.headers.get("content-security-policy");
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(
    policy,
    /frame-ancestors 'self' https:\/\/staff.example.invalid/,
  );
  assert.equal(response.headers.has("x-frame-options"), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /workspace.js/);
  const redirect = await fetch(`${origin}/redirect`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/login");
  assert.deepEqual(
    Buffer.from(await (await fetch(`${origin}/binary`)).arrayBuffer()),
    Buffer.from([0, 255, 42]),
  );
});

test("embedded bridge checks parent and origin, preserves native navigation and disconnects", () => {
  const handlers = new Map(),
    messages = [],
    destinations = [],
    styles = [];
  const attributes = new Map([["class", "theme-dark normal-font"]]);
  const parent = {
    postMessage: (message, origin) => messages.push({ message, origin }),
  };
  let disconnected = false;
  let observeUpdate;
  const axes = [
    "12am",
    "1am",
    "12pm",
    "6pm",
    "24:00",
    "25:00",
    "not a time",
  ].map((textContent) => ({
    childNodes: [{ nodeType: 3, data: textContent }],
    childElementCount: 0,
    get textContent() {
      return this.childNodes[0].data;
    },
  }));
  const nowLine = {
    value: "5:45pm",
    getAttribute() {
      return this.value;
    },
    setAttribute(_key, value) {
      this.value = value;
    },
  };
  const location = {
    pathname: "/workbench/staff/tracker/my-issues",
    replace: (value) => destinations.push(value),
  };
  const window = {
    parent,
    addEventListener: (name, handler) => handlers.set(name, handler),
  };
  const document = {
    addEventListener: (name, handler) =>
      handlers.set(`document:${name}`, handler),
    currentScript: {
      dataset: { staffOrigin: config.staffOrigin, workspace: "staff" },
    },
    documentElement: {
      setAttribute: (name, value) => attributes.set(name, value),
      style: { setProperty: (...args) => styles.push(args) },
    },
    querySelector: () => ({}),
    querySelectorAll: (selector) =>
      selector === ".time-cell" ? axes : [nowLine],
  };
  runInNewContext(
    readFileSync(
      new URL("../server/workspace-assets/workspace.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document,
      location,
      MutationObserver: class {
        constructor(callback) {
          observeUpdate = callback;
        }
        observe() {}
        disconnect() {
          disconnected = true;
        }
      },
      queueMicrotask: (fn) => fn(),
      URL,
    },
  );
  document.documentElement.setAttribute("class", "theme-dark small-font");
  assert.equal(attributes.get("data-drakora-embedded"), "");
  assert.equal(messages[0].message.view, "tracker");
  assert.equal(messages[0].origin, config.staffOrigin);
  assert.equal(Object.hasOwn(messages[0].message, "token"), false);
  const send = (data, origin = config.staffOrigin, source = parent) =>
    handlers.get("message")({ origin, source, data });
  send(
    { type: "drakora-workspace-open", view: "office" },
    "https://evil.invalid",
  );
  send(
    { type: "drakora-workspace-open", view: "office" },
    config.staffOrigin,
    {},
  );
  send({ type: "drakora-workspace-open", view: "constructor" });
  send({ type: "drakora-workspace-open", view: "tracker" });
  assert.equal(destinations.length, 0);
  send({ type: "drakora-workspace-open", view: "calendar" });
  assert.deepEqual(destinations, ["/workbench/staff/time"]);
  send({
    type: "drakora-workspace-theme",
    accent: "url(https://evil.invalid)",
  });
  assert.equal(styles.length, 0);
  send({ type: "drakora-workspace-theme", accent: "#5865f2" });
  assert.deepEqual(styles, [["--staff-accent", "#5865f2"]]);
  send({ type: "drakora-workspace-open", view: "office" });
  assert.deepEqual(destinations, ["/workbench/staff/time"]);
  send({
    type: "drakora-workspace-theme",
    accent: "#FFFFFF",
    foreground: "#16171C",
  });
  assert.deepEqual(styles.slice(-2), [
    ["--staff-accent", "#FFFFFF"],
    ["--staff-accent-text", "#16171C"],
  ]);
  send(
    { type: "drakora-workspace-time", format: "24" },
    "https://evil.invalid",
  );
  assert.equal(axes[0].textContent, "12am");
  send({ type: "drakora-workspace-time", format: "24" });
  assert.deepEqual(
    axes.map((n) => n.textContent),
    ["00:00", "01:00", "12:00", "18:00", "00:00", "25:00", "not a time"],
  );
  assert.equal(nowLine.value, "17:45");
  const nativeTextNode = axes[0].childNodes[0];
  nativeTextNode.data = "2am";
  nowLine.value = "6:01pm";
  observeUpdate();
  assert.equal(axes[0].childNodes[0], nativeTextNode);
  assert.equal(axes[0].textContent, "02:00");
  assert.equal(nowLine.value, "18:01");
  send({ type: "drakora-workspace-time", format: "12" });
  assert.equal(axes[0].textContent, "2:00 AM");
  assert.equal(axes[2].textContent, "12:00 PM");
  assert.equal(nowLine.value, "6:01 PM");
  handlers.get("pagehide")();
  assert.equal(disconnected, true);
  let prevented = false;
  handlers.get("document:click")({
    button: 0,
    target: { closest: () => ({ href: `${config.staffOrigin}/`, target: "" }) },
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(messages.at(-1).message.type, "drakora-dashboard-open");
  assert.equal(messages.at(-1).message.path, "/");
});
