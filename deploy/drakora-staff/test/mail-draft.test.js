import assert from "node:assert/strict";
import test from "node:test";
import { newDraft, replyDraft, draftPayload } from "../src/mail-draft.js";

const identities = [
  { address: "support@drakora.org" },
  { address: "no-reply@drakora.org" },
];
const person = (address, name = "") => ({ address, name });
const original = {
  from: [person("player@example.invalid", "Player")],
  replyTo: [person("reply@example.invalid")],
  to: [person("SUPPORT@drakora.org"), person("team@example.invalid")],
  cc: [
    person("TEAM@example.invalid"),
    person("reply@example.invalid"),
    person("other@example.invalid"),
    person("no-reply@drakora.org"),
  ],
  subject: "Player application",
  replyText: "Hello staff.\nPlease help.",
  date: "2026-10-02T12:00:00Z",
  folder: "INBOX",
  uid: 42,
  validity: "51",
};

test("reply uses Reply-To and the addressed shared identity without prefilling the editor", () => {
  const draft = replyDraft(
    "reply",
    original,
    identities,
    "no-reply@drakora.org",
  );
  assert.equal(draft.from, "support@drakora.org");
  assert.equal(draft.to, "reply@example.invalid");
  assert.equal(draft.cc, "");
  assert.equal(draft.text, "");
  assert.equal(draft.subject, "Re: Player application");
  assert.deepEqual(draft.reply, {
    kind: "reply",
    folder: "INBOX",
    uid: 42,
    validity: "51",
  });
});

test("reply all excludes shared identities and deduplicates To and Cc without changing private Bcc", () => {
  const draft = replyDraft("all", original, identities);
  assert.equal(draft.to, "reply@example.invalid");
  assert.equal(draft.cc, "team@example.invalid, other@example.invalid");
  assert.equal(draft.bcc, "");
});

test("replying to sent mail targets external recipients and preserves the sending identity", () => {
  const draft = replyDraft(
    "all",
    {
      ...original,
      from: [person("no-reply@drakora.org")],
      replyTo: [person("no-reply@drakora.org")],
      to: [person("player@example.invalid")],
      cc: [person("team@example.invalid")],
    },
    identities,
  );
  assert.equal(draft.from, "no-reply@drakora.org");
  assert.equal(draft.to, "player@example.invalid");
  assert.equal(draft.cc, "team@example.invalid");
});

test("forward starts without recipients and existing reply prefixes are not duplicated", () => {
  const draft = replyDraft("forward", original, identities);
  assert.equal(draft.to, "");
  assert.equal(draft.reply.kind, "forward");
  assert.equal(draft.subject, "Fwd: Player application");
  assert.equal(
    replyDraft(
      "reply",
      { ...original, subject: "re: Player application" },
      identities,
    ).subject,
    "re: Player application",
  );
});

test("payload includes collapsed history only at send time and keeps the draft send identity", () => {
  const draft = replyDraft("reply", original, identities);
  draft.text = "We can help.";
  const payload = draftPayload(draft);
  assert.equal(payload.sendId, draft.sendId);
  assert.match(
    payload.text,
    /^We can help\.\n\nOn .*Player <player@example.invalid> wrote:\n> Hello staff\.\n> Please help\.$/,
  );
  assert.equal("quoteText" in payload, false);
  assert.equal("composeKind" in payload, false);
  assert.equal("replyAllCc" in payload, false);
  assert.equal(draftPayload({ ...draft, quoteText: "" }).text, "We can help.");
  assert.notEqual(
    newDraft("support@drakora.org").sendId,
    newDraft("support@drakora.org").sendId,
  );
});
