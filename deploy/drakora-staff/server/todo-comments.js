import { createHash } from "node:crypto";

const commentClass = "chunter:class:ChatMessage";
const expiry = Number.MAX_SAFE_INTEGER;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const marker = (id) => `Tracker comment ${id}`;

export function discordText(
  value,
  exclusions = [],
  fallback = "Staff update. Open Tracker for details.",
) {
  if (!exclusions.length) return value;
  const pattern = exclusions
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`\\b(?:${pattern})\\b`, "i").test(value) ? fallback : value;
}

export function commentMarkup(text) {
  return JSON.stringify({
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  });
}

export function commentText(markup) {
  if (!markup) return "";
  const render = (node) => {
    if (node.type === "text") {
      let text = node.text ?? "";
      for (const mark of node.marks ?? []) {
        if (mark.type === "bold") text = `**${text}**`;
        if (mark.type === "italic") text = `*${text}*`;
        if (mark.type === "strike") text = `~~${text}~~`;
        if (mark.type === "code") text = `\`${text}\``;
        if (mark.type === "link") text = `[${text}](${mark.attrs?.href ?? ""})`;
      }
      return text;
    }
    if (node.type === "hardBreak") return "\n";
    if (node.type === "reference") return node.attrs?.label ?? "";
    if (node.type === "image") return node.attrs?.src ?? "";
    const text = (node.content ?? []).map(render).join("");
    if (node.type === "listItem") return `• ${text}`;
    if (node.type === "codeBlock") return `\`\`\`\n${text}\n\`\`\`\n`;
    if (["paragraph", "heading", "blockquote"].includes(node.type))
      return `${text}\n`;
    return text;
  };
  return render(JSON.parse(markup)).trim();
}

export async function trackerDocs(client, cls, query) {
  const docs = [];
  const seen = new Set();
  for (let offset = 0; offset < 100000;) {
    const page = await client.findAll(cls, query, {
      limit: 1000,
      skip: offset,
      sort: { _id: 1 },
    });
    for (const doc of page) {
      if (seen.has(doc._id))
        throw new Error("Tracker document pagination repeated a page");
      seen.add(doc._id);
    }
    docs.push(...page);
    const total =
      Number.isInteger(page.total) && page.total >= 0 ? page.total : undefined;
    if (total !== undefined ? docs.length >= total : page.length < 1000)
      return docs;
    if (!page.length)
      throw new Error("Tracker document listing was incomplete");
    offset += page.length;
  }
  throw new Error("Tracker document listing was incomplete");
}

