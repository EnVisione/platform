import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import { openStore } from "../server/store.js";
import { applicationService } from "../server/applications.js";
import { applicationFormRouter } from "../server/application-form-routes.js";
import { AuthError } from "../server/discord.js";
import { permissions } from "../server/roles.js";
import {
  questionList,
  activeFormQuestions,
} from "../shared/application-form.js";
import { config as fixture } from "./fixture.js";
const config = {
  ...fixture,
  applications: { specialistRoles: {}, notificationChannelId: "50" },
};
const user = (rank = "28", dashboard = true) => ({
  id: rank,
  name: "Form editor fixture",
  roles: [rank, ...(dashboard ? ["10"] : [])],
  permissions: permissions(config, [rank, ...(dashboard ? ["10"] : [])]),
});
function setup(t) {
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const service = applicationService(
    config,
    store,
    async () => new Response(null, { status: 404 }),
  );
  t.after(async () => {
    await service.close();
    store.close();
  });
  return { service, store, forms: service.forms };
}
const custom = (patch = {}) => ({
  key: "q_123456789012345678901234567890ab",
  title: "A new staff question",
  help: "Explain your answer.",
  kind: "paragraph",
  required: true,
  minLength: 20,
  condition: "always",
  options: [],
  ...patch,
});
function answer(role = "community") {
  return {
    displayName: "Test applicant",
    ign: "Test_Player",
    discordUses: "no",
    discordWhy: "I use another communication service.",
    discordWilling: "yes",
    contactEmail: "fixture@example.com",
    pronouns: "They/them",
    age: "24",
    adultConfirmed: true,
    timezone: "UTC",
    hoursPerWeek: "6",
    communities: ["prom2"],
    privacyConsent: true,
    accuracyConfirmed: true,
    ...Object.fromEntries(
      questionList(role, ["prom2"]).map(([key]) => [
        key,
        "This is a detailed answer explaining the approach and reasoning.",
      ]),
    ),
  };
}
test("all four forms save independently, persist across service restart, and require Manager or Founder", (t) => {
  const { service, store, forms } = setup(t);
  for (const rank of ["21", "29", "22", "30", "23", "25"]) {
    assert.throws(
      () => forms.read(user(rank)),
      /application_decision_role_required/,
    );
    assert.throws(
      () => forms.save(user(rank), {}),
      /application_decision_role_required/,
    );
  }
  assert.throws(
    () => forms.read(user("28", false)),
    /application_decision_role_required/,
  );
  for (const [index, role] of [
    "community",
    "builder",
    "artist",
    "developer",
  ].entries()) {
    const before = forms.read(user());
    const form = structuredClone(before.forms[role]);
    form.description = `Saved ${role} description`;
    form.questions[0].title = `Saved ${role} first question`;
    form.questions.push(custom());
    form.questions.splice(2, 1);
    form.questions.reverse();
    form.scenarios = [
      `Explain how you would handle a ${role} team disagreement.`,
    ];
    const result = forms.save(user(index % 2 ? "20" : "28"), {
      version: before.version,
      role,
      form,
    });
    assert.equal(result.version, before.version + 1);
    assert.deepEqual(result.forms[role], form);
    for (const other of Object.keys(before.forms).filter((key) => key !== role))
      assert.deepEqual(result.forms[other], before.forms[other]);
  }
  const restart = applicationService(
    config,
    store,
    async () => new Response(null, { status: 404 }),
  );
  t.after(() => restart.close());
  assert.equal(restart.forms.read(user()).version, 10);
  for (const role of ["community", "builder", "artist", "developer"])
    assert.equal(
      restart.forms.read(user()).forms[role].description,
      `Saved ${role} description`,
    );
  assert.equal(
    service.forms
      .revision(6)
      .forms.community.description.includes("Support players"),
    true,
  );
});
test("drafts pin revisions, new questions validate, and submitted questions remain immutable", async (t) => {
  const { service, store, forms } = setup(t);
  service.patch("old", { role: "community", answers: answer() });
  store.set(
    "application-draft",
    "legacy",
    { id: "legacy-id", createdAt: Date.now(), answers: {}, scenarios: {} },
    Date.now() + 86400000,
  );
  const current = forms.read(user());
  const form = structuredClone(current.forms.community);
  form.questions = form.questions.filter((q) => q.key !== "moderation");
  form.questions.push(
    custom({ kind: "choice", minLength: 1, options: ["Yes", "No"] }),
  );
  form.questions.push(
    custom({
      key: "q_abcdefabcdefabcdefabcdefabcdefab",
      kind: "short",
      required: false,
      minLength: 1,
      condition: "rh",
    }),
  );
  form.scenarios = ["A new scenario that later drafts will receive."];
  forms.save(user(), { version: current.version, role: "community", form });
  assert.equal(service.view("old").questionnaire.version, 6);
  assert.equal(service.view("legacy").questionnaire.version, 6);
  assert.equal(service.view("old").scenario.includes("A new scenario"), false);
  const saved = await service.submit("old");
  assert.equal(service.get(saved.id).questionnaireVersion, 6);
  assert.equal(
    service.get(saved.id).questions.some((q) => q.key === "moderation"),
    true,
  );
  const newAnswers = answer();
  delete newAnswers.moderation;
  service.patch("new", { role: "community", answers: newAnswers });
  assert.equal(service.view("new").questionnaire.version, 7);
  assert.equal(service.view("new").scenario, form.scenarios[0]);
  assert.equal(
    (await service.submit("new")).errors[custom().key],
    "Choose one of the available answers.",
  );
  service.patch("new", { answers: { [custom().key]: "Invalid" } });
  assert.ok((await service.submit("new")).errors[custom().key]);
  service.patch("new", { answers: { [custom().key]: "Yes" } });
  const result = await service.submit("new");
  const record = service.get(result.id);
  assert.equal(record.answers.moderation, undefined);
  assert.equal(
    record.questions.some((q) => q.condition === "rh"),
    false,
  );
  assert.equal(record.answers[custom().key], "Yes");
  form.questions[0].title = "Changed after submission";
  forms.save(user(), { version: 7, role: "community", form });
  assert.notEqual(
    service.get(result.id).questions[0].title,
    form.questions[0].title,
  );
  assert.equal(service.get(result.id).questionnaireVersion, 7);
  assert.equal(
    activeFormQuestions(form, ["rh"]).some((q) => q.condition === "rh"),
    true,
  );
});
test("invalid forms, protected fields, duplicate keys, and stale saves cannot alter published questions", (t) => {
  const { forms, store } = setup(t);
  const initial = forms.read(user());
  const cases = [
    (f) => (f.questions = []),
    (f) => f.questions.push({ ...f.questions[0] }),
    (f) => f.questions.push(custom({ key: "age" })),
    (f) => f.questions.push(custom({ key: "__proto__" })),
    (f) =>
      f.questions.push(
        custom({ kind: "choice", minLength: 1, options: ["Same", "Same"] }),
      ),
    (f) => f.questions.push(custom({ kind: "short", minLength: 301 })),
    (f) => f.questions.push(custom({ condition: "bad" })),
    (f) =>
      (f.questions.find((q) => q.key === "scenarioAnswer").required = false),
    (f) =>
      (f.questions = f.questions.filter((q) => q.key !== "scenarioAnswer")),
    (f) => (f.scenarios = []),
    (f) => f.scenarios.push(f.scenarios[0]),
    (f) => (f.questions[0].title = " "),
    (f) => (f.questions[0].help = "a".repeat(1501)),
    (f) => f.questions.push(custom({ options: ["Hidden"] })),
    (f) => (f.scenarios[0] = "a".repeat(2001)),
    (f) => f.questions.push(custom({ required: "true" })),
    (f) => f.questions.push(custom({ extra: "unsupported" })),
  ];
  for (const mutate of cases) {
    const form = structuredClone(initial.forms.community);
    mutate(form);
    assert.throws(
      () => forms.save(user(), { version: 6, role: "community", form }),
      /invalid_application_form/,
    );
    assert.deepEqual(forms.read(user()), initial);
  }
  const latest = forms.save(user(), {
    version: 6,
    role: "artist",
    form: initial.forms.artist,
  });
  assert.throws(
    () =>
      forms.save(user(), {
        version: 6,
        role: "builder",
        form: initial.forms.builder,
      }),
    /application_form_changed/,
  );
  assert.deepEqual(forms.read(user()), latest);
  const original = store.set;
  store.set = function (kind, ...args) {
    if (kind === "application-form-current")
      throw new Error("Fixture write failure");
    return original.call(this, kind, ...args);
  };
  assert.throws(
    () =>
      forms.save(user(), {
        version: 7,
        role: "developer",
        form: initial.forms.developer,
      }),
    /Fixture write failure/,
  );
  store.set = original;
  assert.equal(store.get("application-form-revision", "8"), undefined);
  assert.deepEqual(forms.read(user()), latest);
});
test("editor HTTP endpoints enforce current rank and CSRF while preserving saved forms", async (t) => {
  const { forms } = setup(t);
  let actor = user();
  let checks = 0;
  const app = express();
  app.use(
    applicationFormRouter(
      forms,
      async () => {
        checks++;
        return actor;
      },
      (req) => {
        if (
          req.headers.origin !== "http://fixture.test" ||
          req.headers["x-csrf-token"] !== "fixture"
        )
          throw new AuthError("invalid_request");
      },
    ),
  );
  app.use((error, _req, res, _next) =>
    res
      .status(error.status || 503)
      .json({ error: error.code || "service_unavailable" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/application-forms`;
  const catalog = await (await fetch(url)).json();
  const body = JSON.stringify({
    version: catalog.version,
    role: "builder",
    form: catalog.forms.builder,
  });
  assert.equal(
    (
      await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      })
    ).status,
    403,
  );
  actor = user("21");
  assert.equal((await fetch(url)).status, 403);
  assert.equal(
    (
      await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://fixture.test",
          "X-CSRF-Token": "fixture",
        },
        body,
      })
    ).status,
    403,
  );
  actor = user("20");
  assert.equal(
    (
      await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://fixture.test",
          "X-CSRF-Token": "fixture",
        },
        body,
      })
    ).status,
    200,
  );
  assert.equal((await (await fetch(url)).json()).version, 7);
  assert.equal(checks, 5);
});

test("each edited application type accepts only its active questions and keeps protected hours required", async (t) => {
  const { service, forms } = setup(t);
  for (const role of ["community", "builder", "artist", "developer"]) {
    const catalog = forms.read(user());
    const form = structuredClone(catalog.forms[role]);
    form.questions = form.questions.filter((q) => q.key !== "availability");
    form.questions.push(custom({ kind: "short", minLength: 2 }));
    forms.save(user(), { version: catalog.version, role, form });
    const input = answer(role);
    delete input.availability;
    input.ign = `Test_${role}`;
    input.contactEmail = `${role}@example.com`;
    input[custom().key] = "A";
    input.hoursPerWeek = "";
    service.patch(role, { role, answers: input });
    const invalid = await service.submit(role);
    assert.ok(invalid.errors.hoursPerWeek);
    assert.ok(invalid.errors[custom().key]);
    service.patch(role, {
      answers: { hoursPerWeek: "5", [custom().key]: "Okay" },
    });
    const result = await service.submit(role);
    assert.ok(result.id, JSON.stringify(result));
    const record = service.get(result.id);
    assert.equal(
      record.questions.some((q) => q.key === "availability"),
      false,
    );
    assert.equal(record.answers[custom().key], "Okay");
    assert.equal(record.questionnaireVersion, forms.read(user()).version);
  }
});
