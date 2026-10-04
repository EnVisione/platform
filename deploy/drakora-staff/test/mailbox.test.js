import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import express from "express";
import {
  mailboxService,
  safeMailHtml,
  validateMailDraft,
} from "../server/mailbox.js";
import { mailRouter } from "../server/mail-routes.js";
import { mailAccess, permissions } from "../server/roles.js";
import { AuthError } from "../server/discord.js";
import { openStore, hash } from "../server/store.js";
import { config as fixture } from "./fixture.js";

const settings = {
  ...fixture,
  mail: {
    imapSocketPath: "/private/imap.sock",
    identities: [
      { address: "support@drakora.org", name: "Drakora Support" },
      { address: "no-reply@drakora.org", name: "Drakora" },
    ],
  },
  applications: {
    smtp: {
      socketPath: "/private/smtp.sock",
      user: "test-user",
      password: "fixture",
      ca: "test-ca",
    },
  },
};
const input = () => ({
  sendId: randomUUID(),
  from: "support@drakora.org",
  to: "player@example.invalid",
  subject: "Your support request",
  text: "Hello from Drakora.",
});
const key = { folder: "INBOX", uid: 4, validity: "51" };

function harness(t, overrides = {}, config = settings) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const state = {
    clients: [],
    searches: [],
    fetches: [],
    sends: [],
    flags: [],
    moves: [],
    records: Array.from({ length: 37 }, (_, index) => ({
      uid: index + 1,
      envelope: {
        subject: `Message ${index + 1}`,
        from: [{ name: "Player", address: "player@example.invalid" }],
        to: [{ address: "support@drakora.org" }],
        cc: [],
        date: new Date("2026-10-02T10:00:00Z"),
      },
      flags: new Set(),
      size: 1500,
    })),
    structure: {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", size: 12 },
        { part: "2", type: "text/html", size: 100 },
        {
          part: "3",
          type: "application/pdf",
          disposition: "attachment",
          dispositionParameters: { filename: "proof.pdf" },
          size: 5,
        },
      ],
    },
    bodies: {
      1: "Hello player",
      2: '<p>Hello <strong>player</strong><img src="https://tracker.invalid/pixel"><script>steal()</script><a href="javascript:alert(1)">link</a></p>',
      3: "proof",
    },
    ...overrides,
  };
  class Client extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.mailbox = {
        uidValidity: state.validity ?? 51n,
        uidNext: Math.max(0, ...state.records.map((entry) => entry.uid)) + 1,
      };
      this.released = 0;
      this.loggedOut = 0;
      this.closed = 0;
      state.clients.push(this);
    }
    async connect() {
      if (state.connectError) throw new Error("private connection detail");
    }
    async list() {
      return (
        state.folders ?? [
          { path: "Labels/Personal", name: "Personal", flags: new Set() },
          { path: "Labels/drakora.org", name: "drakora.org", flags: new Set() },
          {
            path: "INBOX",
            name: "Inbox",
            flags: new Set(),
            specialUse: "\\Inbox",
          },
          {
            path: "Sent",
            name: "Sent",
            flags: new Set(),
            specialUse: "\\Sent",
          },
          {
            path: "Trash",
            name: "Trash",
            flags: new Set(),
            specialUse: "\\Trash",
          },
          { path: "Hidden", name: "Hidden", flags: new Set(["\\Noselect"]) },
        ]
      );
    }
    async getMailboxLock(folder, options) {
      this.folder = folder;
      this.readOnly = options.readOnly;
      return { release: () => this.released++ };
    }
    async search(query) {
      state.searches.push(query);
      if (this.folder === "Sent")
        return (state.sentRecords ?? []).map((record) => record.uid);
      if (query.uid?.includes(":")) {
        const [start, end] = query.uid.split(":").map(Number);
        return state.records
          .filter(
            (record) =>
              record.uid >= start && record.uid <= end && !record.personal,
          )
          .map((record) => record.uid);
      }
      return state.records.map((record) => record.uid);
    }
    async fetchAll(uids, query) {
      state.fetches.push(uids);
      state.fetchQueries ??= [];
      state.fetchQueries.push(query);
      return (
        this.folder === "Sent" ? (state.sentRecords ?? []) : state.records
      ).filter((record) => uids.includes(record.uid));
    }
    async fetchOne(uid, query, options) {
      if (state.fetchError) throw new Error("private message detail");
      state.directFetches ??= [];
      state.directFetches.push({ uid, query, options });
      const record = state.records.find((record) => record.uid === Number(uid));
      if (!record) return false;
      return {
        ...record,
        bodyStructure: state.structure,
        headers: Buffer.from(
          `Message-ID: <original@example.invalid>\r\nReferences: <prior@example.invalid>\r\nReply-To: Player <player@example.invalid>\r\n${state.deliveryHeaders ?? ""}\r\n`,
        ),
      };
    }
    async download(_uid, part) {
      state.downloads ??= [];
      state.downloads.push(part);
      return {
        content: Readable.from([Buffer.from(state.bodies[part] ?? "")]),
      };
    }
    async messageFlagsAdd(uid, flags) {
      state.flags.push({ uid, flags, add: true });
      return state.flagResult ?? true;
    }
    async messageFlagsRemove(uid, flags) {
      state.flags.push({ uid, flags, add: false });
      return true;
    }
    async messageMove(uid, folder, options) {
      state.moves.push({ uid, folder, options });
      return state.moveResult ?? { destination: folder };
    }
    async logout() {
      this.loggedOut++;
    }
    close() {
      this.closed++;
    }
  }
  const transport = {
    async sendMail(value) {
      state.sends.push(value);
      if (state.sendGate) await state.sendGate;
      if (state.sendError) throw new Error("private SMTP detail");
      return { accepted: value.to, rejected: [] };
    },
    close() {},
  };
  const service = mailboxService(config, store, {
    createClient: (options) => new Client(options),
    transport,
  });
  t.after(async () => {
    await service.close();
    store.close();
  });
  return { service, store, state };
}

