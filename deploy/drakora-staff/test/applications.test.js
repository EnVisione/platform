import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../server/store.js";
import {
  applicationService,
  availableApplicationRoles,
} from "../server/applications.js";
import {
  applicationReviewAccess,
  applicationDecisionAccess,
  permissions,
} from "../server/roles.js";
import { applicationScenarios } from "../server/application-scenarios.js";
import {
  questionList,
  parseEvidenceLinks,
} from "../shared/application-form.js";
import { discordClient } from "../server/discord.js";
import { config as fixture } from "./fixture.js";

const config = {
  ...fixture,
  staffOrigin: "https://staff.example.com",
  discordBotToken: "test-token",
  applications: {
    publicOrigin: "https://example.com",
    notificationChannelId: "50",
    specialistRoles: { builder: "51", artist: "52", developer: "25" },
  },
};
function setup(
  t,
  fetcher = async () => new Response(null, { status: 404 }),
  getMinecraftLink,
) {
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  const service = applicationService(
    config,
    database.store,
    fetcher,
    getMinecraftLink,
  );
  t.after(async () => {
    await service.close();
    database.store.close();
  });
  return { service, store: database.store };
}
function answers(role = "community", communities = ["prom2"]) {
  return {
    displayName: "Application fixture",
    ign: "Test_Player",
    discordUses: "no",
    discordWhy: "I prefer another contact method.",
    discordWilling: "yes",
    contactEmail: "fixture@example.com",
    pronouns: "They/them",
    age: "24",
    timezone: "UTC",
    communities,
    hoursPerWeek: "6",
    adultConfirmed: true,
    privacyConsent: true,
    accuracyConfirmed: true,
    ...Object.fromEntries(
      questionList(role, communities).map(([key]) => [
        key,
        "A detailed synthetic answer explaining my approach and reasoning.",
      ]),
    ),
  };
}
function reviewer(rank = "28", dashboard = true) {
  const roles = [rank, ...(dashboard ? ["10"] : [])];
  return {
    id: rank,
    name: `Reviewer ${rank}`,
    roles,
    permissions: permissions(config, roles),
  };
}
function connectedDraft(
  service,
  sessionId = "session",
  role = "community",
  id = "123",
) {
  service.connect(sessionId, {
    id,
    username: "fixture",
    name: "Fixture",
    email: "verified@example.com",
    roles: [],
    avatar: null,
  });
  service.patch(sessionId, {
    role,
    answers: { ...answers(role), discordConfirmed: true },
  });
}
test("evidence accepts safe public links and no evidence is required to submit", async (t) => {
  const { service } = setup(t);
  const safe = "https://example.com/portfolio\nhttp://example.org/reference";
  assert.deepEqual(parseEvidenceLinks(safe).links, safe.split("\n"));
  for (const invalid of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://user:password@example.com",
    "not a link",
    Array(6).fill("https://example.com").join("\n"),
  ]) {
    service.patch("owner", {
      role: "community",
      answers: { ...answers(), experienceLinks: invalid },
    });
    assert.ok((await service.submit("owner")).errors.experienceLinks);
  }
  service.patch("owner", {
    answers: { experienceLinks: safe, experienceProof: "" },
  });
  const result = await service.submit("owner");
  assert.ok(result.id);
  assert.equal(service.get(result.id).answers.experienceLinks, safe);
  assert.equal(service.get(result.id).evidenceImages, undefined);
});
test("application patches reject image uploads and attachment metadata", (t) => {
  const { service, store } = setup(t);
  assert.throws(() => service.patch("session", { evidenceImages: [] }), {
    code: "invalid_request",
  });
  assert.throws(
    () =>
      service.patch("session", { answers: { evidenceImages: "image data" } }),
    { code: "invalid_request" },
  );
  assert.deepEqual(store.entries("application-image"), []);
});
test("application roles follow verified Discord rank IDs", () => {
  assert.deepEqual(availableApplicationRoles(config), [
    "community",
    "builder",
    "artist",
    "developer",
  ]);
  assert.deepEqual(availableApplicationRoles(config, { roles: ["20", "25"] }), [
    "builder",
    "artist",
  ]);
  assert.deepEqual(availableApplicationRoles(config, { roles: ["51"] }), [
    "community",
    "artist",
    "developer",
  ]);
  assert.deepEqual(availableApplicationRoles(config, { roles: ["52"] }), [
    "community",
    "builder",
    "developer",
  ]);
  assert.deepEqual(availableApplicationRoles(config, { roles: ["25"] }), [
    "community",
    "builder",
    "artist",
  ]);
  assert.deepEqual(availableApplicationRoles(config, { roles: ["51", "52"] }), [
    "community",
    "developer",
  ]);
  for (const id of ["20", "28", "21", "29", "22", "30", "23"])
    assert.deepEqual(availableApplicationRoles(config, { roles: [id] }), [
      "builder",
      "artist",
      "developer",
    ]);
  assert.deepEqual(
    availableApplicationRoles(config, { roles: ["20", "51", "52", "25"] }),
    [],
  );
  for (const [id, expected] of [
    ["20", true],
    ["21", true],
    ["22", true],
    ["28", true],
    ["29", true],
    ["30", true],
    ["23", false],
    ["25", false],
  ]) {
    assert.equal(
      applicationReviewAccess(config, {
        roles: ["10", id],
        permissions: permissions(config, ["10", id]),
      }),
      expected,
    );
    assert.equal(
      applicationReviewAccess(config, {
        roles: [id],
        permissions: permissions(config, [id]),
      }),
      false,
    );
    assert.equal(
      applicationDecisionAccess(config, {
        roles: ["10", id],
        permissions: permissions(config, ["10", id]),
      }),
      ["20", "28"].includes(id),
    );
    assert.equal(
      applicationDecisionAccess(config, {
        roles: [id],
        permissions: permissions(config, [id]),
      }),
      false,
    );
  }
  assert.deepEqual(availableApplicationRoles(config, { roles: ["24"] }), [
    "community",
    "builder",
    "artist",
    "developer",
  ]);
});
test("Discord can connect before a name or role, while a preferred name remains required", async (t) => {
  const { service } = setup(t);
  const challenge = service.challenge("session");
  const url = service.handoff(challenge, {
    id: "123",
    username: "fixture",
    name: "Discord Name",
    avatar: "https://cdn.discordapp.com/test",
    email: "fixture@example.com",
    roles: ["51"],
  });
  service.complete("session", new URL(url).searchParams.get("code"));
  const draft = service.view("session");
  assert.equal(draft.role, null);
  assert.equal(draft.answers.displayName, undefined);
  assert.equal(draft.discord.name, "Discord Name");
  assert.deepEqual(draft.roles, ["community", "artist", "developer"]);
  assert.throws(
    () => service.patch("session", { role: "builder" }),
    /application_role_unavailable/,
  );
  service.patch("session", {
    role: "artist",
    answers: { ...answers("artist"), displayName: "", discordConfirmed: true },
  });
  assert.ok((await service.submit("session")).errors.displayName);
  service.patch("session", { answers: { displayName: "Preferred name" } });
  assert.ok((await service.submit("session")).id);
  assert.throws(
    () => service.challenge("session"),
    /application_already_submitted/,
  );
});
test("only applicants without Discord must answer the final communication question", async (t) => {
  const { service } = setup(t);
  const incomplete = answers();
  delete incomplete.discordWilling;
  service.patch("without-discord", { role: "community", answers: incomplete });
  assert.ok((await service.submit("without-discord")).errors.discordWilling);
  service.patch("without-discord", { answers: { discordWilling: "maybe" } });
  assert.ok((await service.submit("without-discord")).errors.discordWilling);
  service.patch("without-discord", { answers: { discordWilling: "no" } });
  const declined = service.get((await service.submit("without-discord")).id);
  assert.equal(declined.answers.discordWilling, "no");
  assert.equal(declined.status, "Received");
  assert.equal(declined.questionnaireVersion, 5);

  service.patch("uses-discord", {
    role: "community",
    answers: { ...incomplete, discordUses: "yes", discordWhy: "" },
  });
  const existing = service.get((await service.submit("uses-discord")).id);
  assert.equal(existing.answers.discordWilling, undefined);

  service.connect("connected", {
    id: "123",
    username: "fixture",
    name: "Fixture",
    email: "verified@example.com",
    roles: [],
  });
  service.patch("connected", {
    role: "community",
    answers: { ...answers(), discordConfirmed: true },
  });
  const connected = service.get((await service.submit("connected")).id);
  assert.equal(connected.answers.discordWilling, undefined);
  assert.equal(connected.discord.id, "123");
});
test("signing out of an application preserves answers and requires a fresh Discord connection", (t) => {
  const { service } = setup(t);
  const first = service.challenge("session");
  assert.equal(service.getChallenge(first).useStaffSession, true);
  connectedDraft(service);
  const disconnected = service.disconnect("session");
  assert.equal(disconnected.discord, null);
  assert.equal(disconnected.answers.displayName, "Application fixture");
  assert.equal(disconnected.answers.discordConfirmed, undefined);
  const reconnect = service.challenge("session");
  assert.equal(service.getChallenge(reconnect).useStaffSession, false);
  service.connect("session", { id: "456", name: "Other applicant", roles: [] });
  assert.equal(service.view("session").discord.id, "456");
  assert.equal(
    service.getChallenge(service.challenge("session")).useStaffSession,
    true,
  );
});
test("one of twenty scenarios stays fixed and cannot be supplied by the applicant", (t) => {
  const { service } = setup(t);
  assert.equal(applicationScenarios.community.length, 20);
  const first = service.patch("session", { role: "community" });
  assert.ok(applicationScenarios.community.includes(first.scenario));
  assert.equal(service.view("session").scenario, first.scenario);
  assert.equal(
    service.patch("session", {
      role: "community",
      answers: { displayName: "Name" },
    }).scenario,
    first.scenario,
  );
  assert.throws(
    () => service.patch("session", { answers: { identity: { id: "20" } } }),
    /invalid_request/,
  );
  assert.equal(service.view("session").scenarios, undefined);
});
test("registered staff confirm the panel name and cannot apply during a pending correction", async (t) => {
  let link = { name: "Panel_Name", status: "pending" };
  const { service } = setup(t, undefined, (id) =>
    id === "123" ? link : undefined,
  );
  service.connect("session", {
    id: "123",
    name: "Staff",
    username: "staff",
    roles: ["28"],
    email: "fixture@example.com",
  });
  assert.equal(service.view("session").answers.ign, "Panel_Name");
  assert.deepEqual(service.view("session").linkedMinecraft, {
    name: "Panel_Name",
    changePending: false,
  });
  assert.throws(
    () => service.patch("session", { answers: { ign: "Another_Name" } }),
    /application_minecraft_link_changed/,
  );
  service.patch("session", {
    role: "builder",
    answers: {
      ...answers("builder"),
      ign: "Panel_Name",
      discordConfirmed: true,
    },
  });
  assert.ok((await service.submit("session")).errors.minecraftConfirmed);
  service.patch("session", {
    answers: {
      minecraftConfirmed: false,
      minecraftConfirmedName: "Panel_Name",
    },
  });
  assert.ok((await service.submit("session")).errors.minecraftConfirmed);
  service.patch("session", { answers: { minecraftConfirmed: true } });
  link.changeRequest = { name: "Corrected_Name" };
  assert.ok((await service.submit("session")).errors.minecraftConfirmed);
  link = { name: "Corrected_Name", status: "pending" };
  const updated = service.view("session");
  assert.equal(updated.answers.ign, "Corrected_Name");
  assert.equal(updated.answers.minecraftConfirmed, undefined);
  assert.ok((await service.submit("session")).errors.minecraftConfirmed);
  service.patch("session", {
    answers: {
      ign: "Corrected_Name",
      minecraftConfirmed: true,
      minecraftConfirmedName: "Corrected_Name",
    },
  });
  const result = await service.submit("session");
  assert.ok(result.id);
  assert.equal(service.get(result.id).answers.ign, "Corrected_Name");
});
test("panel name changes during profile lookup invalidate the confirmation before storing an application", async (t) => {
  let name = "Original";
  const { service } = setup(
    t,
    async () => {
      name = "Changed";
      return new Response(null, { status: 404 });
    },
    () => ({ name }),
  );
  service.connect("session", {
    id: "123",
    roles: ["20"],
    email: "fixture@example.com",
  });
  service.patch("session", {
    role: "artist",
    answers: {
      ...answers("artist"),
      ign: "Original",
      discordConfirmed: true,
      minecraftConfirmed: true,
      minecraftConfirmedName: "Original",
    },
  });
  assert.ok((await service.submit("session")).errors.minecraftConfirmed);
  assert.equal(service.list().total, 0);
});
test("unrecognized Discord roles never expose a stored staff Minecraft link", (t) => {
  const { service } = setup(t, undefined, () => ({ name: "PrivateName" }));
  service.connect("session", { id: "123", roles: [] });
  assert.equal(service.view("session").linkedMinecraft, null);
  assert.equal(service.view("session").answers.ign, undefined);
});
test("Jr Moderator and higher can leave feedback but only Manager and Founder can make a final decision", async (t) => {
  const { service } = setup(t);
  const user = (rank, dashboard = true) => {
    const roles = [rank, ...(dashboard ? ["10"] : [])];
    return {
      id: rank,
      name: `Reviewer ${rank}`,
      roles,
      permissions: permissions(config, roles),
    };
  };
  service.patch("session", { role: "community", answers: answers() });
  const { id } = await service.submit("session");
  for (const rank of ["30", "22", "29", "21", "28", "20"])
    service.addComment(
      id,
      user(rank),
      `I know this player from the server, ${rank}.`,
    );
  assert.equal(service.get(id).comments.length, 6);
  assert.equal(service.get(id).comments[0].author.id, "30");
  assert.throws(
    () => service.addComment(id, user("23"), "Feedback"),
    /application_review_role_required/,
  );
  assert.throws(
    () => service.addComment(id, user("20", false), "Feedback"),
    /application_review_role_required/,
  );
  assert.throws(
    () => service.addComment(id, user("30"), "  "),
    /invalid_application_comment/,
  );
  for (const rank of ["30", "22", "29", "21", "23"])
    assert.throws(
      () => service.decide(id, user(rank), "approve"),
      /application_decision_role_required/,
    );
  assert.throws(
    () => service.decide(id, user("28", false), "approve"),
    /application_decision_role_required/,
  );
  assert.throws(
    () => service.decide(id, user("28"), "grant"),
    /invalid_request/,
  );
  const approved = service.decide(
    id,
    user("28"),
    "approve",
    "Supported by staff feedback.",
  );
  assert.equal(approved.status, "Approved");
  assert.equal(approved.decision.author.id, "28");
  assert.equal(service.list().items[0].status, "Approved");
  assert.throws(
    () => service.decide(id, user("20"), "deny", "Not approved."),
    /application_already_decided/,
  );
  service.patch("another", { role: "artist", answers: answers("artist") });
  const another = await service.submit("another");
  assert.equal(
    service.decide(another.id, user("20"), "deny", "More experience is needed.")
      .status,
    "Denied",
  );
});
test("anonymous applicants need email and adult confirmation; conditional community answers are enforced", async (t) => {
  const { service } = setup(t);
  service.patch("session", {
    role: "community",
    answers: {
      ...answers(),
      contactEmail: "",
      age: "17",
      communities: ["prom2", "rh"],
    },
  });
  const result = await service.submit("session");
  assert.ok(result.errors.contactEmail);
  assert.ok(result.errors.age);
  assert.ok(result.errors.rhExperience);
  assert.equal(service.list().total, 0);
});
test("optional Discord login binds the handoff to its originating draft and discards access tokens", async (t) => {
  const { service } = setup(t);
  service.patch("session", {
    role: "community",
    answers: { displayName: "Preferred name" },
  });
  const challenge = service.challenge("session");
  const url = service.handoff(challenge, {
    id: "123",
    username: "fixture",
    name: "Discord Name",
    avatar: "https://cdn.discordapp.com/test",
    email: null,
    roles: [],
  });
  const code = new URL(url).searchParams.get("code");
  assert.throws(
    () => service.complete("other-session", code),
    /invalid_login_state/,
  );
  service.complete("session", code);
  assert.throws(() => service.complete("session", code), /invalid_login_state/);
  assert.equal(service.view("session").answers.displayName, "Preferred name");
  assert.equal(service.view("session").discord.emailAvailable, false);
  service.patch("session", {
    answers: { ...answers(), discordConfirmed: true, contactEmail: "" },
  });
  assert.ok((await service.submit("session")).errors.contactEmail);
  service.patch("session", {
    answers: { contactEmail: "fixture@example.com" },
  });
  assert.ok((await service.submit("session")).id);
});
test("submission is idempotent and notifications never ping users or roles", async (t) => {
  const sent = [];
  const { service, store } = setup(t, async (url, options) => {
    if (url.includes("api.mojang.com"))
      return Response.json({ id: "a".repeat(32), name: "Test_Player" });
    if (url.endsWith("/users/@me/channels")) {
      assert.deepEqual(JSON.parse(options.body), { recipient_id: "123" });
      return Response.json({ id: "999" });
    }
    sent.push({ url, ...JSON.parse(options.body) });
    return Response.json({ id: "notification-id" });
  });
  service.patch("session", {
    role: "developer",
    answers: answers("developer", ["discord"]),
  });
  service.connect("session", {
    id: "123",
    username: "fixture",
    name: "Fixture",
    email: "verified@example.com",
    roles: [],
    avatar: null,
  });
  service.patch("session", { answers: { discordConfirmed: true } });
  const first = await service.submit("session");
  assert.deepEqual(await service.submit("session"), first);
  assert.equal(service.list().total, 1);
  assert.equal(service.get(first.id).contactEmail, "verified@example.com");
  assert.equal(
    service.get(first.id).minecraft.verification,
    "Awaiting in-game verification",
  );
  assert.equal(service.view("session").answers, undefined);
  await service.delivery();
  await service.delivery();
  assert.equal(sent.length, 2);
  const notice = sent.find((message) => message.url.includes("/channels/50/"));
  const dm = sent.find((message) => message.url.includes("/channels/999/"));
  assert.match(dm.embeds[0].description, /submitted and will be reviewed/);
  assert.ok(service.get(first.id).notifications[0].sentAt);
  assert.notEqual(notice.nonce, dm.nonce);
  assert.deepEqual(notice.allowed_mentions, {
    parse: [],
    users: [],
    roles: [],
    replied_user: false,
  });
  assert.match(notice.content, /<@123>/);
  assert.equal(
    notice.components[0].components[0].url,
    `${config.staffOrigin}/applications/${first.id}`,
  );
  assert.equal(store.page("application-notification").total, 0);
});
test("a notification failure preserves the application and retries later", async (t) => {
  const { service, store } = setup(
    t,
    async (url) =>
      new Response(null, { status: url.includes("mojang") ? 404 : 503 }),
  );
  service.patch("session", { role: "artist", answers: answers("artist") });
  const { id } = await service.submit("session");
  await service.delivery();
  assert.ok(service.get(id));
  assert.equal(store.get("application-notification", id).attempts, 1);
});
test("application rows are encrypted on disk and rolled back together on failure", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "drakora-application-test-"));
  const path = join(directory, "applications.sqlite");
  const { store } = openStore(path, randomBytes(32).toString("base64"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  store.set("application", "id", { email: "private-applicant@example.com" });
  assert.throws(() =>
    store.transaction(() => {
      store.set("application", "rollback", { value: 1 });
      throw new Error("rollback");
    }),
  );
  assert.equal(store.get("application", "rollback"), undefined);
  for (const file of [path, `${path}-wal`])
    assert.equal(
      readFileSync(file).includes(Buffer.from("private-applicant@example.com")),
      false,
    );
});
test("public Discord identity works without a staff role or verified email", async (t) => {
  const { store } = setup(t);
  const discord = discordClient(config, store, async (url) => {
    if (url.endsWith("/token"))
      return Response.json({ access_token: "temporary", expires_in: 3600 });
    if (url.endsWith("/users/@me"))
      return Response.json({ id: "123", username: "fixture", verified: false });
    return new Response(null, { status: 404 });
  });
  const identity = await discord.identity("code");
  assert.equal(identity.email, null);
  assert.deepEqual(identity.roles, []);
  assert.equal(identity.tokens, undefined);
  assert.equal(store.get("user", "123"), undefined);
});

