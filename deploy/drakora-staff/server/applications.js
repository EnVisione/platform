import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { AuthError } from "./discord.js";
import { listFilters } from "./list-filters.js";
import { staffCapability, communityRankNames } from "./roles.js";
import { hash } from "./store.js";
import {
  applicationRoles,
  applicationBaseFields,
  applicationStatuses,
  communityOptions,
  activeFormQuestions,
  questionAnswerError,
  parseEvidenceLinks,
} from "../shared/application-form.js";
import { applicationForms } from "./application-forms.js";
import {
  applicationNotifications,
  notificationMode,
} from "./application-notifications.js";

const week = 7 * 86400000;
const permanent = Number.MAX_SAFE_INTEGER;
const defaultDenialReason =
  "We are not moving forward with your application at this time. Thank you for your interest in joining the Drakora team.";
const token = () => randomBytes(32).toString("base64url");

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
  getStaffAvatar = () => undefined,
) {
  const notifications = applicationNotifications(config, store, fetcher);
  const forms = applicationForms(config, store);
  const draftForm = (draft) =>
    forms.revision(draft.questionnaireVersion).forms[draft.role];
  const draftQuestions = (draft) =>
    draft.role
      ? activeFormQuestions(draftForm(draft), draft.answers.communities)
      : [];
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
        questionnaireVersion: forms.current().version,
      };
      store.set("application-draft", sessionId, draft, Date.now() + week);
    }
    if (!draft.questionnaireVersion) {
      draft.questionnaireVersion = forms.baselineVersion;
      write(sessionId, draft);
    }
    return draft;
  }
  function write(sessionId, draft) {
    store.set("application-draft", sessionId, draft, Date.now() + week);
  }
  function view(sessionId) {
    const draft = load(sessionId);
    if (draft.submittedId) {
      const record = store.get("application", draft.submittedId);
      return {
        submitted: {
          emailEnabled: Boolean(config.applications.smtp),
          id: draft.submittedId,
          role: applicationRoles[draft.role].label,
          name: record.answers.displayName,
          status: record.status,
          discordLinked: Boolean(record.discord),
          notificationPreference: notificationMode(record),
          contactEmail: record.contactEmail,
          notifications: notifications.status(record.id),
          decision: record.decision
            ? {
                reason: record.decision.reason,
                reapplyAfter: record.decision.reapplyAfter,
              }
            : undefined,
        },
      };
    }
    const identity = draft.identity;
    const linked = linkedMinecraft(draft);
    return {
      id: draft.id,
      emailEnabled: Boolean(config.applications.smtp),
      questionnaire: {
        version: draft.questionnaireVersion,
        forms: Object.fromEntries(
          Object.entries(forms.revision(draft.questionnaireVersion).forms).map(
            ([role, form]) => [
              role,
              { description: form.description, questions: form.questions },
            ],
          ),
        ),
      },
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
      reapplicationWaits: Object.fromEntries(
        availableApplicationRoles(config, identity)
          .map((role) => [role, cooldown({ ...draft, role })])
          .filter(([, until]) => until > Date.now()),
      ),
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
      const scenarios = draftForm(draft).scenarios;
      draft.scenarios[input.role] ??= scenarios[randomInt(scenarios.length)];
    }
    if (input.answers !== undefined) {
      if (
        !input.answers ||
        typeof input.answers !== "object" ||
        Array.isArray(input.answers)
      )
        throw new AuthError("invalid_request", 400);
      const linked = linkedMinecraft(draft);
      const fields = new Set([
        ...applicationBaseFields,
        ...Object.values(
          forms.revision(draft.questionnaireVersion).forms,
        ).flatMap((form) => form.questions.map((question) => question.key)),
      ]);
      if (
        linked &&
        input.answers.ign !== undefined &&
        input.answers.ign !== linked.name
      )
        throw new AuthError("application_minecraft_link_changed", 409);
      for (const [key, value] of Object.entries(input.answers)) {
        if (!fields.has(key)) throw new AuthError("invalid_request", 400);
        if (
          key === "notificationPreference" &&
          !["discord", "email"].includes(value)
        )
          throw new AuthError("invalid_notification_preference", 400);
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
    delete draft.discordSignedOut;
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
    draft.discordSignedOut = true;
    delete draft.answers.discordConfirmed;
    write(sessionId, draft);
    return view(sessionId);
  }
  function restart(sessionId) {
    const previous = load(sessionId);
    if (!previous.submittedId)
      throw new AuthError("application_draft_exists", 409);
    const record = store.get("application", previous.submittedId);
    const key = record && `${record.createdAt}.${record.id}`;
    const summary = key && store.get("application-summary", key);
    if (summary && !summary.discordId && !summary.browserSessionHash)
      store.set(
        "application-summary",
        key,
        { ...summary, browserSessionHash: hash(sessionId) },
        permanent,
      );
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
      { sessionId, useStaffSession: draft.discordSignedOut !== true },
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
  function cooldownKeys(role, discordId, email, ign) {
    const identities = [
      `contact:${text(email).toLowerCase()}\0${text(ign).toLowerCase()}`,
    ];
    if (discordId) identities.push(`discord:${discordId}`);
    return identities.map((identity) => `${role}.${hash(identity)}`);
  }
  function cooldown(draft) {
    return Math.max(
      0,
      ...cooldownKeys(
        draft.role,
        draft.identity?.id,
        contactEmail(draft),
        draft.answers.ign,
      ).map((key) => store.get("application-cooldown", key)?.until ?? 0),
    );
  }
  function contactEmail(draft) {
    return draft.answers.notificationPreference === "email"
      ? text(draft.answers.contactEmail)
      : draft.identity?.email || text(draft.answers.contactEmail);
  }
  async function updateNotifications(sessionId, input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["preference", "email"].includes(key),
      ) ||
      !["discord", "email"].includes(input.preference)
    )
      throw new AuthError("invalid_notification_preference", 400);
    const email = text(input.email);
    if (
      typeof input.email !== "string" ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    )
      throw new AuthError("invalid_contact_email", 400);
    return notifications.preferencesChanged(() =>
      store.transaction(() => {
        const draft = load(sessionId);
        const record =
          draft.submittedId && store.get("application", draft.submittedId);
        if (!record) throw new AuthError("application_not_found", 404);
        if (input.preference === "discord" && !record.discord)
          throw new AuthError("invalid_notification_preference", 400);
        record.notificationPreference = input.preference;
        record.contactEmail = email;
        if (
          record.status === "Denied" &&
          record.decision.reapplyAfter > Date.now()
        )
          for (const key of cooldownKeys(
            record.role,
            record.discord?.id,
            email,
            record.answers.ign,
          ))
            store.set(
              "application-cooldown",
              key,
              { until: record.decision.reapplyAfter },
              record.decision.reapplyAfter,
            );
        store.set("application", record.id, record, permanent);
        notifications.reconcile(record);
        return view(sessionId);
      }),
    );
  }
  function validate(draft) {
    const a = draft.answers;
    const errors = {};
    const until = cooldown(draft);
    if (until > Date.now())
      errors.reapplication = `You can apply for this role again from ${new Date(until).toISOString().replace("T", " ").replace(".000Z", " UTC")}.`;
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
      ((!draft.identity?.email || a.notificationPreference === "email") &&
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
    for (const question of draftQuestions(draft)) {
      const error = questionAnswerError(question, a[question.key]);
      if (error) errors[question.key] = error;
    }
    const links = parseEvidenceLinks(a.experienceLinks);
    if (links.error) errors.experienceLinks = links.error;
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
        ...applicationBaseFields,
        ...draftQuestions(draft).map((question) => question.key),
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
        questionnaireVersion: draft.questionnaireVersion,
        questions: draftQuestions(draft),
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
        contactEmail: contactEmail(draft),
        notificationPreference: notificationMode({
          discord: identity,
          notificationPreference: answers.notificationPreference,
        }),
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
          browserSessionHash: hash(sessionId),
          status: record.status,
        },
        permanent,
      );
      notifications.queueStaff(record);
      notifications.queueApplicant(record, "received");
      current.submittedId = record.id;
      write(sessionId, current);
      return { id: record.id };
    });
  }
  function addComment(id, user, value) {
    if (!staffCapability(config, user, "applications.comment"))
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
        author: { id: user.id, name: user.name, avatar: user.avatar ?? null },
        createdAt: Date.now(),
      });
      store.set("application", id, record, permanent);
      return applicationView(record);
    });
  }
  function applicationView(record) {
    return record
      ? {
          ...record,
          comments: (record.comments ?? []).map((entry) => ({
            ...entry,
            author: {
              ...entry.author,
              avatar:
                getStaffAvatar(entry.author.id) ?? entry.author.avatar ?? null,
            },
          })),
          emailEnabled: Boolean(config.applications.smtp),
          notifications: notifications.status(record.id),
        }
      : undefined;
  }
  function saveStatus(record, event) {
    store.set("application", record.id, record, permanent);
    const key = `${record.createdAt}.${record.id}`;
    const summary = store.get("application-summary", key);
    store.set(
      "application-summary",
      key,
      { ...summary, status: record.status },
      permanent,
    );
    notifications.queueApplicant(record, event);
    notifications.queueStaff(record, event);
    return applicationView(record);
  }
  function startReview(id, user) {
    if (!staffCapability(config, user, "applications.review"))
      throw new AuthError("application_decision_role_required");
    return store.transaction(() => {
      const record = store.get("application", id);
      if (!record) throw new AuthError("application_not_found", 404);
      if (record.status === "Reviewing") return applicationView(record);
      if (record.status !== "Received")
        throw new AuthError("application_already_decided", 409);
      record.status = "Reviewing";
      record.review = {
        author: { id: user.id, name: user.name },
        startedAt: Date.now(),
      };
      return saveStatus(record, "reviewing");
    });
  }
  function decide(id, user, decision, reason = "", reapplyDays = 7) {
    if (
      !staffCapability(
        config,
        user,
        decision === "deny" ? "applications.deny" : "applications.approve",
      )
    )
      throw new AuthError("application_decision_role_required");
    if (
      !["approve", "deny"].includes(decision) ||
      typeof reason !== "string" ||
      reason.length > 2000
    )
      throw new AuthError("invalid_request", 400);
    if (
      decision === "deny" &&
      (!Number.isSafeInteger(reapplyDays) ||
        reapplyDays < 0 ||
        reapplyDays > 365)
    )
      throw new AuthError("invalid_reapplication_wait", 400);
    return store.transaction(() => {
      const record = store.get("application", id);
      if (!record) throw new AuthError("application_not_found", 404);
      if (!["Received", "Reviewing"].includes(record.status))
        throw new AuthError("application_already_decided", 409);
      record.status = decision === "approve" ? "Approved" : "Denied";
      record.decision = {
        author: { id: user.id, name: user.name },
        reason:
          reason.trim() || (decision === "deny" ? defaultDenialReason : ""),
        decidedAt: Date.now(),
      };
      if (decision === "deny") {
        const keys = cooldownKeys(
          record.role,
          record.discord?.id,
          record.contactEmail,
          record.answers.ign,
        );
        const until = Math.max(
          record.decision.decidedAt + reapplyDays * 86400000,
          ...keys.map(
            (key) => store.get("application-cooldown", key)?.until ?? 0,
          ),
        );
        record.decision.reapplyDays = reapplyDays;
        record.decision.reapplyAfter = until;
        for (const key of keys)
          store.set("application-cooldown", key, { until }, until);
      }
      return saveStatus(record, decision === "approve" ? "approved" : "denied");
    });
  }
  function list(
    offset = 0,
    { role = "", status = "", name = "", from = "", to = "" } = {},
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof role !== "string" ||
      (role && !Object.hasOwn(applicationRoles, role)) ||
      typeof status !== "string" ||
      (status && !Object.hasOwn(applicationStatuses, status)) ||
      typeof name !== "string" ||
      name.length > 80
    )
      throw new AuthError("invalid_request", 400);
    const { withinDate } = listFilters({ offset, query: name, from, to }, 80);
    const search = name.trim().toLowerCase();
    const page = store.page(
      "application-summary",
      50,
      offset,
      role || status || search || from || to
        ? (item) =>
            withinDate(item.createdAt) &&
            (!role || item.role === role) &&
            (!status || item.status === status) &&
            (!search ||
              [item.name, item.ign, item.discordId].some(
                (value) =>
                  typeof value === "string" &&
                  value.toLowerCase().includes(search),
              ))
        : undefined,
    );
    return {
      ...page,
      items: page.items.map(({ browserSessionHash, ...summary }) => summary),
    };
  }
  function history(sessionId, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new AuthError("invalid_request", 400);
    const draft = load(sessionId);
    const sessionHash = hash(sessionId);
    const pageSize = 20;
    const page = store.page(
      "application-summary",
      pageSize,
      offset,
      (summary) =>
        summary.discordId
          ? summary.discordId === draft.identity?.id
          : summary.browserSessionHash === sessionHash ||
            summary.id === draft.submittedId,
    );
    return {
      total: page.total,
      pageSize,
      items: page.items.map((summary) => ({
        id: summary.id,
        role: applicationRoles[summary.role].label,
        ign: summary.ign,
        createdAt: summary.createdAt,
        status: summary.status,
      })),
    };
  }
  function previousApplications(id, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new AuthError("invalid_request", 400);
    const record = store.get("application", id);
    if (!record) throw new AuthError("application_not_found", 404);
    const email = text(record.contactEmail).toLowerCase();
    const ign = text(record.answers.ign).toLowerCase();
    const pageSize = 5;
    const page = store.page(
      "application-summary",
      pageSize,
      offset,
      (summary) => {
        if (summary.id === record.id) return false;
        if (record.discord?.id && summary.discordId)
          return summary.discordId === record.discord.id;
        if (!email || !ign || text(summary.ign).toLowerCase() !== ign)
          return false;
        const previous = store.get("application", summary.id);
        return text(previous?.contactEmail).toLowerCase() === email;
      },
    );
    return {
      total: page.total,
      pageSize,
      items: page.items.map(({ id, role, ign, createdAt, status }) => ({
        id,
        role,
        ign,
        createdAt,
        status,
      })),
    };
  }
  return {
    forms,
    view,
    patch,
    updateNotifications,
    connect,
    disconnect,
    restart,
    challenge,
    getChallenge,
    handoff,
    complete,
    submit,
    addComment,
    startReview,
    decide,
    minecraftProfile,
    list,
    attention() {
      const items = store
        .entries("application-summary")
        .map(([, item]) => item);
      const received = items.filter(
        (item) => item.status === "Received",
      ).length;
      const reviewing = items.filter(
        (item) => item.status === "Reviewing",
      ).length;
      return { received, reviewing, pending: received + reviewing };
    },
    history,
    previousApplications,
    get: (id) => applicationView(store.get("application", id)),
    delivery: notifications.delivery,
    start: notifications.start,
    close: notifications.close,
  };
}