test("attention includes read unanswered mail and excludes replies and staff messages", async (t) => {
  const records = [
    { uid: 1, flags: new Set(["\\Seen"]) },
    { uid: 2, flags: new Set(["\\Answered"]) },
    {
      uid: 3,
      flags: new Set(),
      headers: Buffer.from("Message-ID: <replied@example.invalid>\r\n\r\n"),
    },
    {
      uid: 4,
      flags: new Set(),
      headers: Buffer.from(
        "Message-ID: <sent-replied@example.invalid>\r\n\r\n",
      ),
    },
    {
      uid: 5,
      flags: new Set(),
      envelope: { from: [{ address: "support@drakora.org" }] },
    },
  ];
  const { service, state, store } = harness(t, {
    records: records.map((record) => ({
      ...record,
      envelope: {
        ...record.envelope,
        to: [{ address: "support@drakora.org" }],
      },
    })),
    sentRecords: [
      {
        uid: 101,
        headers: Buffer.from(
          "In-Reply-To: <sent-replied@example.invalid>\r\nReferences: <prior@example.invalid> <sent-replied@example.invalid>\r\n\r\n",
        ),
      },
    ],
  });
  store.set(
    "mail-response",
    hash("<replied@example.invalid>"),
    { sentAt: Date.now() },
    Number.MAX_SAFE_INTEGER,
  );
  assert.deepEqual(await service.attention(), {
    unanswered: 1,
    unread: 3,
    folder: "INBOX",
  });
  assert.equal(state.downloads?.length ?? 0, 0);
  assert.equal(state.clients.at(-1).readOnly, true);
});

test("new mail baseline, UID reset and empty polling never replay old mail", async (t) => {
  const { service, state } = harness(t);
  assert.deepEqual(await service.incoming(), {
    validity: "51",
    through: 37,
    items: [],
  });
  assert.deepEqual(await service.incoming({ validity: "51", uid: 37 }), {
    validity: "51",
    through: 37,
    items: [],
  });
  state.validity = 52n;
  assert.deepEqual(await service.incoming({ validity: "51", uid: 0 }), {
    validity: "52",
    through: 37,
    items: [],
  });
  assert.deepEqual(state.searches, []);
  assert.ok(
    state.clients.every(
      (client) =>
        client.readOnly && client.released === 1 && client.loggedOut === 1,
    ),
  );
});

