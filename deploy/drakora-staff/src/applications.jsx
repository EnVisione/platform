import React, { useEffect, useState } from "react";
import {
  applicationRoles,
  applicationStatuses,
  communityOptions,
  questionList,
} from "../shared/application-form.js";
import "./apply.css";
import { EvidenceLinks } from "./application-evidence.jsx";
import { ApplicationPlayer } from "./application-player.jsx";
import { ApplicationFormEditor } from "./application-form-editor.jsx";

function ApplicationStatus({ status }) {
  const tone =
    {
      Received: "received",
      Reviewing: "reviewing",
      Approved: "approved",
      Denied: "denied",
    }[status] || "received";
  return (
    <span className={`application-status application-status-${tone}`}>
      {applicationStatuses[status] || status}
    </span>
  );
}

function applicationListSearch(offset, { role, status }) {
  const query = new URLSearchParams({ offset: String(offset) });
  if (role) query.set("role", role);
  if (status) query.set("status", status);
  return `?${query}`;
}

export function StaffApplications({ csrf, canDecide }) {
  if (location.pathname === "/applications/editor")
    return canDecide ? (
      <ApplicationFormEditor csrf={csrf} />
    ) : (
      <p className="notice">
        Only Managers and Founders can edit application questions.
      </p>
    );
  return <ApplicationReviews csrf={csrf} canDecide={canDecide} />;
}

function ApplicationReviews({ csrf, canDecide }) {
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
    return {
      role: Object.hasOwn(applicationRoles, role) ? role : "",
      status: Object.hasOwn(applicationStatuses, status) ? status : "",
    };
  });
  const listSearch = applicationListSearch(offset, filters);
  const filtered = Boolean(filters.role || filters.status);
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
            "Feedback requires Jr Moderator rank or higher and Dashboard access.",
          application_decision_role_required:
            "Only Managers and Founders with Dashboard access can start review, approve, or deny applications.",
          application_already_decided:
            "Another Manager or Founder already decided this application. Refresh to see the decision.",
          application_comments_full:
            "This application has reached its feedback limit.",
          invalid_application_comment:
            "Write between 3 and 4,000 characters of feedback.",
          application_denial_reason_required:
            "Write a denial message so the applicant understands the decision.",
          invalid_reapplication_wait:
            "Choose a whole number of days between 7 and 365.",
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
              ? "Application access requires the Dashboard role and Jr Moderator rank or higher."
              : response.status === 404
                ? "Application not found."
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
        {canDecide && (
          <a
            className="apply-button apply-primary application-editor-link"
            href="/applications/editor"
          >
            Edit application questions
          </a>
        )}
        <p>
          Private submissions for Jr Moderator rank and higher. Share what you
          know about the applicant. Managers and Founders make the final
          decision.
        </p>
        <fieldset className="application-filters">
          <legend className="sr-only">Filter staff applications</legend>
          <label>
            Application type
            <select
              value={filters.role}
              onChange={(event) =>
                updateList({ ...filters, role: event.target.value })
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
                updateList({ ...filters, status: event.target.value })
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
          <button
            type="button"
            disabled={!filtered}
            onClick={() => updateList({ role: "", status: "" })}
          >
            Reset filters
          </button>
        </fieldset>
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
                <strong>{entry.author.name}</strong>
                {" · "}
                <time>{new Date(entry.createdAt).toLocaleString()}</time>
                <p>{entry.text}</p>
              </article>
            ))}
            {!data.comments?.length && <p>No staff feedback yet.</p>}
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
                  Only Managers and Founders can start review or decide
                  applications. Linked Discord applicants receive status updates
                  by DM. Discord roles are assigned separately.
                </p>
                {data.status === "Received" && (
                  <button
                    className="apply-button application-review-start"
                    disabled={busy}
                    onClick={() => review("review", {})}
                  >
                    Start reviewing
                  </button>
                )}
                <label className="apply-field">
                  <span>Message to applicant (required for denial)</span>
                  <textarea
                    maxLength={2000}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="apply-field">
                  <span>
                    Wait before reapplying for this role (days, if denied)
                  </span>
                  <input
                    type="number"
                    min={7}
                    max={365}
                    step={1}
                    value={reapplyDays}
                    onChange={(event) => setReapplyDays(event.target.value)}
                    disabled={busy}
                  />
                  <small>
                    The minimum wait is 7 days, counted from the denial.
                  </small>
                </label>
                <div className="apply-actions">
                  <button
                    className="apply-button application-approve"
                    disabled={busy}
                    onClick={() =>
                      review("decision", { decision: "approve", reason })
                    }
                  >
                    Approve application
                  </button>
                  <button
                    className="apply-secondary application-deny"
                    disabled={busy}
                    onClick={() =>
                      review("decision", {
                        decision: "deny",
                        reason,
                        reapplyDays: Number(reapplyDays),
                      })
                    }
                  >
                    Deny application
                  </button>
                </div>
              </>
            ) : (
              <p>
                Awaiting a Manager or Founder decision. You can add staff
                feedback above.
              </p>
            )}
            {reviewError && (
              <p className="apply-error" role="alert">
                {reviewError}
              </p>
            )}
          </section>
          {data.discord ? (
            <section
              className="application-response"
              aria-labelledby="application-dm-title"
            >
              <h3 id="application-dm-title">Applicant Discord updates</h3>
              <p>
                Messages go to the Discord account linked when this application
                was submitted. Refresh to see delivery updates.
              </p>
              {data.notifications?.length ? (
                <ul>
                  {data.notifications.map((notification) => (
                    <li key={notification.event}>
                      {
                        {
                          received: "Submission confirmation",
                          reviewing: "Review started",
                          approved: "Approval",
                          denied: "Denial",
                        }[notification.event]
                      }
                      :{" "}
                      {notification.pending
                        ? "Queued"
                        : notification.sentAt
                          ? `Sent ${new Date(notification.sentAt).toLocaleString()}`
                          : "Could not deliver. Use the contact email to follow up."}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  No updates scheduled for this older submission. Starting
                  review or making a decision will send an update.
                </p>
              )}
            </section>
          ) : (
            <p className="apply-muted">
              Discord is not linked. Use the contact email to communicate review
              updates and decisions.
            </p>
          )}
          <p className="apply-muted">
            Reference {data.id} · Questionnaire version{" "}
            {data.questionnaireVersion}
          </p>
        </div>
        <ApplicationPlayer application={data} />
      </div>
    </article>
  );
}
