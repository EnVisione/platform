import test from "node:test";
import assert from "node:assert/strict";
import { discordTodoSync } from "../server/todo-sync.js";
import {
  commentMarkup,
  trackerDocs,
  discordText,
} from "../server/todo-comments.js";

const issueClass = "tracker:class:Issue";
const commentClass = "chunter:class:ChatMessage";
const sourceField = {
  name: "discordPost",
  attributeOf: "tracker:mixin:IssueTypeData",
};
const statuses = [
  ["Pending", "pending"],
  ["In Progress", "active"],
  ["Awaiting Verification", "verification"],
  ["Completed", "completed"],
  ["Impossible / Void", "void"],
].map(([name, _id]) => ({ name, _id }));

function fixture(t) {
  const thread = {
    id: "100",
    parent_id: "20",
    name: "Update staff information",
    applied_tags: [],
  };
  const threads = new Map([[thread.id, thread]]);
  const archived = new Set();
  const forum = {
    id: "20",
    type: 15,
    available_tags: [
      { id: "30", name: "In Progress" },
      { id: "31", name: "Complete" },
      { id: "32", name: "Envy", moderated: true },
      { id: "33", name: "Hampe", moderated: true },
      { id: "34", name: "Bug" },
    ],
  };
  const project = { _id: "dev", identifier: "DEV", sequence: 0 };
  const people = [
    { _id: "envy", name: ",EnVy", personUuid: "envy-account" },
    { _id: "hampe", name: ",Hampe", personUuid: "hampe-account" },
  ];
  const social = [
    {
      _id: "envy-social",
      attachedTo: "envy",
      type: "oidc",
      value: "discord:101",
    },
    {
      _id: "hampe-social",
      attachedTo: "hampe",
      type: "oidc",
      value: "discord:102",
    },
  ];
  const issues = [];
  const comments = [];
  const messages = new Map([
    [
      "100",
      {
        id: "100",
        type: 0,
        author: { id: "101", username: "EnVy" },
        content: "Original post",
        timestamp: "2026-10-02T12:00:00Z",
      },
    ],
  ]);
  const records = new Map();
  const writes = [];
  const requests = [];
  const failures = new Map();
  let nextId = 200;
  let closeCount = 0;
  let incomplete = false;
  let lostMessageResponse = false;
  let lostThreadResponse = false;
  const store = {
    get: (kind, id) => structuredClone(records.get(`${kind}:${id}`)),
    set: (kind, id, value) =>
      records.set(`${kind}:${id}`, structuredClone(value)),
    entries: (kind) =>
      [...records]
        .filter(([key]) => key.startsWith(`${kind}:`))
        .map(([key, value]) => [
          key.slice(kind.length + 1),
          structuredClone(value),
        ]),
  };
  const config = {
    guildId: "1",
    discordBotToken: "test",
    hulyWorkspace: "workspace",
    staffOrigin: "https://staff.example.invalid",
    todoForums: [{ channelId: "20", projectId: "dev" }],
  };
  const fetcher = async (url, options) => {
    const { pathname: path } = new URL(url);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method, body });
    const failure = failures.get(`${method} ${path}`);
    if (failure)
      return Response.json({ code: failure.code }, { status: failure.status });
    let result;
    if (path.endsWith("/threads/active"))
      result = {
        threads: [...threads.values()].filter((item) => !archived.has(item.id)),
      };
    else if (path.endsWith("/threads/archived/public"))
      result = {
        threads: [...threads.values()].filter((item) => archived.has(item.id)),
        has_more: incomplete,
      };
    else if (path === "/api/v10/users/@me") result = { id: "bot" };
    else if (path === "/api/v10/channels/20") {
      if (method === "PATCH")
        forum.available_tags = body.available_tags.map((tag) => ({
          ...tag,
          id: tag.id ?? String(nextId++),
        }));
      result = forum;
    } else if (path === "/api/v10/channels/20/threads" && method === "POST") {
      const id = String(nextId++);
      result = {
        id,
        parent_id: "20",
        name: body.name,
        applied_tags: body.applied_tags,
      };
      threads.set(id, result);
      messages.set(id, {
        id,
        channel_id: id,
        type: 0,
        author: { id: "bot", bot: true },
        ...body.message,
      });
      if (lostThreadResponse) {
        lostThreadResponse = false;
        throw new Error("Lost thread response");
      }
    } else {
      const [, channelId, messageId] =
        path.match(
          /^\/api\/v10\/channels\/(\d+)(?:\/messages(?:\/(\d+))?)?$/,
        ) ?? [];
      if (channelId && threads.has(channelId)) {
        if (path.includes("/messages")) {
          if (method === "POST") {
            const id = String(nextId++);
            result = {
              id,
              channel_id: channelId,
              type: 0,
              author: { id: "bot", bot: true },
              ...body,
            };
            messages.set(id, result);
            if (lostMessageResponse) {
              lostMessageResponse = false;
              throw new Error("Lost message response");
            }
          } else if (method === "DELETE") {
            messages.delete(messageId);
            return new Response(null, { status: 204 });
          } else if (method === "PATCH") {
            Object.assign(messages.get(messageId), body);
            result = messages.get(messageId);
          } else
            result = messageId
              ? messages.get(messageId)
              : [...messages.values()]
                  .filter(
                    (message) => (message.channel_id ?? "100") === channelId,
                  )
                  .sort((a, b) => Number(b.id) - Number(a.id));
        } else if (method === "DELETE") {
          threads.delete(channelId);
          for (const [id, message] of messages)
            if ((message.channel_id ?? "100") === channelId)
              messages.delete(id);
          result = { id: channelId };
        } else {
          if (method === "PATCH") Object.assign(threads.get(channelId), body);
          result = threads.get(channelId);
        }
      }
    }
    return result === undefined
      ? Response.json(
          { code: path.includes("/messages/") ? 10008 : 10003 },
          { status: 404 },
        )
      : Response.json(result);
  };
  const matches = (doc, query) =>
    Object.entries(query).every(([key, value]) => {
      const actual = key
        .split(".")
        .reduce((current, part) => current?.[part], doc);
      return actual === value;
    });
  const client = {
    async findAll(cls, query) {
      const docs =
        cls === "core:class:Attribute"
          ? [sourceField]
          : cls === "tracker:class:IssueStatus"
            ? statuses
            : cls === "contact:class:Person"
              ? people
              : cls === "contact:class:SocialIdentity"
                ? social
                : cls === issueClass
                  ? issues.filter((doc) => matches(doc, query))
                  : cls === commentClass
                    ? comments.filter((doc) => matches(doc, query))
                    : undefined;
      assert.ok(docs, `Unexpected class ${cls}`);
      return structuredClone(docs);
    },
    async findOne(cls, query) {
      return structuredClone(
        cls === "tracker:class:Project"
          ? project
          : issues.find((issue) => issue._id === query._id),
      );
    },
    async updateDoc(cls, _space, id, update) {
      if (cls === "tracker:class:Project") {
        project.sequence += update.$inc.sequence;
        return { object: { sequence: project.sequence } };
      }
      const doc = (cls === commentClass ? comments : issues).find(
        (item) => item._id === id,
      );
      assert.ok(doc);
      Object.assign(doc, update);
      if (cls === commentClass) doc.modifiedAccount = this.account;
      writes.push({ id, update });
    },
    async addCollection(
      cls,
      space,
      parent,
      parentClass,
      collection,
      data,
      id,
      createdOn,
      createdBy,
    ) {
      const docs = cls === issueClass ? issues : comments;
      assert.ok(!docs.some((doc) => doc._id === id));
      if (cls === commentClass && createdBy) {
        const identity = social.find((entry) => entry._id === createdBy);
        const person = people.find(
          (entry) => entry._id === identity?.attachedTo,
        );
        assert.equal(
          this.account,
          person?.personUuid,
          "Comment author must belong to the authenticated account",
        );
      }
      docs.push({
        ...data,
        _id: id,
        _class: cls,
        space,
        attachedTo: parent,
        attachedToClass: parentClass,
        collection,
        createdOn,
        createdBy,
        createdAccount: this.account,
      });
    },
    async removeCollection(cls, _space, id) {
      const docs = cls === issueClass ? issues : comments;
      const index = docs.findIndex((item) => item._id === id);
      if (index >= 0) docs.splice(index, 1);
      if (cls === issueClass)
        for (let i = comments.length - 1; i >= 0; i--)
          if (comments[i].attachedTo === id) comments.splice(i, 1);
    },
    async createMixin(id, _class, _space, mixin, data) {
      const issue = issues.find((item) => item._id === id);
      issue[mixin] = { ...issue[mixin], ...data };
    },
    async close() {
      closeCount++;
    },
  };
  const sync = discordTodoSync(
    config,
    store,
    { serviceToken: (account = "owner") => account },
    {
      fetcher,
      openClient: async (_endpoint, _workspace, account) =>
        Object.assign(Object.create(client), { account }),
    },
  );
  t.after(() => sync.close());
  const nativeComment = (id = "native-comment", text = "Tracker reply") => {
    comments.push({
      _id: id,
      _class: commentClass,
      space: "dev",
      attachedTo: issues[0]._id,
      message: commentMarkup(text),
      createdBy: "envy-social",
      createdOn: Date.now(),
    });
  };
  const discordComment = (id = "110", text = "Discord reply") =>
    messages.set(id, {
      id,
      type: 0,
      author: { id: "101", username: "EnVy" },
      content: text,
      timestamp: "2026-10-02T12:01:00Z",
    });
  return {
    sync,
    thread,
    threads,
    archived,
    forum,
    config,
    project,
    issues,
    comments,
    messages,
    store,
    writes,
    requests,
    failures,
    nativeComment,
    discordComment,
    setIncomplete: () => (incomplete = true),
    loseMessage: () => (lostMessageResponse = true),
    loseThread: () => (lostThreadResponse = true),
    closed: () => closeCount,
  };
}