test("a changed draft is not submitted under an earlier validated identity", async (t) => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const { service } = setup(t, async () => {
    await wait;
    return new Response(null, { status: 404 });
  });
  service.patch("session", { role: "community", answers: answers() });
  const submitting = service.submit("session");
  service.patch("session", { answers: { ign: "Other_Player" } });
  release();
  await assert.rejects(submitting, /application_draft_changed/);
  assert.equal(service.list().total, 0);
});

test("starting another application keeps the submitted record and creates a new draft", async (t) => {
  const { service } = setup(t);
  assert.throws(() => service.restart("session"), /application_draft_exists/);
  service.patch("session", { role: "community", answers: answers() });
  const submitted = await service.submit("session");
  const next = service.restart("session");
  assert.notEqual(next.id, submitted.id);
  assert.deepEqual(next.answers, {});
  assert.equal(service.list().total, 1);
  assert.ok(service.get(submitted.id));
});

test("review starts once, requires decision access, and queues ordered applicant updates", async (t) => {
  const dms = [];
  const { service, store } = setup(t, async (url, options) => {
    if (url.includes("mojang")) return new Response(null, { status: 404 });
    if (url.endsWith("/users/@me/channels"))
      return Response.json({ id: "999" });
    const payload = JSON.parse(options.body);
    if (url.includes("/channels/999/")) dms.push(payload);
    return Response.json({ id: `message-${dms.length}` });
  });
  connectedDraft(service);
  const { id } = await service.submit("session");
  for (const rank of ["21", "30", "22", "29", "23"])
    assert.throws(
      () => service.startReview(id, reviewer(rank)),
      /application_decision_role_required/,
    );
  assert.throws(
    () => service.startReview(id, reviewer("20", false)),
    /application_decision_role_required/,
  );
  const reviewing = service.startReview(id, reviewer());
  assert.equal(reviewing.status, "Reviewing");
  assert.equal(reviewing.review.author.id, "28");
  assert.equal(service.list().items[0].status, "Reviewing");
  assert.deepEqual(
    service.startReview(id, reviewer("20")).review,
    reviewing.review,
  );
  assert.equal(store.page("application-notification").total, 3);
  service.decide(id, reviewer("20"), "approve", "Welcome to the team.");
  assert.throws(
    () => service.startReview(id, reviewer()),
    /application_already_decided/,
  );
  for (let i = 0; i < 4; i++) await service.delivery();
  assert.deepEqual(
    dms.map((message) => message.embeds[0].title),
    [
      "Application received",
      "Application under review",
      "Application approved",
    ],
  );
  assert.equal(new Set(dms.map((message) => message.nonce)).size, 3);
  for (const message of dms)
    assert.deepEqual(message.allowed_mentions.parse, []);
  assert.equal(store.page("application-notification").total, 0);
});

