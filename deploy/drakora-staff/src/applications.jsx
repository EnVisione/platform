import React, { useEffect, useState } from "react";
import { applicationRoles, questionList } from "../shared/application-form.js";
import "./apply.css";

export function StaffApplications({ csrf, canDecide }) {
  const id = location.pathname.split("/")[2];
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
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
            "Only Managers and Founders with Dashboard access can approve or deny applications.",
          application_already_decided:
            "Another Manager or Founder already decided this application. Refresh to see the decision.",
          application_comments_full:
            "This application has reached its feedback limit.",
          invalid_application_comment:
            "Write between 3 and 4,000 characters of feedback.",
        };
        throw new Error(
          messages[result.error] ||
            "Could not save your review. Please try again.",
        );
      }
      setData(result);
      if (action === "comments") setComment("");
      else setReason("");
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
        : `/api/applications?offset=${offset}`,
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
        setData(await response.json());
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [id, offset]);
  if (error)
    return (
      <p className="notice" role="alert">
        {error}
      </p>
    );
  if (!data) return <p>Loading applications…</p>;
  if (!id)
    return (
      <section className="staff-applications">
        <h2>Staff Applications</h2>
        <p>
          Private submissions for Jr Moderator rank and higher. Share what you
          know about the applicant. Managers and Founders make the final
          decision.
        </p>
        {data.items.length ? (
          <div className="application-list">
            {data.items.map((item) => (
              <a
                key={item.id}
                className="application-row"
                href={`/applications/${item.id}`}
              >
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {item.ign} · {applicationRoles[item.role].label}
                  </span>
                </div>
                <div>
                  <span>{item.status}</span>
                  <time>{new Date(item.createdAt).toLocaleString()}</time>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <p>No applications yet.</p>
        )}
        <div className="apply-actions">
          <button
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </button>
          <span>{data.total} applications</span>
          <button
            disabled={offset + 50 >= data.total}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </button>
        </div>
      </section>
    );
  const a = data.answers;
  return (
    <article className="staff-applications">
      <a href="/applications">← All applications</a>
      <h2>{a.displayName}</h2>
      <p>
        {applicationRoles[data.role].label} · {data.status} ·{" "}
        {new Date(data.createdAt).toLocaleString()}
      </p>
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
        <dt>Minecraft name</dt>
        <dd>
          {a.ign} · {data.minecraft.verification}
        </dd>
        <dt>Profile UUID</dt>
        <dd>{data.minecraft.uuid || "Not resolved"}</dd>
        <dt>Contact email</dt>
        <dd>{data.contactEmail}</dd>
        <dt>Pronouns</dt>
        <dd>{a.pronouns}</dd>
        <dt>Age</dt>
        <dd>{a.age}</dd>
        <dt>Timezone</dt>
        <dd>{a.timezone}</dd>
        <dt>Available hours / week</dt>
        <dd>{a.hoursPerWeek}</dd>
        <dt>Active communities</dt>
        <dd>{a.communities.join(", ")}</dd>
        {!data.discord && (
          <>
            <dt>Uses Discord</dt>
            <dd>
              {a.discordUses}
              {a.discordWhy && ` — ${a.discordWhy}`}
            </dd>
          </>
        )}
      </dl>
      <p className="apply-muted">
        Minecraft network history, playtime, and in-game verification will
        appear after server integration.
      </p>
      {questionList(data.role, a.communities).map(([key, label]) => (
        <section className="application-response" key={key}>
          <h3>{label}</h3>
          {key === "scenarioAnswer" && <blockquote>{data.scenario}</blockquote>}
          <p>{a[key] || "Not provided"}</p>
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
        {data.decision ? (
          <>
            <p>
              {data.status} by {data.decision.author.name} on{" "}
              {new Date(data.decision.decidedAt).toLocaleString()}.
            </p>
            {data.decision.reason && <p>{data.decision.reason}</p>}
          </>
        ) : canDecide ? (
          <>
            <p>
              Only Managers and Founders can decide applications. This records
              the decision; Discord roles are assigned separately.
            </p>
            <label className="apply-field">
              <span>Decision reason (optional)</span>
              <textarea
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={busy}
              />
            </label>
            <div className="apply-actions">
              <button
                className="apply-button"
                disabled={busy}
                onClick={() =>
                  review("decision", { decision: "approve", reason })
                }
              >
                Approve application
              </button>
              <button
                className="apply-secondary"
                disabled={busy}
                onClick={() => review("decision", { decision: "deny", reason })}
              >
                Deny application
              </button>
            </div>
          </>
        ) : (
          <p>
            Awaiting a Manager or Founder decision. You can add staff feedback
            above.
          </p>
        )}
        {reviewError && (
          <p className="apply-error" role="alert">
            {reviewError}
          </p>
        )}
      </section>
      <p className="apply-muted">
        Reference {data.id} · Questionnaire version {data.questionnaireVersion}
      </p>
    </article>
  );
}
