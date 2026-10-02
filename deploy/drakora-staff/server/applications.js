import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { AuthError } from "./discord.js";
import { hash } from "./store.js";
import {
  applicationRoles,
  communityOptions,
  questionList,
} from "../shared/application-form.js";
import { applicationScenarios } from "./application-scenarios.js";
import {
  communityRankNames,
  applicationReviewAccess,
  applicationDecisionAccess,
} from "./roles.js";

const week = 7 * 86400000;
const permanent = Number.MAX_SAFE_INTEGER;
const token = () => randomBytes(32).toString("base64url");
const optional = new Set(["experienceProof", "comments"]);
const baseFields = [
  "displayName",
  "ign",
  "minecraftConfirmed",
  "minecraftConfirmedName",
  "discordUses",
  "discordWhy",
  "discordWilling",
  "contactEmail",
  "pronouns",
  "age",
  "timezone",
  "communities",
  "hoursPerWeek",
  "adultConfirmed",
  "discordConfirmed",
  "privacyConsent",
  "accuracyConfirmed",
];
const fields = new Set([
  ...baseFields,
  ...Object.keys(applicationRoles).flatMap((role) =>
    questionList(
      role,
      communityOptions.map(([key]) => key),
    ).map(([key]) => key),
  ),
]);
const booleans = new Set([
  "adultConfirmed",
  "minecraftConfirmed",
  "discordConfirmed",
  "privacyConsent",
  "accuracyConfirmed",
]);
const validName = (name) =>
  typeof name === "string" && /^[A-Za-z0-9_]{3,16}$/.test(name);
const text = (value) => (typeof value === "string" ? value.trim() : "");

export function availableApplicationRoles(config, identity) {
  const ids = new Set(identity?.roles ?? []);
  const community = config.ranks.some(
    (rank) => communityRankNames.includes(rank.name) && ids.has(rank.id),
  );
  const held = Object.entries(config.applications.specialistRoles)
    .filter(([, id]) => ids.has(id))
    .map(([role]) => role);
  return Object.keys(applicationRoles).filter((role) =>
    role === "community" ? !community : !held.includes(role),
  );
}

