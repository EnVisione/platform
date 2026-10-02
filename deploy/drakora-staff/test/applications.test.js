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
import { questionList } from "../shared/application-form.js";
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
    () => service.decide(id, user("20"), "deny"),
    /application_already_decided/,
  );
  service.patch("another", { role: "artist", answers: answers("artist") });
  const another = await service.submit("another");
  assert.equal(service.decide(another.id, user("20"), "deny").status, "Denied");
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
    sent.push(JSON.parse(options.body));
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
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].allowed_mentions, {
    parse: [],
    users: [],
    roles: [],
    replied_user: false,
  });
  assert.match(sent[0].content, /<@123>/);
  assert.equal(
    sent[0].components[0].components[0].url,
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
