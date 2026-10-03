import test from "node:test";
import assert from "node:assert/strict";
import { trackerEvents } from "../server/todo-events.js";

test("native issue, comment and label events wake mapped projects and renew reconnect credentials", async () => {
  let notify;
  let options;
  let changes = 0;
  let tokens = 0;
  let closed = false;
  const urls = [];
  const watcher = trackerEvents(
    {
      todoForums: [{ projectId: "dev" }],
      hulyWorkspace: "staff",
      hulyOwner: "owner",
    },
    { serviceToken: () => `token-${++tokens}` },
    () => changes++,
    {
      connect(url, handler, workspace, owner, settings) {
        assert.equal(url, "ws://transactor:3333/");
        assert.equal(workspace, "staff");
        assert.equal(owner, "owner");
        notify = handler;
        options = settings;
        return { close: async () => (closed = true) };
      },
      socketFactory: (url) => urls.push(url),
    },
  );
  notify(undefined, {
    objectClass: "tracker:class:Issue",
    objectSpace: "other",
  });
  notify({ objectClass: "contact:class:Person", objectSpace: "dev" });
  assert.equal(changes, 0);
  notify({ objectClass: "tracker:class:Issue", objectSpace: "dev" });
  notify({
    objectClass: "tracker:class:Issue",
    objectSpace: "other",
    tx: { objectClass: "chunter:class:ChatMessage", objectSpace: "dev" },
  });
  notify({
    txes: [{ objectClass: "tracker:class:Issue", objectSpace: "dev" }],
  });
  assert.equal(changes, 3);
  notify({ objectClass: "tags:class:TagReference", objectSpace: "other" });
  notify({ objectClass: "tags:class:TagElement", objectSpace: "other" });
  assert.equal(changes, 3);
  notify({
    tx: { objectClass: "tags:class:TagReference", objectSpace: "dev" },
  });
  notify({
    objectClass: "tags:class:TagElement",
    objectSpace: "core:space:Workspace",
  });
  assert.equal(changes, 5);
  await options.onConnect();
  assert.equal(changes, 6);
  options.socketFactory("ws://transactor:3333/?sessionId=first");
  options.socketFactory("ws://transactor:3333/?sessionId=second");
  assert.deepEqual(urls, [
    "ws://transactor:3333/token-1?sessionId=first",
    "ws://transactor:3333/token-2?sessionId=second",
  ]);
  await watcher.close();
  assert.equal(closed, true);
});
