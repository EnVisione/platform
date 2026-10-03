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

function fixture(t, options = {}) {
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
  const labelDefinitions = [];
  const labelReferences = [];
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
  const webhooks = new Map();
  let nextId = 200;
  let closeCount = 0;
  let incomplete = false;
  let lostMessageResponse = false;
  let lostWebhookResponse = false;
  let lostThreadResponse = false;
  let lostOpenResponse = false;
  let lostRenameResponse = false;
  const store = {
    get: (kind, id) => structuredClone(records.get(`${kind}:${id}`)),
    set: (kind, id, value) =>
      records.set(`${kind}:${id}`, structuredClone(value)),
    delete: (kind, id) => records.delete(`${kind}:${id}`),
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
    const { pathname: path, searchParams } = new URL(url);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({
      path,
      method,
      body,
      query: Object.fromEntries(searchParams),
      authorization: options.headers.Authorization,
    });
    const failure = failures.get(`${method} ${path}`);
    if (failure)
      return Response.json(
        {
          code: failure.code,
          retry_after: failure.retry_after,
          global: failure.global,
        },
        { status: failure.status },
      );
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
    else if (/^\/api\/v10\/guilds\/1\/members\/10[12]$/.test(path)) {
      const id = path.split("/").at(-1);
      result = {
        nick: id === "101" ? "EnVy" : "Hampe",
        user: {
          id,
          username: id === "101" ? "EnVy" : "Hampe",
          avatar: "a".repeat(32),
        },
      };
    } else if (path === "/api/v10/channels/20/webhooks") {
      if (method === "POST") {
        result = {
          id: String(nextId++),
          type: 1,
          channel_id: "20",
          user: { id: "bot" },
          token: "fixture",
          name: body.name,
        };
        webhooks.set(result.id, result);
        if (lostWebhookResponse) {
          lostWebhookResponse = false;
          throw new Error("Lost webhook response");
        }
      } else result = [...webhooks.values()];
    } else if (path.startsWith("/api/v10/webhooks/")) {
      const [, hookId, token, messageId] =
        path.match(
          /^\/api\/v10\/webhooks\/(\d+)(?:\/([^/]+)(?:\/messages\/(\d+))?)?$/,
        ) ?? [];
      const hook = webhooks.get(hookId);
      if (!hook || (token && token !== hook.token))
        return Response.json({ code: 10015 }, { status: 404 });
      if (!token) result = hook;
      else if (method === "POST") {
        assert.equal(searchParams.get("wait"), "true");
        const id = String(nextId++);
        result = {
          ...body,
          id,
          channel_id: searchParams.get("thread_id"),
          type: 0,
          webhook_id: hookId,
          author: { id: hookId, username: body.username, bot: true },
        };
        messages.set(id, result);
        if (lostMessageResponse) {
          lostMessageResponse = false;
          throw new Error("Lost message response");
        }
      } else if (method === "PATCH") {
        result = messages.get(messageId);
        if (!result) return Response.json({ code: 10008 }, { status: 404 });
        Object.assign(result, body);
      }
    } else if (path === "/api/v10/channels/20") {
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
            if (archived.has(channelId)) {
              archived.delete(channelId);
              threads.get(channelId).thread_metadata = {
                ...threads.get(channelId).thread_metadata,
                archived: false,
              };
            }
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
          if (method === "PATCH") {
            const item = threads.get(channelId);
            if (archived.has(channelId) && body.archived !== false)
              return Response.json({ code: 50083 }, { status: 400 });
            if (body.archived !== undefined) {
              if (body.archived) archived.add(channelId);
              else archived.delete(channelId);
              item.thread_metadata = {
                ...item.thread_metadata,
                archived: body.archived,
              };
            }
            Object.assign(item, body);
            if (body.name !== undefined && lostRenameResponse) {
              lostRenameResponse = false;
              throw new Error("Lost rename response");
            }
            if (body.archived === false && lostOpenResponse) {
              lostOpenResponse = false;
              throw new Error("Lost opening response");
            }
          }
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
      return value?.$in ? value.$in.includes(actual) : actual === value;
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
                    : cls === "tags:class:TagElement"
                      ? labelDefinitions.filter((doc) => matches(doc, query))
                      : cls === "tags:class:TagReference"
                        ? labelReferences.filter((doc) => matches(doc, query))
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
  const start = () =>
    discordTodoSync(
      config,
      store,
      { serviceToken: (account = "owner") => account },
      {
        fetcher,
        openClient: async (_endpoint, _workspace, account) =>
          Object.assign(Object.create(client), { account }),
        ...options,
      },
    );
  const sync = start();
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
    client,
    thread,
    threads,
    archived,
    forum,
    config,
    project,
    issues,
    comments,
    people,
    social,
    labelDefinitions,
    labelReferences,
    messages,
    store,
    writes,
    requests,
    failures,
    webhooks,
    restart: async () => {
      await sync.close();
      const restarted = start();
      t.after(() => restarted.close());
      return restarted;
    },
    nativeComment,
    discordComment,
    setIncomplete: () => (incomplete = true),
    loseMessage: () => (lostMessageResponse = true),
    loseWebhook: () => (lostWebhookResponse = true),
    loseThread: () => (lostThreadResponse = true),
    loseOpen: () => (lostOpenResponse = true),
    loseRename: () => (lostRenameResponse = true),
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

test("a linked staff assignee without a forum tag gets one persistent tag and can be assigned from either side", async (t) => {
  const s = fixture(t);
  s.thread.applied_tags = ["34"];
  s.people.push({
    _id: "sakura",
    name: ",Sakura",
    personUuid: "sakura-account",
  });
  s.social.push({
    _id: "sakura-social",
    attachedTo: "sakura",
    type: "oidc",
    value: "discord:103",
  });
  await s.sync.sync();
  s.issues[0].assignee = "sakura";
  await s.sync.sync();
  const tag = s.forum.available_tags.find((tag) => tag.name === "Sakura");
  assert.ok(tag?.moderated);
  assert.equal(s.store.get("discord-todo-tags", "20")[tag.id], "103");
  assert.deepEqual(s.thread.applied_tags.toSorted(), ["34", tag.id].toSorted());
  await s.sync.sync();
  assert.equal(
    s.forum.available_tags.filter((tag) => tag.name === "Sakura").length,
    1,
  );
  s.issues[0].assignee = null;
  await s.sync.sync();
  s.thread.applied_tags.push(tag.id);
  await s.sync.sync();
  assert.equal(s.issues[0].assignee, "sakura");
});

test("Discord tag limits keep unrepresentable assignments pending without removing other tags", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.forum.available_tags = s.forum.available_tags.filter(
    (tag) => tag.id !== "32",
  );
  while (s.forum.available_tags.length < 20)
    s.forum.available_tags.push({
      id: String(400 + s.forum.available_tags.length),
      name: "Other tag",
    });
  s.issues[0].assignee = "envy";
  await assert.rejects(s.sync.sync(), /available forum tag/);
  assert.equal(s.forum.available_tags.length, 20);
  assert.deepEqual(s.thread.applied_tags, []);
  const b = fixture(t);
  for (let i = 0; i < 5; i++) {
    const id = String(400 + i);
    b.forum.available_tags.push({ id, name: "Other tag" });
    b.thread.applied_tags.push(id);
  }
  await b.sync.sync();
  b.issues[0].assignee = "envy";
  await assert.rejects(b.sync.sync(), /exceed five tags/);
  assert.equal(b.thread.applied_tags.length, 5);
});

test("Void labels and priorities decorate only Discord titles and merge with Discord title edits", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  const issue = s.issues[0];
  s.labelDefinitions.push({
    _id: "void-label",
    targetClass: issueClass,
    title: "Void",
  });
  s.labelReferences.push({
    _id: "label-reference",
    space: "dev",
    attachedTo: issue._id,
    tag: "void-label",
    title: "Former label name",
  });
  issue.priority = 2;
  await s.sync.sync();
  assert.equal(s.thread.name, "[VOID] [HIGH] Update staff information");
  assert.equal(issue.title, "Update staff information");
  assert.equal(issue.status, "pending");
  s.thread.name = "[VOID] [HIGH] Revised task";
  issue.priority = 4;
  await s.sync.sync();
  assert.equal(s.thread.name, "[VOID] [LOW] Revised task");
  assert.equal(issue.title, "Revised task");
  for (const [priority, prefix] of [
    [0, ""],
    [1, "[URGENT] "],
    [2, "[HIGH] "],
    [3, "[MEDIUM] "],
    [4, "[LOW] "],
  ]) {
    issue.priority = priority;
    await s.sync.sync();
    assert.equal(s.thread.name, `[VOID] ${prefix}Revised task`);
    assert.equal(issue.title, "Revised task");
    const count = s.requests.length;
    await s.sync.sync();
    assert.ok(
      s.requests.slice(count).every((request) => request.method === "GET"),
    );
  }
  s.labelDefinitions[0].title = "Other";
  await s.sync.sync();
  assert.equal(s.thread.name, "[LOW] Revised task");
  s.labelDefinitions[0].title = "VOID";
  await s.sync.sync();
  assert.equal(s.thread.name, "[VOID] [LOW] Revised task");
  s.labelReferences.length = 0;
  issue.priority = 0;
  await s.sync.sync();
  assert.equal(s.thread.name, "Revised task");
});

test("failed and interrupted title delivery never imports managed prefixes into Tracker", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  const issue = s.issues[0];
  issue.priority = 2;
  s.loseRename();
  await assert.rejects(s.sync.sync(), /Lost rename response/);
  assert.equal(s.thread.name, "[HIGH] Update staff information");
  assert.equal(issue.title, "Update staff information");
  issue.priority = 3;
  s.failures.set("PATCH /api/v10/channels/100", { status: 500 });
  await assert.rejects(s.sync.sync(), /HTTP 500/);
  assert.equal(s.thread.name, "[HIGH] Update staff information");
  issue.priority = 4;
  await assert.rejects(s.sync.sync(), /HTTP 500/);
  assert.equal(issue.title, "Update staff information");
  s.failures.clear();
  await s.sync.sync();
  assert.equal(s.thread.name, "[LOW] Update staff information");
  assert.equal(issue.title, "Update staff information");
});

