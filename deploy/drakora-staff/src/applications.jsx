import React, { useEffect, useState } from "react";
import {
  applicationRoles,
  applicationStatuses,
  communityOptions,
  questionList,
} from "../shared/application-form.js";
import "./apply.css";
import { DateFilters } from "./list-filters.jsx";
import { NotificationDeliveries } from "./application-notification-settings.jsx";
import { EvidenceLinks } from "./application-evidence.jsx";
import { ApplicationPlayer } from "./application-player.jsx";
import { ApplicationFormEditor } from "./application-form-editor.jsx";
import { ApplicationStatus } from "./application-status.jsx";

function applicationListSearch(offset, { role, status, name, from, to }) {
  const query = new URLSearchParams({ offset: String(offset) });
  if (role) query.set("role", role);
  if (status) query.set("status", status);
  if (name) query.set("name", name);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  return `?${query}`;
}

export function StaffApplications({ csrf, capabilities }) {
  if (location.pathname === "/applications/editor")
    return capabilities["applications.edit"] ? (
      <ApplicationFormEditor csrf={csrf} />
    ) : (
      <p className="notice">
        Your roles do not have permission to edit application questions.
      </p>
    );
  return <ApplicationReviews csrf={csrf} capabilities={capabilities} />;
}

function ApplicationReviews({ csrf, capabilities }) {
  const canDecide =
    capabilities["applications.review"] ||
    capabilities["applications.approve"] ||
    capabilities["applications.deny"];
  const id = location.pathname.split("/")[2];
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(() => {
    const value = Number(
      new URLSearchParams(location.search).get("offset") ?? 0,
    );
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  });
  const [filters, setFilters] = useState(() => {
    const query = new URLSearchParams(location.search);
    const role = query.get("role") ?? "";
    const status = query.get("status") ?? "";
    const name = query.get("name") ?? "";
    return {
      role: Object.hasOwn(applicationRoles, role) ? role : "",
      status: Object.hasOwn(applicationStatuses, status) ? status : "",
      name: name.length <= 80 ? name.trim() : "",
      from: query.get("from") || "",
      to: query.get("to") || "",
    };
  });
  const [nameInput, setNameInput] = useState(filters.name);
  const listSearch = applicationListSearch(offset, filters);
  const filtered = Boolean(
    filters.role ||
    filters.status ||
    filters.name ||
    filters.from ||
    filters.to,
  );
  function updateList(nextFilters, nextOffset = 0) {
    setFilters(nextFilters);
    setOffset(nextOffset);
    history.replaceState(
      history.state,
      "",
      `/applications${applicationListSearch(nextOffset, nextFilters)}`,
    );
  }
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [reapplyDays, setReapplyDays] = useState("7");
  const [reviewError, setReviewError] = useState("");
  const [busy, setBusy] = useState(false);
  async function review(action, body) {
    setBusy(true);
    setReviewError("");
    try {
      const response = await fetch(
        `/api/applications/${encodeURIComponent(id)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        const messages = {
          application_review_role_required:
            "Your roles do not have permission to post application feedback.",
          application_decision_role_required:
            "Your roles do not have permission for this application action.",
          application_already_decided:
            "Another reviewer already decided this application. Refresh to see the decision.",
          application_comments_full:
            "This application has reached its feedback limit.",
          invalid_application_comment:
            "Write between 3 and 4,000 characters of feedback.",
          invalid_reapplication_wait:
            "Choose a whole number of days between 0 and 365.",
        };
        throw new Error(
          messages[result.error] ||
            "Could not save your review. Please try again.",
        );
      }
      setData(result);
      if (action === "comments") setComment("");
      else if (action === "decision") setReason("");
    } catch (failure) {
      setReviewError(
        failure.message || "Could not save your review. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    fetch(
      id
        ? `/api/applications/${encodeURIComponent(id)}`
        : `/api/applications${listSearch}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 403
              ? "Your roles do not have permission to view applications."
              : response.status === 404
                ? "Application not found."
                : response.status === 400
                  ? "Check the filters and choose a valid date range."
                  : "Could not load applications.",
          );
        const result = await response.json();
        if (!controller.signal.aborted) setData(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [id, listSearch]);
  if (id && error)
    return (
      <p className="notice" role="alert">
        {error}
      </p>
    );
  if (id && !data) return <p>Loading application…</p>;
  if (!id)
    return (
      <section className="staff-applications">
        <h2>Staff Applications</h2>
        {capabilities["applications.edit"] && (
          <a
            className="apply-button apply-primary application-editor-link"
            href="/applications/editor"
          >
            Edit application questions
          </a>
        )}
        <p>
          Private submissions for staff with application access. Share what you
          know about the applicant. Review actions follow your role permissions.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            updateList({ ...filters, name: nameInput.trim() });
          }}
        >
          <fieldset className="application-filters list-filters">
            <legend className="sr-only">Filter staff applications</legend>
            <label>
              Applicant name
              <input
                type="search"
                placeholder="Name, Minecraft username, or Discord ID"
                maxLength={80}
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
              />
            </label>
            <label>
              Application type
              <select
                value={filters.role}
                onChange={(event) =>
                  updateList({
                    ...filters,
                    name: nameInput.trim(),
                    role: event.target.value,
                  })
                }
              >
                <option value="">All types</option>
                {Object.entries(applicationRoles).map(([value, role]) => (
                  <option key={value} value={value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select
                value={filters.status}
                onChange={(event) =>
                  updateList({
                    ...filters,
                    name: nameInput.trim(),
                    status: event.target.value,
                  })
                }
              >
                <option value="">All statuses</option>
                {Object.entries(applicationStatuses).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <DateFilters
              from={filters.from}
              to={filters.to}
              change={(key, value) =>
                updateList({ ...filters, name: nameInput.trim(), [key]: value })
              }
            />
            <div className="application-filter-actions">
              <button type="submit">Search</button>
              <button
                type="button"
                disabled={!filtered && !nameInput}
                onClick={() => {
                  setNameInput("");
                  updateList({
                    role: "",
                    status: "",
                    name: "",
                    from: "",
                    to: "",
                  });
                }}
              >
                Reset filters
              </button>
            </div>
          </fieldset>
        </form>
        <p className="application-retention">
          Dates filter when applications were submitted.
        </p>
        <p className="application-retention">
          Denied applications are kept for reference.
        </p>
        {error ? (
          <p className="notice" role="alert">
            {error}
          </p>
        ) : !data ? (
          <p role="status">Loading applications…</p>
        ) : data.items.length ? (
          <div className="application-list">
            {data.items.map((item) => (
              <a
                key={item.id}
                className="application-row"
                href={`/applications/${item.id}${listSearch}`}
              >
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {item.ign} · {applicationRoles[item.role].label}
                  </span>
                </div>
                <div>
                  <ApplicationStatus status={item.status} />
                  <time>{new Date(item.createdAt).toLocaleString()}</time>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <p>
            {filtered
              ? "No applications match these filters."
              : "No applications yet."}
          </p>
        )}
        {data && (
          <div className="apply-actions">
            <button
              disabled={!offset}
              onClick={() => updateList(filters, Math.max(0, offset - 50))}
            >
              Previous
            </button>
            <span role="status">
              {data.total} {filtered ? "matching " : ""}
              {data.total === 1 ? "application" : "applications"}
            </span>
            <button
              disabled={offset + 50 >= data.total}
              onClick={() => updateList(filters, offset + 50)}
            >
              Next
            </button>
          </div>
        )}
      </section>
    );
  const a = data.answers;
  return (
    <article className="staff-applications application-detail">
      <header className="application-header">
        <a className="application-back" href={`/applications${listSearch}`}>
          ← {filtered ? "Back to filtered applications" : "All applications"}
        </a>
        <h2>{a.displayName}</h2>
        <div className="application-meta">
          <span>{applicationRoles[data.role].label}</span>
          <ApplicationStatus status={data.status} />
          <time>{new Date(data.createdAt).toLocaleString()}</time>
        </div>
      </header>
      <div className="application-layout">
        <div className="application-review">
          <section
            className="application-review-card"
            aria-labelledby="application-details-title"
          >
            <h3 id="application-details-title">Applicant details</h3>
            {data.discord && (
              <div className="apply-profile">
                <img src={data.discord.avatar} alt="" />
                <div>
                  <strong>{data.discord.name}</strong>
                  <span>
                    @{data.discord.username} · Discord ID {data.discord.id}
                  </span>
                </div>
              </div>
            )}
            <dl className="application-facts">
              <div>
                <dt>Contact email</dt>
                <dd>{data.contactEmail}</dd>
              </div>
              <div>
                <dt>Pronouns</dt>
                <dd>{a.pronouns}</dd>
              </div>
              <div>
                <dt>Age</dt>
                <dd>{a.age}</dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{a.timezone}</dd>
              </div>
              <div>
                <dt>Available hours / week</dt>
                <dd>{a.hoursPerWeek}</dd>
              </div>
              <div>
                <dt>Active communities</dt>
                <dd>
                  {a.communities
                    .map(
                      (key) =>
                        communityOptions.find(
                          ([value]) => value === key,
                        )?.[1] || key,
                    )
                    .join(", ")}
                </dd>
              </div>
              {!data.discord && (
                <>
                  <div>
                    <dt>Uses Discord</dt>
                    <dd>
                      {a.discordUses}
                      {a.discordWhy && ` — ${a.discordWhy}`}
                    </dd>
                  </div>
                  {a.discordUses === "no" && (
                    <div>
                      <dt>Willing to download Discord if approved</dt>
                      <dd>
                        {a.discordWilling === "yes"
                          ? "Yes"
                          : a.discordWilling === "no"
                            ? "No"
                            : "Not asked on this application"}
                      </dd>
                    </div>
                  )}
                </>
              )}
            </dl>
          </section>
          {(data.questions
            ? data.questions.map((question) => [question.key, question.title])
            : questionList(data.role, a.communities)
          ).map(([key, label]) => (
            <section className="application-response" key={key}>
              <h3>{label}</h3>
              {key === "scenarioAnswer" && (
                <blockquote>{data.scenario}</blockquote>
              )}
              <p>{a[key] || "Not provided"}</p>
              {key === "experienceProof" && (
                <EvidenceLinks value={a.experienceLinks} />
              )}
            </section>
          ))}
          <section
            className="application-response"
            aria-labelledby="application-feedback-title"
          >
            <h3 id="application-feedback-title">Staff feedback</h3>
            <p>
              Do you know this player? Share relevant experience, concerns, or
              support for their application.
            </p>
            {(data.comments ?? []).map((entry) => (
              <article className="application-feedback" key={entry.id}>
                <header className="application-feedback-author">
                  <span
                    className="application-feedback-avatar"
                    aria-hidden="true"
                  >
                    {entry.author.name?.trim().charAt(0).toUpperCase() || "?"}
                    {entry.author.avatar && (
                      <img
                        src={entry.author.avatar}
                        alt=""
                        loading="lazy"
                        onError={(event) => {
                          event.currentTarget.hidden = true;
                        }}
                      />
                    )}
                  </span>
                  <div>
                    <strong>{entry.author.name}</strong>
                    {" · "}
                    <time>{new Date(entry.createdAt).toLocaleString()}</time>
                  </div>
                </header>
                <p>{entry.text}</p>
              </article>
            ))}
            {!data.comments?.length && <p>No staff feedback yet.</p>}
            {capabilities["applications.comment"] && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  review("comments", { comment });
                }}
              >
                <label className="apply-field">
                  <span>Your feedback</span>
                  <textarea
                    required
                    minLength={3}
                    maxLength={4000}
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <button className="apply-button" disabled={busy}>
                  Post feedback
                </button>
              </form>
            )}
          </section>
          <section
            className="application-response"
            aria-labelledby="application-decision-title"
          >
            <h3 id="application-decision-title">Application decision</h3>
            {data.review && (
              <p>
                Review started by {data.review.author.name} on{" "}
                {new Date(data.review.startedAt).toLocaleString()}.
              </p>
            )}
            {data.decision ? (
              <>
                <p>
                  {data.status} by {data.decision.author.name} on{" "}
                  {new Date(data.decision.decidedAt).toLocaleString()}.
                </p>
                {data.decision.reason && <p>{data.decision.reason}</p>}
                {data.decision.reapplyAfter && (
                  <p>
                    The applicant may apply for this role again from{" "}
                    {new Date(data.decision.reapplyAfter).toLocaleString()}.
                    Minimum wait: {data.decision.reapplyDays} days after denial.
                  </p>
                )}
              </>
            ) : canDecide ? (
              <>
                <p>
                  Review actions follow your role permissions. Applicants
                  receive updates using their selected notification method.
                  Discord roles are assigned separately.
                </p>
                {capabilities["applications.review"] &&
                  data.status === "Received" && (
                    <button
                      className="apply-button application-review-start"
                      disabled={busy}
                      onClick={() => review("review", {})}
                    >
                      Start reviewing
                    </button>
                  )}
                {(capabilities["applications.approve"] ||
                  capabilities["applications.deny"]) && (
                  <label className="apply-field">
                    <span>Message to applicant (optional)</span>
                    <textarea
                      maxLength={2000}
                      placeholder="Leave blank to send a generic denial message."
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                )}
                {capabilities["applications.deny"] && (
                  <label className="apply-field">
                    <span>
                      Wait before reapplying for this role (days, if denied)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={365}
                      step={1}
                      value={reapplyDays}
                      onChange={(event) => setReapplyDays(event.target.value)}
                      disabled={busy}
                    />
                    <small>
                      Choose 0–365 whole days, counted from the denial. Zero
                      adds no waiting period.
                    </small>
                  </label>
                )}
                <div className="apply-actions">
                  {capabilities["applications.approve"] && (
                    <button
                      className="apply-button application-approve"
                      disabled={busy}
                      onClick={() =>
                        review("decision", { decision: "approve", reason })
                      }
                    >
                      Approve application
                    </button>
                  )}
                  {capabilities["applications.deny"] && (
                    <button
                      className="apply-secondary application-deny"
                      disabled={busy}
                      onClick={() =>
                        review("decision", {
                          decision: "deny",
                          reason,
                          reapplyDays:
                            reapplyDays.trim() === ""
                              ? null
                              : Number(reapplyDays),
                        })
                      }
                    >
                      Deny application
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p>Awaiting a decision from an authorized reviewer.</p>
            )}
            {reviewError && (
              <p className="apply-error" role="alert">
                {reviewError}
              </p>
            )}
          </section>
          <section
            className="application-response"
            aria-labelledby="application-dm-title"
          >
            <h3 id="application-dm-title">Applicant updates</h3>
            <p>
              {data.notificationPreference === "email" || !data.discord
                ? data.emailEnabled
                  ? "Email updates are selected. Delivery status shows when the mail service accepted each update. Refresh to see changes."
                  : "Email contact selected. Automatic sending is awaiting SMTP setup. Use the contact email to follow up manually."
                : "Discord DMs are preferred. Blocked DMs fall back to a private channel in the main Drakora server. Refresh to see delivery updates."}
            </p>
            <NotificationDeliveries notifications={data.notifications} />
          </section>
          <p className="apply-muted">
            Reference {data.id} · Questionnaire version{" "}
            {data.questionnaireVersion}
          </p>
        </div>
        <ApplicationPlayer
          application={data}
          listSearch={listSearch}
          capabilities={capabilities}
        />
      </div>
    </article>
  );
}
