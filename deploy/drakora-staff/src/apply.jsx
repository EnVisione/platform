import { LegalNotice } from "./legal-notice.jsx";
import React, { useEffect, useRef, useState } from "react";
import {
  applicationRoles,
  applicationBaseFields,
  communityOptions,
  activeFormQuestions,
  questionAnswerError,
  parseEvidenceLinks,
} from "../shared/application-form.js";
import { RequiredMark, EvidenceLinks } from "./application-evidence.jsx";
import {
  NotificationSettings,
  NotificationDeliveries,
} from "./application-notification-settings.jsx";
import logo from "./assets/drakora-logo.png";
import { ApplicationHistory } from "./application-history.jsx";
import "./apply.css";

const notices = {
  application_draft_changed:
    "Your draft changed while submitting. Please check it and submit again.",
  discord_cancelled:
    "Discord sign-in was cancelled. You can continue without it.",
  invalid_login_state:
    "Your Discord sign-in link expired. Please connect again.",
  service_unavailable:
    "Applications are temporarily unavailable. Your saved draft is still here. Please try again.",
  application_role_unavailable:
    "Your Discord roles changed which applications are available. Choose another role.",
  application_minecraft_link_changed:
    "Your linked Minecraft name changed. Refresh this page and confirm the current name.",
};
const timezoneOptions = [
  ...new Set([
    "UTC",
    ...(Intl.supportedValuesOf
      ? Intl.supportedValuesOf("timeZone")
      : [Intl.DateTimeFormat().resolvedOptions().timeZone]),
  ]),
];
const stepKey = "drakora.application.step.v2";
function storedStep() {
  try {
    return Math.max(0, Number(sessionStorage.getItem(stepKey)) || 0);
  } catch {
    return 0;
  }
}