test("decorated titles preserve full Unicode Tracker titles and unmanaged bracketed names", async (t) => {
  const s = fixture(t);
  s.thread.name = "[HIGH] Checklist";
  await s.sync.sync();
  assert.equal(s.issues[0].title, "[HIGH] Checklist");
  assert.equal(s.thread.name, "[HIGH] Checklist");
  const title = "😀".repeat(120);
  s.issues[0].title = title;
  s.issues[0].priority = 1;
  await s.sync.sync();
  assert.equal(Array.from(s.thread.name).length, 100);
  assert.equal(s.thread.name, "[URGENT] " + "😀".repeat(91));
  const count = s.requests.length;
  await s.sync.sync();
  assert.equal(s.issues[0].title, title);
  assert.ok(
    s.requests.slice(count).every((request) => request.method === "GET"),
  );
  s.issues.length = 0;
  await s.sync.sync();
  assert.equal(s.store.get("discord-todo-title", "100"), undefined);
});

test("new Tracker posts recover decorated titles after an interrupted creation", async (t) => {
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
    priority: 2,
  });
  s.labelDefinitions.push({
    _id: "void-label",
    targetClass: issueClass,
    title: "Void",
  });
  s.labelReferences.push({
    space: "dev",
    attachedTo: "native",
    tag: "void-label",
  });
  s.loseThread();
  await assert.rejects(s.sync.sync(), /Lost thread response/);
  await s.sync.sync();
  const id = s.store.get("huly-todo", "native").threadId;
  assert.equal(s.threads.get(id).name, "[VOID] [HIGH] New native task");
  assert.equal(
    s.issues.find((issue) => issue._id === "native").title,
    "New native task",
  );
  assert.equal(s.threads.size, 2);
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
    (message) => message.webhook_id,
  );
  assert.equal(outgoing.author.username, "EnVy");
  assert.equal(
    outgoing.avatar_url,
    `https://cdn.discordapp.com/avatars/101/${"a".repeat(32)}.png?size=256`,
  );
  assert.equal(outgoing.content, "Tracker reply");
  assert.deepEqual(outgoing.embeds, []);
  assert.deepEqual(outgoing.allowed_mentions, { parse: [] });
  s.messages.get("110").content = "Edited Discord reply";
  s.comments[0].message = commentMarkup("Edited Tracker reply");
  await s.sync.sync();
  assert.equal(incoming.message, commentMarkup("Edited Discord reply"));
  assert.equal(incoming.modifiedAccount, "envy-account");
  assert.equal(outgoing.content, "Edited Tracker reply");
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