test("denial needs a message and at least seven days, persists cooldown across drafts and service restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { service, store } = setup(t);
  connectedDraft(service);
  const { id } = await service.submit("session");
  assert.throws(
    () => service.decide(id, reviewer(), "deny", "  "),
    /application_denial_reason_required/,
  );
  for (const days of [6, 0, 7.5, "7", null, 366])
    assert.throws(
      () =>
        service.decide(id, reviewer(), "deny", "More experience needed.", days),
      /invalid_reapplication_wait/,
    );
  assert.equal(service.get(id).status, "Received");
  const denied = service.decide(
    id,
    reviewer(),
    "deny",
    "Please gain more community experience.",
    10,
  );
  const until = denied.decision.reapplyAfter;
  assert.equal(until, Date.now() + 10 * 86400000);
  assert.equal(service.list().items[0].status, "Denied");
  const dm = store.get("application-notification", `${id}:denied`);
  assert.equal(dm.payload.embeds[0].description, denied.decision.reason);
  assert.match(
    dm.payload.embeds[0].fields[1].value,
    new RegExp(String(until / 1000)),
  );
  await service.close();
  const restarted = applicationService(
    config,
    store,
    async () => new Response(null, { status: 404 }),
  );
  t.after(() => restarted.close());
  connectedDraft(restarted, "new-browser");
  restarted.patch("new-browser", {
    answers: { ign: "Another_Name", contactEmail: "changed@example.com" },
  });
  assert.equal(
    restarted.view("new-browser").reapplicationWaits.community,
    until,
  );
  assert.ok((await restarted.submit("new-browser")).errors.reapplication);
  restarted.patch("anonymous", {
    role: "community",
    answers: {
      ...answers(),
      ign: "test_player",
      contactEmail: "VERIFIED@example.com",
    },
  });
  assert.ok((await restarted.submit("anonymous")).errors.reapplication);
  connectedDraft(restarted, "other-role", "artist");
  assert.ok((await restarted.submit("other-role")).id);
  t.mock.timers.setTime(until - 1);
  connectedDraft(restarted, "deadline");
  assert.ok((await restarted.submit("deadline")).errors.reapplication);
  t.mock.timers.setTime(until);
  assert.equal(
    restarted.view("deadline").reapplicationWaits.community,
    undefined,
  );
  assert.ok((await restarted.submit("deadline")).id);
});