test("Discord imports stay linked through archival with no duplicate issue", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  assert.equal(s.issues[0].identifier, "DEV-1");
  assert.equal(
    s.issues[0][sourceField.attributeOf][sourceField.name],
    "https://discord.com/channels/1/100",
  );
  s.archived.add("100");
  await s.sync.sync();
  assert.equal(s.issues.length, 1);
  assert.equal(s.issues[0].status, "pending");
  assert.deepEqual(s.writes, []);
});

test("Tracker and Discord assignments and status tags synchronize both ways without overwriting other tags", async (t) => {
  const s = fixture(t);
  s.thread.applied_tags = ["34"];
  await s.sync.sync();
  s.issues[0].assignee = "envy";
  s.issues[0].status = "completed";
  await s.sync.sync();
  assert.deepEqual(s.thread.applied_tags.toSorted(), ["31", "32", "34"]);
  s.thread.applied_tags = ["30", "33", "34"];
  await s.sync.sync();
  assert.equal(s.issues[0].assignee, "hampe");
  assert.equal(s.issues[0].status, "active");
  s.thread.applied_tags = ["34"];
  await s.sync.sync();
  assert.equal(s.issues[0].assignee, null);
  assert.equal(s.issues[0].status, "pending");
  s.thread.applied_tags = ["32", "34"];
  await s.sync.sync();
  assert.equal(s.issues[0].assignee, "envy");
  s.issues[0].assignee = null;
  await s.sync.sync();
  assert.deepEqual(s.thread.applied_tags, ["34"]);
  const count = s.requests.length;
  await s.sync.sync();
  assert.ok(
    s.requests.slice(count).every((request) => request.method === "GET"),
  );
});

