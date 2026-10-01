import test from "node:test";
import assert from "node:assert/strict";
import { discordTodoSync } from "../server/todo-sync.js";

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

function fixture() {
  const thread = {
    id: "100",
    parent_id: "20",
    name: "Update staff information",
    applied_tags: [],
  };
  const forum = {
    id: "20",
    type: 15,
    available_tags: [
      { id: "30", name: "In Progress" },
      { id: "31", name: "Complete" },
    ],
  };
  const project = { _id: "dev", identifier: "DEV", sequence: 0 };
  const issues = [];
  const records = new Map();
  const writes = [];
  let active = [thread];
  let archived = [];
  const config = {
    guildId: "1",
    discordBotToken: "fixture-token",
    hulyWorkspace: "workspace",
    todoForums: [{ channelId: "20", projectId: "dev" }],
  };
  const store = {
    get: (kind, id) => records.get(`${kind}:${id}`),
    set: (kind, id, value) => records.set(`${kind}:${id}`, value),
  };
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    const body = path.endsWith("/threads/active")
      ? { threads: active }
      : path.endsWith("/threads/archived/public")
        ? { threads: archived, has_more: false }
        : path.endsWith("/channels/20")
          ? forum
          : undefined;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  };
  const client = {
    async findAll(cls, query) {
      if (cls === "core:class:Attribute") return [sourceField];
      if (cls === "tracker:class:IssueStatus") return statuses;
      if (cls === "tracker:class:Issue") {
        const url = Object.values(query)[0];
        return issues.filter(
          (issue) => issue[sourceField.attributeOf]?.[sourceField.name] === url,
        );
      }
      throw new Error(`Unexpected class ${cls}`);
    },
    async findOne(cls, query) {
      if (cls === "tracker:class:Project")
        return query._id === project._id ? project : undefined;
      if (cls === "tracker:class:Issue")
        return issues.find((issue) => issue._id === query._id);
      throw new Error(`Unexpected class ${cls}`);
    },
    async updateDoc(cls, _space, id, update) {
      if (cls === "tracker:class:Project") {
        assert.equal(id, project._id);
        project.sequence += update.$inc.sequence;
        return { object: { sequence: project.sequence } };
      }
      const issue = issues.find((item) => item._id === id);
      assert.ok(issue);
      Object.assign(issue, update);
      writes.push({ id, update });
    },
    async addCollection(
      cls,
      space,
      _parent,
      _parentClass,
      _collection,
      data,
      id,
    ) {
      assert.equal(cls, "tracker:class:Issue");
      issues.push({ ...data, _id: id, _class: cls, space });
    },
    async createMixin(id, _class, _space, mixin, data) {
      const issue = issues.find((item) => item._id === id);
      assert.ok(issue);
      issue[mixin] = { ...issue[mixin], ...data };
    },
    async close() {},
  };
  const sync = discordTodoSync(
    config,
    store,
    { serviceToken: () => "token" },
    {
      fetcher,
      openClient: async () => client,
    },
  );
  return {
    sync,
    thread,
    issues,
    project,
    writes,
    setActive: (value) => (active = value),
    setArchived: (value) => (archived = value),
  };
}

test("forum posts create one linked Huly issue and remain linked after archive", async () => {
  const state = fixture();
  await state.sync.sync();
  assert.equal(state.issues.length, 1);
  assert.equal(state.issues[0].identifier, "DEV-1");
  assert.equal(state.issues[0].status, "pending");
  assert.equal(
    state.issues[0][sourceField.attributeOf][sourceField.name],
    "https://discord.com/channels/1/100",
  );
  state.setActive([]);
  state.setArchived([state.thread]);
  await state.sync.sync();
  assert.equal(state.issues.length, 1);
  assert.equal(state.project.sequence, 1);
  assert.deepEqual(state.writes, []);
});

test("existing linked issues keep Huly edits until the Discord post changes", async () => {
  const state = fixture();
  state.issues.push({
    _id: "existing",
    _class: "tracker:class:Issue",
    space: "dev",
    title: "Edited in Huly",
    status: "verification",
    [sourceField.attributeOf]: {
      [sourceField.name]: "https://discord.com/channels/1/100",
    },
  });
  await state.sync.sync();
  assert.equal(state.issues[0].title, "Edited in Huly");
  assert.equal(state.issues[0].status, "verification");
  state.thread.name = "Updated in Discord";
  state.thread.applied_tags = ["30"];
  await state.sync.sync();
  assert.equal(state.issues[0].title, "Updated in Discord");
  assert.equal(state.issues[0].status, "active");
  assert.equal(state.issues.length, 1);
  assert.equal(state.project.sequence, 0);
});
