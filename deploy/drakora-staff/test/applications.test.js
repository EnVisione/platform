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
import { applicationNotifications } from "../server/application-notifications.js";
import { rolePermissions } from "../server/role-permissions.js";
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
  settings = config,
  getStaffAvatar,
) {
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  const service = applicationService(
    settings,
    database.store,
    fetcher,
    getMinecraftLink,
    getStaffAvatar,
  );
  t.after(async () => {
    await service.close();
    database.store.close();
  });
  return { service, store: database.store };
}

test("Overview counts pending applications and excludes completed decisions", (t) => {
  const { service, store } = setup(t);
  for (const [id, status] of Object.entries({
    a: "Received",
    b: "Reviewing",
    c: "Approved",
    d: "Denied",
  }))
    store.set("application-summary", id, { status });
  assert.deepEqual(service.attention(), {
    received: 1,
    reviewing: 1,
    pending: 2,
  });
});

test("application dates combine with applicant, role and status filters without exposing private summary fields", (t) => {
  const { service, store } = setup(t);
  const at = Date.parse("2026-10-03T23:59:59.999Z");
  for (let i = 0; i < 52; i++)
    store.set(
      "application-summary",
      String(i).padStart(3, "0"),
      {
        id: String(i),
        createdAt: at,
        role: "builder",
        status: "Received",
        name: "Selected applicant",
        browserSessionHash: "private",
      },
      Number.MAX_SAFE_INTEGER,
    );
  store.set(
    "application-summary",
    "older",
    {
      id: "older",
      createdAt: at - 86400000,
      role: "builder",
      status: "Received",
      name: "Selected applicant",
    },
    Number.MAX_SAFE_INTEGER,
  );
  const result = service.list(50, {
    from: "2026-10-03",
    to: "2026-10-03",
    role: "builder",
    status: "Received",
    name: "SELECTED",
  });
  assert.equal(result.total, 52);
  assert.equal(result.items.length, 2);
  assert.equal(
    result.items.some((item) => Object.hasOwn(item, "browserSessionHash")),
    false,
  );
  assert.equal(service.list(0, { from: "2026-10-04" }).total, 0);
});
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
  assert.equal(declined.questionnaireVersion, 6);

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
test("feedback uses trusted Discord avatars and restores legacy authors from cached profiles", async (t) => {
  const profiles = new Map();
  const { service, store } = setup(t, undefined, undefined, config, (id) =>
    profiles.get(id),
  );
  service.patch("session", { role: "community", answers: answers() });
  const { id } = await service.submit("session");
  const author = {
    ...reviewer(),
    avatar: "https://cdn.discordapp.com/embed/avatars/0.png",
  };
  const saved = service.addComment(
    id,
    author,
    "I know this player from the server.",
  );
  assert.equal(saved.comments[0].author.avatar, author.avatar);
  assert.equal(
    store.get("application", id).comments[0].author.avatar,
    author.avatar,
  );
  profiles.set(author.id, "https://cdn.discordapp.com/embed/avatars/1.png");
  assert.equal(
    service.get(id).comments[0].author.avatar,
    profiles.get(author.id),
  );
  const legacy = store.get("application", id);
  delete legacy.comments[0].author.avatar;
  store.set("application", id, legacy, Number.MAX_SAFE_INTEGER);
  assert.equal(
    service.get(id).comments[0].author.avatar,
    profiles.get(author.id),
  );
  assert.equal(
    store.get("application", id).comments[0].author.avatar,
    undefined,
  );
  profiles.clear();
  assert.equal(service.get(id).comments[0].author.avatar, null);
  assert.equal(service.get(id).comments[0].author.name, author.name);
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
  assert.match(dm.embeds[0].description, /Thanks for applying/);
  assert.match(dm.embeds[0].description, /keep you updated right here/);
  assert.equal(dm.embeds[0].color, 0x2dd4bf);
  assert.equal(dm.embeds[0].fields[1].value, "Received");
  assert.equal(dm.embeds[0].thumbnail, undefined);
  assert.equal(dm.embeds[0].author.name, "Drakora · Staff Applications");
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
test("applicant updates preserve full feedback within Discord embed limits", async (t) => {
  const { store } = setup(t);
  const notifications = applicationNotifications(config, store, () =>
    assert.fail("No live Discord request is needed"),
  );
  t.after(() => notifications.close());
  const record = {
    id: "00000000-0000-4000-8000-000000000000",
    role: "artist",
    answers: { displayName: "*".repeat(80) },
    discord: {
      id: "123",
      avatar: "https://cdn.discordapp.com/embed/avatars/0.png",
    },
    decision: {
      reason: "\\*".repeat(1000),
      reapplyAfter: Date.now() + 7 * 86400000,
      reapplyDays: 7,
    },
  };
  for (const event of ["received", "reviewing", "approved", "denied"]) {
    notifications.queueApplicant(record, event);
    const { embeds } = store.get(
      "application-notification",
      `${record.id}:${event}`,
    ).payload;
    assert.equal(embeds[0].thumbnail.url, record.discord.avatar);
    assert.ok(embeds[0].description.includes("\\*"));
    assert.equal(
      new Date(embeds[0].timestamp).toISOString(),
      embeds[0].timestamp,
    );
    let characters = 0;
    for (const embed of embeds) {
      assert.ok(embed.title.length <= 256);
      assert.ok(embed.description.length <= 4096);
      characters += embed.title.length + embed.description.length;
      characters += embed.author?.name.length ?? 0;
      characters += embed.footer?.text.length ?? 0;
      for (const field of embed.fields ?? []) {
        assert.ok(field.name.length <= 256);
        assert.ok(field.value.length <= 1024);
        characters += field.name.length + field.value.length;
      }
    }
    assert.ok(characters <= 6000);
    if (event === "approved" || event === "denied") {
      assert.equal(embeds.length, 2);
      assert.equal(embeds[1].description.length, 4000);
      assert.equal(
        embeds[1].description.replaceAll("\\", ""),
        "*".repeat(1000),
      );
    } else {
      assert.equal(embeds.length, 1);
    }
  }
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

test("applicant history finds earlier Discord applications and exposes only their current public summaries", async (t) => {
  const { service, store } = setup(t);
  connectedDraft(service, "first", "community", "123");
  const first = await service.submit("first");
  service.startReview(first.id, reviewer());
  service.addComment(first.id, reviewer(), "Private staff feedback.");
  const record = service.get(first.id);
  const key = `${record.createdAt}.${record.id}`;
  const { browserSessionHash, ...legacy } = store.get(
    "application-summary",
    key,
  );
  store.set("application-summary", key, legacy, Number.MAX_SAFE_INTEGER);
  connectedDraft(service, "other", "developer", "456");
  await service.submit("other");
  connectedDraft(service, "second-browser", "builder", "123");
  const second = await service.submit("second-browser");
  const result = service.history("second-browser");
  assert.equal(result.total, 2);
  assert.equal(
    result.items.find((item) => item.id === first.id).status,
    "Reviewing",
  );
  assert.equal(
    result.items.find((item) => item.id === second.id).status,
    "Received",
  );
  for (const item of result.items)
    assert.deepEqual(Object.keys(item).sort(), [
      "createdAt",
      "id",
      "ign",
      "role",
      "status",
    ]);
  assert.equal(service.history("stranger").total, 0);
  service.decide(first.id, reviewer(), "approve");
  assert.equal(
    service.history("second-browser").items.find((item) => item.id === first.id)
      .status,
    "Approved",
  );
  service.restart("second-browser");
  service.disconnect("second-browser");
  assert.equal(service.history("second-browser").total, 0);
  service.connect("second-browser", { id: "456", name: "Other", roles: [] });
  assert.equal(service.history("second-browser").total, 1);
  assert.ok(
    service.list().items.every((item) => item.browserSessionHash === undefined),
  );
});

test("anonymous history stays with its browser through new drafts and service restart, including the existing receipt", async (t) => {
  const { service, store } = setup(t);
  service.patch("owner", { role: "community", answers: answers() });
  const first = await service.submit("owner");
  const record = service.get(first.id);
  const key = `${record.createdAt}.${record.id}`;
  const { browserSessionHash, ...legacy } = store.get(
    "application-summary",
    key,
  );
  store.set("application-summary", key, legacy, Number.MAX_SAFE_INTEGER);
  assert.equal(service.history("owner").total, 1);
  service.restart("owner");
  service.patch("owner", { role: "builder", answers: answers("builder") });
  const second = await service.submit("owner");
  service.decide(
    first.id,
    reviewer(),
    "deny",
    "Please gain more experience.",
    7,
  );
  service.patch("other", { role: "artist", answers: answers("artist") });
  await service.submit("other");
  assert.equal(service.history("owner").total, 2);
  assert.equal(service.history("other").total, 1);
  const restarted = applicationService(
    config,
    store,
    async () => new Response(null, { status: 404 }),
  );
  t.after(() => restarted.close());
  const items = restarted.history("owner").items;
  assert.equal(items.find((item) => item.id === first.id).status, "Denied");
  assert.equal(items.find((item) => item.id === second.id).status, "Received");
  assert.equal(restarted.history("new-browser").total, 0);
});

test("applicant history paginates only owned applications and rejects invalid offsets", (t) => {
  const { service, store } = setup(t);
  service.connect("owner", { id: "123", name: "Fixture", roles: [] });
  for (let i = 0; i < 45; i++)
    store.set(
      "application-summary",
      String(i).padStart(3, "0"),
      {
        id: `application-${i}`,
        createdAt: i,
        role: "artist",
        ign: "Test_Player",
        discordId: i % 2 ? "456" : "123",
        status: "Received",
      },
      Number.MAX_SAFE_INTEGER,
    );
  const first = service.history("owner");
  const last = service.history("owner", 20);
  assert.equal(first.total, 23);
  assert.equal(first.items.length, 20);
  assert.equal(last.items.length, 3);
  assert.deepEqual(
    last.items.map((item) => item.id),
    ["application-4", "application-2", "application-0"],
  );
  assert.equal(
    new Set([...first.items, ...last.items].map((item) => item.id)).size,
    23,
  );
  for (const offset of [
    -1,
    1.2,
    NaN,
    Infinity,
    "0",
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => service.history("owner", offset), /invalid_request/);
});

test("staff history matches Discord identity across name changes and returns current statuses without the open application", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { service } = setup(t);
  const previous = [];
  for (const role of ["community", "builder", "artist"]) {
    connectedDraft(service, role, role, "123");
    previous.push(await service.submit(role));
    t.mock.timers.tick(10);
  }
  service.decide(previous[0].id, reviewer(), "deny", "", 0);
  service.startReview(previous[1].id, reviewer());
  service.decide(previous[2].id, reviewer(), "approve");
  connectedDraft(service, "unrelated", "developer", "456");
  service.patch("unrelated", { answers: { ign: "Renamed_Player" } });
  await service.submit("unrelated");
  t.mock.timers.tick(10);
  connectedDraft(service, "current", "developer", "123");
  service.patch("current", { answers: { ign: "Renamed_Player" } });
  const current = await service.submit("current");
  const page = service.previousApplications(current.id);
  assert.equal(page.total, 3);
  assert.deepEqual(
    page.items.map(({ id }) => id),
    previous.map(({ id }) => id).reverse(),
  );
  assert.deepEqual(
    page.items.map(({ status }) => status),
    ["Approved", "Reviewing", "Denied"],
  );
  for (const item of page.items)
    assert.deepEqual(Object.keys(item).sort(), [
      "createdAt",
      "id",
      "ign",
      "role",
      "status",
    ]);
  service.decide(previous[1].id, reviewer(), "approve");
  assert.equal(
    service
      .previousApplications(current.id)
      .items.find(({ id }) => id === previous[1].id).status,
    "Approved",
  );
  assert.throws(() => service.previousApplications("missing"), {
    code: "application_not_found",
    status: 404,
  });
});

test("staff history matches anonymous contact and Minecraft name together without granting public history access", async (t) => {
  const { service } = setup(t);
  service.patch("first", { role: "community", answers: answers() });
  const first = await service.submit("first");
  for (const [session, changes] of [
    ["wrong-email", { contactEmail: "someone-else@example.com" }],
    ["wrong-ign", { ign: "Another_Player" }],
  ]) {
    service.patch(session, {
      role: "artist",
      answers: { ...answers("artist"), ...changes },
    });
    await service.submit(session);
  }
  service.patch("current", {
    role: "builder",
    answers: {
      ...answers("builder"),
      contactEmail: "FIXTURE@example.com",
      ign: "test_player",
      displayName: "New preferred name",
    },
  });
  const current = await service.submit("current");
  assert.deepEqual(
    service.previousApplications(current.id).items.map(({ id }) => id),
    [first.id],
  );
  assert.deepEqual(
    service.previousApplications(first.id).items.map(({ id }) => id),
    [current.id],
  );
  assert.equal(service.history("current").total, 1);
  assert.equal(service.history("stranger").total, 0);
});

test("staff history paginates matching applications and validates offsets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { service } = setup(t);
  const ids = [];
  for (let index = 0; index < 12; index++) {
    const session = `history-page-${index}`;
    connectedDraft(service, session, "builder", "123");
    ids.push((await service.submit(session)).id);
    t.mock.timers.tick(10);
  }
  const current = ids.pop();
  const pages = [0, 5, 10].map((offset) =>
    service.previousApplications(current, offset),
  );
  assert.deepEqual(
    pages.map(({ total, pageSize, items }) => [total, pageSize, items.length]),
    [
      [11, 5, 5],
      [11, 5, 5],
      [11, 5, 1],
    ],
  );
  assert.deepEqual(
    pages.flatMap(({ items }) => items.map(({ id }) => id)),
    ids.reverse(),
  );
  for (const offset of [
    -1,
    1.5,
    NaN,
    Infinity,
    "0",
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => service.previousApplications(current, offset), {
      code: "invalid_request",
      status: 400,
    });
});

test("review starts once, requires decision access, and queues ordered applicant updates", async (t) => {
  const dms = [];
  const notices = [];
  const { service, store } = setup(t, async (url, options) => {
    if (url.includes("mojang")) return new Response(null, { status: 404 });
    if (url.endsWith("/users/@me/channels"))
      return Response.json({ id: "999" });
    const payload = JSON.parse(options.body);
    if (url.includes("/channels/999/")) dms.push(payload);
    if (url.includes("/channels/50/")) notices.push(payload);
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
  assert.equal(store.page("application-notification").total, 4);
  service.decide(id, reviewer("20"), "approve", "Welcome to the team.");
  assert.throws(
    () => service.startReview(id, reviewer()),
    /application_already_decided/,
  );
  for (let i = 0; i < 4; i++) await service.delivery();
  assert.deepEqual(
    dms.map((message) => message.embeds[0].title),
    [
      "📬 We received your application!",
      "🔎 Your application is under review",
      "🎉 Welcome to the Drakora team!",
    ],
  );
  assert.deepEqual(
    dms.map((message) => message.embeds[0].color),
    [0x2dd4bf, 0x5865f2, 0x3ba55c],
  );
  assert.equal(dms[1].embeds[0].fields[1].value, "In review");
  assert.match(dms[2].embeds[0].description, /excited to welcome you/);
  assert.equal(dms[2].embeds[1].description, "Welcome to the team.");
  assert.equal(new Set(dms.map((message) => message.nonce)).size, 3);
  assert.equal(notices.length, 3);
  assert.match(notices[0].content, /just filled out/);
  assert.match(notices[1].content, /^<@28> started reviewing .*<@123>/);
  assert.match(notices[2].content, /^<@20> accepted .*<@123>/);
  assert.match(notices[2].content, /Welcome to the staff team!/);
  assert.equal(notices[1].embeds[0].title, "Application under review");
  assert.equal(notices[1].embeds[0].color, 0x5865f2);
  assert.equal(notices[2].embeds[0].color, 0x3ba55c);
  assert.equal(notices[2].embeds[0].description, "Welcome to the team.");
  for (const notice of notices.slice(1)) {
    assert.equal(
      notice.embeds[0].fields.at(-1).value,
      "Applicant notified by DM.",
    );
    assert.equal(
      notice.components[0].components[0].url,
      `${config.staffOrigin}/applications/${id}`,
    );
  }
  assert.equal(
    new Set([...dms, ...notices].map((message) => message.nonce)).size,
    6,
  );
  for (const message of [...dms, ...notices]) {
    assert.deepEqual(message.allowed_mentions, {
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    });
    assert.equal(message.enforce_nonce, true);
  }
  assert.equal(store.page("application-notification").total, 0);
});

test("application filters combine type and status and retain denied records after cleanup and restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { service, store } = setup(t);
  const roles = ["community", "developer", "artist", "builder"];
  const statuses = ["Received", "Reviewing", "Approved", "Denied"];
  const ids = [];
  for (const role of roles) {
    for (const [index, status] of statuses.entries()) {
      const session = `${role}-${index}`;
      service.patch(session, {
        role,
        answers: {
          ...answers(role),
          ign: `${role}_${index}`,
          contactEmail: `${session}@example.com`,
        },
      });
      const { id } = await service.submit(session);
      ids.push(id);
      if (status === "Reviewing") service.startReview(id, reviewer());
      if (status === "Approved") service.decide(id, reviewer(), "approve");
      if (status === "Denied")
        service.decide(id, reviewer(), "deny", "More role experience needed.");
    }
  }
  assert.equal(service.list().total, 16);
  for (const role of roles) {
    const page = service.list(0, { role });
    assert.equal(page.total, 4);
    assert.ok(page.items.every((item) => item.role === role));
    for (const status of statuses) {
      const combined = service.list(0, { role, status });
      assert.equal(combined.total, 1);
      assert.equal(combined.items[0].role, role);
      assert.equal(combined.items[0].status, status);
    }
  }
  for (const status of statuses) {
    const page = service.list(0, { status });
    assert.equal(page.total, 4);
    assert.ok(page.items.every((item) => item.status === status));
  }
  const deniedId = service.list(0, { role: "builder", status: "Denied" })
    .items[0].id;
  t.mock.timers.setTime(Date.now() + 8 * 86400000);
  store.clean();
  await service.close();
  const restarted = applicationService(
    config,
    store,
    async () => new Response(null, { status: 404 }),
  );
  t.after(() => restarted.close());
  assert.equal(restarted.list(0, { status: "Denied" }).total, 4);
  assert.equal(
    restarted.get(deniedId).decision.reason,
    "More role experience needed.",
  );
  assert.equal(restarted.get(deniedId).answers.ign, "builder_3");
  assert.equal(
    restarted.list(0, { name: "BUILDER_3", status: "Denied" }).items[0].id,
    deniedId,
  );
  assert.equal(restarted.list().total, 16);
  assert.ok(ids.every((id) => restarted.get(id)));
});

test("application name filters match preferred names, Minecraft names, and Discord IDs", (t) => {
  const { service, store } = setup(t);
  const rows = [
    {
      id: "builder",
      name: "Rani [Builder]",
      ign: "Lunar_Player",
      discordId: "123456789012345678",
      role: "builder",
      status: "Received",
    },
    {
      id: "artist",
      name: "Rani",
      ign: "Lunar_Player",
      discordId: "123456789012345678",
      role: "artist",
      status: "Denied",
    },
    {
      id: "developer",
      name: "Another applicant",
      ign: "Rani_Dev",
      discordId: "987654321098765432",
      role: "developer",
      status: "Reviewing",
    },
    { id: "legacy", role: "community", status: "Received" },
  ];
  for (const [index, row] of rows.entries())
    store.set(
      "application-summary",
      `${Date.now() + index}.${row.id}`,
      { ...row, browserSessionHash: "private-session-hash" },
      Number.MAX_SAFE_INTEGER,
    );
  assert.equal(service.list(0, { name: "  rAnI  " }).total, 3);
  assert.equal(service.list(0, { name: "lUnAr_PlAyEr" }).total, 2);
  const account = service.list(0, { name: "123456789012345678" });
  assert.equal(account.total, 2);
  assert.deepEqual(
    new Set(account.items.map((item) => item.id)),
    new Set(["builder", "artist"]),
  );
  assert.ok(
    account.items.every((item) => !Object.hasOwn(item, "browserSessionHash")),
  );
  assert.equal(service.list(0, { name: "[Builder]" }).items[0].id, "builder");
  assert.equal(service.list(0, { name: "%" }).total, 0);
  assert.equal(service.list(0, { name: "private-session-hash" }).total, 0);
  assert.equal(service.list(0, { name: "   " }).total, 4);
  assert.deepEqual(service.list(0, { name: "not found" }), {
    items: [],
    total: 0,
  });
  assert.equal(
    service.list(0, { name: "Rani", role: "artist", status: "Denied" }).items[0]
      .id,
    "artist",
  );
});

test("application filters search beyond the first page and paginate matching results only", (t) => {
  const { service, store } = setup(t);
  const createdAt = Date.now();
  for (let index = 0; index < 110; index++) {
    const row = {
      id: `summary-${index}`,
      createdAt: createdAt + index,
      role: index < 30 ? "artist" : "community",
      status: index === 29 ? "Reviewing" : "Received",
      name: index < 80 ? "Rani" : "Another applicant",
    };
    store.set(
      "application-summary",
      `${row.createdAt}.${row.id}`,
      row,
      Number.MAX_SAFE_INTEGER,
    );
  }
  store.set(
    "application-summary",
    "expired",
    { role: "artist", status: "Reviewing", name: "Rani" },
    Date.now() - 1,
  );
  store.set(
    "unrelated",
    "other",
    { role: "artist", status: "Reviewing" },
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(service.list().total, 110);
  assert.equal(service.list().items.length, 50);
  const first = service.list(0, { role: "community", status: "Received" });
  const second = service.list(50, { role: "community", status: "Received" });
  assert.equal(first.total, 80);
  assert.equal(second.total, 80);
  assert.equal(first.items.length, 50);
  assert.equal(second.items.length, 30);
  assert.equal(first.items[0].id, "summary-109");
  assert.equal(second.items[0].id, "summary-59");
  assert.equal(second.items.at(-1).id, "summary-30");
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
    80,
  );
  const older = service.list(0, { role: "artist", status: "Reviewing" });
  assert.equal(older.total, 1);
  assert.equal(older.items[0].id, "summary-29");
  assert.deepEqual(service.list(0, { role: "community", status: "Denied" }), {
    items: [],
    total: 0,
  });
  assert.deepEqual(service.list(100, { role: "community" }), {
    items: [],
    total: 80,
  });
  const namedFirst = service.list(0, { name: "Rani" });
  const namedSecond = service.list(50, { name: "Rani" });
  assert.equal(namedFirst.total, 80);
  assert.equal(namedSecond.total, 80);
  assert.equal(namedFirst.items.length, 50);
  assert.equal(namedFirst.items[0].id, "summary-79");
  assert.equal(namedSecond.items.length, 30);
  assert.equal(namedSecond.items.at(-1).id, "summary-0");
  assert.equal(
    new Set([...namedFirst.items, ...namedSecond.items].map((item) => item.id))
      .size,
    80,
  );
  assert.equal(
    service.list(0, { name: "Rani", role: "community", status: "Received" })
      .total,
    50,
  );
  assert.equal(
    service.list(0, { name: "Rani", status: "Reviewing" }).items[0].id,
    "summary-29",
  );
});

test("application filters reject invalid types, statuses, names, and offsets", (t) => {
  const { service } = setup(t);
  for (const role of [
    "worker",
    "constructor",
    "toString",
    ["community"],
    null,
    {},
  ])
    assert.throws(
      () => service.list(0, { role }),
      (error) => error.code === "invalid_request" && error.status === 400,
    );
  for (const status of [
    "Pending",
    "approved",
    "constructor",
    ["Denied"],
    null,
    {},
  ])
    assert.throws(
      () => service.list(0, { status }),
      (error) => error.code === "invalid_request" && error.status === 400,
    );
  for (const offset of [-1, 0.5, NaN, Infinity, "0", []])
    assert.throws(
      () => service.list(offset),
      (error) => error.code === "invalid_request" && error.status === 400,
    );
  for (const name of [null, {}, ["Rani"], 123, "a".repeat(81)])
    assert.throws(
      () => service.list(0, { name }),
      (error) => error.code === "invalid_request" && error.status === 400,
    );
  assert.deepEqual(service.list(0, { role: "", status: "" }), {
    items: [],
    total: 0,
  });
});

test("denial validates wait bounds and persists cooldown across drafts and service restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { service, store } = setup(t);
  connectedDraft(service);
  const { id } = await service.submit("session");
  for (const days of [-1, 7.5, "7", null, 366, NaN, Infinity])
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
  assert.match(dm.payload.embeds[0].description, /wasn't accepted this time/);
  assert.equal(dm.payload.embeds[0].color, 0xed4245);
  assert.equal(dm.payload.embeds[1].description, denied.decision.reason);
  assert.match(
    dm.payload.embeds[0].fields[2].value,
    new RegExp(String(until / 1000)),
  );
  assert.match(dm.payload.embeds[0].fields[2].value, /:R>/);
  assert.match(dm.payload.embeds[0].fields[2].value, /Minimum wait: 10 days/);
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

test("blank denial messages use the generic response in applicant and staff updates", async (t) => {
  const { service, store } = setup(t);
  for (const [index, reason] of [undefined, "", " \n\t "].entries()) {
    const session = `blank-reason-${index}`;
    connectedDraft(service, session);
    const { id } = await service.submit(session);
    const denied = service.decide(id, reviewer(), "deny", reason, 0);
    assert.equal(denied.status, "Denied");
    assert.match(
      denied.decision.reason,
      /not moving forward with your application/,
    );
    assert.match(denied.decision.reason, /Thank you/);
    assert.equal(
      service.view(session).submitted.decision.reason,
      denied.decision.reason,
    );
    const applicant = store.get("application-notification", `${id}:denied`);
    const staff = store.get("application-notification", `${id}:staff:denied`);
    assert.equal(
      applicant.payload.embeds[1].description,
      denied.decision.reason,
    );
    assert.equal(staff.payload.embeds[0].description, denied.decision.reason);
  }
});

test("zero wait allows immediate reapplication while 365 days is the upper boundary", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { service } = setup(t);
  connectedDraft(service);
  const first = await service.submit("session");
  const denied = service.decide(first.id, reviewer(), "deny", "", 0);
  assert.equal(denied.decision.reapplyDays, 0);
  assert.equal(denied.decision.reapplyAfter, Date.now());
  connectedDraft(service, "immediate");
  assert.equal(
    service.view("immediate").reapplicationWaits.community,
    undefined,
  );
  const second = await service.submit("immediate");
  assert.ok(second.id);
  const final = service.decide(
    second.id,
    reviewer(),
    "deny",
    "More experience needed.",
    365,
  );
  assert.equal(final.decision.reason, "More experience needed.");
  assert.equal(final.decision.reapplyAfter, Date.now() + 365 * 86400000);
  connectedDraft(service, "blocked");
  assert.ok((await service.submit("blocked")).errors.reapplication);
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
  const notices = [];
  const { service, store } = setup(t, async (url, options) => {
    if (url.includes("mojang")) return new Response(null, { status: 404 });
    if (url.endsWith("/users/@me/channels"))
      return Response.json({ id: "999" });
    if (url.includes("/channels/999/"))
      return new Response(null, { status: 403 });
    notices.push(JSON.parse(options.body));
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
  service.startReview(id, reviewer());
  await service.delivery();
  assert.equal(service.get(id).status, "Reviewing");
  assert.match(
    notices.at(-1).embeds[0].fields.at(-1).value,
    /Could not deliver/,
  );
  assert.equal(store.page("application-notification").total, 0);
});

test("staff denial notices support anonymous applicants and legacy jobs without sending DMs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const notices = [];
  const { service, store } = setup(t, async (url, options) => {
    if (url.includes("mojang")) return new Response(null, { status: 404 });
    assert.ok(url.endsWith("/channels/50/messages"));
    notices.push(JSON.parse(options.body));
    return Response.json({ id: `notice-${notices.length}` });
  });
  service.patch("session", {
    role: "community",
    answers: { ...answers(), displayName: "Applicant @everyone" },
  });
  const { id } = await service.submit("session");
  store.set(
    "application-notification",
    id,
    { id, attempts: 0, nextAt: 0 },
    Number.MAX_SAFE_INTEGER,
  );
  service.addComment(
    id,
    reviewer(),
    "This private discussion must stay in the panel.",
  );
  const reason = "_".repeat(2000);
  const denied = service.decide(id, reviewer("20"), "deny", reason, 10);
  assert.throws(
    () => service.decide(id, reviewer(), "approve"),
    /application_already_decided/,
  );
  await service.delivery();
  assert.equal(notices.length, 2);
  assert.match(notices[0].content, /just filled out/);
  const notice = notices[1];
  assert.match(notice.content, /^<@20> denied Applicant/);
  assert.ok(notice.content.includes("\\@everyone"));
  const embed = notice.embeds[0];
  assert.equal(embed.title, "Application denied");
  assert.equal(embed.color, 0xed4245);
  assert.equal(embed.description, "\\_".repeat(2000));
  assert.ok(embed.description.length <= 4096);
  const deadline = Math.ceil(denied.decision.reapplyAfter / 1000);
  assert.equal(
    embed.fields[1].value,
    `<t:${deadline}:F> · <t:${deadline}:R>\nMinimum wait: 10 days.`,
  );
  assert.match(
    embed.fields.at(-1).value,
    /Email selected.*awaiting SMTP setup/,
  );
  assert.ok(embed.footer.text.includes(id));
  assert.equal(
    notice.components[0].components[0].url,
    `${config.staffOrigin}/applications/${id}`,
  );
  assert.equal(JSON.stringify(notices).includes("private discussion"), false);
  assert.deepEqual(notice.allowed_mentions.parse, []);
  assert.ok(store.get("application-delivery", `${id}:staff:denied`).sentAt);
  assert.equal(store.page("application-notification").total, 0);
});

test("staff status notices describe queued DMs accurately without repeating the notice after a retry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const notices = [];
  let unavailable = false;
  const { service, store } = setup(t, async (url, options) => {
    if (url.includes("mojang")) return new Response(null, { status: 404 });
    if (url.endsWith("/users/@me/channels"))
      return Response.json({ id: "999" });
    if (url.includes("/channels/999/") && unavailable)
      return new Response(null, { status: 503 });
    if (url.includes("/channels/50/")) notices.push(JSON.parse(options.body));
    return Response.json({ id: "delivered" });
  });
  connectedDraft(service);
  const { id } = await service.submit("session");
  await service.delivery();
  unavailable = true;
  service.startReview(id, reviewer());
  await service.delivery();
  assert.equal(notices.length, 2);
  assert.equal(
    notices[1].embeds[0].fields.at(-1).value,
    "Applicant DM queued for delivery.",
  );
  const pending = store.get("application-notification", `${id}:reviewing`);
  assert.equal(pending.attempts, 1);
  unavailable = false;
  t.mock.timers.setTime(pending.nextAt);
  await service.delivery();
  assert.ok(
    service.get(id).notifications.find((event) => event.event === "reviewing")
      .sentAt,
  );
  assert.equal(notices.length, 2);
  assert.equal(store.page("application-notification").total, 0);
});

test("staff notification queue failure rolls back review and decision updates", async (t) => {
  const { service, store } = setup(t);
  connectedDraft(service);
  const { id } = await service.submit("session");
  const original = store.set.bind(store);
  t.mock.method(store, "set", (kind, key, value, expires) => {
    if (kind === "application-notification" && key.includes(":staff:"))
      throw new Error("staff queue failed");
    return original(kind, key, value, expires);
  });
  assert.throws(
    () => service.startReview(id, reviewer()),
    /staff queue failed/,
  );
  assert.throws(
    () =>
      service.decide(
        id,
        reviewer(),
        "deny",
        "More community experience needed.",
      ),
    /staff queue failed/,
  );
  assert.equal(service.get(id).status, "Received");
  assert.equal(service.get(id).review, undefined);
  assert.equal(service.get(id).decision, undefined);
  assert.equal(service.list().items[0].status, "Received");
  assert.equal(store.page("application-cooldown").total, 0);
  assert.equal(store.page("application-notification").total, 2);
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

test("email opt-out requires an explicit address and preserves updates without sending Discord messages", async (t) => {
  const calls = [];
  const { service, store } = setup(t, async (url, options) => {
    calls.push(url);
    return Response.json({ id: "900" });
  });
  connectedDraft(service);
  service.patch("session", {
    answers: { notificationPreference: "email", contactEmail: "" },
  });
  assert.ok((await service.submit("session")).errors.contactEmail);
  service.patch("session", { answers: { contactEmail: "chosen@example.com" } });
  const { id } = await service.submit("session");
  service.startReview(id, reviewer("28"));
  service.decide(
    id,
    reviewer("28"),
    "deny",
    "Try again after gaining more experience.",
    10,
  );
  await service.delivery();
  assert.equal(
    calls.filter((url) => url.includes("/users/@me/channels")).length,
    0,
  );
  assert.equal(calls.filter((url) => url.includes("/channels/")).length, 3);
  assert.equal(service.get(id).contactEmail, "chosen@example.com");
  assert.deepEqual(
    service
      .get(id)
      .notifications.map((update) => [
        update.event,
        update.route,
        update.awaitingSetup,
      ]),
    [
      ["received", "email", true],
      ["reviewing", "email", true],
      ["denied", "email", true],
    ],
  );
  const receipt = service.view("session").submitted;
  assert.equal(
    receipt.decision.reason,
    "Try again after gaining more experience.",
  );
  assert.equal(receipt.decision.author, undefined);
  assert.ok(receipt.decision.reapplyAfter);
  assert.equal(receipt.comments, undefined);
  assert.equal(store.page("application-email-notification", 10).total, 3);
  assert.equal(store.page("application-notification", 10).total, 0);
  assert.throws(
    () =>
      service.patch("other", { answers: { notificationPreference: "public" } }),
    /invalid_notification_preference/,
  );
});

test("receipt preferences are session-bound, cancel queued DMs, persist, and keep the role cooldown", async (t) => {
  const { service, store } = setup(t);
  connectedDraft(service);
  const { id } = await service.submit("session");
  await assert.rejects(
    service.updateNotifications("other", {
      preference: "email",
      email: "chosen@example.com",
    }),
    /application_not_found/,
  );
  await assert.rejects(
    service.updateNotifications("session", {
      preference: "email",
      email: "bad",
    }),
    /invalid_contact_email/,
  );
  const updated = await service.updateNotifications("session", {
    preference: "email",
    email: "chosen@example.com",
  });
  assert.equal(updated.submitted.name, "Application fixture");
  assert.equal(updated.submitted.notificationPreference, "email");
  assert.equal(store.page("application-notification", 10).total, 1); // staff notice only
  service.startReview(id, reviewer("28"));
  service.decide(id, reviewer("28"), "deny", "More experience needed.", 7);
  await service.updateNotifications("session", {
    preference: "email",
    email: "new@example.com",
  });
  assert.equal(
    service.view("session").submitted.contactEmail,
    "new@example.com",
  );
  assert.equal(
    store.get("application-email-notification", `${id}:received`).recipient,
    "new@example.com",
  );
  service.restart("session");
  service.disconnect("session");
  service.patch("session", {
    role: "community",
    answers: { ...answers(), contactEmail: "new@example.com" },
  });
  assert.ok((await service.submit("session")).errors.reapplication);
});

function fallbackFetcher({
  member = true,
  dmStatus = 403,
  repair = true,
} = {}) {
  const calls = [];
  let channel;
  let creates = 0;
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname.replace("/api/v10", "");
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, body });
    if (path === "/users/@me/channels") return Response.json({ id: "100" });
    if (path === "/channels/100/messages")
      return Response.json(
        { code: dmStatus === 403 ? 50007 : undefined, retry_after: 60 },
        { status: dmStatus },
      );
    if (path === "/guilds/60/members/123")
      return member
        ? Response.json({ user: { id: "123" } })
        : new Response(null, { status: 404 });
    if (path === "/users/@me") return Response.json({ id: "999" });
    if (path === "/guilds/60/roles") return Response.json([{ id: "61" }]);
    if (path === "/channels/62")
      return Response.json({ id: "62", guild_id: "60", type: 4 });
    if (path === "/guilds/60/channels" && method === "GET")
      return Response.json(channel ? [channel] : []);
    if (path === "/guilds/60/channels" && method === "POST") {
      creates++;
      channel = { id: "200", guild_id: "60", ...body };
      return Response.json(channel);
    }
    if (path === "/channels/200" && method === "PATCH") {
      if (repair) channel = { ...channel, ...body };
      return Response.json(channel);
    }
    if (path === "/channels/200") return Response.json(channel);
    if (path.endsWith("/messages"))
      return Response.json({ id: String(300 + calls.length) });
    if (url.includes("minecraft")) return new Response(null, { status: 404 });
    throw new Error(`Unexpected synthetic request ${method} ${path}`);
  };
  return {
    fetcher,
    calls,
    get creates() {
      return creates;
    },
    widen() {
      channel.permission_overwrites.push({
        id: "70",
        type: 0,
        allow: "1024",
        deny: "0",
      });
    },
  };
}
const fallbackConfig = {
  ...config,
  applications: {
    ...config.applications,
    fallback: { guildId: "60", categoryId: "62", reviewerRoleIds: ["61"] },
  },
};

test("blocked DMs use one private channel, repair its permissions, and report the delivery route", async (t) => {
  const fixture = fallbackFetcher();
  const { service, store } = setup(
    t,
    fixture.fetcher,
    undefined,
    fallbackConfig,
  );
  connectedDraft(service);
  const { id } = await service.submit("session");
  await service.delivery();
  const delivery = service.get(id).notifications[0];
  assert.equal(delivery.route, "private");
  assert.equal(
    store.get("application-dm-delivery", `${id}:received`).channelId,
    "200",
  );
  assert.ok(delivery.sentAt);
  assert.equal(delivery.channelUrl, "https://discord.com/channels/60/200");
  const created = fixture.calls.find(
    (call) => call.path === "/guilds/60/channels" && call.method === "POST",
  ).body;
  assert.deepEqual(
    created.permission_overwrites.find((overwrite) => overwrite.id === "60"),
    { id: "60", type: 0, allow: "0", deny: "1024" },
  );
  assert.deepEqual(
    created.permission_overwrites.map((overwrite) => overwrite.id),
    ["60", "61", "123", "999"],
  );
  fixture.widen();
  service.startReview(id, reviewer("28"));
  await service.delivery();
  assert.equal(fixture.creates, 1);
  assert.ok(
    fixture.calls.some(
      (call) => call.path === "/channels/200" && call.method === "PATCH",
    ),
  );
  assert.equal(
    fixture.calls.filter((call) => call.path === "/channels/100/messages")
      .length,
    1,
  );
  const notice = fixture.calls.find(
    (call) => call.path === "/channels/50/messages" && call.body.embeds,
  )?.body;
  assert.match(
    notice.embeds[0].fields.at(-1).value,
    /notified in a private channel/,
  );
  for (const call of fixture.calls.filter((call) =>
    call.path.endsWith("/messages"),
  ))
    assert.deepEqual(call.body.allowed_mentions.parse, []);
});

test("fallback never exposes an absent member or posts into a channel whose permissions cannot be repaired", async (t) => {
  for (const options of [{ member: false }, { repair: false }]) {
    const fixture = fallbackFetcher(options);
    const { service } = setup(t, fixture.fetcher, undefined, fallbackConfig);
    connectedDraft(service);
    const { id } = await service.submit("session");
    await service.delivery();
    if (options.repair === false) {
      fixture.widen();
      service.startReview(id, reviewer("28"));
      await service.delivery();
    }
    const update = service.get(id).notifications.at(-1);
    assert.ok(update.failedAt);
    assert.equal(
      update.reason,
      options.member === false
        ? "fallback_join_required"
        : "fallback_permissions_failed",
    );
    assert.equal(
      fixture.calls.filter((call) => call.path === "/channels/200/messages")
        .length,
      options.member === false ? 0 : 1,
    );
    if (options.member === false) assert.equal(fixture.creates, 0);
  }
});

test("rate-limited DMs stay queued without creating a private fallback channel", async (t) => {
  const fixture = fallbackFetcher({ dmStatus: 429 });
  const { service } = setup(t, fixture.fetcher, undefined, fallbackConfig);
  connectedDraft(service);
  const { id } = await service.submit("session");
  await service.delivery();
  assert.equal(service.get(id).notifications[0].pending, true);
  assert.equal(fixture.creates, 0);
  assert.equal(
    fixture.calls.some((call) => call.path.startsWith("/guilds/60")),
    false,
  );
});

test("opt-out waits for an in-flight update and prevents later Discord updates", async (t) => {
  let release;
  let began;
  const entered = new Promise((resolve) => {
    began = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const { service } = setup(t, async (url, options) => {
    if (url.endsWith("/users/@me/channels"))
      return Response.json({ id: "100" });
    if (url.endsWith("/channels/100/messages")) {
      began();
      await blocked;
    }
    calls.push(url);
    return Response.json({ id: "200" });
  });
  connectedDraft(service);
  const { id } = await service.submit("session");
  const delivery = service.delivery();
  await entered;
  const update = service.updateNotifications("session", {
    preference: "email",
    email: "chosen@example.com",
  });
  assert.equal(service.get(id).notificationPreference, "discord");
  release();
  await delivery;
  await update;
  service.startReview(id, reviewer("28"));
  await service.delivery();
  assert.equal(
    calls.filter((url) => url.endsWith("/channels/100/messages")).length,
    1,
  );
  assert.equal(service.get(id).notifications.at(-1).route, "email");
});

test("switching an undelivered email update back to Discord exposes the new queue instead of an old failure", async (t) => {
  const { service, store } = setup(t);
  connectedDraft(service);
  service.patch("session", {
    answers: {
      notificationPreference: "email",
      contactEmail: "chosen@example.com",
    },
  });
  const { id } = await service.submit("session");
  store.set(
    "application-dm-delivery",
    `${id}:received`,
    { failedAt: Date.now() },
    Number.MAX_SAFE_INTEGER,
  );
  await service.updateNotifications("session", {
    preference: "discord",
    email: "chosen@example.com",
  });
  assert.equal(
    service.view("session").submitted.notifications[0].pending,
    true,
  );
  assert.equal(
    service.view("session").submitted.notifications[0].failedAt,
    undefined,
  );
});

test("application feedback, review, approval and denial enforce independent saved permissions", async (t) => {
  const { service, store } = setup(t);
  const policy = rolePermissions(config, store);
  const current = policy.read(reviewer("20"));
  const roles = current.roles
    .filter((role) => role.id)
    .map((role) => ({ id: role.id, permissions: { ...role.permissions } }));
  const sr = roles.find((role) => role.id === "29");
  sr.permissions["applications.comment"] = false;
  sr.permissions["applications.review"] = true;
  sr.permissions["applications.deny"] = true;
  policy.save(reviewer("20"), { revision: current.revision, roles });
  service.patch("scoped", { role: "community", answers: answers() });
  const { id } = await service.submit("scoped");
  const member = policy.apply(reviewer("29"));
  assert.throws(
    () => service.addComment(id, member, "Staff feedback"),
    /application_review_role_required/,
  );
  assert.equal(service.startReview(id, member).status, "Reviewing");
  assert.throws(
    () => service.decide(id, member, "approve"),
    /application_decision_role_required/,
  );
  assert.equal(service.decide(id, member, "deny", "", 0).status, "Denied");
});