test("new mail scans bounded UID ranges and fetches only shared headers without marking read", async (t) => {
  const { service, state } = harness(t);
  state.records[1].personal = true;
  const batch = await service.incoming({ validity: "51", uid: 0 });
  assert.deepEqual(
    batch.items.map((item) => item.uid),
    [1, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(batch.through, 11);
  assert.deepEqual(state.fetchQueries, [{ envelope: true }]);
  assert.ok(
    state.searches[0].or.some(
      (query) => query.header?.["Delivered-To"] === "support@drakora.org",
    ),
  );
  assert.deepEqual(state.flags, []);
  state.records.push({ ...state.records[0], uid: 2000 });
  assert.deepEqual(await service.incoming({ validity: "51", uid: 1000 }), {
    validity: "51",
    through: 1500,
    items: [],
  });
  assert.equal(state.searches.at(-1).uid, "1001:1500");
});

test("incoming alerts skip shared sent copies and advance to genuine replies", async (t) => {
  const config = {
    ...settings,
    mail: {
      ...settings.mail,
      identities: [
        ...settings.mail.identities,
        { address: "partners@drakora.org", name: "Drakora Partnerships" },
      ],
    },
  };
  const { service, state } = harness(t, {}, config);
  for (const record of state.records.slice(0, 10)) {
    record.envelope.from =
      record.uid === 2
        ? [{ group: [{ address: "support@drakora.org" }] }]
        : [{ address: "PARTNERS@DRAKORA.ORG" }];
    record.envelope.to = [{ address: "player@example.invalid" }];
  }
  state.records[2].envelope.to = [{ address: "support@drakora.org" }];
  state.records[10].envelope.to = [{ address: "partners@drakora.org" }];
  const skipped = await service.incoming({ validity: "51", uid: 0 });
  assert.deepEqual(skipped, { validity: "51", through: 10, items: [] });
  const next = await service.incoming({
    validity: skipped.validity,
    uid: skipped.through,
  });
  assert.equal(next.through, 20);
  assert.deepEqual(
    next.items.map((item) => item.uid),
    [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  );
  assert.equal(next.items[0].to[0].address, "partners@drakora.org");
  assert.deepEqual(state.flags, []);
  assert.equal(state.downloads?.length ?? 0, 0);
  assert.ok(state.clients.every((client) => client.readOnly));
});

test("mail permission requires Dashboard and Admin, Manager or Founder", () => {
  for (const rank of fixture.ranks) {
    const user = {
      roles: ["10", rank.id],
      permissions: permissions(fixture, ["10", rank.id]),
    };
    assert.equal(
      mailAccess(settings, user),
      ["Founder", "Manager", "Admin"].includes(rank.name),
    );
    assert.equal(
      mailAccess(settings, {
        ...user,
        permissions: permissions(fixture, [rank.id]),
      }),
      false,
    );
    assert.equal(mailAccess(fixture, user), false);
  }
});

test("mail list scopes configured identities, bounds fetches and paginates newest first", async (t) => {
  const { service, state } = harness(t);
  const page = await service.list({
    folder: "INBOX",
    search: "ticket",
    identity: "support@drakora.org",
    unread: true,
    offset: 25,
  });
  assert.equal(page.total, 37);
  assert.equal(page.validity, "51");
  assert.deepEqual(
    page.items.map((item) => item.uid),
    Array.from({ length: 12 }, (_, index) => 12 - index),
  );
  assert.equal(state.searches[0].seen, false);
  assert.equal(state.searches[0].text, "ticket");
  assert.ok(
    state.searches[0].or.every((entry) =>
      JSON.stringify(entry).includes("support@drakora.org"),
    ),
  );
  assert.equal(state.fetches[0].length, 12);
  const options = state.clients[0].options;
  assert.equal(options.doSTARTTLS, true);
  assert.equal(options.tls.ca, "test-ca");
  assert.equal(options.tls.path, "/private/imap.sock");
  assert.equal(options.logger, false);
  assert.equal(state.clients[0].released, 1);
  assert.equal(state.clients[0].loggedOut, 1);
  assert.deepEqual(
    (await service.folders()).map((folder) => folder.path),
    ["INBOX", "Sent", "Trash", "Labels/drakora.org"],
  );
  await assert.rejects(service.list({ folder: "Labels/Personal", offset: 0 }), {
    code: "mail_not_found",
  });
  await assert.rejects(service.detail({ ...key, folder: "Labels/Personal" }), {
    code: "mail_not_found",
  });
  assert.throws(
    () =>
      service.list({
        folder: "INBOX",
        identity: "personal@example.invalid",
        offset: 0,
      }),
    { code: "invalid_mail_request" },
  );
});

test("message HTML blocks executable content, forms, remote tracking and CSS", async (t) => {
  const { service } = harness(t);
  const record = await service.detail(key);
  assert.equal(record.text, "Hello player");
  assert.match(record.html, /<strong>player<\/strong>/);
  assert.doesNotMatch(record.html, /script|javascript|tracker|<img/);
  assert.deepEqual(record.replyTo, [
    { name: "Player", address: "player@example.invalid" },
  ]);
  assert.deepEqual(
    record.attachments.map((file) => file.filename),
    ["proof.pdf"],
  );
  const hostile = safeMailHtml(
    '<style>*{display:none}</style><form action="/api/mail/send"><input name="x"></form><iframe src="/api/me"></iframe><svg onload="x()"></svg><p onclick="x()" style="position:fixed">safe</p><a href="https://example.invalid">open</a>',
  );
  assert.doesNotMatch(
    hostile,
    /<style|<form|<input|<iframe|<svg|onclick|position:/,
  );
  assert.match(hostile, /rel="noopener noreferrer"/);
});

test("HTML-only Proton messages supply readable reply text", async (t) => {
  const { service } = harness(t, {
    structure: { part: "1", type: "text/html" },
    bodies: { 1: "<p>Hello <b>Proton</b></p>" },
  });
  const record = await service.detail(key);
  assert.equal(record.text, "");
  assert.match(record.replyText, /Hello Proton/);
  assert.deepEqual(record.attachments, []);
});

test("stale UID validity and out-of-scope direct reads cannot bypass mailbox checks", async (t) => {
  const { service, state } = harness(t);
  await assert.rejects(service.detail({ ...key, validity: "50" }), {
    code: "mail_changed",
  });
  assert.equal(state.clients.at(-1).released, 1);
  state.records.find((record) => record.uid === key.uid).envelope.to = [
    { address: "personal@example.invalid" },
  ];
  await assert.rejects(service.detail(key), { code: "mail_not_found" });
  await assert.rejects(service.attachment({ ...key, part: "3" }), {
    code: "mail_not_found",
  });
  await assert.rejects(service.flags({ ...key, flag: "seen", value: true }), {
    code: "mail_not_found",
  });
  assert.equal(state.flags.length, 0);
  assert.equal(state.downloads?.length ?? 0, 0);
  await assert.rejects(
    service.send("staff-user", {
      ...input(),
      reply: { ...key, kind: "reply" },
    }),
    { code: "mail_not_found" },
  );
  assert.equal(state.sends.length, 0);
  await assert.rejects(service.detail({ ...key, uid: 999 }), {
    code: "mail_not_found",
  });
  await assert.rejects(service.detail({ ...key, uid: "4:*" }), {
    code: "invalid_mail_request",
  });
});

test("direct reads verify configured addresses without scanning the mailbox", async (t) => {
  const { service, state, store } = harness(t);
  const record = state.records.find((record) => record.uid === key.uid);
  for (const field of ["from", "to", "cc", "bcc"]) {
    record.envelope = { [field]: [{ address: "SUPPORT@DRAKORA.ORG" }] };
    assert.equal((await service.detail(key)).uid, key.uid);
  }
  record.envelope = {
    to: [{ address: "support@drakora.org.attacker.invalid" }],
    from: [
      { name: "support@drakora.org", address: "personal@example.invalid" },
    ],
  };
  await assert.rejects(service.detail(key), { code: "mail_not_found" });
  state.deliveryHeaders =
    "Delivered-To: personal@example.invalid\r\nDelivered-To:\r\n Shared <NO-REPLY@DRAKORA.ORG>\r\n";
  assert.equal((await service.detail(key)).uid, key.uid);
  assert.equal(
    (await service.attachment({ ...key, part: "3" })).content.toString(),
    "proof",
  );
  await service.flags({ ...key, flag: "starred", value: true });
  await service.send("staff-user", {
    ...input(),
    reply: { ...key, kind: "reply" },
  });
  assert.equal(state.searches.length, 0);
  for (const fetch of state.directFetches) {
    assert.equal(fetch.uid, key.uid);
    assert.deepEqual(fetch.options, { uid: true });
    assert.equal(fetch.query.envelope, true);
    assert.equal(fetch.query.headers.includes("delivered-to"), true);
  }
  assert.equal(state.sends[0].inReplyTo, "<original@example.invalid>");
  assert.equal(
    typeof store.get("mail-response", hash("<original@example.invalid>"))
      .sentAt,
    "number",
  );
  state.deliveryHeaders =
    "Delivered-To: support@drakora.org.attacker.invalid\r\n";
  await assert.rejects(service.detail(key), { code: "mail_not_found" });
});

test("attachment downloads are explicit, bounded and restricted to real MIME parts", async (t) => {
  const { service, state } = harness(t);
  assert.equal(
    (await service.attachment({ ...key, part: "3" })).content.toString(),
    "proof",
  );
  await assert.rejects(service.attachment({ ...key, part: "99" }), {
    code: "mail_not_found",
  });
  state.bodies["1"] = "x".repeat(1048577);
  await assert.rejects(service.detail(key), { code: "mail_too_large" });
  assert.equal(state.clients.at(-1).released, 1);
});

test("flag operations mutate only Seen and Flagged and always release the lock", async (t) => {
  const { service, state } = harness(t);
  await service.flags({ ...key, flag: "seen", value: true });
  await service.flags({ ...key, flag: "starred", value: false });
  assert.deepEqual(state.flags, [
    { uid: 4, flags: ["\\Seen"], add: true },
    { uid: 4, flags: ["\\Flagged"], add: false },
  ]);
  assert.equal(state.clients[0].readOnly, false);
  assert.throws(() => service.flags({ ...key, flag: "deleted", value: true }), {
    code: "invalid_mail_request",
  });
});

test("opening marks a successfully loaded message read once in the same connection", async (t) => {
  const { service, state } = harness(t);
  assert.equal((await service.detail(key)).seen, false);
  assert.deepEqual(state.flags, []);
  const opened = await service.detail(key, true);
  assert.equal(opened.seen, true);
  assert.equal(opened.text, "Hello player");
  assert.equal(state.clients.length, 2);
  assert.equal(state.clients[1].readOnly, false);
  await service.detail(key, true);
  assert.deepEqual(state.flags, [{ uid: 4, flags: ["\\Seen"], add: true }]);
  await service.detail(key, false);
  assert.equal(state.clients.at(-1).readOnly, true);
});

test("opening never marks failed, stale or private messages read", async (t) => {
  const { service, state } = harness(t);
  await assert.rejects(service.detail({ ...key, validity: "50" }, true), {
    code: "mail_changed",
  });
  state.bodies[1] = "x".repeat(1048577);
  await assert.rejects(service.detail(key, true), { code: "mail_too_large" });
  state.records.find((record) => record.uid === key.uid).envelope.to = [
    { address: "personal@example.invalid" },
  ];
  await assert.rejects(service.detail(key, true), { code: "mail_not_found" });
  assert.deepEqual(state.flags, []);
  assert.ok(
    state.clients.every(
      (client) => client.released === 1 && client.loggedOut === 1,
    ),
  );
});

test("failed read flag update does not report the email as read", async (t) => {
  const { service, state } = harness(t, { flagResult: false });
  await assert.rejects(service.detail(key, true), { code: "mail_changed" });
  assert.equal(
    state.records.find((record) => record.uid === key.uid).flags.has("\\Seen"),
    false,
  );
});

test("deletion moves only the scoped exact UID to server-selected Trash", async (t) => {
  const { service, state } = harness(t);
  assert.deepEqual(await service.trash({ ...key, destination: "Personal" }), {
    ok: true,
  });
  assert.deepEqual(state.moves, [
    { uid: 4, folder: "Trash", options: { uid: true } },
  ]);
  assert.equal(state.clients[0].readOnly, false);
  assert.equal(state.clients[0].released, 1);
  assert.equal(state.clients[0].loggedOut, 1);
  assert.deepEqual(state.flags, []);
});

test("deletion rejects stale, missing, personal, hidden and already trashed messages", async (t) => {
  const { service, state } = harness(t);
  for (const [input, code] of [
    [{ ...key, validity: "50" }, "mail_changed"],
    [{ ...key, uid: 999 }, "mail_not_found"],
    [{ ...key, folder: "Labels/Personal" }, "mail_not_found"],
    [{ ...key, uid: "4:*" }, "invalid_mail_request"],
    [{ ...key, folder: "Trash" }, "invalid_mail_request"],
  ])
    await assert.rejects(service.trash(input), { code });
  state.records.find((record) => record.uid === key.uid).envelope.to = [
    { address: "personal@example.invalid" },
  ];
  await assert.rejects(service.trash(key), { code: "mail_not_found" });
  assert.deepEqual(state.moves, []);
  assert.deepEqual(state.flags, []);
  assert.ok(state.clients.every((client) => client.loggedOut === 1));
});

test("unavailable Trash and failed moves preserve failure instead of expunging", async (t) => {
  const { service, state } = harness(t, {
    folders: [
      { path: "INBOX", name: "Inbox", flags: new Set(), specialUse: "\\Inbox" },
    ],
  });
  await assert.rejects(service.trash(key), { code: "mail_trash_unavailable" });
  assert.deepEqual(state.moves, []);
  state.folders.push({
    path: "Trash",
    name: "Trash",
    flags: new Set(),
    specialUse: "\\Trash",
  });
  state.moveResult = false;
  await assert.rejects(service.trash(key), { code: "mail_changed" });
  assert.deepEqual(state.flags, []);
  assert.ok(
    state.clients.every(
      (client) => client.released === 1 && client.loggedOut === 1,
    ),
  );
});

test("Bridge failures expose no credentials, email contents or SMTP responses", async (t) => {
  const { service, state } = harness(t, { fetchError: true });
  await assert.rejects(service.detail(key), {
    message: "mail_unavailable",
    status: 503,
  });
  assert.equal(state.clients[0].released, 1);
  assert.equal(state.clients[0].loggedOut, 1);
  state.connectError = true;
  await assert.rejects(service.folders(), { message: "mail_unavailable" });
  assert.equal(state.clients.at(-1).loggedOut, 1);
});

test("draft validation blocks sender spoofing, header injection, remote files and excessive recipients", () => {
  const identities = settings.mail.identities;
  assert.equal(
    validateMailDraft(input(), identities).from.name,
    "Drakora Support",
  );
  for (const patch of [
    { from: "stranger@example.invalid" },
    { to: "player@example.invalid\r\nBcc: stranger@example.invalid" },
    { subject: "Subject\r\nBcc: other" },
    {
      to: Array.from(
        { length: 21 },
        (_, index) => `p${index}@example.invalid`,
      ).join(","),
    },
    { sendId: "" },
    { attachments: [{ filename: "a.png", path: "/etc/passwd" }] },
    { attachments: [{ filename: "../a.png", content: "YWJj" }] },
  ]) {
    assert.throws(
      () => validateMailDraft({ ...input(), ...patch }, identities),
      { code: "invalid_mail_request" },
    );
  }
  assert.equal(
    validateMailDraft(
      {
        ...input(),
        cc: "one@example.invalid;two@example.invalid",
        bcc: "private@example.invalid",
        attachments: [{ filename: "proof.txt", content: "YWJj" }],
      },
      identities,
    ).attachments[0].content.toString(),
    "abc",
  );
});

test("sending preserves threading, stores only a receipt and does not duplicate submissions", async (t) => {
  const { service, store, state } = harness(t);
  const draft = { ...input(), reply: { ...key, kind: "reply" } };
  const first = await service.send("42", draft);
  assert.deepEqual(await service.send("42", draft), first);
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].inReplyTo, "<original@example.invalid>");
  assert.deepEqual(state.sends[0].references, [
    "<prior@example.invalid>",
    "<original@example.invalid>",
  ]);
  assert.equal(state.sends[0].disableFileAccess, true);
  assert.equal(state.sends[0].disableUrlAccess, true);
  assert.doesNotMatch(
    JSON.stringify(store.get("mail-send", `42:${draft.sendId}`)),
    /Hello from Drakora|fixture/,
  );
  await assert.rejects(
    service.send("42", { ...draft, text: "Changed after submission" }),
    { code: "mail_send_changed" },
  );
});

test("concurrent send requests and uncertain SMTP results cannot resend the same draft", async (t) => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const { service, state } = harness(t, { sendGate: gate });
  const draft = input();
  const pending = service.send("42", draft);
  await assert.rejects(service.send("42", draft), {
    code: "mail_send_pending",
  });
  finish();
  await pending;
  assert.equal(state.sends.length, 1);
  state.sendError = true;
  const unknown = input();
  await assert.rejects(service.send("42", unknown), {
    code: "mail_send_uncertain",
  });
  await assert.rejects(service.send("42", unknown), {
    code: "mail_send_uncertain",
  });
  assert.equal(state.sends.length, 2);
});

