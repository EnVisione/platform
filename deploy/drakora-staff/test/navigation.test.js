import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { isPageRequest, requestPath } from "../server/navigation.js";

test("request paths preserve the original mounted route and omit queries", () => {
  assert.equal(
    requestPath({
      originalUrl: "/api/mail?folder=inbox",
      url: "/?folder=inbox",
    }),
    "/api/mail",
  );
  assert.equal(
    requestPath({ url: "/_transactor/session?mode=live" }),
    "/_transactor/session",
  );
});

test("native websocket requests have a usable path without Express fields", async (t) => {
  const server = createServer();
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const received = new Promise((resolve) => {
    server.once("upgrade", (req, socket) => {
      resolve({
        originalUrl: req.originalUrl,
        path: requestPath(req),
        page: isPageRequest(req),
      });
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = connect(server.address().port, "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  client.write(
    "GET /_transactor/session?mode=live HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
  );
  assert.deepEqual(await received, {
    originalUrl: undefined,
    path: "/_transactor/session",
    page: false,
  });
});

test("only page navigation can restart login after logout", () => {
  const request = (path, headers = {}, method = "GET") => ({
    path,
    headers,
    method,
  });
  assert.equal(
    isPageRequest(
      request("/workbench/drakorastaff", { "sec-fetch-mode": "navigate" }),
    ),
    true,
  );
  assert.equal(isPageRequest(request("/")), true);
  assert.equal(isPageRequest(request("/login", { accept: "text/html" })), true);
  assert.equal(
    isPageRequest(
      request("/bundle.js", { "sec-fetch-mode": "no-cors", accept: "*/*" }),
    ),
    false,
  );
  assert.equal(
    isPageRequest(request("/image.png", { "sec-fetch-mode": "no-cors" })),
    false,
  );
  assert.equal(
    isPageRequest(
      request("/config.json", {
        "sec-fetch-mode": "cors",
        accept: "text/html",
      }),
    ),
    false,
  );
  assert.equal(
    isPageRequest(request("/_accounts", { "sec-fetch-mode": "navigate" })),
    false,
  );
  assert.equal(isPageRequest(request("/", { upgrade: "websocket" })), false);
  assert.equal(isPageRequest(request("/", {}, "POST")), false);
});