test("denial during a new submission blocks it after profile lookup", async (t) => {
  let release;
  let pause = false;
  const { service } = setup(t, async () => {
    if (pause)
      await new Promise((resolve) => {
        release = resolve;
      });
    return new Response(null, { status: 404 });
  });
  connectedDraft(service);
  const { id } = await service.submit("session");
  connectedDraft(service, "in-flight");
  service.patch("in-flight", { answers: { ign: "Other_Player" } });
  pause = true;
  const pending = service.submit("in-flight");
  service.decide(id, reviewer(), "deny", "Please wait before reapplying.");
  release();
  assert.ok((await pending).errors.reapplication);
  assert.equal(service.list().total, 1);
});

test("closed Discord DMs do not undo submission or staff delivery", async (t) => {
  const { service, store } = setup(t, async (url) => {
    if (url.includes("mojang")) return new Response(null, { status: 404 });
    if (url.endsWith("/users/@me/channels"))
      return Response.json({ id: "999" });
    if (url.includes("/channels/999/"))
      return new Response(null, { status: 403 });
    return Response.json({ id: "notice" });
  });
  connectedDraft(service);
  const { id } = await service.submit("session");
  await service.delivery();
  await service.delivery();
  assert.equal(service.get(id).status, "Received");
  assert.equal(service.get(id).notifications[0].blocked, true);
  assert.ok(service.get(id).notifications[0].failedAt);
  assert.ok(store.get("application-delivery", id).sentAt);
  assert.equal(store.page("application-notification").total, 0);
});