test("lost webhook reply response recovers its checkpoint after a restart without reposting", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.nativeComment();
  s.loseMessage();
  await assert.rejects(s.sync.sync(), /Lost message response/);
  const restarted = await s.restart();
  await restarted.sync();
  assert.equal(s.messages.size, 2);
  assert.equal(s.comments.length, 1);
  assert.equal(
    s.store.get("discord-todo-comments", "100").pairs["native-comment"].pending,
    undefined,
  );
  assert.equal(
    s.requests.filter(
      (r) => r.method === "POST" && r.path.startsWith("/api/v10/webhooks/"),
    ).length,
    1,
  );
});

test("comment deletion propagates from either copy and never resurrects", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.discordComment();
  s.nativeComment();
  await s.sync.sync();
  const outgoing = [...s.messages.values()].find(
    (message) => message.webhook_id,
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

test("identical consecutive replies remain distinct after an uncertain send and reuse the forum webhook", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.nativeComment("first", "Same reply");
  s.nativeComment("second", "Same reply");
  s.loseMessage();
  await assert.rejects(s.sync.sync(), /Lost message response/);
  await s.sync.sync();
  const replies = [...s.messages.values()].filter((m) => m.webhook_id);
  assert.equal(replies.length, 2);
  assert.equal(replies[0].content, replies[1].content);
  const state = s.store.get("discord-todo-comments", "100");
  assert.notEqual(
    state.pairs.first.messageIds[0],
    state.pairs.second.messageIds[0],
  );
  assert.equal(
    s.requests.filter(
      (r) => r.path === "/api/v10/channels/20/webhooks" && r.method === "POST",
    ).length,
    1,
  );
  assert.equal(
    s.requests.filter(
      (r) => r.path === "/api/v10/channels/20/webhooks" && r.method === "GET",
    ).length,
    1,
  );
  assert.ok(
    s.requests
      .filter((r) => r.path.includes("/fixture"))
      .every(
        (r) => r.authorization === undefined && r.query.thread_id === "100",
      ),
  );
  assert.equal(
    s.requests.filter((r) => r.path === "/api/v10/guilds/1/members/101").length,
    2,
  );
});

test("historical bot replies keep their links through edits and deletion without being reposted", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.nativeComment();
  s.messages.set("190", {
    id: "190",
    type: 0,
    author: { id: "bot", bot: true },
    embeds: [
      {
        author: { name: "EnVy · Tracker" },
        description: "Tracker reply",
        footer: { text: "Tracker comment native-comment part 1" },
      },
    ],
  });
  await s.sync.sync();
  assert.equal(s.messages.size, 2);
  assert.equal(s.webhooks.size, 0);
  s.comments[0].message = commentMarkup("Edited historical reply");
  await s.sync.sync();
  assert.equal(
    s.messages.get("190").embeds[0].description,
    "Edited historical reply",
  );
  s.comments.length = 0;
  await s.sync.sync();
  assert.equal(s.messages.size, 1);
});

