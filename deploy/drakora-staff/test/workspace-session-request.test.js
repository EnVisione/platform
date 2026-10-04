import test from "node:test";
import assert from "node:assert/strict";
import { workspaceSessionRequests } from "../shared/workspace-session-request.js";

const options = { origin: "https://todo.example.test", csrf: "session-csrf" };
const response = (code) => ({
  ok: true,
  json: async () => ({ url: `${options.origin}/__staff/attach?code=${code}` }),
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("retry replaces a stalled request and ignores its late response", async (t) => {
  const old = deferred();
  const calls = [];
  const requests = workspaceSessionRequests({
    fetcher: (_url, init) => {
      calls.push(init);
      return calls.length === 1
        ? old.promise
        : Promise.resolve(response("fresh"));
    },
  });
  t.after(() => requests.cancelAll());
  const first = requests.start("calendar", options);
  const second = requests.start("calendar", options);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].headers["X-CSRF-Token"], options.csrf);
  assert.equal(JSON.parse(calls[1].body).view, "calendar");
  assert.equal(await second, `${options.origin}/__staff/attach?code=fresh`);
  old.resolve(response("expired"));
  assert.equal(await first, undefined);
});

test("old completion cannot clear a newer attempt or block another view", async (t) => {
  const calls = [];
  const requests = workspaceSessionRequests({
    fetcher: (_url, init) => {
      const result = deferred();
      calls.push({ ...result, signal: init.signal });
      return result.promise;
    },
  });
  t.after(() => requests.cancelAll());
  const old = requests.start("calendar", options);
  const current = requests.start("calendar", options);
  const tracker = requests.start("tracker", options);
  assert.equal(calls[1].signal.aborted, false);
  assert.equal(calls[2].signal.aborted, false);
  calls[0].resolve(response("old"));
  assert.equal(await old, undefined);
  const replacement = requests.start("calendar", options);
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls[2].signal.aborted, false);
  calls[1].resolve(response("superseded"));
  calls[2].resolve(response("tracker"));
  calls[3].resolve(response("calendar"));
  assert.equal(await current, undefined);
  assert.equal(await tracker, `${options.origin}/__staff/attach?code=tracker`);
  assert.equal(
    await replacement,
    `${options.origin}/__staff/attach?code=calendar`,
  );
});

test("request and response body stalls time out and permit another attempt", async (t) => {
  for (const stall of ["request", "body"]) {
    let attempt = 0;
    const requests = workspaceSessionRequests({
      timeout: 20,
      fetcher: (_url, { signal }) => {
        if (++attempt > 1) return Promise.resolve(response("recovered"));
        const blocked = new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return stall === "request"
          ? blocked
          : Promise.resolve({ ok: true, json: () => blocked });
      },
    });
    t.after(() => requests.cancelAll());
    await assert.rejects(
      requests.start("calendar", options),
      /workspace_timeout/,
    );
    assert.equal(
      await requests.start("calendar", options),
      `${options.origin}/__staff/attach?code=recovered`,
    );
  }
});

test("session failures and foreign destinations remain rejected", async (t) => {
  for (const result of [
    { ok: false, json: async () => ({ error: "login_required" }) },
    {
      ok: true,
      json: async () => ({ url: "https://other.example.test/__staff/attach" }),
    },
    { ok: true, json: async () => ({ url: `${options.origin}/login` }) },
  ]) {
    const requests = workspaceSessionRequests({ fetcher: async () => result });
    t.after(() => requests.cancelAll());
    await assert.rejects(
      requests.start("calendar", options),
      /login_required|service_unavailable/,
    );
  }
});

test("unmount cancels all views without reporting late failures", async () => {
  const calls = [];
  const requests = workspaceSessionRequests({
    fetcher: (_url, init) => {
      const result = deferred();
      calls.push({ ...result, signal: init.signal });
      return result.promise;
    },
  });
  const calendar = requests.start("calendar", options);
  const tracker = requests.start("tracker", options);
  requests.cancelAll();
  for (const call of calls) {
    assert.equal(call.signal.aborted, true);
    call.reject(new Error("network unavailable"));
  }
  assert.deepEqual(await Promise.all([calendar, tracker]), [
    undefined,
    undefined,
  ]);
});
