import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { createHash, randomUUID } from "node:crypto";
import { AuthError } from "./discord.js";
import { bridgeMailTransport } from "./bridge-mail.js";
import { validMailAddress } from "./mail-address.js";
import { hash } from "./store.js";

const bodyLimit = 1024 * 1024;
const attachmentLimit = 10 * 1024 * 1024;
const standardFolders = new Map([
  ["inbox", "\\Inbox"],
  ["sent", "\\Sent"],
  ["archive", "\\Archive"],
  ["all mail", "\\All"],
  ["starred", "\\Flagged"],
  ["drafts", "\\Drafts"],
  ["spam", "\\Junk"],
  ["trash", "\\Trash"],
]);
const invalid = () => new AuthError("invalid_mail_request", 400);
const lower = (value) => value.toLowerCase();
const addresses = (values = []) =>
  values.map(({ name, address }) => ({
    name: String(name ?? "").slice(0, 200),
    address: String(address ?? "").slice(0, 254),
  }));

export function safeMailHtml(value) {
  return sanitizeHtml(value, {
    allowedTags: [
      "p",
      "br",
      "div",
      "span",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer",
      }),
    },
  });
}

function partsOf(structure) {
  const parts = [];
  function visit(node, depth) {
    if (!node || depth > 12 || parts.length >= 100)
      throw new AuthError("mail_too_large", 413);
    if (node.childNodes?.length) {
      for (const child of node.childNodes) visit(child, depth + 1);
    } else {
      parts.push(node);
    }
  }
  visit(structure, 0);
  return parts;
}

async function boundedContent(client, uid, part, limit) {
  const download = await client.download(uid, part, {
    uid: true,
    maxBytes: limit + 1,
    chunkSize: 65536,
  });
  if (!download?.content) throw new AuthError("mail_not_found", 404);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of download.content) {
      size += chunk.length;
      if (size > limit) throw new AuthError("mail_too_large", 413);
      chunks.push(chunk);
    }
  } finally {
    download.content.destroy();
  }
  return Buffer.concat(chunks);
}

function recipients(value) {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string" || value.length > 5200) throw invalid();
  const list = value.split(/[,;]/).map((item) => item.trim());
  if (!list.every(validMailAddress)) throw invalid();
  return [...new Set(list.map(lower))];
}

export function validateMailDraft(input, identities) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalid();
  const identity = identities.find(
    (entry) => lower(entry.address) === lower(String(input.from ?? "")),
  );
  const to = recipients(input.to),
    cc = recipients(input.cc),
    bcc = recipients(input.bcc);
  if (
    !identity ||
    !to.length ||
    to.length + cc.length + bcc.length > 20 ||
    typeof input.subject !== "string" ||
    !input.subject.trim() ||
    input.subject.length > 200 ||
    /[\r\n\0]/.test(input.subject) ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 50000 ||
    input.text.includes("\0") ||
    !/^[a-f0-9-]{36}$/.test(input.sendId ?? "")
  )
    throw invalid();
  const files = input.attachments ?? [];
  if (!Array.isArray(files) || files.length > 5) throw invalid();
  let total = 0;
  const attachments = files.map((file) => {
    if (
      !file ||
      typeof file.filename !== "string" ||
      !file.filename ||
      file.filename.length > 200 ||
      /[\r\n\0/\\]/.test(file.filename) ||
      typeof file.content !== "string" ||
      !file.content ||
      file.content.length > Math.ceil(attachmentLimit / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.content,
      )
    )
      throw invalid();
    const content = Buffer.from(file.content, "base64");
    total += content.length;
    if (!content.length || total > attachmentLimit)
      throw new AuthError("mail_too_large", 413);
    return {
      filename: file.filename,
      content,
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
    };
  });
  if (
    input.reply !== undefined &&
    (!input.reply ||
      typeof input.reply !== "object" ||
      !["reply", "forward"].includes(input.reply.kind))
  )
    throw invalid();
  return {
    from: { name: identity.name, address: identity.address },
    to,
    cc,
    bcc,
    subject: input.subject.trim(),
    text: input.text,
    attachments,
  };
}