test("a removed forum webhook is recreated for new replies and rate records do not expose its token", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.nativeComment("first");
  await s.sync.sync();
  s.webhooks.clear();
  s.nativeComment("second");
  await assert.rejects(s.sync.sync(), /10015/);
  assert.equal(s.store.entries("discord-todo-webhooks").length, 0);
  await s.sync.sync();
  assert.equal([...s.messages.values()].filter((m) => m.webhook_id).length, 2);
  const hook = [...s.webhooks.values()][0];
  const route = `/api/v10/webhooks/${hook.id}/${hook.token}`;
  s.nativeComment("third");
  s.failures.set(`POST ${route}`, { status: 429, retry_after: 10 });
  await assert.rejects(s.sync.sync(), /HTTP 429/);
  const waits = s.store.entries("discord-todo-rate");
  assert.ok(waits.some(([key]) => key.endsWith("/:token")));
  assert.ok(waits.every(([key]) => !key.includes(hook.token)));
});

test("lost webhook creation recovers only the bot owned hook without adopting another author's webhook", async (t) => {
  const s = fixture(t);
  s.webhooks.set("190", {
    id: "190",
    type: 1,
    channel_id: "20",
    user: { id: "someone-else" },
    token: "other",
    name: "Drakora Tracker",
  });
  await s.sync.sync();
  s.nativeComment();
  s.loseWebhook();
  await assert.rejects(s.sync.sync(), /Lost webhook response/);
  const restarted = await s.restart();
  await restarted.sync();
  const reply = [...s.messages.values()].find((m) => m.webhook_id);
  assert.notEqual(reply.webhook_id, "190");
  assert.equal(s.webhooks.size, 2);
  assert.equal(
    s.requests.filter(
      (r) => r.method === "POST" && r.path === "/api/v10/channels/20/webhooks",
    ).length,
    1,
  );
});