export async function syncComments({
  client,
  authorClient,
  issue,
  thread,
  discord,
  botId,
  store,
  identities,
  webhooks,
  profile,
  textExclusions = [],
}) {
  const messages = [];
  let before;
  for (let page = 0; page < 1000; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    const batch = await discord(`/channels/${thread.id}/messages?${query}`);
    if (!Array.isArray(batch))
      throw new Error("Discord message listing is invalid");
    messages.push(...batch);
    if (batch.length < 100) break;
    const next = batch.at(-1)?.id;
    if (!next || next === before || page === 999)
      throw new Error("Discord message listing was incomplete");
    before = next;
  }
  const comments = await trackerDocs(client, commentClass, {
    attachedTo: issue._id,
  });
  const byMessage = new Map(messages.map((message) => [message.id, message]));
  const byComment = new Map(comments.map((comment) => [comment._id, comment]));
  const state = store.get("discord-todo-comments", thread.id) ?? { pairs: {} };
  const save = () =>
    store.set("discord-todo-comments", thread.id, state, expiry);
  const removeComment = (comment) =>
    client.removeCollection(
      comment._class,
      comment.space,
      comment._id,
      issue._id,
      issue._class,
      "comments",
    );
  const removeMessage = (id) =>
    discord(`/channels/${thread.id}/messages/${id}`, {
      method: "DELETE",
      missingCode: 10008,
    });
  const used = new Set();
  const managedHooks = new Set(
    store.entries("discord-todo-webhooks").map(([, hook]) => hook.id),
  );
  for (const pair of Object.values(state.pairs)) {
    if (!pair.pending) continue;
    const { part, webhookId, after } = pair.pending;
    const sent = messages
      .filter(
        (message) =>
          message.webhook_id === webhookId &&
          BigInt(message.id) > BigInt(after),
      )
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))[0];
    if (sent) {
      pair.messageIds[part] = sent.id;
      (pair.webhookIds ??= [])[part] = webhookId;
      state.lastSentId = sent.id;
    }
    delete pair.pending;
    save();
  }
  for (const message of messages) {
    if (message.author?.id !== botId) continue;
    const match = /^Tracker comment (.+) part (\d+)$/.exec(
      message.embeds?.[0]?.footer?.text ?? "",
    );
    if (!match) continue;
    const index = Number(match[2]) - 1;
    if (index < 0 || index >= 10000) continue;
    const pair = (state.pairs[match[1]] ??= {
      direction: "huly",
      messageIds: [],
    });
    pair.messageIds[index] ??= message.id;
  }
  for (const [id, pair] of Object.entries(state.pairs)) {
    if (pair.direction === "huly" || pair.deleted)
      for (const messageId of pair.messageIds) used.add(messageId);
    if (pair.deleted) continue;
    if (!byComment.has(id)) {
      const existing = await client.findOne(commentClass, { _id: id });
      if (existing) byComment.set(id, existing);
    }
    for (const messageId of pair.messageIds.filter(Boolean)) {
      if (byMessage.has(messageId)) continue;
      const existing = await discord(
        `/channels/${thread.id}/messages/${messageId}`,
        { missingCode: 10008 },
      );
      if (existing) byMessage.set(messageId, existing);
    }
    const comment = byComment.get(id);
    if (
      !comment ||
      pair.messageIds.some((messageId) => !byMessage.has(messageId))
    ) {
      // Persist the deletion before transport so retries cannot recreate a comment.
      pair.deleted = true;
      save();
    }
  }
  for (const [id, pair] of Object.entries(state.pairs)) {
    if (!pair.deleted) continue;
    const comment = byComment.get(id);
    if (comment) await removeComment(comment);
    for (const messageId of pair.messageIds)
      if (messageId && byMessage.has(messageId)) await removeMessage(messageId);
    byComment.delete(id);
  }
  for (const message of messages.toReversed()) {
    if (message.id === thread.id || used.has(message.id)) continue;
    if (message.author?.id === botId || managedHooks.has(message.webhook_id))
      continue;
    if (![0, 19].includes(message.type)) continue;
    const text = [
      message.content,
      ...(message.attachments ?? []).map((attachment) => attachment.url),
    ]
      .filter(Boolean)
      .join("\n");
    if (!text) continue;
    const id = `drakora:discord-comment:${message.id}`;
    const pair = state.pairs[id];
    if (pair?.deleted) continue;
    const person = identities.byDiscord.get(message.author?.id);
    const linked = person?.account && person.socialId;
    const attributed = linked
      ? text
      : `${person?.name ?? message.author?.global_name ?? message.author?.username ?? "Discord member"} (Discord)\n\n${text}`;
    const markup = commentMarkup(attributed);
    if (!byComment.has(id)) {
      const author = await authorClient(person);
      await author.addCollection(
        commentClass,
        issue.space,
        issue._id,
        issue._class,
        "comments",
        { message: markup, attachments: 0 },
        id,
        Date.parse(message.timestamp),
        linked ? person.socialId : undefined,
      );
    } else if (byComment.get(id).message !== markup) {
      const author = await authorClient(person);
      await author.updateDoc(commentClass, issue.space, id, {
        message: markup,
        editedOn: Date.now(),
      });
    }
    state.pairs[id] = { direction: "discord", messageIds: [message.id] };
    save();
  }
  for (const comment of comments) {
    const pair = state.pairs[comment._id];
    if (pair?.deleted || pair?.direction === "discord") continue;
    const text = discordText(
      commentText(comment.message) || "(Empty comment)",
      textExclusions,
    );
    let person = identities.bySocial.get(
      comment.createdBy ?? comment.modifiedBy,
    );
    let author = discordText(
      person?.name ?? "Staff member",
      textExclusions,
      "Staff member",
    );
    const next = pair ?? { direction: "huly", messageIds: [] };
    const legacy =
      next.format === "bot" ||
      next.messageIds.some(
        (id) =>
          byMessage.get(id)?.author?.id === botId &&
          !byMessage.get(id)?.webhook_id,
      );
    next.format = legacy ? "bot" : "webhook";
    const fingerprint = legacy ? hash(`${author}\n${text}`) : hash(text);
    if (!legacy && next.hash !== fingerprint) {
      person = await profile(person);
      author = discordText(
        person?.name ?? "Staff member",
        textExclusions,
        "Staff member",
      );
    }
    const chunkSize = legacy ? 3800 : 2000;
    const chunks = Array.from(
      { length: Math.ceil(text.length / chunkSize) },
      (_, i) => text.slice(i * chunkSize, (i + 1) * chunkSize),
    );
    for (let i = 0; i < chunks.length; i++) {
      const footer = `${marker(comment._id)} part ${i + 1}`;
      let id =
        next.messageIds[i] ??
        messages.find(
          (message) =>
            message.author?.id === botId &&
            message.embeds?.[0]?.footer?.text === footer,
        )?.id;
      const body = legacy
        ? {
            embeds: [
              {
                author: { name: `${author} · Tracker`.slice(0, 256) },
                description: chunks[i],
                color: 0x5865f2,
                footer: { text: footer },
                ...(comment.createdOn
                  ? { timestamp: new Date(comment.createdOn).toISOString() }
                  : {}),
              },
            ],
            allowed_mentions: { parse: [] },
          }
        : { content: chunks[i], embeds: [], allowed_mentions: { parse: [] } };
      if (!id) {
        let posted;
        if (legacy)
          posted = await discord(`/channels/${thread.id}/messages`, {
            method: "POST",
            body: {
              ...body,
              nonce: hash(`${comment._id}:${i}`).slice(0, 25),
              enforce_nonce: true,
            },
          });
        else {
          const hook = await webhooks.hook(thread.parent_id);
          const after =
            [state.lastSentId, ...messages.map((message) => message.id)]
              .filter(Boolean)
              .sort((a, b) => (BigInt(a) > BigInt(b) ? -1 : 1))[0] || "0";
          next.pending = { part: i, webhookId: hook.id, after };
          state.pairs[comment._id] = next;
          save();
          posted = await webhooks.request(
            thread,
            hook,
            undefined,
            {
              ...body,
              username: /discord|clyde/i.test(author)
                ? "Staff member"
                : Array.from(author).slice(0, 80).join(""),
              ...(person?.avatar && author !== "Staff member"
                ? { avatar_url: person.avatar }
                : {}),
            },
            discord,
          );
          (next.webhookIds ??= [])[i] = hook.id;
          state.lastSentId = posted.id;
          delete next.pending;
        }
        id = posted.id;
      } else if (next.hash !== fingerprint) {
        if (legacy)
          await discord(`/channels/${thread.id}/messages/${id}`, {
            method: "PATCH",
            body,
          });
        else {
          const hook = await webhooks.hook(
            thread.parent_id,
            next.webhookIds?.[i] || byMessage.get(id)?.webhook_id,
          );
          await webhooks.request(thread, hook, id, body, discord);
        }
      }
      next.messageIds[i] = id;
      state.pairs[comment._id] = next;
      save();
    }
    for (const id of next.messageIds.slice(chunks.length))
      await removeMessage(id);
    next.messageIds.length = chunks.length;
    next.hash = fingerprint;
    save();
  }
}
