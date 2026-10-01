import apiClient from "@hcengineering/api-client";

const issueClass = "tracker:class:Issue";
const projectClass = "tracker:class:Project";
const sourceLabel = "embedded:embedded:Discord post";
const statusNames = {
  pending: "Pending",
  "in progress": "In Progress",
  "awaiting verification": "Awaiting Verification",
  complete: "Completed",
  completed: "Completed",
  "vetoed/not possible": "Impossible / Void",
  "impossible/void": "Impossible / Void",
};

export function discordTodoSync(
  config,
  store,
  huly,
  { fetcher = fetch, openClient = apiClient.createRestTxOperations } = {},
) {
  let timer;
  let active;
  let closed = false;

  async function discordJson(path) {
    const response = await fetcher(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${config.discordBotToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(
        `Discord to-do request failed with HTTP ${response.status}`,
      );
    return response.json();
  }

  async function sourceThreads() {
    const forums = new Map(
      config.todoForums.map((forum) => [forum.channelId, forum]),
    );
    const activeThreads = await discordJson(
      `/guilds/${config.guildId}/threads/active`,
    );
    if (!Array.isArray(activeThreads.threads))
      throw new Error("Discord active threads response is invalid");
    const threads = new Map(
      activeThreads.threads
        .filter((thread) => forums.has(thread.parent_id))
        .map((thread) => [thread.id, thread]),
    );
    const tags = new Map();
    for (const forum of config.todoForums) {
      const channel = await discordJson(`/channels/${forum.channelId}`);
      if (channel.type !== 15 || !Array.isArray(channel.available_tags))
        throw new Error("Configured Discord to-do channel is not a forum");
      tags.set(
        forum.channelId,
        new Map(channel.available_tags.map((tag) => [tag.id, tag.name])),
      );
      let before;
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ limit: "100" });
        if (before) query.set("before", before);
        const archived = await discordJson(
          `/channels/${forum.channelId}/threads/archived/public?${query}`,
        );
        if (!Array.isArray(archived.threads))
          throw new Error("Discord archived threads response is invalid");
        for (const thread of archived.threads) threads.set(thread.id, thread);
        if (!archived.has_more) break;
        before = archived.threads.at(-1)?.thread_metadata?.archive_timestamp;
        if (!before || page === 19)
          throw new Error("Discord archived thread listing was incomplete");
      }
    }
    return { tags, threads: [...threads.values()] };
  }

  function sourceStatus(thread, tags) {
    const names = (thread.applied_tags ?? [])
      .map((id) => tags.get(id)?.toLowerCase())
      .filter((name) => statusNames[name] !== undefined);
    if (names.length > 1) return undefined;
    return names[0] ?? "pending";
  }

  async function reconcile() {
    const { tags, threads } = await sourceThreads();
    const client = await openClient(
      "http://transactor:3333",
      config.hulyWorkspace,
      huly.serviceToken(),
    );
    try {
      const attributes = await client.findAll("core:class:Attribute", {
        label: sourceLabel,
      });
      if (attributes.length !== 1)
        throw new Error("Huly Discord post field is missing or ambiguous");
      const sourceField = attributes[0];
      const statuses = await client.findAll("tracker:class:IssueStatus", {});
      const statusByName = new Map(
        statuses.map((status) => [status.name, status._id]),
      );
      for (const name of Object.values(statusNames))
        if (!statusByName.has(name))
          throw new Error(`Huly issue status ${name} is missing`);
      const projects = new Map();
      for (const forum of config.todoForums) {
        const project = await client.findOne(projectClass, {
          _id: forum.projectId,
        });
        if (!project) throw new Error("Configured Huly project is missing");
        projects.set(forum.channelId, project);
      }
      for (const thread of threads) {
        const project = projects.get(thread.parent_id);
        const statusKey = sourceStatus(thread, tags.get(thread.parent_id));
        const url = `https://discord.com/channels/${config.guildId}/${thread.id}`;
        const record = store.get("discord-todo", thread.id);
        let issue = record?.issueId
          ? await client.findOne(issueClass, { _id: record.issueId })
          : undefined;
        if (!issue) {
          const matches = await client.findAll(issueClass, {
            [`${sourceField.attributeOf}.${sourceField.name}`]: url,
          });
          if (matches.length > 1)
            throw new Error("More than one Huly issue links to a Discord post");
          issue = matches[0];
        }
        if (!issue) {
          const issueId = `drakora:discord:${thread.id}`;
          issue = await client.findOne(issueClass, { _id: issueId });
          if (!issue) {
            const result = await client.updateDoc(
              projectClass,
              "core:space:Space",
              project._id,
              { $inc: { sequence: 1 } },
              true,
            );
            const number = result?.object?.sequence;
            if (!Number.isInteger(number))
              throw new Error("Huly did not return a project issue number");
            await client.addCollection(
              issueClass,
              project._id,
              "tracker:ids:NoParent",
              issueClass,
              "subIssues",
              {
                title: thread.name,
                description: null,
                assignee: null,
                component: null,
                milestone: null,
                number,
                status: statusByName.get(statusNames[statusKey ?? "pending"]),
                priority: 0,
                rank: "",
                comments: 0,
                subIssues: 0,
                dueDate: null,
                parents: [],
                reportedTime: 0,
                remainingTime: 0,
                estimation: 0,
                reports: 0,
                relations: [],
                childInfo: [],
                kind: "tracker:taskTypes:Issue",
                identifier: `${project.identifier}-${number}`,
              },
              issueId,
            );
            issue = await client.findOne(issueClass, { _id: issueId });
            if (!issue) throw new Error("Huly did not create the issue");
          }
        }
        if (issue[sourceField.attributeOf]?.[sourceField.name] !== url)
          await client.createMixin(
            issue._id,
            issue._class,
            issue.space,
            sourceField.attributeOf,
            { [sourceField.name]: url },
          );
        if (record?.issueId === issue._id) {
          const updates = {};
          if (record.title !== thread.name) updates.title = thread.name;
          if (statusKey && record.statusKey !== statusKey)
            updates.status = statusByName.get(statusNames[statusKey]);
          if (Object.keys(updates).length)
            await client.updateDoc(issueClass, issue.space, issue._id, updates);
        }
        store.set(
          "discord-todo",
          thread.id,
          { issueId: issue._id, title: thread.name, statusKey },
          Number.MAX_SAFE_INTEGER,
        );
      }
    } finally {
      await client.close();
    }
  }

  function sync() {
    if (closed) return Promise.resolve();
    if (!active) active = reconcile().finally(() => (active = undefined));
    return active;
  }

  function start() {
    const run = () =>
      void sync().catch((error) =>
        console.error("Discord to-do synchronization failed:", error.message),
      );
    run();
    timer = setInterval(run, 300000);
    timer.unref();
  }

  async function close() {
    closed = true;
    clearInterval(timer);
    await active?.catch(() => {});
  }

  return { sync, start, close };
}