test("saved staff profiles and text exclusions apply to plain webhook replies", async (t) => {
  const s = fixture(t);
  s.store.set("user", "101", {
    id: "101",
    hulyAccount: "envy-account",
    name: "Dashboard name",
    avatar: "https://cdn.discordapp.com/avatars/101/saved.png",
  });
  await s.sync.sync();
  s.nativeComment("first", "Hello @everyone");
  await s.sync.sync();
  const reply = [...s.messages.values()].find((m) => m.webhook_id);
  assert.equal(reply.author.username, "Dashboard name");
  assert.equal(
    reply.avatar_url,
    "https://cdn.discordapp.com/avatars/101/saved.png",
  );
  assert.deepEqual(reply.allowed_mentions, { parse: [] });
  assert.ok(s.requests.every((r) => !r.path.includes("/members/")));
  s.config.todoPublicTextExclusions = ["Dashboard name", "Private note"];
  s.nativeComment("second", "Private note with details");
  await s.sync.sync();
  const neutral = [...s.messages.values()].filter((m) => m.webhook_id).at(-1);
  assert.equal(neutral.author.username, "Staff member");
  assert.equal(neutral.avatar_url, undefined);
  assert.equal(neutral.content, "Staff update. Open Tracker for details.");
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

test("Tracker events coalesce into a fast sync and a change during an active run gets a trailing pass", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let notify;
  let stopped = 0;
  const s = fixture(t, {
    watchTracker: (_config, _huly, changed) => {
      notify = changed;
      return { close: async () => stopped++ };
    },
  });
  s.sync.start();
  s.sync.start();
  await s.sync.sync();
  assert.equal(s.closed(), 1);
  s.issues[0].assignee = "envy";
  notify();
  notify();
  t.mock.timers.tick(749);
  assert.deepEqual(s.thread.applied_tags, []);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.deepEqual(s.thread.applied_tags, ["32"]);
  assert.equal(s.closed(), 2);

  let release;
  let seen;
  const gate = new Promise((resolve) => (release = resolve));
  const reading = new Promise((resolve) => (seen = resolve));
  const original = s.client.findOne;
  let hold = true;
  s.client.findOne = async function (...args) {
    const result = await original.apply(this, args);
    if (hold && args[0] === issueClass) {
      hold = false;
      seen();
      await gate;
    }
    return result;
  };
  const active = s.sync.sync();
  await reading;
  s.issues[0].assignee = "hampe";
  notify();
  t.mock.timers.tick(2000);
  release();
  await active;
  assert.equal(s.closed(), 3);
  t.mock.timers.tick(750);
  await new Promise(setImmediate);
  assert.deepEqual(s.thread.applied_tags, ["33"]);
  assert.equal(s.closed(), 4);
  await s.sync.close();
  notify();
  t.mock.timers.tick(30000);
  assert.equal(s.closed(), 4);
  assert.equal(stopped, 1);
});

test("archived posts update assignments and comments while retaining archival and lock state", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.archived.add("100");
  s.thread.thread_metadata = { archived: true, locked: true };
  s.issues[0].assignee = "envy";
  s.nativeComment();
  await s.sync.sync();
  assert.deepEqual(s.thread.applied_tags, ["32"]);
  assert.equal(s.thread.thread_metadata.archived, true);
  assert.equal(s.thread.thread_metadata.locked, true);
  assert.equal(s.archived.has("100"), true);
  assert.equal(s.messages.size, 2);
  assert.equal(s.store.get("discord-todo-archive", "100"), undefined);
  const updates = s.requests.filter(
    (request) => request.method === "PATCH" && request.path.endsWith("/100"),
  );
  assert.deepEqual(
    updates.map((request) => request.body.archived),
    [false, undefined, true],
  );
});

test("failed rearchival remains durable and retries even without another content change", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.archived.add("100");
  s.thread.thread_metadata = { archived: true };
  s.issues[0].assignee = "envy";
  const findAll = s.client.findAll;
  s.client.findAll = async function (...args) {
    if (args[0] === commentClass)
      s.failures.set("PATCH /api/v10/channels/100", { status: 500 });
    return findAll.apply(this, args);
  };
  await assert.rejects(s.sync.sync(), /HTTP 500/);
  assert.equal(s.store.get("discord-todo-archive", "100"), true);
  assert.equal(s.archived.has("100"), false);
  s.client.findAll = findAll;
  s.failures.clear();
  await s.sync.sync();
  assert.equal(s.archived.has("100"), true);
  assert.equal(s.store.get("discord-todo-archive", "100"), undefined);
  assert.equal(s.issues.length, 1);
});