test("email routes enforce role, host and CSRF boundaries and send attachment downloads safely", async (t) => {
  const { service, state } = harness(t);
  const app = express();
  let roles = ["10", "20"],
    signedIn = true,
    readOnly = false,
    deleteAllowed = true;
  app.use(
    "/api/mail",
    mailRouter({
      service,
      staffHost: "staff.example.invalid",
      authorize: async (_req, capability = "mail.view") => {
        if (!signedIn) throw new AuthError("login_required", 401);
        const user = {
          id: "42",
          roles,
          permissions: permissions(fixture, roles),
          capabilities: {
            "mail.view": mailAccess(settings, {
              roles,
              permissions: permissions(fixture, roles),
            }),
            "mail.flags": !readOnly,
            ...Object.fromEntries(
              settings.mail.identities.flatMap(({ address }) => [
                [`mail.inbox.${address}.view`, true],
                [`mail.inbox.${address}.send`, !readOnly],
                [`mail.inbox.${address}.reply`, !readOnly],
              ]),
            ),
          },
        };
        if (readOnly && capability !== "mail.view")
          throw new AuthError("mail_role_required");
        if (capability === "mail.delete" && !deleteAllowed)
          throw new AuthError("mail_role_required");
        if (!mailAccess(settings, user))
          throw new AuthError("mail_role_required");
        return user;
      },
      requireMutation(req) {
        if (
          req.headers.origin !== "https://staff.example.invalid" ||
          req.headers["x-csrf-token"] !== "test-csrf"
        )
          throw new AuthError("invalid_request");
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status ?? 503).json({ error: error.code ?? "unexpected" }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    Host: "staff.example.invalid",
    Origin: "https://staff.example.invalid",
    "X-CSRF-Token": "test-csrf",
    "Content-Type": "application/json",
  };
  const call = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        `${origin}/api/mail${path}`,
        {
          method: options.method ?? "GET",
          headers: { ...headers, ...options.headers },
        },
        (res) => {
          const body = [];
          res.on("data", (chunk) => body.push(chunk));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(body), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  assert.equal((await call("/")).status, 200);
  assert.equal(
    (await call("/folders", { headers: { Host: "drakora.org" } })).status,
    404,
  );
  signedIn = false;
  assert.equal((await call("/folders")).status, 401);
  signedIn = true;
  roles = ["10", "22"];
  assert.equal((await call("/messages?folder=INBOX")).status, 403);
  assert.equal(
    (await call("/send", { method: "POST", body: JSON.stringify(input()) }))
      .status,
    403,
  );
  roles = ["10", "21"];
  assert.equal(
    (
      await call("/send", {
        method: "POST",
        headers: { "X-CSRF-Token": "wrong" },
        body: JSON.stringify(input()),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/flags", {
        method: "POST",
        headers: { Origin: "https://other.invalid" },
        body: JSON.stringify({ ...key, flag: "seen", value: true }),
      })
    ).status,
    403,
  );
  assert.equal((await call("/messages?folder=INBOX&offset=-1")).status, 400);
  assert.equal(
    (
      await call("/messages/4/open?folder=INBOX&validity=51", {
        method: "POST",
        headers: { "X-CSRF-Token": "wrong" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/messages/4/open?folder=INBOX&validity=51", {
        method: "POST",
        headers: { Origin: "https://other.invalid" },
      })
    ).status,
    403,
  );
  const opened = await call("/messages/4/open?folder=INBOX&validity=51", {
    method: "POST",
  });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).seen, true);
  assert.equal(
    (
      await call("/trash", {
        method: "POST",
        headers: { "X-CSRF-Token": "wrong" },
        body: JSON.stringify(key),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/trash", {
        method: "POST",
        headers: { Origin: "https://other.invalid" },
        body: JSON.stringify(key),
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/trash", { method: "POST", body: JSON.stringify(key) }))
      .status,
    200,
  );
  assert.equal(state.moves.length, 1);
  deleteAllowed = false;
  assert.equal(
    (await call("/trash", { method: "POST", body: JSON.stringify(key) }))
      .status,
    403,
  );
  assert.equal(state.moves.length, 1);
  deleteAllowed = true;
  const attachment = await call(
    "/messages/4/attachments/3?folder=INBOX&validity=51",
  );
  assert.equal(attachment.status, 200);
  assert.match(attachment.headers.get("content-disposition"), /^attachment/);
  assert.match(
    attachment.headers.get("content-type"),
    /application\/octet-stream/,
  );
  assert.equal(attachment.headers.get("cache-control"), "no-store");
  assert.equal(await attachment.text(), "proof");
  assert.equal(
    (await call("/send", { method: "POST", body: JSON.stringify(input()) }))
      .status,
    200,
  );
  readOnly = true;
  assert.equal((await call("/")).status, 200);
  assert.equal((await call("/messages?folder=INBOX")).status, 200);
  assert.equal(
    (await call("/messages/4?folder=INBOX&validity=51")).status,
    200,
  );
  const readOnlyOpened = await call(
    "/messages/5/open?folder=INBOX&validity=51",
    { method: "POST" },
  );
  assert.equal(readOnlyOpened.status, 200);
  assert.equal((await readOnlyOpened.json()).seen, false);
  assert.equal(
    (await call("/trash", { method: "POST", body: JSON.stringify(key) }))
      .status,
    403,
  );
  assert.equal(state.moves.length, 1);
  assert.equal(
    (await call("/messages/4/attachments/3?folder=INBOX&validity=51")).status,
    403,
  );
  assert.equal(
    (
      await call("/flags", {
        method: "POST",
        body: JSON.stringify({ ...key, flag: "seen", value: true }),
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/send", { method: "POST", body: JSON.stringify(input()) }))
      .status,
    403,
  );
  assert.equal(state.flags.length, 1);
  readOnly = false;
  roles = ["10", "23"];
  assert.equal((await call("/")).status, 403);
  assert.equal(state.sends.length, 1);
});

test("per-inbox scope blocks guessed messages, files, read flags and deletion, including mixed recipients", async (t) => {
  const { service, state } = harness(t);
  const visible = ["support@drakora.org"];
  state.records.find((record) => record.uid === 4).envelope.to = [
    { address: "no-reply@drakora.org" },
  ];
  for (const action of [
    () => service.detail(key, true, visible),
    () => service.attachment({ ...key, part: "3" }, visible),
    () => service.flags({ ...key, flag: "seen", value: true }, visible),
    () => service.trash(key, visible),
  ])
    await assert.rejects(action(), { code: "mail_not_found" });
  assert.equal(state.flags.length, 0);
  assert.equal(state.moves.length, 0);
  state.records.find((record) => record.uid === 4).envelope.cc = [
    { address: "support@drakora.org" },
  ];
  await assert.rejects(service.detail(key, false, visible), {
    code: "mail_not_found",
  });
  assert.throws(
    () =>
      service.list(
        { folder: "INBOX", identity: "no-reply@drakora.org", offset: 0 },
        visible,
      ),
    { code: "mail_role_required" },
  );
  const list = await service.list({ folder: "INBOX", offset: 0 }, visible);
  assert.equal(
    list.items.some((record) => record.uid === 4),
    false,
  );
  assert.ok(
    state.searches
      .at(-1)
      .not.or.some((term) => term.to === "no-reply@drakora.org"),
  );
  await assert.rejects(service.detail(key, false, []), {
    code: "mail_not_found",
  });
});

test("compose and reply inbox grants are independent and a forged reply cannot send to arbitrary recipients", async (t) => {
  const { service, state } = harness(t);
  const access = {
    view: ["support@drakora.org"],
    send: [],
    reply: ["support@drakora.org"],
  };
  await assert.rejects(service.send("staff", input(), access), {
    code: "mail_role_required",
  });
  const reply = { ...input(), reply: { ...key, kind: "reply" } };
  await service.send("staff", reply, access);
  assert.equal(state.sends.length, 1);
  await assert.rejects(
    service.send(
      "staff",
      { ...reply, sendId: randomUUID(), to: "intruder@example.invalid" },
      access,
    ),
    { code: "mail_role_required" },
  );
  await assert.rejects(
    service.send(
      "staff",
      { ...reply, sendId: randomUUID() },
      { ...access, reply: [], send: ["support@drakora.org"] },
    ),
    { code: "mail_role_required" },
  );
  assert.equal(state.sends.length, 1);
});