test("legacy links keep Tracker edits on adoption and then follow changes in either platform", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  const issue = s.issues[0];
  s.store.set("discord-todo", "100", {
    issueId: issue._id,
    title: s.thread.name,
    statusKey: "pending",
  });
  issue.title = "Edited in Tracker";
  issue.status = "verification";
  await s.sync.sync();
  assert.equal(s.thread.name, issue.title);
  assert.ok(
    s.forum.available_tags.some(
      (tag) =>
        tag.name === "Awaiting Verification" &&
        s.thread.applied_tags.includes(tag.id),
    ),
  );
  s.thread.name = "Edited in Discord";
  s.thread.applied_tags = ["30"];
  await s.sync.sync();
  assert.equal(issue.title, "Edited in Discord");
  assert.equal(issue.status, "active");
});

test("same field conflicts favor Discord while independent changes merge", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.thread.name = "Discord title";
  s.issues[0].title = "Tracker title";
  s.issues[0].assignee = "envy";
  await s.sync.sync();
  assert.equal(s.issues[0].title, "Discord title");
  assert.ok(s.thread.applied_tags.includes("32"));
});

test("comments mirror both ways once with author attribution and native source edits", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.discordComment();
  s.nativeComment();
  await s.sync.sync();
  assert.equal(s.comments.length, 2);
  const incoming = s.comments.find((comment) =>
    comment._id.startsWith("drakora:"),
  );
  assert.equal(incoming.createdBy, "envy-social");
  assert.equal(incoming.createdAccount, "envy-account");
  assert.equal(incoming.message, commentMarkup("Discord reply"));
  const outgoing = [...s.messages.values()].find(
    (message) => message.author.id === "bot",
  );
  assert.match(outgoing.embeds[0].author.name, /EnVy/);
  assert.equal(outgoing.embeds[0].description, "Tracker reply");
  s.messages.get("110").content = "Edited Discord reply";
  s.comments[0].message = commentMarkup("Edited Tracker reply");
  await s.sync.sync();
  assert.equal(incoming.message, commentMarkup("Edited Discord reply"));
  assert.equal(incoming.modifiedAccount, "envy-account");
  assert.equal(outgoing.embeds[0].description, "Edited Tracker reply");
  await s.sync.sync();
  assert.equal(s.comments.length, 2);
  assert.equal(s.messages.size, 3);
});