export function applicationService(
  config,
  store,
  fetcher = fetch,
  getMinecraftLink = () => undefined,
) {
  let timer;
  let running;
  let closed = false;
  let deliveryOffset = 0;
  function linkedMinecraft(draft) {
    const identity = draft.identity;
    if (!identity) return null;
    const ids = new Set(identity.roles);
    const activeStaff =
      config.ranks.some((rank) => ids.has(rank.id)) ||
      Object.values(config.applications.specialistRoles).some((id) =>
        ids.has(id),
      );
    const link = activeStaff ? getMinecraftLink(identity.id) : undefined;
    return link
      ? { name: link.name, changePending: Boolean(link.changeRequest) }
      : null;
  }
  function load(sessionId) {
    let draft = store.get("application-draft", sessionId);
    if (!draft) {
      draft = {
        id: randomUUID(),
        createdAt: Date.now(),
        answers: {},
        scenarios: {},
      };
      store.set("application-draft", sessionId, draft, Date.now() + week);
    }
    return draft;
  }
  function write(sessionId, draft) {
    store.set("application-draft", sessionId, draft, Date.now() + week);
  }
  function view(sessionId) {
    const draft = load(sessionId);
    if (draft.submittedId)
      return {
        submitted: {
          id: draft.submittedId,
          role: applicationRoles[draft.role].label,
        },
      };
    const identity = draft.identity;
    const linked = linkedMinecraft(draft);
    return {
      id: draft.id,
      role: draft.role ?? null,
      answers: linked
        ? {
            ...draft.answers,
            ign: linked.name,
            minecraftConfirmed:
              draft.answers.minecraftConfirmedName === linked.name
                ? draft.answers.minecraftConfirmed
                : undefined,
          }
        : draft.answers,
      linkedMinecraft: linked,
      scenario: draft.scenarios[draft.role] ?? null,
      roles: availableApplicationRoles(config, identity),
      discord: identity
        ? {
            id: identity.id,
            name: identity.name,
            username: identity.username,
            avatar: identity.avatar,
            emailAvailable: Boolean(identity.email),
          }
        : null,
    };
  }
  function patch(sessionId, input) {
    const draft = load(sessionId);
    if (draft.submittedId)
      throw new AuthError("application_already_submitted", 409);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !["role", "answers"].includes(key))
    )
      throw new AuthError("invalid_request", 400);
    if (input.role !== undefined) {
      if (
        !availableApplicationRoles(config, draft.identity).includes(input.role)
      )
        throw new AuthError("application_role_unavailable", 400);
      draft.role = input.role;
      draft.scenarios[input.role] ??=
        applicationScenarios[input.role][
          randomInt(applicationScenarios[input.role].length)
        ];
    }
    if (input.answers !== undefined) {
      if (
        !input.answers ||
        typeof input.answers !== "object" ||
        Array.isArray(input.answers)
      )
        throw new AuthError("invalid_request", 400);
      const linked = linkedMinecraft(draft);
      if (
        linked &&
        input.answers.ign !== undefined &&
        input.answers.ign !== linked.name
      )
        throw new AuthError("application_minecraft_link_changed", 409);
      for (const [key, value] of Object.entries(input.answers)) {
        if (!fields.has(key)) throw new AuthError("invalid_request", 400);
        if (key === "communities") {
          if (
            !Array.isArray(value) ||
            value.length > 3 ||
            value.some((v) => !communityOptions.some(([id]) => id === v))
          )
            throw new AuthError("invalid_request", 400);
          draft.answers[key] = [...new Set(value)];
        } else if (booleans.has(key)) {
          if (typeof value !== "boolean")
            throw new AuthError("invalid_request", 400);
          draft.answers[key] = value;
        } else {
          if (typeof value !== "string" || value.length > 6000)
            throw new AuthError("invalid_request", 400);
          draft.answers[key] = value.trim();
        }
      }
    }
    write(sessionId, draft);
    return view(sessionId);
  }
  function connect(sessionId, identity) {
    const draft = load(sessionId);
    if (draft.submittedId)
      throw new AuthError("application_already_submitted", 409);
    draft.identity = identity;
    delete draft.answers.discordConfirmed;
    delete draft.answers.minecraftConfirmed;
    delete draft.answers.minecraftConfirmedName;
    const linked = linkedMinecraft(draft);
    if (linked) draft.answers.ign = linked.name;
    if (!availableApplicationRoles(config, identity).includes(draft.role))
      delete draft.role;
    write(sessionId, draft);
  }
  function disconnect(sessionId) {
    const draft = load(sessionId);
    if (draft.submittedId)
      throw new AuthError("application_already_submitted", 409);
    delete draft.identity;
    delete draft.answers.discordConfirmed;
    write(sessionId, draft);
    return view(sessionId);
  }
  function restart(sessionId) {
    const previous = load(sessionId);
    if (!previous.submittedId)
      throw new AuthError("application_draft_exists", 409);
    store.delete("application-draft", sessionId);
    const draft = load(sessionId);
    if (previous.identity) {
      draft.identity = previous.identity;
      write(sessionId, draft);
    }
    return view(sessionId);
  }
  function challenge(sessionId) {
    const draft = load(sessionId);
    if (draft.submittedId)
      throw new AuthError("application_already_submitted", 409);
    const value = token();
    store.set(
      "application-oauth",
      hash(value),
      { sessionId },
      Date.now() + 600000,
    );
    return value;
  }
  function getChallenge(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
      ? store.get("application-oauth", hash(value))
      : undefined;
  }
  function handoff(value, identity) {
    const request = getChallenge(value);
    if (!request) throw new AuthError("invalid_login_state");
    store.delete("application-oauth", hash(value));
    const code = token();
    store.set(
      "application-handoff",
      hash(code),
      { ...request, identity },
      Date.now() + 60000,
    );
    return `${config.applications.publicOrigin}/apply/auth/complete?code=${code}`;
  }
  function complete(sessionId, code) {
    const pending =
      typeof code === "string"
        ? store.get("application-handoff", hash(code))
        : null;
    if (!pending || pending.sessionId !== sessionId)
      throw new AuthError("invalid_login_state");
    store.delete("application-handoff", hash(code));
    connect(sessionId, pending.identity);
  }
  function validate(draft) {
    const a = draft.answers;
    const errors = {};
    if (!availableApplicationRoles(config, draft.identity).includes(draft.role))
      errors.role = "Choose an available role.";
    if (!text(a.displayName) || a.displayName.length > 80)
      errors.displayName = "Enter the name we should use, up to 80 characters.";
    if (!validName(a.ign))
      errors.ign =
        "Enter a Java Edition username: 3–16 letters, numbers, or underscores.";
    const linked = linkedMinecraft(draft);
    if (
      linked &&
      (linked.changePending ||
        a.ign !== linked.name ||
        a.minecraftConfirmed !== true ||
        a.minecraftConfirmedName !== linked.name)
    )
      errors.minecraftConfirmed = linked.changePending
        ? "Wait for a Founder or Manager to approve your Minecraft name change in panel settings."
        : "Confirm your current linked Minecraft name. If it is incorrect, request a change in panel settings and wait for Founder or Manager approval.";
    if (draft.identity) {
      if (a.discordConfirmed !== true)
        errors.discordConfirmed = "Confirm that this Discord account is yours.";
    } else {
      if (!["yes", "no"].includes(a.discordUses))
        errors.discordUses = "Tell us whether you use Discord.";
      if (a.discordUses === "no" && text(a.discordWhy).length < 10)
        errors.discordWhy = "Tell us why you do not use Discord.";
      if (a.discordUses === "no" && !["yes", "no"].includes(a.discordWilling))
        errors.discordWilling =
          "Tell us whether you would download Discord for staff communication if approved.";
    }
    if (
      (!draft.identity?.email &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(a.contactEmail))) ||
      text(a.contactEmail).length > 254
    )
      errors.contactEmail = "Enter a contact email so staff can reach you.";
    if (!text(a.pronouns) || a.pronouns.length > 80)
      errors.pronouns = "Enter your pronouns or choose Prefer not to say.";
    if (
      !/^\d{2,3}$/.test(a.age ?? "") ||
      Number(a.age) < 18 ||
      Number(a.age) > 120 ||
      a.adultConfirmed !== true
    )
      errors.age = "Applicants must be 18 or older. Confirm your age.";
    try {
      new Intl.DateTimeFormat("en", { timeZone: a.timezone }).format();
      if (!text(a.timezone)) throw new Error();
    } catch {
      errors.timezone = "Choose a valid timezone.";
    }
    if (!a.communities?.length)
      errors.communities =
        "Choose at least one community where you are active.";
    if (
      !text(a.hoursPerWeek) ||
      !Number.isFinite(Number(a.hoursPerWeek)) ||
      Number(a.hoursPerWeek) < 1 ||
      Number(a.hoursPerWeek) > 168
    )
      errors.hoursPerWeek = "Enter between 1 and 168 hours per week.";
    for (const [key] of questionList(draft.role, a.communities)) {
      const length = text(a[key]).length;
      if (!optional.has(key) && length < (key === "scenarioAnswer" ? 40 : 20))
        errors[key] =
          `Please give a little more detail, at least ${key === "scenarioAnswer" ? 40 : 20} characters.`;
      if (length > (key === "scenarioAnswer" ? 6000 : 4000))
        errors[key] = "Your answer is too long.";
    }
    if (!draft.scenarios[draft.role])
      errors.scenarioAnswer = "Choose a role to receive your scenario.";
    if (a.privacyConsent !== true)
      errors.privacyConsent =
        "Confirm that staff may store and read your application.";
    if (a.accuracyConfirmed !== true)
      errors.accuracyConfirmed = "Confirm that your answers are accurate.";
    return errors;
  }
  async function minecraftProfile(name) {
    if (!validName(name)) throw new AuthError("invalid_minecraft_name", 400);
    const cached = store.get("minecraft-profile", name.toLowerCase());
    if (cached) return cached;
    let result = { name, uuid: null, found: false };
    try {
      const response = await fetcher(
        `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (response.ok) {
        const profile = await response.json();
        if (/^[a-f0-9]{32}$/i.test(profile.id) && validName(profile.name))
          result = { name: profile.name, uuid: profile.id, found: true };
      }
    } catch {
      /* Profile lookup is a preview, not proof of ownership. */
    }
    store.set(
      "minecraft-profile",
      name.toLowerCase(),
      result,
      Date.now() + (result.found ? 21600000 : 60000),
    );
    return result;
  }
  async function submit(sessionId) {
    const draft = load(sessionId);
    if (draft.submittedId) return { id: draft.submittedId };
    const errors = validate(draft);
    if (Object.keys(errors).length) return { errors };
    const fingerprint = hash(JSON.stringify(draft));
    const profile = await minecraftProfile(draft.answers.ign);
    return store.transaction(() => {
      const current = load(sessionId);
      if (current.submittedId) return { id: current.submittedId };
      if (hash(JSON.stringify(current)) !== fingerprint)
        throw new AuthError("application_draft_changed", 409);
      const currentErrors = validate(current);
      if (Object.keys(currentErrors).length) return { errors: currentErrors };
      const createdAt = Date.now();
      const allowed = new Set([
        ...baseFields,
        ...questionList(draft.role, draft.answers.communities).map(
          ([key]) => key,
        ),
      ]);
      const answers = Object.fromEntries(
        Object.entries(draft.answers).filter(([key]) => allowed.has(key)),
      );
      const identity = draft.identity;
      if (identity || answers.discordUses !== "no")
        delete answers.discordWilling;
      const record = {
        id: draft.id,
        createdAt,
        role: draft.role,
        questionnaireVersion: 3,
        status: "Received",
        answers,
        scenario: draft.scenarios[draft.role],
        discord: identity
          ? {
              id: identity.id,
              name: identity.name,
              username: identity.username,
              avatar: identity.avatar,
              email: identity.email,
            }
          : null,
        contactEmail: identity?.email || answers.contactEmail,
        minecraft: {
          ...profile,
          submittedName: answers.ign,
          verification: "Awaiting in-game verification",
          firstJoinedAt: null,
          playtimeSeconds: null,
          lastLoginAt: null,
        },
      };
      store.set("application", record.id, record, permanent);
      store.set(
        "application-summary",
        `${createdAt}.${record.id}`,
        {
          id: record.id,
          createdAt,
          role: record.role,
          name: answers.displayName,
          ign: answers.ign,
          discordId: identity?.id ?? null,
          status: record.status,
        },
        permanent,
      );
      store.set(
        "application-notification",
        record.id,
        { id: record.id, attempts: 0, nextAt: createdAt },
        permanent,
      );
      current.submittedId = record.id;
      write(sessionId, current);
      return { id: record.id };
    });
  }
  async function deliver() {
    const page = store.page("application-notification", 20, deliveryOffset);
    deliveryOffset = deliveryOffset + 20 < page.total ? deliveryOffset + 20 : 0;
    for (const pending of page.items) {
      if (closed || pending.nextAt > Date.now()) continue;
      const record = store.get("application", pending.id);
      if (!record) {
        store.delete("application-notification", pending.id);
        continue;
      }
      try {
        const name = record.answers.displayName
          .replace(/([\\*_~`|<>@])/g, "\\$1")
          .replace(/[\r\n]/g, " ");
        const response = await fetcher(
          `https://discord.com/api/v10/channels/${config.applications.notificationChannelId}/messages`,
          {
            method: "POST",
            signal: AbortSignal.timeout(10000),
            headers: {
              Authorization: `Bot ${config.discordBotToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content: `${name}${record.discord ? ` (<@${record.discord.id}>)` : ""} just filled out a ${applicationRoles[record.role].label} application.`,
              allowed_mentions: {
                parse: [],
                users: [],
                roles: [],
                replied_user: false,
              },
              nonce: hash(record.id).slice(0, 24),
              enforce_nonce: true,
              components: [
                {
                  type: 1,
                  components: [
                    {
                      type: 2,
                      style: 5,
                      label: "Click to view",
                      url: `${config.staffOrigin}/applications/${record.id}`,
                    },
                  ],
                },
              ],
            }),
          },
        );
        if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
        const message = await response.json();
        store.transaction(() => {
          store.set(
            "application-delivery",
            record.id,
            { messageId: message.id, sentAt: Date.now() },
            permanent,
          );
          store.delete("application-notification", record.id);
        });
      } catch {
        pending.attempts++;
        if (pending.attempts >= 8) {
          store.set(
            "application-delivery",
            pending.id,
            { failedAt: Date.now() },
            permanent,
          );
          store.delete("application-notification", pending.id);
          console.error(
            "Application notification could not be delivered:",
            pending.id,
          );
        } else {
          pending.nextAt =
            Date.now() + Math.min(3600000, 30000 * 2 ** pending.attempts);
          store.set("application-notification", pending.id, pending, permanent);
        }
      }
    }
  }
  function tick() {
    if (!running && !closed)
      running = deliver().finally(() => {
        running = undefined;
      });
    return running;
  }
  function addComment(id, user, value) {
    if (!applicationReviewAccess(config, user))
      throw new AuthError("application_review_role_required");
    const comment = text(value);
    if (comment.length < 3 || comment.length > 4000)
      throw new AuthError("invalid_application_comment", 400);
    return store.transaction(() => {
      const record = store.get("application", id);
      if (!record) throw new AuthError("application_not_found", 404);
      record.comments ??= [];
      if (record.comments.length >= 100)
        throw new AuthError("application_comments_full", 409);
      record.comments.push({
        id: randomUUID(),
        text: comment,
        author: { id: user.id, name: user.name },
        createdAt: Date.now(),
      });
      store.set("application", id, record, permanent);
      return record;
    });
  }
  function decide(id, user, decision, reason = "") {
    if (!applicationDecisionAccess(config, user))
      throw new AuthError("application_decision_role_required");
    if (
      !["approve", "deny"].includes(decision) ||
      typeof reason !== "string" ||
      reason.length > 2000
    )
      throw new AuthError("invalid_request", 400);
    return store.transaction(() => {
      const record = store.get("application", id);
      if (!record) throw new AuthError("application_not_found", 404);
      if (record.status !== "Received")
        throw new AuthError("application_already_decided", 409);
      record.status = decision === "approve" ? "Approved" : "Denied";
      record.decision = {
        author: { id: user.id, name: user.name },
        reason: reason.trim(),
        decidedAt: Date.now(),
      };
      store.set("application", id, record, permanent);
      const key = `${record.createdAt}.${record.id}`;
      const summary = store.get("application-summary", key);
      store.set(
        "application-summary",
        key,
        { ...summary, status: record.status },
        permanent,
      );
      return record;
    });
  }
  return {
    view,
    patch,
    connect,
    disconnect,
    restart,
    challenge,
    getChallenge,
    handoff,
    complete,
    submit,
    addComment,
    decide,
    minecraftProfile,
    list: (offset = 0) => store.page("application-summary", 50, offset),
    get: (id) => store.get("application", id),
    delivery: tick,
    start() {
      timer = setInterval(tick, 15000);
      timer.unref();
      tick();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
