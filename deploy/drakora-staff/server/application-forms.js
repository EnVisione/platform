import { AuthError } from "./discord.js";
import { staffCapability } from "./roles.js";
import { applicationScenarios } from "./application-scenarios.js";
import {
  applicationRoles,
  communityOptions,
  defaultApplicationForm,
  formLimits,
} from "../shared/application-form.js";

const permanent = Number.MAX_SAFE_INTEGER;
const baselineVersion = 6;
const defaults = Object.fromEntries(
  Object.keys(applicationRoles).map((role) => [
    role,
    defaultApplicationForm(role, applicationScenarios[role]),
  ]),
);
const fail = () => {
  throw new AuthError("invalid_application_form", 400);
};
function bounded(value, maximum, required = false) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (required && !value.trim())
  )
    fail();
  return value.trim();
}
function validateForm(role, input) {
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["description", "questions", "scenarios"].includes(key),
    )
  )
    fail();
  if (
    !Array.isArray(input.questions) ||
    input.questions.length < 1 ||
    input.questions.length > formLimits.questions
  )
    fail();
  const keys = new Set();
  const existing = new Set(
    defaults[role].questions.map((question) => question.key),
  );
  const questions = input.questions.map((question) => {
    if (
      !question ||
      Array.isArray(question) ||
      Object.keys(question).some(
        (key) =>
          ![
            "key",
            "title",
            "help",
            "kind",
            "required",
            "minLength",
            "condition",
            "options",
          ].includes(key),
      )
    )
      fail();
    const key = bounded(question.key, 80, true);
    if ((!existing.has(key) && !/^q_[a-f0-9]{32}$/.test(key)) || keys.has(key))
      fail();
    keys.add(key);
    if (
      !["paragraph", "short", "choice"].includes(question.kind) ||
      typeof question.required !== "boolean"
    )
      fail();
    if (
      !Number.isSafeInteger(question.minLength) ||
      question.minLength < 1 ||
      question.minLength > (question.kind === "short" ? 300 : 4000)
    )
      fail();
    if (
      !["always", ...communityOptions.map(([id]) => id)].includes(
        question.condition,
      )
    )
      fail();
    if (
      !Array.isArray(question.options) ||
      question.options.length > formLimits.options
    )
      fail();
    const options = question.options.map((option) =>
      bounded(option, 120, true),
    );
    if (
      new Set(options).size !== options.length ||
      (question.kind === "choice"
        ? options.length < 2 || question.minLength !== 1
        : options.length !== 0)
    )
      fail();
    if (
      key === "scenarioAnswer" &&
      (question.kind !== "paragraph" ||
        !question.required ||
        question.condition !== "always" ||
        question.minLength < 40)
    )
      fail();
    return {
      key,
      title: bounded(question.title, 160, true),
      help: bounded(question.help, 1500),
      kind: question.kind,
      required: question.required,
      minLength: question.minLength,
      condition: question.condition,
      options,
    };
  });
  if (
    !keys.has("scenarioAnswer") ||
    !Array.isArray(input.scenarios) ||
    !input.scenarios.length ||
    input.scenarios.length > formLimits.scenarios
  )
    fail();
  const scenarios = input.scenarios.map((scenario) =>
    bounded(scenario, 2000, true),
  );
  if (new Set(scenarios).size !== scenarios.length) fail();
  return {
    description: bounded(input.description, 300, true),
    questions,
    scenarios,
  };
}

export function applicationForms(config, store) {
  const baseline = () => ({
    version: baselineVersion,
    forms: structuredClone(defaults),
  });
  store.transaction(() => {
    if (!store.get("application-form-revision", String(baselineVersion)))
      store.set(
        "application-form-revision",
        String(baselineVersion),
        baseline(),
        permanent,
      );
  });
  function current() {
    const pointer = store.get("application-form-current", "published");
    return revision(pointer?.version ?? baselineVersion);
  }
  function revision(version) {
    const value = store.get("application-form-revision", String(version));
    if (!value) throw new Error("Application questionnaire revision missing");
    return value;
  }
  function authorize(user) {
    if (!staffCapability(config, user, "applications.edit"))
      throw new AuthError("application_decision_role_required");
  }
  return {
    current,
    revision,
    baselineVersion,
    read(user) {
      authorize(user);
      return current();
    },
    save(user, input) {
      authorize(user);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !["version", "role", "form"].includes(key),
        ) ||
        !Number.isSafeInteger(input.version) ||
        typeof input.role !== "string" ||
        !Object.hasOwn(applicationRoles, input.role)
      )
        fail();
      const form = validateForm(input.role, input.form);
      return store.transaction(() => {
        const previous = current();
        if (input.version !== previous.version)
          throw new AuthError("application_form_changed", 409);
        const next = {
          version: previous.version + 1,
          forms: { ...previous.forms, [input.role]: form },
          updatedAt: Date.now(),
          updatedBy: { id: user.id, name: user.name },
        };
        store.set(
          "application-form-revision",
          String(next.version),
          next,
          permanent,
        );
        store.set(
          "application-form-current",
          "published",
          { version: next.version },
          permanent,
        );
        return next;
      });
    },
  };
}