test("Discord rate limits retain messages and delay retries for the specified time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  let limited = true;
  let calls = 0;
  const { service, store } = setup(t, async (url) => {
    if (url.includes("mojang")) return new Response(null, { status: 404 });
    calls++;
    if (limited) return Response.json({ retry_after: 125.5 }, { status: 429 });
    if (url.endsWith("/users/@me/channels"))
      return Response.json({ id: "999" });
    return Response.json({ id: "delivered" });
  });
  connectedDraft(service);
  const { id } = await service.submit("session");
  await service.delivery();
  const pending = store.get("application-notification", `${id}:received`);
  assert.equal(pending.nextAt, Date.now() + 125500);
  assert.equal(calls, 1);
  await service.delivery();
  assert.equal(calls, 1);
  limited = false;
  t.mock.timers.setTime(pending.nextAt);
  await service.delivery();
  assert.ok(service.get(id).notifications[0].sentAt);
  assert.equal(store.page("application-notification").total, 0);
});

test("notification queue failures roll back submission and decisions together", async (t) => {
  const { service, store } = setup(t);
  connectedDraft(service);
  const original = store.set.bind(store);
  let rejectQueue = true;
  t.mock.method(store, "set", (kind, key, value, expires) => {
    if (
      rejectQueue &&
      kind === "application-notification" &&
      key.endsWith(":received")
    )
      throw new Error("queue write failed");
    return original(kind, key, value, expires);
  });
  await assert.rejects(service.submit("session"), /queue write failed/);
  assert.equal(service.list().total, 0);
  assert.equal(store.page("application-notification").total, 0);
  assert.equal(service.view("session").submitted, undefined);
  rejectQueue = false;
  const { id } = await service.submit("session");
  t.mock.method(store, "set", (kind, key, value, expires) => {
    if (kind === "application-notification" && key.endsWith(":denied"))
      throw new Error("queue write failed");
    return original(kind, key, value, expires);
  });
  assert.throws(
    () => service.decide(id, reviewer(), "deny", "Please gain experience."),
    /queue write failed/,
  );
  assert.equal(service.get(id).status, "Received");
  assert.equal(service.list().items[0].status, "Received");
  assert.equal(store.page("application-cooldown").total, 0);
});
