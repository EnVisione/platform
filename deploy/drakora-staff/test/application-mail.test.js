import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  applicationEmail,
  applicationMail,
} from "../server/application-mail.js";
import { applicationNotifications } from "../server/application-notifications.js";
import { openStore } from "../server/store.js";
import { validateConfig } from "../server/config.js";
import { config as fixture } from "./fixture.js";

const config = {
  ...fixture,
  staffOrigin: "https://staff.example.com",
  discordBotToken: "fixture",
  applications: {
    publicOrigin: "https://example.com",
    notificationChannelId: "50",
    smtp: {
      socketPath: "/nonexistent-drakora-test/smtp.sock",
      user: "fixture",
      password: "fixture",
      from: "no-reply@example.com",
      replyTo: "support@example.com",
      ca: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
    },
  },
};
const record = (id = "fixture", role = "community") => ({
  id,
  role,
  answers: { displayName: "<img src=x> & Applicant" },
  contactEmail: "applicant@example.com",
  notificationPreference: "email",
  discord: { id: "123" },
  review: { author: { id: "20" } },
  decision: {
    author: { id: "20" },
    reason: "<script>not HTML</script>\nHelpful feedback.",
    reapplyDays: 0,
    reapplyAfter: 1800000000000,
  },
});
function setup(t, send) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const notices = [];
  const mailer = { send, close() {} };
  const worker = applicationNotifications(
    config,
    store,
    async (_url, options) => {
      notices.push(JSON.parse(options.body));
      return Response.json({ id: "900" });
    },
    mailer,
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  return { store, worker, notices, mailer };
}

test("email templates cover all four roles and statuses without exposing answers or rendering applicant HTML", () => {
  for (const role of ["community", "builder", "artist", "developer"])
    for (const event of ["received", "reviewing", "approved", "denied"]) {
      const applicant = record("fixture", role);
      applicant.answers.privateAnswer = "private-answer-fixture";
      applicant.comments = [{ text: "private-staff-feedback" }];
      const message = applicationEmail(config, applicant, event);
      assert.equal(message.from.address, "no-reply@example.com");
      assert.equal(message.replyTo, "support@example.com");
      assert.deepEqual(message.to, { address: "applicant@example.com" });
      assert.ok(message.text.includes(applicant.answers.displayName));
      assert.ok(message.html.includes("&lt;img src=x&gt; &amp; Applicant"));
      assert.ok(!message.html.includes("<script>"));
      assert.ok(!message.text.includes("private-answer-fixture"));
      assert.ok(!message.html.includes("private-staff-feedback"));
      assert.equal(message.disableFileAccess && message.disableUrlAccess, true);
      assert.equal(
        message.messageId,
        applicationEmail(config, applicant, event).messageId,
      );
      if (event === "denied") {
        assert.ok(message.text.includes("Waiting period: 0 days"));
        assert.ok(
          message.html.includes("&lt;script&gt;not HTML&lt;/script&gt;"),
        );
      }
    }
});

test("email outbox sends ordered status updates once and reports acceptance to the staff channel", async (t) => {
  const sent = [];
  const { store, worker, notices } = setup(t, async (applicant, event) => {
    sent.push(event);
    return { accepted: [applicant.contactEmail], messageId: event };
  });
  const applicant = record();
  store.set("application", applicant.id, applicant);
  for (const event of ["denied", "reviewing", "received"])
    worker.queueApplicant(applicant, event);
  worker.queueStaff(applicant, "denied");
  await worker.delivery();
  await worker.delivery();
  assert.deepEqual(sent, ["received", "reviewing", "denied"]);
  assert.equal(store.page("application-email-notification").total, 0);
  assert.equal(worker.status(applicant.id).length, 3);
  assert.ok(
    worker
      .status(applicant.id)
      .every((update) => update.route === "email" && update.sentAt),
  );
  assert.match(
    notices[0].embeds[0].fields.at(-1).value,
    /accepted by the email service/,
  );
  applicant.notificationPreference = "discord";
  store.set("application", applicant.id, applicant);
  worker.reconcile(applicant);
  await worker.delivery();
  assert.equal(notices.length, 1);
});