test("an interrupted opening response still restores the archived post", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.archived.add("100");
  s.thread.thread_metadata = { archived: true };
  s.issues[0].assignee = "envy";
  s.loseOpen();
  await assert.rejects(s.sync.sync(), /Lost opening response/);
  assert.equal(s.archived.has("100"), true);
  assert.equal(s.store.get("discord-todo-archive", "100"), undefined);
  await s.sync.sync();
  assert.deepEqual(s.thread.applied_tags, ["32"]);
  assert.equal(s.archived.has("100"), true);
});

test("a post archived after the initial listing is restored after a mirrored comment", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.nativeComment();
  const findAll = s.client.findAll;
  s.client.findAll = async function (...args) {
    if (args[0] === commentClass) {
      s.archived.add("100");
      s.thread.thread_metadata = { archived: true, locked: true };
    }
    return findAll.apply(this, args);
  };
  await s.sync.sync();
  assert.equal(s.messages.size, 2);
  assert.equal(s.thread.thread_metadata.archived, true);
  assert.equal(s.thread.thread_metadata.locked, true);
  assert.equal(s.store.get("discord-todo-archive", "100"), undefined);
});

test("an already archived restoration checkpoint is cleared without another archived edit", async (t) => {
  const s = fixture(t);
  await s.sync.sync();
  s.archived.add("100");
  s.thread.thread_metadata = { archived: true };
  s.store.set("discord-todo-archive", "100", true);
  const before = s.requests.length;
  await s.sync.sync();
  assert.equal(s.store.get("discord-todo-archive", "100"), undefined);
  assert.equal(s.archived.has("100"), true);
  assert.equal(
    s.requests.slice(before).some((request) => request.method === "PATCH"),
    false,
  );
});

test("Discord rate limits delay event retries and periodic runs without another request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const s = fixture(t, { watchTracker: () => ({ close: async () => {} }) });
  await s.sync.sync();
  s.failures.set("GET /api/v10/guilds/1/threads/active", {
    status: 429,
    retry_after: 45,
    global: true,
  });
  await assert.rejects(s.sync.sync(), /HTTP 429/);
  const count = s.requests.length;
  s.failures.clear();
  s.issues[0].assignee = "envy";
  s.sync.changed();
  t.mock.timers.tick(30000);
  await s.sync.sync();
  assert.equal(s.requests.length, count);
  t.mock.timers.tick(14999);
  assert.deepEqual(s.thread.applied_tags, []);
  t.mock.timers.tick(1);
  t.mock.timers.tick(750);
  await new Promise(setImmediate);
  assert.deepEqual(s.thread.applied_tags, ["32"]);
});

test("tag updates do not resend titles and one throttled post does not block another", async (t) => {
  const s = fixture(t);
  s.threads.set("101", {
    id: "101",
    parent_id: "20",
    name: "Second task",
    applied_tags: [],
  });
  await s.sync.sync();
  const second = s.issues.find((issue) => issue._id.endsWith(":101"));
  s.issues[0].assignee = "envy";
  second.assignee = "hampe";
  s.failures.set("PATCH /api/v10/channels/100", {
    status: 429,
    retry_after: 60,
  });
  await assert.rejects(s.sync.sync(), /HTTP 429/);
  assert.deepEqual(s.threads.get("101").applied_tags, ["33"]);
  const updates = s.requests.filter(
    (request) => request.method === "PATCH" && request.body.applied_tags,
  );
  assert.ok(updates.length >= 2);
  assert.ok(updates.every((request) => !Object.hasOwn(request.body, "name")));
  assert.ok(
    s.store.get("discord-todo-rate", "PATCH /channels/100").until > Date.now(),
  );
  const count = s.requests.filter(
    (request) => request.method === "PATCH" && request.path.endsWith("/100"),
  ).length;
  await assert.rejects(s.sync.sync(), /waiting for its rate limit/);
  assert.equal(
    s.requests.filter(
      (request) => request.method === "PATCH" && request.path.endsWith("/100"),
    ).length,
    count,
  );
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
  assert.equal(s.messages.size, 5);
  assert.ok(
    [...s.messages.values()]
      .filter((m) => m.webhook_id)
      .every((m) => m.content.length <= 2000 && m.embeds.length === 0),
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