export function mailboxService(config, store, dependencies = {}) {
  if (!config.mail) return undefined;
  const settings = config.mail,
    smtp = config.applications.smtp;
  const identities = settings.identities.map(({ address, name }) => ({
    address,
    name,
  }));
  const transport = dependencies.transport ?? bridgeMailTransport(smtp);
  const makeClient =
    dependencies.createClient ?? ((options) => new ImapFlow(options));
  const active = new Set();
  const sending = new Set();
  let closed = false;
  const domains = new Set(
    identities.map((identity) => identity.address.split("@")[1].toLowerCase()),
  );
  function selectableFolders(entries) {
    return entries
      .filter((entry) => !entry.flags?.has("\\Noselect"))
      .map((entry) => ({
        ...entry,
        specialUse:
          entry.specialUse ??
          standardFolders.get(entry.path.toLowerCase()) ??
          null,
      }))
      .filter(
        (entry) =>
          entry.specialUse ||
          domains.has(entry.name.toLowerCase()) ||
          settings.folderPaths?.includes(entry.path),
      )
      .sort((a, b) => {
        const order = [...standardFolders.values()];
        const priority = (entry) =>
          order.includes(entry.specialUse)
            ? order.indexOf(entry.specialUse)
            : order.length;
        return priority(a) - priority(b) || a.name.localeCompare(b.name);
      });
  }
  const identityScope = {
    or: identities.flatMap(({ address }) => [
      { to: address },
      { cc: address },
      { bcc: address },
      { from: address },
      { header: { "Delivered-To": address } },
    ]),
  };
  const identityAddresses = new Set(
    identities.map(({ address }) => lower(address)),
  );
  function matchesIdentity(values = []) {
    return values.some(
      ({ address, group }) =>
        identityAddresses.has(lower(String(address ?? ""))) ||
        (group && matchesIdentity(group)),
    );
  }
  async function connection(action) {
    if (closed || active.size >= 4) throw new AuthError("mail_busy", 503);
    const client = makeClient({
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      doSTARTTLS: true,
      tls: {
        path: settings.imapSocketPath,
        ca: smtp.ca,
        minVersion: "TLSv1.2",
      },
      auth: { user: smtp.user, pass: smtp.password },
      logger: false,
      logRaw: false,
      disableAutoIdle: true,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
      maxLineLength: bodyLimit,
      maxLiteralSize: 20 * bodyLimit,
      maxResponseSize: 24 * bodyLimit,
    });
    active.add(client);
    // connection errors remain inside the request boundary.
    client.on("error", () => {});
    try {
      await client.connect();
      return await action(client);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("mail_unavailable", 503);
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
      active.delete(client);
    }
  }
  function folderPath(value) {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 300 ||
      /[\r\n\0]/.test(value)
    )
      throw invalid();
    return value;
  }
  async function mailbox(client, folder, validity, readOnly, action) {
    folderPath(folder);
    const folders = selectableFolders(await client.list({ listOnly: true }));
    if (
      !folders.some(
        (entry) => entry.path === folder && !entry.flags?.has("\\Noselect"),
      )
    )
      throw new AuthError("mail_not_found", 404);
    const lock = await client.getMailboxLock(folder, { readOnly });
    try {
      const current = String(client.mailbox.uidValidity);
      if (validity !== undefined && validity !== current)
        throw new AuthError("mail_changed", 409);
      return await action(current, folders);
    } finally {
      lock.release();
    }
  }
  function messageKey(input) {
    if (
      !input ||
      !/^[1-9]\d{0,9}$/.test(String(input.uid ?? "")) ||
      Number(input.uid) > 4294967295 ||
      !/^\d{1,20}$/.test(input.validity ?? "")
    )
      throw invalid();
    folderPath(input.folder);
    return Number(input.uid);
  }
  async function scopedMessage(client, input, query) {
    const uid = messageKey(input);
    const record = await client.fetchOne(
      uid,
      {
        ...query,
        uid: true,
        envelope: true,
        headers:
          query.headers === true
            ? true
            : [...new Set([...(query.headers || []), "delivered-to"])],
      },
      { uid: true },
    );
    if (!record || record.uid !== uid)
      throw new AuthError("mail_not_found", 404);
    const envelope = record.envelope ?? {};
    if (
      [envelope.from, envelope.to, envelope.cc, envelope.bcc].some(
        matchesIdentity,
      )
    )
      return record;
    const parsed = await simpleParser(record.headers ?? Buffer.alloc(0), {
      skipHtmlToText: true,
      skipTextToHtml: true,
    });
    const deliveredTo = parsed.headers.get("delivered-to");
    const deliveries = Array.isArray(deliveredTo) ? deliveredTo : [deliveredTo];
    if (!deliveries.some((entry) => matchesIdentity(entry?.value)))
      throw new AuthError("mail_not_found", 404);
    return record;
  }
  function summary(record) {
    const envelope = record.envelope ?? {};
    return {
      uid: record.uid,
      subject: String(envelope.subject ?? "(No subject)").slice(0, 500),
      from: addresses(envelope.from),
      to: addresses(envelope.to),
      cc: addresses(envelope.cc),
      date: envelope.date instanceof Date ? envelope.date.toISOString() : null,
      seen: Boolean(record.flags?.has("\\Seen")),
      starred: Boolean(record.flags?.has("\\Flagged")),
      size: record.size,
    };
  }
  async function inMessage(input, readOnly, action) {
    messageKey(input);
    return connection((client) =>
      mailbox(
        client,
        input.folder,
        input.validity,
        readOnly,
        (_current, folders) => action(client, folders),
      ),
    );
  }
  return {
    identities,
    incoming(cursor) {
      return connection((client) =>
        mailbox(client, "INBOX", undefined, true, async (validity) => {
          const highest = Number(client.mailbox.uidNext) - 1;
          if (!Number.isInteger(highest) || highest < 0 || highest > 4294967295)
            throw new AuthError("mail_unavailable", 503);
          if (!cursor || cursor.validity !== validity)
            return { validity, through: highest, items: [] };
          if (!Number.isInteger(cursor.uid) || cursor.uid < 0) throw invalid();
          if (highest <= cursor.uid)
            return { validity, through: cursor.uid, items: [] };
          const end = Math.min(highest, cursor.uid + 500);
          const matches =
            (await client.search(
              { ...identityScope, uid: `${cursor.uid + 1}:${end}` },
              { uid: true },
            )) || [];
          matches.sort((a, b) => a - b);
          const uids = matches.slice(0, 10);
          const records = uids.length
            ? await client.fetchAll(uids, { envelope: true }, { uid: true })
            : [];
          records.sort((a, b) => a.uid - b.uid);
          return {
            validity,
            through: matches.length > uids.length ? uids.at(-1) : end,
            items: records.map(summary),
          };
        }),
      );
    },
    folders: () =>
      connection(async (client) => {
        const folders = selectableFolders(
          await client.list({ listOnly: true }),
        );
        return folders
          .filter((entry) => !entry.flags?.has("\\Noselect"))
          .map((entry) => ({
            path: entry.path,
            name: entry.name,
            specialUse: entry.specialUse ?? null,
          }));
      }),
    attention: () =>
      connection(async (client) => {
        const folders = selectableFolders(
          await client.list({ listOnly: true }),
        );
        const inbox = folders.find((entry) => entry.specialUse === "\\Inbox");
        if (!inbox) throw new AuthError("mail_unavailable", 503);
        const pending = new Map();
        let withoutMessageId = 0;
        const unread = await mailbox(
          client,
          inbox.path,
          undefined,
          true,
          async () => {
            const uids =
              (await client.search(identityScope, { uid: true })) || [];
            let unread = 0;
            for (let offset = 0; offset < uids.length; offset += 100) {
              const records = await client.fetchAll(
                uids.slice(offset, offset + 100),
                {
                  envelope: true,
                  flags: true,
                  headers: ["message-id"],
                },
                { uid: true },
              );
              for (const record of records) {
                if (matchesIdentity(record.envelope?.from)) continue;
                if (!record.flags?.has("\\Seen")) unread++;
                const parsed = await simpleParser(
                  record.headers ?? Buffer.alloc(0),
                  {
                    skipHtmlToText: true,
                    skipTextToHtml: true,
                  },
                );
                if (
                  !record.flags?.has("\\Answered") &&
                  !(
                    parsed.messageId &&
                    store.get("mail-response", hash(parsed.messageId))
                  )
                ) {
                  if (parsed.messageId)
                    pending.set(
                      parsed.messageId,
                      (pending.get(parsed.messageId) ?? 0) + 1,
                    );
                  else withoutMessageId++;
                }
              }
            }
            return unread;
          },
        );
        const sent = folders.find((entry) => entry.specialUse === "\\Sent");
        if (sent && pending.size)
          await mailbox(client, sent.path, undefined, true, async () => {
            const uids =
              (await client.search(
                {
                  or: identities.map((identity) => ({
                    from: identity.address,
                  })),
                },
                { uid: true },
              )) || [];
            for (
              let offset = 0;
              offset < uids.length && pending.size;
              offset += 100
            ) {
              const records = await client.fetchAll(
                uids.slice(offset, offset + 100),
                {
                  headers: ["in-reply-to", "references"],
                },
                { uid: true },
              );
              for (const record of records) {
                const parsed = await simpleParser(
                  record.headers ?? Buffer.alloc(0),
                  {
                    skipHtmlToText: true,
                    skipTextToHtml: true,
                  },
                );
                for (const reference of [
                  parsed.inReplyTo,
                  ...[].concat(parsed.references ?? []),
                ])
                  pending.delete(reference);
              }
            }
          });
        return {
          unanswered:
            withoutMessageId +
            [...pending.values()].reduce((total, count) => total + count, 0),
          unread,
          folder: inbox.path,
        };
      }),
    list(input) {
      folderPath(input.folder);
      if (
        typeof (input.search ?? "") !== "string" ||
        (input.search ?? "").length > 120 ||
        /[\r\n\0]/.test(input.search ?? "") ||
        !Number.isInteger(input.offset) ||
        input.offset < 0 ||
        input.offset > 1000000 ||
        (input.identity &&
          !identities.some((entry) => entry.address === input.identity))
      )
        throw invalid();
      const scope = input.identity
        ? {
            or: [
              { to: input.identity },
              { cc: input.identity },
              { bcc: input.identity },
              { from: input.identity },
              { header: { "Delivered-To": input.identity } },
            ],
          }
        : identityScope;
      return connection((client) =>
        mailbox(client, input.folder, undefined, true, async (validity) => {
          const query = { ...scope };
          if (input.search) query.text = input.search;
          if (input.unread) query.seen = false;
          const matches = (await client.search(query, { uid: true })) || [];
          matches.sort((a, b) => b - a);
          const uids = matches.slice(input.offset, input.offset + 25);
          const messages = uids.length
            ? await client.fetchAll(
                uids,
                { envelope: true, flags: true, size: true },
                { uid: true },
              )
            : [];
          messages.sort((a, b) => b.uid - a.uid);
          return {
            items: messages.map(summary),
            total: matches.length,
            offset: input.offset,
            validity,
          };
        }),
      );
    },
    detail(input, markRead = false) {
      return inMessage(input, !markRead, async (client) => {
        const record = await scopedMessage(client, input, {
          envelope: true,
          flags: true,
          size: true,
          bodyStructure: true,
          headers: ["reply-to", "message-id", "references", "in-reply-to"],
        });
        const parsed = await simpleParser(record.headers ?? Buffer.alloc(0), {
          skipHtmlToText: true,
          skipTextToHtml: true,
        });
        const parts = partsOf(record.bodyStructure);
        const inline = parts.filter(
          (part) =>
            !part.disposition ||
            part.disposition.toLowerCase() !== "attachment",
        );
        const plain = inline.find((part) => part.type === "text/plain");
        const htmlPart = inline.find((part) => part.type === "text/html");
        const text = plain
          ? (
              await boundedContent(
                client,
                record.uid,
                plain.part || "1",
                bodyLimit,
              )
            ).toString("utf8")
          : "";
        const html = htmlPart
          ? safeMailHtml(
              (
                await boundedContent(
                  client,
                  record.uid,
                  htmlPart.part || "1",
                  bodyLimit,
                )
              ).toString("utf8"),
            )
          : "";
        let replyText = text;
        if (!replyText && html) {
          const decoded = await simpleParser(
            Buffer.from(
              `Content-Type: text/html; charset=utf-8\r\n\r\n${html}`,
            ),
            { skipTextToHtml: true, maxHtmlLengthToParse: bodyLimit },
          );
          replyText = decoded.text ?? "";
        }
        const attachments = parts
          .filter((part) => ![plain, htmlPart].includes(part))
          .map((part) => ({
            part: part.part || "1",
            filename: String(
              part.dispositionParameters?.filename ??
                part.parameters?.name ??
                `attachment-${part.part ?? "1"}`,
            ).slice(0, 200),
            type: part.type,
            size: part.size,
          }));
        if (markRead && !record.flags?.has("\\Seen")) {
          const changed = await client.messageFlagsAdd(record.uid, ["\\Seen"], {
            uid: true,
          });
          if (!changed) throw new AuthError("mail_changed", 409);
          record.flags ??= new Set();
          record.flags.add("\\Seen");
        }
        return {
          ...summary(record),
          folder: input.folder,
          validity: input.validity,
          text,
          html,
          replyText,
          replyTo: addresses(
            parsed.replyTo?.value ??
              record.envelope?.replyTo ??
              record.envelope?.from,
          ),
          attachments,
        };
      });
    },
    attachment(input) {
      if (!/^\d+(?:\.\d+){0,12}$/.test(input.part ?? "")) throw invalid();
      return inMessage(input, true, async (client) => {
        const record = await scopedMessage(client, input, {
          bodyStructure: true,
        });
        const part = partsOf(record.bodyStructure).find(
          (entry) => (entry.part || "1") === input.part,
        );
        if (!part) throw new AuthError("mail_not_found", 404);
        if (part.size > attachmentLimit * 1.4)
          throw new AuthError("mail_too_large", 413);
        return {
          filename: String(
            part.dispositionParameters?.filename ??
              part.parameters?.name ??
              "attachment",
          )
            .replace(/[\r\n\0/\\]/g, "_")
            .slice(0, 200),
          content: await boundedContent(
            client,
            record.uid,
            input.part,
            attachmentLimit,
          ),
        };
      });
    },
    flags(input) {
      if (
        !input ||
        !["seen", "starred"].includes(input.flag) ||
        typeof input.value !== "boolean"
      )
        throw invalid();
      return inMessage(input, false, async (client) => {
        await scopedMessage(client, input, { uid: true });
        const flag = input.flag === "seen" ? "\\Seen" : "\\Flagged";
        const changed = input.value
          ? await client.messageFlagsAdd(Number(input.uid), [flag], {
              uid: true,
            })
          : await client.messageFlagsRemove(Number(input.uid), [flag], {
              uid: true,
            });
        if (!changed) throw new AuthError("mail_changed", 409);
        return { ok: true };
      });
    },
    trash(input) {
      return inMessage(input, false, async (client, folders) => {
        await scopedMessage(client, input, { uid: true });
        const trash = folders.find((entry) => entry.specialUse === "\\Trash");
        if (!trash) throw new AuthError("mail_trash_unavailable", 503);
        if (trash.path === input.folder) throw invalid();
        const moved = await client.messageMove(Number(input.uid), trash.path, {
          uid: true,
        });
        if (!moved) throw new AuthError("mail_changed", 409);
        return { ok: true };
      });
    },
    async send(userId, input) {
      if (closed) throw new AuthError("mail_unavailable", 503);
      const mail = validateMailDraft(input, identities);
      const digest = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const key = `${userId}:${input.sendId}`;
      if (sending.has(key)) throw new AuthError("mail_send_pending", 409);
      const existing = store.get("mail-send", key);
      if (existing) {
        if (existing.digest !== digest)
          throw new AuthError("mail_send_changed", 409);
        if (existing.result) return existing.result;
        throw new AuthError("mail_send_uncertain", 409);
      }
      sending.add(key);
      try {
        let repliedMessageId;
        if (input.reply?.kind === "reply") {
          const headers = await inMessage(input.reply, true, async (client) => {
            const original = await scopedMessage(client, input.reply, {
              headers: ["message-id", "references"],
            });
            return simpleParser(original.headers ?? Buffer.alloc(0), {
              skipHtmlToText: true,
              skipTextToHtml: true,
            });
          });
          const messageId = headers.messageId;
          const validId = (value) =>
            typeof value === "string" && /^<[^<>\s\r\n]{1,250}>$/.test(value);
          if (validId(messageId)) {
            repliedMessageId = messageId;
            mail.inReplyTo = messageId;
            mail.references = [
              ...(Array.isArray(headers.references)
                ? headers.references
                : [headers.references]
              )
                .filter(validId)
                .slice(-20),
              messageId,
            ];
          }
        }
        const messageId = `<${randomUUID()}@${mail.from.address.split("@")[1]}>`;
        // retain the send receipt without message bodies or attachment data.
        store.set(
          "mail-send",
          key,
          { digest, messageId },
          Date.now() + 30 * 86400000,
        );
        let result;
        try {
          const sent = await transport.sendMail({
            ...mail,
            messageId,
            disableFileAccess: true,
            disableUrlAccess: true,
          });
          result = {
            status: "sent",
            accepted: (sent.accepted ?? []).filter(validMailAddress),
            rejected: (sent.rejected ?? []).filter(validMailAddress),
            messageId,
          };
          if (!result.accepted.length)
            throw new Error("No recipients accepted");
        } catch {
          throw new AuthError("mail_send_uncertain", 503);
        }
        store.set(
          "mail-send",
          key,
          { digest, messageId, result },
          Date.now() + 30 * 86400000,
        );
        if (repliedMessageId)
          store.set(
            "mail-response",
            hash(repliedMessageId),
            { sentAt: Date.now() },
            Number.MAX_SAFE_INTEGER,
          );
        return result;
      } finally {
        sending.delete(key);
      }
    },
    async close() {
      closed = true;
      for (const client of active) client.close();
      transport.close();
    },
  };
}