export function PublicApplication() {
  const [draft, setDraft] = useState(null);
  const [answers, setAnswers] = useState({});
  const [step, setStep] = useState(storedStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState({});
  const [saveState, setSaveState] = useState("");
  const [profile, setProfile] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const queue = useRef(Promise.resolve());
  const changed = useRef(false);
  const csrf = useRef("");
  async function request(path, method = "GET", body) {
    const response = await fetch(`/apply/api/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf.current,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok && response.status !== 422)
      throw new Error(data.error || "service_unavailable");
    return data;
  }
  function save(body) {
    if (body.answers) {
      const allowed = new Set([
        ...applicationBaseFields,
        ...(draft?.role
          ? draft.questionnaire.forms[draft.role].questions.map(
              (question) => question.key,
            )
          : []),
      ]);
      body = {
        ...body,
        answers: Object.fromEntries(
          Object.entries(body.answers).filter(([key]) => allowed.has(key)),
        ),
      };
    }
    const action = queue.current
      .catch(() => {})
      .then(() => request("draft", "PATCH", body));
    queue.current = action;
    return action;
  }
  useEffect(() => {
    let active = true;
    request("draft")
      .then((data) => {
        if (!active) return;
        csrf.current = data.csrf;
        setDraft(data);
        setAnswers(
          data.answers ??
            (data.submitted
              ? {
                  notificationPreference: data.submitted.notificationPreference,
                  contactEmail: data.submitted.contactEmail,
                }
              : {}),
        );
        if (data.submitted) setReceipt(data.submitted);
        if (!data.role) setStep(0);
        else if (
          data.linkedMinecraft &&
          (data.linkedMinecraft.changePending ||
            data.answers.minecraftConfirmed !== true ||
            data.answers.minecraftConfirmedName !== data.linkedMinecraft.name)
        )
          setStep((current) => Math.min(current, 2));
        const loginError = new URLSearchParams(location.search).get("error");
        if (loginError)
          setError(
            notices[loginError] ||
              "Discord could not be connected. Please try again or continue without it.",
          );
      })
      .catch(() => active && setError(notices.service_unavailable));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!changed.current || !draft || receipt) return;
    setSaveState("Saving draft…");
    const timer = setTimeout(() => {
      save({ answers })
        .then(() => setSaveState("Draft saved for 7 days in this browser."))
        .catch(() =>
          setSaveState(
            "Draft could not be saved. Check your connection before continuing.",
          ),
        );
    }, 1000);
    return () => clearTimeout(timer);
  }, [answers]);
  useEffect(() => {
    try {
      sessionStorage.setItem(stepKey, String(step));
    } catch {}
  }, [step]);
  useEffect(() => {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(answers.ign ?? "")) {
      setProfile(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        fetch(`/apply/api/minecraft/${encodeURIComponent(answers.ign)}`, {
          signal: controller.signal,
        })
          .then((response) => (response.ok ? response.json() : null))
          .then(setProfile)
          .catch(() => {}),
      500,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [answers.ign]);
  function update(key, value) {
    changed.current = true;
    setAnswers((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }
  const questions =
    draft?.role && draft.questionnaire
      ? activeFormQuestions(
          draft.questionnaire.forms[draft.role],
          answers.communities ?? [],
        ).map((question) => [
          question.key,
          question.title,
          question.help,
          question,
        ])
      : [];
  const notificationPreference =
    draft?.discord && answers.notificationPreference !== "email"
      ? "discord"
      : "email";
  async function refreshReceipt() {
    setBusy(true);
    setError("");
    try {
      setReceipt((await request("draft")).submitted);
    } catch {
      setError(notices.service_unavailable);
    } finally {
      setBusy(false);
    }
  }
  async function saveNotifications(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await request("notifications", "PUT", {
        preference:
          answers.notificationPreference ?? receipt.notificationPreference,
        email: answers.contactEmail ?? receipt.contactEmail,
      });
      setReceipt(data.submitted);
      setSaveState(
        "Notification preference saved. Future updates will use your choice.",
      );
    } catch (error) {
      setError(
        error.message === "invalid_contact_email"
          ? "Enter a valid contact email."
          : notices.service_unavailable,
      );
    } finally {
      setBusy(false);
    }
  }
  const needsDiscordQuestion = !draft?.discord && answers.discordUses === "no";
  const stages = [
    "name",
    "role",
    "ign",
    "discord",
    "details",
    "communities",
    ...questions.map(([key]) => key),
    ...(needsDiscordQuestion ? ["discordWilling"] : []),
    "review",
  ];
  const index = Math.min(step, stages.length - 1);
  const current = stages[index];
  const question = questions.find(([key]) => key === current);
  const percent = Math.round((index / (stages.length - 1)) * 100);
  async function restart() {
    setBusy(true);
    setError("");
    try {
      await queue.current.catch(() => {});
      const data = await request("new", "POST", {});
      changed.current = false;
      setDraft((old) => ({ ...data, csrf: old.csrf }));
      setAnswers({});
      setReceipt(null);
      setStep(0);
      setErrors({});
      setSaveState("");
    } catch {
      setError(notices.service_unavailable);
    } finally {
      setBusy(false);
    }
  }
  async function choose(role) {
    setBusy(true);
    setError("");
    try {
      const data = await save({ role });
      setDraft((old) => ({ ...old, ...data }));
      setStep(stages.indexOf("ign"));
    } catch (failure) {
      setError(notices[failure.message] || notices.service_unavailable);
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    setBusy(true);
    setError("");
    try {
      await save({ answers });
      const data = await request("discord/start", "POST", {});
      location.assign(data.url);
    } catch (failure) {
      setError(notices[failure.message] || notices.service_unavailable);
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    try {
      await queue.current.catch(() => {});
      const data = await request("discord/disconnect", "POST", {});
      setDraft((old) => ({ ...old, ...data }));
      update("discordConfirmed", false);
    } catch {
      setError(notices.service_unavailable);
    } finally {
      setBusy(false);
    }
  }
  async function next(event) {
    event.preventDefault();
    setError("");
    if (question) {
      const error = questionAnswerError(question[3], answers[current]);
      if (error) {
        setErrors((old) => ({ ...old, [current]: error }));
        return;
      }
    }
    if (current === "name" && !answers.displayName?.trim()) {
      setError("Please tell us what we should call you before continuing.");
      return;
    }
    if (
      current === "role" &&
      draft.reapplicationWaits?.[draft.role] > Date.now()
    ) {
      setError(
        `You can apply for this role again from ${new Date(draft.reapplicationWaits[draft.role]).toLocaleString()}.`,
      );
      return;
    }
    if (
      current === "ign" &&
      draft.linkedMinecraft &&
      (draft.linkedMinecraft.changePending ||
        answers.minecraftConfirmed !== true ||
        answers.minecraftConfirmedName !== draft.linkedMinecraft.name)
    ) {
      setError(
        "Confirm your linked name before continuing. If it is incorrect, request a change in panel settings and wait for Founder or Manager approval.",
      );
      return;
    }
    if (current === "communities" && !answers.communities?.length) {
      setError("Choose at least one community where you are active.");
      return;
    }
    if (current === "experienceProof") {
      const links = parseEvidenceLinks(answers.experienceLinks);
      if (links.error) {
        setError(links.error);
        return;
      }
    }
    setBusy(true);
    try {
      const data = await save({ answers });
      setDraft((old) => ({ ...old, ...data }));
      if (current === "review") {
        const result = await request("submit", "POST", {});
        if (result.errors) {
          setErrors(result.errors);
          setError(
            "Please correct the answers listed below before submitting.",
          );
        } else {
          setReceipt((await request("draft")).submitted);
          changed.current = false;
        }
      } else setStep(index + 1);
    } catch (failure) {
      setError(notices[failure.message] || notices.service_unavailable);
    } finally {
      setBusy(false);
    }
  }
  function field(key, label, options = {}) {
    return (
      <label className="apply-field" key={key}>
        <span>
          {label}
          {options.required !== false && <RequiredMark />}
        </span>
        <input
          value={answers[key] ?? ""}
          onChange={(event) => update(key, event.target.value)}
          required
          {...options}
          aria-invalid={Boolean(errors[key])}
        />
        {errors[key] && <small className="apply-error">{errors[key]}</small>}
      </label>
    );
  }
  function check(key, label, required = true) {
    return (
      <label className="apply-check">
        <input
          type="checkbox"
          checked={Boolean(answers[key])}
          onChange={(event) => update(key, event.target.checked)}
          required={required}
        />
        <span>
          {label}
          {required && <RequiredMark />}
        </span>
      </label>
    );
  }
  return (
    <main className="apply-layout">
      <div className="apply-shell">
        <a className="apply-brand" href="/apply">
          <img src={logo} alt="" />
          <span>
            Drakora <small>STAFF APPLICATIONS</small>
          </span>
        </a>
        <section
          className={`apply-card${receipt ? " apply-receipt" : ""}`}
          aria-labelledby="apply-title"
        >
          <LegalNotice application />
          {!draft ? (
            <>
              <h1 id="apply-title">Staff applications</h1>
              <p>{error || "Opening your application…"}</p>
              <button type="button" onClick={() => location.reload()}>
                Retry
              </button>
            </>
          ) : receipt ? (
            <>
              <div className="apply-receipt-heading">
                <span className="apply-receipt-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="m5 12 4 4L19 6"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <div>
                  <span className="apply-eyebrow">APPLICATION RECEIVED</span>
                  <h1 id="apply-title">
                    Thank you,{" "}
                    {receipt.name || answers.displayName || "applicant"}.
                  </h1>
                </div>
              </div>
              <p>
                Your {receipt.role} application has been submitted for review.
              </p>
              <div className="apply-receipt-next">
                <h2>What happens next?</h2>
                <p>
                  The team will review your application and follow up using your
                  contact details.
                </p>
                <p className="apply-muted">
                  {receipt.notificationPreference === "email"
                    ? receipt.emailEnabled
                      ? "Watch for an email confirmation and review updates. Check your spam folder too."
                      : "You chose email contact. Automatic email sending is awaiting setup; staff can use your saved address manually."
                    : "Watch for a Discord DM. If DMs are blocked, check your private update channel in Drakora."}
                </p>
              </div>
              <div className="apply-receipt-next">
                <h2>Application status: {receipt.status || "Received"}</h2>
                {receipt.decision?.reason && (
                  <p className="apply-applicant-feedback">
                    {receipt.decision.reason}
                  </p>
                )}
                {receipt.decision?.reapplyAfter && (
                  <p>
                    You can apply for this role again from{" "}
                    {new Date(receipt.decision.reapplyAfter).toLocaleString()}.
                  </p>
                )}
                <NotificationDeliveries notifications={receipt.notifications} />
                <button
                  type="button"
                  className="apply-secondary"
                  onClick={refreshReceipt}
                  disabled={busy}
                >
                  Refresh updates
                </button>
                <p className="apply-muted">
                  This receipt stays available in this browser for 7 days. Keep
                  your application reference.
                </p>
                <details className="apply-answer">
                  <summary>Change notification preferences</summary>
                  <form onSubmit={saveNotifications}>
                    <NotificationSettings
                      emailEnabled={receipt.emailEnabled}
                      linked={receipt.discordLinked}
                      preference={
                        answers.notificationPreference ??
                        receipt.notificationPreference
                      }
                      email={answers.contactEmail ?? receipt.contactEmail}
                      onChange={update}
                    />
                    <button type="submit" disabled={busy}>
                      Save notification preferences
                    </button>
                  </form>
                </details>
                {saveState && <p role="status">{saveState}</p>}
              </div>
              <ApplicationHistory receipt={receipt} />
              <p className="apply-receipt-reference">
                <span>Application reference</span>
                <code>{receipt.id}</code>
              </p>
              {error && (
                <p className="apply-notice" role="alert">
                  {error}
                </p>
              )}
              <div className="apply-receipt-actions">
                <button
                  type="button"
                  className="apply-secondary"
                  onClick={restart}
                  disabled={busy}
                >
                  Start another application
                </button>
                <a
                  className="apply-button"
                  href="https://discord.com/channels/1405306768476864562"
                >
                  Open Drakora Discord
                </a>
              </div>
            </>
          ) : (
            <>
              <div
                className="apply-progress"
                aria-label={`Application progress: ${percent}%`}
              >
                <progress max="100" value={percent} />
                <span>
                  {index + 1} / {stages.length}
                </span>
              </div>
              {draft.discord && (
                <p className="apply-welcome">
                  Welcome back, {answers.displayName || draft.discord.name}.
                  Your Discord roles determine which team applications are
                  available.
                </p>
              )}
              {error && (
                <p className="apply-notice" role="alert">
                  {error}
                </p>
              )}
              <form onSubmit={next}>
                <p className="apply-muted">
                  <span className="apply-required" aria-hidden="true">
                    *
                  </span>{" "}
                  Required fields
                </p>
                {current === "role" && (
                  <>
                    <span className="apply-eyebrow">JOIN THE TEAM</span>
                    <h1 id="apply-title">
                      What are you applying for?
                      <RequiredMark />
                    </h1>
                    <p>Choose the team you would like to join.</p>
                    <div className="apply-roles">
                      {draft.roles.map((role) => (
                        <button
                          type="button"
                          key={role}
                          onClick={() => choose(role)}
                          disabled={
                            busy ||
                            draft.reapplicationWaits?.[role] > Date.now()
                          }
                        >
                          <strong>{applicationRoles[role].label}</strong>
                          <span>
                            {draft.questionnaire.forms[role].description}
                          </span>
                          {draft.reapplicationWaits?.[role] > Date.now() && (
                            <span>
                              Available again from{" "}
                              {new Date(
                                draft.reapplicationWaits[role],
                              ).toLocaleString()}
                              .
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    {!draft.roles.length && (
                      <p>
                        You already hold all of these roles. Speak to a Founder
                        about your responsibilities.
                      </p>
                    )}
                  </>
                )}
                {current === "name" && (
                  <>
                    <h1 id="apply-title">What should we call you?</h1>
                    <p>
                      Use the name you would like the team to use. Please answer
                      this even if you connect Discord.
                    </p>
                    {field("displayName", "Your preferred name", {
                      maxLength: 80,
                      autoComplete: "nickname",
                    })}
                    <div className="apply-discord-option">
                      <p>
                        Discord sign-in is optional. Connecting lets us confirm
                        your Discord account.
                      </p>
                      {draft.discord ? (
                        <>
                          <p>Connected as @{draft.discord.username}</p>
                          <button
                            className="apply-link"
                            type="button"
                            onClick={disconnect}
                            disabled={busy}
                          >
                            Not you? Sign out
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={connect} disabled={busy}>
                          Connect Discord
                        </button>
                      )}
                    </div>
                  </>
                )}
                {current === "ign" && (
                  <>
                    <h1 id="apply-title">
                      {draft.linkedMinecraft
                        ? "Is this your Minecraft name?"
                        : "Your Minecraft name"}
                      {draft.linkedMinecraft && <RequiredMark />}
                    </h1>
                    {draft.linkedMinecraft ? (
                      <>
                        <p>
                          Your staff panel already links your Discord account to{" "}
                          <strong>{draft.linkedMinecraft.name}</strong>.
                        </p>
                        <div className="apply-radios">
                          {[true, false].map((correct) => (
                            <label key={String(correct)}>
                              <input
                                type="radio"
                                name="minecraftConfirmed"
                                required
                                disabled={draft.linkedMinecraft.changePending}
                                checked={
                                  answers.minecraftConfirmed === correct &&
                                  answers.minecraftConfirmedName ===
                                    draft.linkedMinecraft.name
                                }
                                onChange={() => {
                                  update("minecraftConfirmed", correct);
                                  update(
                                    "minecraftConfirmedName",
                                    draft.linkedMinecraft.name,
                                  );
                                }}
                              />
                              {correct
                                ? "Yes, this is correct"
                                : "No, this is incorrect"}
                            </label>
                          ))}
                        </div>
                        {(answers.minecraftConfirmed === false ||
                          draft.linkedMinecraft.changePending) && (
                          <div className="apply-notice" role="alert">
                            <p>
                              Please stop here. Open panel settings and request
                              the correct Minecraft name. Wait for Founder or
                              Manager approval, then return here and refresh
                              before continuing.
                            </p>
                            <a
                              className="apply-button"
                              href="https://staff.drakora.org/settings"
                            >
                              Open panel settings
                            </a>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <p>Enter your Minecraft Java Edition username.</p>
                        {field("ign", "In-game name (IGN)", {
                          pattern: "[A-Za-z0-9_]{3,16}",
                          minLength: 3,
                          maxLength: 16,
                          spellCheck: false,
                          autoComplete: "off",
                        })}
                      </>
                    )}
                    {/^[A-Za-z0-9_]{3,16}$/.test(answers.ign ?? "") && (
                      <div className="apply-player">
                        <img
                          key={answers.ign}
                          src={`/apply/api/head/${encodeURIComponent(answers.ign)}`}
                          alt="Minecraft head preview"
                          onError={(event) => {
                            event.currentTarget.hidden = true;
                          }}
                        />
                        <span>
                          {profile?.found ? profile.name : answers.ign}
                          <small>
                            {profile?.found
                              ? "Minecraft profile found. Ownership is not verified."
                              : "A profile preview may be unavailable. You can still apply."}
                          </small>
                        </span>
                      </div>
                    )}
                  </>
                )}
                {current === "discord" && (
                  <>
                    <h1 id="apply-title">
                      {draft.discord ? "Is this you?" : "Do you use Discord?"}
                      {!draft.discord && <RequiredMark />}
                    </h1>
                    {draft.discord ? (
                      <>
                        <div className="apply-profile">
                          <img src={draft.discord.avatar} alt="" />
                          <div>
                            <strong>{draft.discord.name}</strong>
                            <span>@{draft.discord.username}</span>
                          </div>
                        </div>
                        {check(
                          "discordConfirmed",
                          "Yes, this Discord account belongs to me.",
                        )}
                        <button
                          className="apply-link"
                          type="button"
                          disabled={busy}
                          onClick={disconnect}
                        >
                          Use another account or continue without Discord
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="apply-radios">
                          {["yes", "no"].map((value) => (
                            <label key={value}>
                              <input
                                type="radio"
                                name="discordUses"
                                value={value}
                                required
                                checked={answers.discordUses === value}
                                onChange={() => update("discordUses", value)}
                              />
                              {value === "yes" ? "Yes" : "No"}
                            </label>
                          ))}
                        </div>
                        {answers.discordUses === "yes" && (
                          <>
                            <p>
                              Connect your account if you would like us to
                              confirm it. You can also continue with a contact
                              email.
                            </p>
                            <button
                              type="button"
                              onClick={connect}
                              disabled={busy}
                            >
                              Connect Discord
                            </button>
                          </>
                        )}
                        {answers.discordUses === "no" && (
                          <label className="apply-field">
                            <span>
                              Why do you not use Discord?
                              <RequiredMark />
                            </span>
                            <textarea
                              required
                              minLength={10}
                              maxLength={1000}
                              value={answers.discordWhy ?? ""}
                              onChange={(event) =>
                                update("discordWhy", event.target.value)
                              }
                            />
                          </label>
                        )}
                      </>
                    )}
                    <NotificationSettings
                      emailEnabled={draft.emailEnabled}
                      linked={Boolean(draft.discord)}
                      preference={notificationPreference}
                      email={answers.contactEmail}
                      emailAvailable={draft.discord?.emailAvailable}
                      onChange={update}
                    />
                    {errors.contactEmail && (
                      <p className="apply-error">{errors.contactEmail}</p>
                    )}
                  </>
                )}
                {current === "details" && (
                  <>
                    <h1 id="apply-title">A few details</h1>
                    {field("pronouns", "Pronouns", {
                      list: "pronoun-options",
                      maxLength: 80,
                    })}
                    <datalist id="pronoun-options">
                      {[
                        "He/him",
                        "She/her",
                        "They/them",
                        "Prefer not to say",
                      ].map((value) => (
                        <option key={value} value={value} />
                      ))}
                    </datalist>
                    {field("age", "Age", {
                      type: "number",
                      min: 18,
                      max: 120,
                      step: 1,
                    })}
                    {field(
                      "hoursPerWeek",
                      "Hours you can realistically offer per week",
                      { type: "number", min: 1, max: 168, step: "0.5" },
                    )}
                    <p>
                      Applicants must be 18 or older. Staff work needs mature
                      judgment, consistency, and responsibility. This age
                      requirement is not a judgment of younger community
                      members.
                    </p>
                    {check("adultConfirmed", "I am 18 or older.")}
                    {field("timezone", "Timezone", {
                      list: "timezone-options",
                      maxLength: 80,
                      placeholder: "America/Chicago",
                    })}
                    <datalist id="timezone-options">
                      {timezoneOptions.map((zone) => (
                        <option key={zone} value={zone} />
                      ))}
                    </datalist>
                    <button
                      type="button"
                      className="apply-link"
                      onClick={() =>
                        update(
                          "timezone",
                          Intl.DateTimeFormat().resolvedOptions().timeZone,
                        )
                      }
                    >
                      Use my device timezone
                    </button>
                  </>
                )}
                {current === "communities" && (
                  <>
                    <h1 id="apply-title">
                      Where are you usually active?
                      <RequiredMark />
                    </h1>
                    <p>
                      Select all that apply. We will ask about each community
                      you choose.
                    </p>
                    {communityOptions.map(([key, label]) => (
                      <label className="apply-check" key={key}>
                        <input
                          type="checkbox"
                          checked={answers.communities?.includes(key) ?? false}
                          onChange={(event) =>
                            update(
                              "communities",
                              event.target.checked
                                ? [...(answers.communities ?? []), key]
                                : answers.communities.filter(
                                    (value) => value !== key,
                                  ),
                            )
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </>
                )}
                {question && (
                  <>
                    <span className="apply-eyebrow">
                      {applicationRoles[draft.role].label}
                    </span>
                    <h1 id="apply-title">
                      {question[1]}
                      {question[3].required && <RequiredMark />}
                    </h1>
                    <p>{question[2]}</p>
                    {["portfolio", "experienceProof"].includes(current) && (
                      <>
                        <a
                          className="apply-button"
                          href="https://imgur.com/upload"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open Imgur
                        </a>
                        <p className="apply-muted">
                          Upload your screenshots to Imgur, then paste the image
                          or album link here. Screenshots stay on Imgur.
                        </p>
                      </>
                    )}
                    {current === "scenarioAnswer" && (
                      <blockquote className="apply-scenario">
                        {draft.scenario}
                      </blockquote>
                    )}
                    <label className="apply-field">
                      <span className="sr-only">{question[1]}</span>
                      {question[3].kind === "choice" ? (
                        <select
                          required={question[3].required}
                          value={answers[current] ?? ""}
                          onChange={(event) =>
                            update(current, event.target.value)
                          }
                        >
                          <option value="">Choose an answer</option>
                          {question[3].options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : question[3].kind === "short" ? (
                        <input
                          required={question[3].required}
                          minLength={question[3].minLength}
                          maxLength={300}
                          value={answers[current] ?? ""}
                          onChange={(event) =>
                            update(current, event.target.value)
                          }
                        />
                      ) : (
                        <textarea
                          required={question[3].required}
                          minLength={question[3].minLength}
                          maxLength={current === "scenarioAnswer" ? 6000 : 4000}
                          rows={8}
                          value={answers[current] ?? ""}
                          onChange={(event) =>
                            update(current, event.target.value)
                          }
                        />
                      )}
                      {errors[current] && (
                        <small className="apply-error">{errors[current]}</small>
                      )}
                    </label>
                    {current === "experienceProof" && (
                      <label className="apply-field">
                        <span>Public links (optional)</span>
                        <textarea
                          rows={3}
                          className="apply-evidence-link-input"
                          maxLength={6000}
                          value={answers.experienceLinks ?? ""}
                          onChange={(event) =>
                            update("experienceLinks", event.target.value)
                          }
                          placeholder="https://example.com/your-work&#10;One link per line, up to 5 links."
                          aria-invalid={Boolean(errors.experienceLinks)}
                        />
                        {errors.experienceLinks && (
                          <small className="apply-error">
                            {errors.experienceLinks}
                          </small>
                        )}
                      </label>
                    )}
                  </>
                )}
                {current === "discordWilling" && (
                  <>
                    <h1 id="apply-title">Staff communication</h1>
                    <p id="discord-willing-question">
                      If your application is approved, are you willing to
                      download Discord for staff communication?
                      <RequiredMark />
                    </p>
                    <div
                      className="apply-radios"
                      role="radiogroup"
                      aria-labelledby="discord-willing-question"
                    >
                      {["yes", "no"].map((value) => (
                        <label key={value}>
                          <input
                            type="radio"
                            name="discordWilling"
                            required
                            value={value}
                            checked={answers.discordWilling === value}
                            onChange={() => update("discordWilling", value)}
                          />
                          <span>{value === "yes" ? "Yes" : "No"}</span>
                        </label>
                      ))}
                    </div>
                    {errors.discordWilling && (
                      <p className="apply-error">{errors.discordWilling}</p>
                    )}
                  </>
                )}
                {current === "review" && (
                  <>
                    <h1 id="apply-title">Check your application</h1>
                    <p>
                      You are applying for {applicationRoles[draft.role].label}.
                      Please check your answers before submitting.
                    </p>
                    <div className="apply-review-edits">
                      {[
                        ["name", "Name"],
                        ["ign", "Minecraft name"],
                        ["discord", "Discord and contact"],
                        ["details", "Personal details"],
                        ["communities", "Communities"],
                        ...(needsDiscordQuestion
                          ? [["discordWilling", "Staff communication"]]
                          : []),
                      ].map(([stage, label]) => (
                        <button
                          className="apply-link"
                          key={stage}
                          type="button"
                          onClick={() => setStep(stages.indexOf(stage))}
                        >
                          Edit {label}
                        </button>
                      ))}
                    </div>
                    <dl className="apply-review">
                      <dt>Name</dt>
                      <dd>{answers.displayName}</dd>
                      <dt>Minecraft</dt>
                      <dd>{answers.ign}</dd>
                      <dt>Discord</dt>
                      <dd>
                        {draft.discord
                          ? `@${draft.discord.username}`
                          : "Not connected"}
                      </dd>
                      {needsDiscordQuestion && (
                        <>
                          <dt>Willing to download Discord if approved</dt>
                          <dd>
                            {answers.discordWilling === "yes"
                              ? "Yes"
                              : answers.discordWilling === "no"
                                ? "No"
                                : "Not answered"}
                          </dd>
                        </>
                      )}
                      <dt>Contact</dt>
                      <dd>
                        {notificationPreference === "email" ||
                        !draft.discord?.emailAvailable
                          ? answers.contactEmail
                          : "Your verified Discord email"}
                      </dd>
                      <dt>Application updates</dt>
                      <dd>
                        {notificationPreference === "email"
                          ? "Email contact · automatic sending awaits setup"
                          : "Discord DMs with a private channel fallback"}
                      </dd>
                      <dt>Pronouns / age / timezone</dt>
                      <dd>
                        {answers.pronouns} · {answers.age} · {answers.timezone}
                      </dd>
                      <dt>Availability</dt>
                      <dd>{answers.hoursPerWeek} hours per week</dd>
                    </dl>
                    {questions.map(([key, label]) => (
                      <details className="apply-answer" key={key}>
                        <summary>{label}</summary>
                        {key === "scenarioAnswer" && (
                          <blockquote>{draft.scenario}</blockquote>
                        )}
                        <p>{answers[key] || "No answer"}</p>
                        {key === "experienceProof" && (
                          <EvidenceLinks value={answers.experienceLinks} />
                        )}
                        <button
                          type="button"
                          className="apply-link"
                          onClick={() => setStep(stages.indexOf(key))}
                        >
                          Edit answer
                        </button>
                      </details>
                    ))}
                    {Object.entries(errors)
                      .filter(([, value]) => value)
                      .map(([key, value]) => (
                        <p className="apply-error" key={key}>
                          {key}: {value}
                        </p>
                      ))}
                    <p className="apply-muted">
                      Your answers, shared links, contact details, and linked
                      Discord and Minecraft identity are stored privately for
                      staff applications. Authorized staff with Jr Moderator
                      rank or higher can read them. Minecraft ownership and
                      network activity are not verified yet. Please do not
                      include passwords, home addresses, or private documents.
                    </p>
                    <p className="apply-muted">
                      Updates use your selected contact method. Discord updates
                      use DMs, with a private channel in Drakora when DMs are
                      blocked. Email updates use our configured mail service. If
                      denied, you must wait at least 7 days before applying for
                      the same role again. The decision will include your
                      reapplication date.
                    </p>
                    {check(
                      "privacyConsent",
                      "I have read the Privacy Policy and agree to the Terms of Service.",
                    )}
                    {check(
                      "accuracyConfirmed",
                      "My answers are accurate and the work or evidence I shared is my own, or clearly attributed.",
                    )}
                  </>
                )}
                <div className="apply-actions">
                  {index > 0 && (
                    <button
                      type="button"
                      className="apply-secondary"
                      disabled={busy}
                      onClick={() => {
                        setError("");
                        setStep(Math.max(0, index - 1));
                      }}
                    >
                      Back
                    </button>
                  )}
                  {current !== "role" && (
                    <button
                      className="apply-button"
                      type="submit"
                      disabled={
                        busy ||
                        (current === "ign" &&
                          Boolean(draft.linkedMinecraft) &&
                          (draft.linkedMinecraft.changePending ||
                            answers.minecraftConfirmed === false))
                      }
                    >
                      {busy
                        ? "Saving…"
                        : current === "review"
                          ? "Submit application"
                          : "Continue"}
                    </button>
                  )}
                </div>
              </form>
              <p className="apply-save" role="status">
                {saveState ||
                  "Your draft stays in this browser for 7 days. Discord sign-in is optional."}
              </p>
            </>
          )}
        </section>
        <footer className="apply-footer">
          Drakora Network · Staff applications ·{" "}
          <a href="/privacy-settings">Privacy information</a>
        </footer>
      </div>
    </main>
  );
}
