import apiClient from "@hcengineering/api-client";
import { discordText, syncComments, trackerDocs } from "./todo-comments.js";
import { trackerEvents } from "./todo-events.js";
import { trackerWebhooks } from "./todo-webhooks.js";
import { discordAvatar } from "./avatar.js";

const issueClass = "tracker:class:Issue";
const projectClass = "tracker:class:Project";
const tagClass = "tags:class:TagElement";
const tagReferenceClass = "tags:class:TagReference";
const priorityLabels = [undefined, "URGENT", "HIGH", "MEDIUM", "LOW"];
const sourceLabel = "embedded:embedded:Discord post";
const expiry = Number.MAX_SAFE_INTEGER;
const statusNames = {
  pending: "Pending",
  "in progress": "In Progress",
  "awaiting verification": "Awaiting Verification",
  complete: "Completed",
  completed: "Completed",
  "vetoed/not possible": "Impossible / Void",
  "impossible/void": "Impossible / Void",
};
const tagNames = {
  Pending: "Pending",
  "In Progress": "In Progress",
  "Awaiting Verification": "Awaiting Verification",
  Completed: "Complete",
  "Impossible / Void": "Vetoed/Not Possible",
};
const normalize = (name) =>
  String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
const aliases = (name) => {
  const value = normalize(name)
    .replace(/[^\p{L}\p{N}_ ,.-]/gu, "")
    .trim();
  return [value, ...value.split(/[\s_,.]+/)].filter(Boolean);
};
const starterMarker = (id) => `Tracker issue ${id}`;