test("each linked Discord author uses their own native account and unknown authors retain their name", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.discordComment();
  const first = s.messages.get("110");
  s.messages.set("111", {
    ...first,
    id: "111",
    author: { id: "102", username: "Hampe" },
  });
  s.messages.set("112", {
    ...first,
    id: "112",
    author: { id: "103", username: "Guest" },
  });
  await s.sync.sync();
  const hampe = s.comments.find((comment) => comment._id.endsWith(":111"));
  assert.equal(hampe.createdBy, "hampe-social");
  assert.equal(hampe.createdAccount, "hampe-account");
  const guest = s.comments.find((comment) => comment._id.endsWith(":112"));
  assert.equal(guest.createdAccount, "owner");
  assert.equal(
    guest.message,
    commentMarkup("Guest (Discord)\n\nDiscord reply"),
  );
});

test("lost Discord reply response recovers its marker after a restart without reposting", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.nativeComment();
  s.loseMessage();
  await assert.rejects(s.sync.sync(), /Lost message response/);
  await s.sync.sync();
  assert.equal(s.messages.size, 2);
  assert.equal(s.comments.length, 1);
});

test("comment deletion propagates from either copy and never resurrects", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.discordComment();
  s.nativeComment();
  await s.sync.sync();
  const outgoing = [...s.messages.values()].find(
    (message) => message.author.id === "bot",
  );
  s.messages.delete(outgoing.id);
  s.comments.splice(
    s.comments.findIndex((comment) => comment._id.startsWith("drakora:")),
    1,
  );
  await s.sync.sync();
  assert.equal(s.comments.length, 0);
  assert.equal(s.messages.size, 1);
  await s.sync.sync();
  assert.equal(s.comments.length, 0);
  assert.equal(s.messages.size, 1);
});

test("linked task deletion propagates both ways with durable tombstones", async (t) => {
  for (const source of ["discord", "huly"]) {
    const s = fixture(t);
    await s.sync.sync();
    const id = s.issues[0]._id;
    if (source === "discord") s.threads.delete("100");
    else s.issues.length = 0;
    await s.sync.sync();
    assert.equal(s.issues.length, 0);
    assert.equal(s.threads.size, 0);
    assert.equal(s.store.get("huly-todo", id).deleted, true);
    await s.sync.sync();
    assert.equal(s.project.sequence, 1);
    assert.equal(s.issues.length, 0);
  }
});

test("incomplete listings and denied or failed fetches never delete linked work", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.archived.add("100");
  s.setIncomplete();
  await assert.rejects(s.sync.sync(), /incomplete/);
  assert.equal(s.issues.length, 1);
  s.archived.delete("100");
  const b = fixture(t);
  await b.sync.sync();
  b.threads.delete("100");
  b.failures.set("GET /api/v10/channels/100", { status: 403 });
  await assert.rejects(b.sync.sync(), /HTTP 403/);
  assert.equal(b.issues.length, 1);
  assert.ok(!b.store.get("discord-todo", "100").deleted);
  b.failures.set("GET /api/v10/channels/100", { status: 404, code: 999 });
  await assert.rejects(b.sync.sync(), /HTTP 404/);
  assert.equal(b.issues.length, 1);
});

test("new Tracker tasks create a forum post and recover a lost creation response", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.issues.push({
    _id: "native",
    _class: issueClass,
    space: "dev",
    title: "New native task",
    identifier: "DEV-2",
    status: "pending",
    assignee: "envy",
  });
  s.loseThread();
  await assert.rejects(s.sync.sync(), /Lost thread response/);
  await s.sync.sync();
  assert.equal(s.threads.size, 2);
  assert.equal(s.issues.length, 2);
  const record = s.store.get("huly-todo", "native");
  assert.ok(record.threadId);
  assert.ok(s.threads.get(record.threadId).applied_tags.includes("32"));
  await s.sync.sync();
  assert.equal(s.threads.size, 2);
});