test("temporary SMTP failure survives restart and preferences can cancel unsent mail", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  let calls = 0;
  const { store, worker, notices } = setup(t, async (applicant) => {
    calls++;
    throw Object.assign(new Error("temporary SMTP failure"), {
      responseCode: 450,
    });
  });
  const applicant = record();
  store.set("application", applicant.id, applicant);
  worker.queueApplicant(applicant, "received");
  worker.queueApplicant(applicant, "reviewing");
  await worker.delivery();
  assert.equal(calls, 1);
  assert.equal(store.page("application-email-notification").total, 2);
  assert.equal(worker.status(applicant.id)[0].pending, true);
  await worker.close();
  const restarted = applicationNotifications(
    config,
    store,
    async () => {
      throw new Error("Unexpected Discord call");
    },
    {
      send: async (current, event) => {
        calls++;
        return { accepted: [current.contactEmail], messageId: event };
      },
      close() {},
    },
  );
  t.after(() => restarted.close());
  t.mock.timers.tick(60000);
  await restarted.delivery();
  assert.equal(calls, 3);
  assert.equal(store.page("application-email-notification").total, 0);
  const other = record("other");
  store.set("application", other.id, other);
  worker.queueApplicant(other, "received");
  other.notificationPreference = "discord";
  store.set("application", other.id, other);
  worker.reconcile(other);
  assert.equal(store.page("application-email-notification").total, 0);
  assert.ok(store.get("application-notification", "other:received"));
  assert.equal(notices.length, 0);
});

test("recipient rejection exposes failed email delivery without losing the application", async (t) => {
  const { store, worker } = setup(t, async () => ({
    accepted: [],
    messageId: "rejected",
  }));
  const applicant = record();
  store.set("application", applicant.id, applicant);
  worker.queueApplicant(applicant, "received");
  await worker.delivery();
  assert.equal(store.page("application-email-notification").total, 0);
  assert.equal(worker.status(applicant.id)[0].reason, "email_delivery_failed");
  assert.ok(worker.status(applicant.id)[0].failedAt);
  assert.ok(store.get("application", applicant.id));
});

test("SMTP transport remains optional and rejects an unavailable private socket without network fallback", async (t) => {
  const disabled = structuredClone(config);
  delete disabled.applications.smtp;
  assert.equal(applicationMail(disabled), undefined);
  const mailer = applicationMail(config);
  t.after(() => mailer.close());
  await assert.rejects(mailer.verify(), { code: "ENOENT" });
});

test("SMTP configuration rejects injected sender headers and incomplete credentials", () => {
  const valid = {
    ...config,
    todoOrigin: "https://todo.example.com",
    discordClientSecret: "fixture",
    sessionSecret: "fixture",
    oidcClientSecret: "fixture",
    hulySecret: "fixture",
    hulyOwner: "fixture",
    hulyWorkspace: "fixture",
    hulyAccounts: "fixture",
    hulyUpstream: "fixture",
    databaseKey: randomBytes(32).toString("base64"),
    discordClientId: "2",
    office: undefined,
    applications: {
      ...config.applications,
      databaseKey: randomBytes(32).toString("base64"),
      specialistRoles: { builder: "51", artist: "52", developer: "25" },
    },
  };
  assert.equal(validateConfig(valid), valid);
  for (const [field, value] of [
    ["from", "no-reply@example.com\r\nBcc: other@example.com"],
    ["replyTo", "a@example.com,other@example.com"],
    ["socketPath", "relative.sock"],
    ["password", ""],
    ["ca", ""],
  ]) {
    const invalid = structuredClone(valid);
    invalid.applications.smtp[field] = value;
    assert.throws(() => validateConfig(invalid), /private SMTP socket/);
  }
  valid.mail = {
    imapSocketPath: "/private/imap.sock",
    identities: [{ address: "support@example.com", name: "Drakora Support" }],
  };
  assert.equal(validateConfig(valid), valid);
  for (const patch of [
    { imapSocketPath: "relative.sock" },
    { identities: [] },
    {
      identities: [
        { address: "support@example.com", name: "Injected\r\nFrom" },
      ],
    },
    {
      identities: [
        { address: "support@example.com", name: "One" },
        { address: "SUPPORT@example.com", name: "Two" },
      ],
    },
  ]) {
    const invalid = structuredClone(valid);
    Object.assign(invalid.mail, patch);
    assert.throws(() => validateConfig(invalid), /private IMAP socket/);
  }
  const missingSmtp = structuredClone(valid);
  delete missingSmtp.applications.smtp;
  assert.throws(() => validateConfig(missingSmtp), /private IMAP socket/);
});