export function discordTodoSync(
  config,
  store,
  huly,
  {
    fetcher = fetch,
    openClient = apiClient.createRestTxOperations,
    watchTracker = trackerEvents,
  } = {},
) {
  let timer;
  let wakeTimer;
  let active;
  let watcher;
  let pending = false;
  let rateTimer;
  const rateLimits = new Map(
    store
      .entries("discord-todo-rate")
      .map(([key, record]) => [key, record.until]),
  );
  let closed = false;
  let botId;
  let webhooks;
  const publicText = (value, fallback) =>
    discordText(value, config.todoPublicTextExclusions, fallback);

  function displayTitle(title, issue, voidIssues) {
    const labels = [
      ...(voidIssues.has(issue._id) ? ["VOID"] : []),
      ...(priorityLabels[issue.priority]
        ? [priorityLabels[issue.priority]]
        : []),
    ];
    const prefix = labels.map((label) => `[${label}] `).join("");
    return {
      title,
      prefix,
      name:
        prefix +
        Array.from(publicText(title))
          .slice(0, 100 - prefix.length)
          .join(""),
    };
  }

  function sourceTitle(thread, saved) {
    const displays = [saved?.current, saved?.previous].filter(Boolean);
    const exact = displays.find((display) => display.name === thread.name);
    if (exact) return exact.title;
    const decorated = displays.find(
      (display) => display.prefix && thread.name.startsWith(display.prefix),
    );
    return decorated ? thread.name.slice(decorated.prefix.length) : thread.name;
  }

  function prepareTitle(thread, display, saved, title) {
    if (
      saved?.current?.name === display.name &&
      saved.current.title === display.title
    )
      return;
    const displays = [saved?.current, saved?.previous].filter(Boolean);
    const observed =
      displays.find((candidate) => candidate.name === thread.name) ??
      displays.find(
        (candidate) =>
          candidate.prefix && thread.name.startsWith(candidate.prefix),
      );
    store.set(
      "discord-todo-title",
      thread.id,
      {
        current: display,
        previous: { name: thread.name, prefix: observed?.prefix ?? "", title },
      },
      expiry,
    );
  }

  async function discord(path, { method = "GET", body, missingCode } = {}) {
    const route = `${method} ${path
      .split("?")[0]
      .replace(/(\/webhooks\/\d+)\/[^/]+/, "$1/:token")
      .replace(/\/messages\/\d+$/, "/messages/:id")}`;
    if (
      Date.now() <
      Math.max(rateLimits.get("*") ?? 0, rateLimits.get(route) ?? 0)
    )
      throw new Error(
        "Discord to-do synchronization is waiting for its rate limit",
      );
    const response = await fetcher(`https://discord.com/api/v10${path}`, {
      method,
      headers: {
        ...(!/^\/webhooks\/\d+\/[^/]+/.test(path)
          ? { Authorization: `Bot ${config.discordBotToken}` }
          : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 204) return undefined;
    const data = await response.json();
    if (response.status === 429) {
      const seconds = Number(data.retry_after);
      const delay = seconds * 1000;
      const until =
        Date.now() +
        (Number.isFinite(delay) && delay > 0 && delay <= 2147483647
          ? delay
          : 30000);
      const key = data.global === true ? "*" : route;
      rateLimits.set(key, until);
      store.set("discord-todo-rate", key, { until }, until);
      scheduleRateRetry();
    }
    if (response.status === 404 && missingCode && data.code === missingCode)
      return undefined;
    if (!response.ok)
      throw Object.assign(
        new Error(
          `Discord to-do ${method} failed with HTTP ${response.status}${Number.isInteger(data.code) ? `, code ${data.code}` : ""}`,
        ),
        { code: data.code },
      );
    return data;
  }

  async function withThread(thread, action) {
    let restore = store.get("discord-todo-archive", thread.id);
    const threadDiscord = async (path, options = {}) => {
      if (
        ["POST", "PATCH"].includes(options.method) &&
        (path === `/channels/${thread.id}` ||
          path.startsWith(`/channels/${thread.id}/messages`) ||
          (path.startsWith("/webhooks/") &&
            new URL(`https://discord.invalid${path}`).searchParams.get(
              "thread_id",
            ) === thread.id))
      ) {
        const current = await discord(`/channels/${thread.id}`);
        if (current.thread_metadata?.archived) {
          store.set("discord-todo-archive", thread.id, true, expiry);
          restore = true;
          await discord(`/channels/${thread.id}`, {
            method: "PATCH",
            body: { archived: false },
          });
        }
      }
      return discord(path, options);
    };
    try {
      return await action(threadDiscord);
    } finally {
      if (restore) {
        const current = await discord(`/channels/${thread.id}`, {
          missingCode: 10003,
        });
        if (current && !current.thread_metadata?.archived)
          await discord(`/channels/${thread.id}`, {
            method: "PATCH",
            body: { archived: true },
            missingCode: 10003,
          });
        store.delete("discord-todo-archive", thread.id);
      }
    }
  }

  async function sourceThreads() {
    const forums = new Map(
      config.todoForums.map((forum) => [forum.channelId, forum]),
    );
    const activeThreads = await discord(
      `/guilds/${config.guildId}/threads/active`,
    );
    if (!Array.isArray(activeThreads.threads))
      throw new Error("Discord active threads response is invalid");
    const threads = new Map(
      activeThreads.threads
        .filter((thread) => forums.has(thread.parent_id))
        .map((thread) => [thread.id, thread]),
    );
    const channels = new Map();
    for (const forum of config.todoForums) {
      const channel = await discord(`/channels/${forum.channelId}`);
      if (channel.type !== 15 || !Array.isArray(channel.available_tags))
        throw new Error("Configured Discord to-do channel is not a forum");
      channels.set(forum.channelId, channel);
      let before;
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ limit: "100" });
        if (before) query.set("before", before);
        const archived = await discord(
          `/channels/${forum.channelId}/threads/archived/public?${query}`,
        );
        if (!Array.isArray(archived.threads))
          throw new Error("Discord archived threads response is invalid");
        for (const thread of archived.threads) threads.set(thread.id, thread);
        if (!archived.has_more) break;
        const next =
          archived.threads.at(-1)?.thread_metadata?.archive_timestamp;
        if (!next || next === before || page === 99)
          throw new Error("Discord archived thread listing was incomplete");
        before = next;
      }
    }
    return { channels, threads };
  }

  async function identities(client) {
    const people = await trackerDocs(client, "contact:class:Person", {});
    const social = await trackerDocs(
      client,
      "contact:class:SocialIdentity",
      {},
    );
    const users = store.entries("user").map(([, user]) => user);
    const byDiscord = new Map();
    const bySocial = new Map();
    for (const person of people) {
      const user = users.find(
        (entry) => entry.hulyAccount === person.personUuid,
      );
      const identity = social.find(
        (entry) =>
          entry.attachedTo === person._id &&
          entry.type === "oidc" &&
          entry.value?.startsWith("discord:"),
      );
      const id = identity?.value.slice(8) ?? user?.id;
      const info = {
        personId: person._id,
        name:
          user?.name ?? person.name.split(",").toReversed().join(" ").trim(),
        discordId: id,
        avatar: user?.avatar,
        socialId: identity?._id,
        account: identity ? person.personUuid : undefined,
        names: [person.name, user?.name, user?.username].flatMap(aliases),
      };
      if (id) byDiscord.set(id, info);
      for (const entry of social.filter(
        (entry) => entry.attachedTo === person._id,
      ))
        bySocial.set(entry._id, info);
    }
    const byPerson = new Map(
      [...byDiscord.values()].map((person) => [person.personId, person]),
    );
    return { byDiscord, byPerson, bySocial };
  }

  function assigneeTags(forum, channel, people) {
    const saved = store.get("discord-todo-tags", forum.channelId) ?? {};
    const mapping = new Map();
    for (const tag of channel.available_tags) {
      if (statusNames[normalize(tag.name)]) continue;
      const id = forum.assigneeTags?.[tag.id] ?? saved[tag.id];
      let person = people.byDiscord.get(id);
      if (!person && !id && tag.moderated) {
        const matches = [...people.byDiscord.values()].filter((entry) =>
          entry.names.includes(normalize(tag.name)),
        );
        if (matches.length === 1) person = matches[0];
      }
      if (person) {
        mapping.set(tag.id, person);
        saved[tag.id] = person.discordId;
      }
    }
    store.set("discord-todo-tags", forum.channelId, saved, expiry);
    return mapping;
  }

  function sourceValues(thread, channel, mapping) {
    const selected = (thread.applied_tags ?? []).map((id) =>
      channel.available_tags.find((tag) => tag.id === id),
    );
    const status = selected
      .map((tag) => statusNames[normalize(tag?.name)])
      .filter(Boolean);
    const assignees = [
      ...new Set(
        (thread.applied_tags ?? [])
          .map((id) => mapping.get(id)?.personId)
          .filter(Boolean),
      ),
    ];
    return {
      title: thread.name,
      status: status.length > 1 ? undefined : (status[0] ?? "Pending"),
      assignee: assignees.length > 1 ? undefined : (assignees[0] ?? null),
    };
  }

  async function tagForStatus(channel, name) {
    let tag = channel.available_tags.find(
      (tag) => statusNames[normalize(tag.name)] === name,
    );
    if (!tag && name !== "Pending") {
      if (!tagNames[name] || channel.available_tags.length >= 20)
        throw new Error("Discord forum cannot represent this Tracker status");
      const updated = await discord(`/channels/${channel.id}`, {
        method: "PATCH",
        body: {
          available_tags: [...channel.available_tags, { name: tagNames[name] }],
        },
      });
      channel.available_tags = updated.available_tags;
      tag = channel.available_tags.find(
        (tag) => statusNames[normalize(tag.name)] === name,
      );
      if (!tag) throw new Error("Discord did not create the workflow tag");
    }
    return tag?.id;
  }

  async function tagsForValues(thread, channel, mapping, values, people) {
    const workflowIds = new Set(
      channel.available_tags
        .filter((tag) => statusNames[normalize(tag.name)])
        .map((tag) => tag.id),
    );
    let tags = (thread.applied_tags ?? []).filter(
      (id) => !workflowIds.has(id) && !mapping.has(id),
    );
    const statusId = await tagForStatus(channel, values.status);
    if (statusId) tags.push(statusId);
    if (values.assignee) {
      let assigneeId = [...mapping].find(
        ([, person]) => person.personId === values.assignee,
      )?.[0];
      if (!assigneeId) {
        const person = people.byPerson.get(values.assignee);
        if (!person || channel.available_tags.length >= 20)
          throw new Error(
            "Tracker assignee has no linked Discord identity or available forum tag",
          );
        const updated = await discord(`/channels/${channel.id}`, {
          method: "PATCH",
          body: {
            available_tags: [
              ...channel.available_tags,
              {
                name: publicText(person.name, "Staff member").slice(0, 20),
                moderated: true,
              },
            ],
          },
        });
        const created = updated.available_tags.filter(
          (tag) => !channel.available_tags.some((old) => old.id === tag.id),
        );
        if (created.length !== 1)
          throw new Error("Discord did not create the assignee tag");
        channel.available_tags = updated.available_tags;
        assigneeId = created[0].id;
        mapping.set(assigneeId, person);
        const saved = store.get("discord-todo-tags", channel.id) ?? {};
        saved[assigneeId] = person.discordId;
        store.set("discord-todo-tags", channel.id, saved, expiry);
      }
      tags.push(assigneeId);
    }
    tags = [...new Set(tags)];
    if (tags.length > 5)
      throw new Error("Discord forum post would exceed five tags");
    return tags;
  }

  async function createIssue(client, project, thread, values, statusByName) {
    const issueId = `drakora:discord:${thread.id}`;
    let issue = await client.findOne(issueClass, { _id: issueId });
    if (issue) return issue;
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
        assignee: values.assignee ?? null,
        component: null,
        milestone: null,
        number,
        status: statusByName.get(values.status ?? "Pending"),
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
    return issue;
  }

  async function deleteLinked(client, threadId, record, issue, thread) {
    record.deleted = true;
    store.set("discord-todo", threadId, record, expiry);
    store.set("huly-todo", record.issueId, { threadId, deleted: true }, expiry);
    if (thread)
      await discord(`/channels/${threadId}`, {
        method: "DELETE",
        missingCode: 10003,
      });
    store.delete("discord-todo-archive", threadId);
    store.delete("discord-todo-title", threadId);
    if (issue)
      await client.removeCollection(
        issue._class,
        issue.space,
        issue._id,
        issue.attachedTo ?? "tracker:ids:NoParent",
        issue.attachedToClass ?? issueClass,
        "subIssues",
      );
  }

  async function reconcile() {
    const { channels, threads } = await sourceThreads();
    botId ??= (await discord("/users/@me")).id;
    webhooks ??= trackerWebhooks(store, discord, botId);
    const client = await openClient(
      "http://transactor:3333",
      config.hulyWorkspace,
      huly.serviceToken(),
    );
    const failures = [];
    const authorClients = new Map();
    const profiles = new Map();
    const profile = async (person) => {
      if (!person?.discordId || person.avatar) return person;
      if (!profiles.has(person.discordId)) {
        const member = await discord(
          `/guilds/${config.guildId}/members/${person.discordId}`,
          { missingCode: 10007 },
        );
        profiles.set(
          person.discordId,
          member?.user
            ? {
                ...person,
                name:
                  member.nick ||
                  member.user.global_name ||
                  member.user.username,
                avatar: discordAvatar(
                  member.user,
                  config.guildId,
                  member.avatar,
                ),
              }
            : person,
        );
      }
      return profiles.get(person.discordId);
    };
    const authorClient = async (person) => {
      if (!person?.account || !person.socialId) return client;
      if (!authorClients.has(person.account)) {
        const author = await openClient(
          "http://transactor:3333",
          config.hulyWorkspace,
          huly.serviceToken(person.account),
        );
        authorClients.set(person.account, author);
      }
      return authorClients.get(person.account);
    };
    const attempt = async (action) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    try {
      const attributes = await client.findAll("core:class:Attribute", {
        label: sourceLabel,
      });
      if (attributes.length !== 1)
        throw new Error("Huly Discord post field is missing or ambiguous");
      const field = attributes[0];
      const path = `${field.attributeOf}.${field.name}`;
      const statuses = await client.findAll("tracker:class:IssueStatus", {});
      const statusByName = new Map(
        statuses.map((status) => [status.name, status._id]),
      );
      const nameByStatus = new Map(
        statuses.map((status) => [status._id, status.name]),
      );
      for (const name of Object.values(statusNames))
        if (!statusByName.has(name))
          throw new Error(`Huly issue status ${name} is missing`);
      const people = await identities(client);
      const labelDefinitions = await trackerDocs(client, tagClass, {
        targetClass: issueClass,
      });
      const voidLabels = new Set(
        labelDefinitions
          .filter((label) => normalize(label.title) === "void")
          .map((label) => label._id),
      );
      const labelReferences = await trackerDocs(client, tagReferenceClass, {
        space: { $in: config.todoForums.map((forum) => forum.projectId) },
      });
      const voidIssues = new Set(
        labelReferences
          .filter((reference) => voidLabels.has(reference.tag))
          .map((reference) => reference.attachedTo),
      );
      const projects = new Map();
      const mappings = new Map();
      for (const forum of config.todoForums) {
        const project = await client.findOne(projectClass, {
          _id: forum.projectId,
        });
        if (!project) throw new Error("Configured Huly project is missing");
        projects.set(forum.channelId, project);
        mappings.set(
          forum.channelId,
          assigneeTags(forum, channels.get(forum.channelId), people),
        );
      }
      for (const [id, record] of store.entries("discord-todo")) {
        if (!threads.has(id))
          await attempt(async () => {
            const issue = await client.findOne(issueClass, {
              _id: record.issueId,
            });
            if (record.deleted && !issue) return;
            const channelId =
              record.forumId ??
              config.todoForums.find(
                (forum) => forum.projectId === issue?.space,
              )?.channelId;
            if (!channelId || !channels.has(channelId)) return;
            if (issue && issue.space !== projects.get(channelId)._id)
              throw new Error(
                "Linked Tracker issue moved outside its configured project",
              );
            const thread = await discord(`/channels/${id}`, {
              missingCode: 10003,
            });
            if (thread && projects.has(thread.parent_id))
              threads.set(id, thread);
            else if (!thread) await deleteLinked(client, id, record, issue);
          });
      }
      for (let thread of threads.values())
        await attempt(() =>
          withThread(thread, async (threadDiscord) => {
            const channel = channels.get(thread.parent_id);
            const project = projects.get(thread.parent_id);
            const mapping = mappings.get(thread.parent_id);
            let record = store.get("discord-todo", thread.id);
            let issue = record?.issueId
              ? await client.findOne(issueClass, { _id: record.issueId })
              : undefined;
            if (record && (record.deleted || !issue)) {
              await deleteLinked(client, thread.id, record, issue, thread);
              return;
            }
            const url = `https://discord.com/channels/${config.guildId}/${thread.id}`;
            if (!issue) {
              const matches = await client.findAll(issueClass, { [path]: url });
              if (matches.length > 1)
                throw new Error(
                  "More than one Huly issue links to a Discord post",
                );
              issue = matches[0];
              if (!issue) {
                const starter = await discord(
                  `/channels/${thread.id}/messages/${thread.id}`,
                  { missingCode: 10008 },
                );
                const footer =
                  starter?.author?.id === botId
                    ? starter.embeds?.[0]?.footer?.text
                    : undefined;
                if (footer?.startsWith("Tracker issue ")) {
                  issue = await client.findOne(issueClass, {
                    _id: footer.slice(14),
                  });
                  if (!issue)
                    throw new Error(
                      "Tracker source issue for this Discord post is missing",
                    );
                }
              }
            }
            const source = sourceValues(thread, channel, mapping);
            const titleState = store.get("discord-todo-title", thread.id);
            source.title = sourceTitle(thread, titleState);
            const imported = !issue;
            issue ??= await createIssue(
              client,
              project,
              thread,
              source,
              statusByName,
            );
            if (issue.space !== project._id)
              throw new Error(
                "Linked Tracker issue moved outside its configured project",
              );
            if (issue[field.attributeOf]?.[field.name] !== url)
              await client.createMixin(
                issue._id,
                issue._class,
                issue.space,
                field.attributeOf,
                { [field.name]: url },
              );
            const target = {
              title: issue.title,
              status: nameByStatus.get(issue.status),
              assignee: issue.assignee ?? null,
            };
            const next = {};
            const updates = {};
            for (const key of ["title", "status", "assignee"]) {
              if (source[key] === undefined || target[key] === undefined)
                throw new Error(
                  "Tracker or Discord task has an ambiguous workflow or assignee",
                );
              const legacy =
                key === "title"
                  ? record?.title
                  : key === "status"
                    ? statusNames[record?.statusKey]
                    : undefined;
              const previous = record?.discord ? record.discord[key] : legacy;
              const discordChanged =
                previous !== undefined && previous !== source[key];
              next[key] =
                imported ||
                discordChanged ||
                (!record?.discord &&
                  key === "assignee" &&
                  source.assignee !== null)
                  ? source[key]
                  : target[key];
              if (target[key] !== next[key])
                updates[key] =
                  key === "status" ? statusByName.get(next[key]) : next[key];
            }
            if (!tagNames[next.status])
              throw new Error(
                "Tracker status is not supported by the Discord forum workflow",
              );
            const tags = await tagsForValues(
              thread,
              channel,
              mapping,
              next,
              people,
            );
            const threadUpdate = {};
            const display = displayTitle(next.title, issue, voidIssues);
            if (display.name !== thread.name) {
              prepareTitle(thread, display, titleState, source.title);
              threadUpdate.name = display.name;
            }
            if (
              JSON.stringify(tags.toSorted()) !==
              JSON.stringify((thread.applied_tags ?? []).toSorted())
            )
              threadUpdate.applied_tags = tags;
            if (Object.keys(threadUpdate).length) {
              const changed = await threadDiscord(`/channels/${thread.id}`, {
                method: "PATCH",
                body: threadUpdate,
              });
              thread = { ...thread, ...changed };
            }
            if (Object.keys(updates).length)
              await client.updateDoc(
                issueClass,
                issue.space,
                issue._id,
                updates,
              );
            record = {
              issueId: issue._id,
              forumId: channel.id,
              discord: next,
            };
            store.set("discord-todo", thread.id, record, expiry);
            store.set(
              "discord-todo-title",
              thread.id,
              { current: display },
              expiry,
            );
            store.set("huly-todo", issue._id, { threadId: thread.id }, expiry);
            await syncComments({
              client,
              authorClient,
              issue,
              thread,
              discord: threadDiscord,
              botId,
              store,
              identities: people,
              webhooks,
              profile,
              textExclusions: config.todoPublicTextExclusions,
            });
          }),
        );
      const linkedIssues = new Set(
        store.entries("discord-todo").map(([, record]) => record.issueId),
      );
      for (const forum of config.todoForums) {
        const issues = await trackerDocs(client, issueClass, {
          space: forum.projectId,
        });
        for (const issue of issues)
          await attempt(async () => {
            if (
              store.get("huly-todo", issue._id) ||
              issue[field.attributeOf]?.[field.name]
            )
              return;
            if (linkedIssues.has(issue._id)) return;
            const channel = channels.get(forum.channelId);
            const values = {
              title: issue.title,
              status: nameByStatus.get(issue.status),
              assignee: issue.assignee ?? null,
            };
            if (!tagNames[values.status])
              throw new Error(
                "Tracker status is not supported by the Discord forum workflow",
              );
            const tags = await tagsForValues(
              {},
              channel,
              mappings.get(forum.channelId),
              values,
              people,
            );
            const display = displayTitle(issue.title, issue, voidIssues);
            const post = await discord(`/channels/${forum.channelId}/threads`, {
              method: "POST",
              body: {
                name: display.name,
                applied_tags: tags,
                message: {
                  embeds: [
                    {
                      title: issue.identifier,
                      description: "Track this task in the staff dashboard.",
                      url: `${config.staffOrigin}/tracker`,
                      color: 0x5865f2,
                      footer: { text: starterMarker(issue._id) },
                    },
                  ],
                  allowed_mentions: { parse: [] },
                },
              },
            });
            store.set(
              "discord-todo",
              post.id,
              {
                issueId: issue._id,
                forumId: channel.id,
                discord: values,
              },
              expiry,
            );
            store.set("huly-todo", issue._id, { threadId: post.id }, expiry);
            store.set(
              "discord-todo-title",
              post.id,
              { current: display },
              expiry,
            );
            await client.createMixin(
              issue._id,
              issue._class,
              issue.space,
              field.attributeOf,
              {
                [field.name]: `https://discord.com/channels/${config.guildId}/${post.id}`,
              },
            );
            await syncComments({
              client,
              authorClient,
              issue,
              thread: post,
              discord,
              botId,
              store,
              identities: people,
              webhooks,
              profile,
              textExclusions: config.todoPublicTextExclusions,
            });
          });
      }
      if (failures.length)
        throw new Error(
          `${failures.length} Tracker task syncs are pending. ${failures[0].message}`,
        );
    } finally {
      await Promise.all(
        [client, ...authorClients.values()].map((connection) =>
          connection.close(),
        ),
      );
    }
  }

  function sync() {
    if (closed) return Promise.resolve();
    if (!active && Date.now() < (rateLimits.get("*") ?? 0)) {
      scheduleRateRetry();
      return Promise.resolve();
    }
    if (!active) {
      pending = false;
      active = reconcile().finally(() => {
        active = undefined;
        if (pending) changed();
      });
    }
    return active;
  }
  const run = () =>
    void sync().catch((error) =>
      console.error("Discord to-do synchronization failed:", error.message),
    );
  function scheduleRateRetry() {
    clearTimeout(rateTimer);
    for (const [key, until] of rateLimits)
      if (until <= Date.now()) rateLimits.delete(key);
    const waits = [...rateLimits.values()].filter(
      (until) => until > Date.now(),
    );
    if (!closed && waits.length) {
      rateTimer = setTimeout(
        () => {
          rateTimer = undefined;
          scheduleRateRetry();
          changed();
        },
        Math.min(...waits) - Date.now(),
      );
      rateTimer.unref();
    }
  }
  function changed() {
    if (closed) return;
    pending = true;
    if (active || wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      run();
    }, 750);
    wakeTimer.unref();
  }
  function start() {
    if (closed || timer) return;
    watcher = watchTracker(config, huly, changed);
    run();
    timer = setInterval(run, 30000);
    timer.unref();
    scheduleRateRetry();
  }
  async function close() {
    closed = true;
    clearInterval(timer);
    clearTimeout(wakeTimer);
    clearTimeout(rateTimer);
    await watcher?.close();
    await active?.catch(() => {});
  }
  return { sync, changed, start, close };
}