test("concurrent runs share one reconciliation and client closes on failure", async (t) => {
  const s = fixture(t);
  await Promise.all([s.sync.sync(), s.sync.sync()]);
  assert.equal(s.closed(), 1);
  assert.equal(s.issues.length, 1);
  s.failures.set("GET /api/v10/channels/100/messages", { status: 500 });
  await assert.rejects(s.sync.sync(), /HTTP 500/);
  assert.equal(s.closed(), 2);
});

test("ambiguous assignee tags hold the task and long Tracker titles do not trigger loops", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.thread.applied_tags = ["32", "33"];
  await assert.rejects(s.sync.sync(), /ambiguous/);
  assert.equal(s.issues[0].assignee, null);
  s.thread.applied_tags = [];
  s.issues[0].title = "A".repeat(150);
  await s.sync.sync();
  assert.equal(s.thread.name.length, 100);
  const count = s.requests.length;
  await s.sync.sync();
  assert.ok(
    s.requests.slice(count).every((request) => request.method === "GET"),
  );
  assert.equal(s.issues[0].title.length, 150);
});

test("deletion retries preserve tombstones through failed Discord delivery", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.nativeComment();
  s.discordComment();
  await s.sync.sync();
  s.comments.length = 0;
  s.failures.set("DELETE /api/v10/channels/100/messages/110", { status: 403 });
  await assert.rejects(s.sync.sync(), /HTTP 403/);
  assert.equal(s.comments.length, 0);
  s.failures.clear();
  await s.sync.sync();
  assert.equal(s.messages.size, 1);
  assert.equal(s.comments.length, 0);
  const id = s.issues[0]._id;
  s.issues.length = 0;
  s.failures.set("DELETE /api/v10/channels/100", { status: 500 });
  await assert.rejects(s.sync.sync(), /HTTP 500/);
  assert.equal(s.store.get("huly-todo", id).deleted, true);
  s.failures.clear();
  await s.sync.sync();
  assert.equal(s.threads.size, 0);
  assert.equal(s.issues.length, 0);
});

test("long replies split and an interrupted copy is removed if its original was deleted", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.nativeComment("long", "x".repeat(8000));
  await s.sync.sync();
  assert.equal(s.messages.size, 4);
  assert.ok(
    [...s.messages.values()]
      .filter((m) => m.embeds)
      .every((m) => m.embeds[0].description.length <= 3800),
  );
  s.comments.length = 0;
  await s.sync.sync();
  assert.equal(s.messages.size, 1);
  s.nativeComment();
  s.loseMessage();
  await assert.rejects(s.sync.sync(), /Lost message response/);
  s.comments.length = 0;
  await s.sync.sync();
  assert.equal(s.messages.size, 1);
});

test("moderated assignee names and explicit mappings never consume unrelated named tags", async (t) => {
  const s = fixture(t);
  s.forum.available_tags.find((t) => t.id === "34").name = "EnVy";
  s.thread.applied_tags = ["34"];
  await s.sync.sync();
  assert.equal(s.issues[0].assignee, null);
  s.config.todoForums[0].assigneeTags = { 34: "102" };
  s.thread.applied_tags = ["34"];
  await s.sync.sync();
  assert.equal(s.issues[0].assignee, "hampe");
});

test("Tracker pagination follows reported totals and rejects incomplete pages", async () => {
  const docs = Array.from({ length: 3 }, (_, i) => ({ _id: String(i) }));
  const client = {
    findAll: async (_cls, _query, options) =>
      Object.assign(docs.slice(options.skip, options.skip + 2), { total: 3 }),
  };
  assert.deepEqual(await trackerDocs(client, "test", {}), docs);
  await assert.rejects(
    trackerDocs(
      { findAll: async () => Object.assign([], { total: 3 }) },
      "test",
      {},
    ),
    /incomplete/,
  );
});

test("configured text exclusions stay literal and leave normal correspondence intact", () => {
  assert.equal(
    discordText("An internal note", ["internal note"]),
    "Staff update. Open Tracker for details.",
  );
  assert.equal(discordText("Issue 123", ["Issue.*"]), "Issue 123");
  assert.equal(discordText("A staff update", ["ai"]), "A staff update");
  assert.equal(discordText("Normal reply"), "Normal reply");
});
