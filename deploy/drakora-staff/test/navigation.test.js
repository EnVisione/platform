import test from "node:test";
import assert from "node:assert/strict";
import { isPageRequest } from "../server/navigation.js";

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
