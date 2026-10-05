import React, { useEffect, useState } from "react";
import { Tickets } from "./tickets.jsx";
import "./staff-reviews.css";

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "service_unavailable");
  return data;
}
const date = (at) => (at ? new Date(at).toLocaleString() : "Not observed");
const labels = {
  open: "Review in progress",
  promotion_pending: "Promotion syncing",
  promoted: "Promoted",
  continued: "Continue observing",
  cancelled: "Cancelled",
};
const errors = {
  staff_review_roles_changed:
    "Their roles changed during this review. Refresh and start a new review with the current roles.",
  staff_review_ineligible:
    "Managers, Founders and former staff are not eligible for reviews.",
  invalid_review_promotion: "Choose an available higher rank.",
  staff_review_already_decided:
    "This review already has a decision. Refresh to see it.",
  staff_review_manager_required:
    "Only Managers and Founders can view staff reviews.",
};
const failure = (error) =>
  errors[error.message] || "Could not complete this action. Please try again.";
const mutation = (csrf, body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
  body: JSON.stringify(body),
});

export function AccountReview({ account, csrf }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const schedule = account.staffReview;
  async function start() {
    setBusy(true);
    setError("");
    try {
      const data = await request(
        `/api/staff-reviews/start/${account.id}`,
        mutation(csrf, {}),
      );
      location.assign(`/staff-reviews/${data.review.id}`);
    } catch (error) {
      setError(failure(error));
      setBusy(false);
    }
  }
  if (!account.reviewEligible && !schedule?.openId) return null;
  return (
    <div className="account-review">
      {schedule?.openId ? (
        <a className="review-link" href={`/staff-reviews/${schedule.openId}`}>
          {labels[schedule.status] || "Open review"}
        </a>
      ) : (
        <>
          <span>
            Next staff review:{" "}
            {schedule ? date(schedule.nextDue) : "Scheduling…"}
          </span>
          <button disabled={busy} onClick={start}>
            {busy ? "Starting…" : "Start review early"}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function ReviewLogs() {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [offset, setOffset] = useState(0),
    [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    request(
      `/api/staff-reviews?${new URLSearchParams({ query, status, offset: String(offset) })}`,
      { signal: controller.signal },
    )
      .then(setData)
      .catch((error) => {
        if (error.name !== "AbortError") setError(failure(error));
      });
    return () => controller.abort();
  }, [query, status, offset]);
  return (
    <section className="staff-review-panel">
      <h2>Staff reviews</h2>
      <p>
        Monthly reviews, early evaluations and promotion decisions. Managers and
        Founders only.
      </p>
      <div className="review-filters">
        <label>
          Search staff
          <input
            value={query}
            placeholder="Discord or Minecraft name"
            maxLength={100}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          Reviews
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All reviews</option>
            <option value="open">In progress</option>
            <option value="closed">Completed</option>
          </select>
        </label>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!data && !error ? (
        <p>Loading reviews…</p>
      ) : (
        data && (
          <>
            <div className="review-list">
              {data.reviews.map((review) => (
                <a href={`/staff-reviews/${review.id}`} key={review.id}>
                  <strong>{review.member.name}</strong>
                  <span>{review.ranks.join(" · ")}</span>
                  <span>
                    {labels[review.status]} · {date(review.openedAt)}
                  </span>
                </a>
              ))}
            </div>
            {!data.total && <p>No staff reviews yet.</p>}
            <div className="review-pagination">
              <button
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 30))}
              >
                Previous
              </button>
              <span>{data.total} reviews</span>
              <button
                disabled={offset + 30 >= data.total}
                onClick={() => setOffset(offset + 30)}
              >
                Next
              </button>
            </div>
          </>
        )
      )}
    </section>
  );
}
export function StaffLogs({ user, csrf }) {
  const ticketsAllowed = Boolean(user.capabilities["logs.view"]);
  const [tab, setTab] = useState(
    user.staffReviews &&
      (!ticketsAllowed ||
        new URLSearchParams(location.search).get("tab") === "staff-reviews")
      ? "reviews"
      : "tickets",
  );
  return (
    <>
      <div className="review-tabs">
        {ticketsAllowed && (
          <button
            aria-pressed={tab === "tickets"}
            onClick={() => setTab("tickets")}
          >
            Tickets
          </button>
        )}
        {user.staffReviews && (
          <button
            aria-pressed={tab === "reviews"}
            onClick={() => setTab("reviews")}
          >
            Staff reviews
          </button>
        )}
      </div>
      {tab === "reviews" && user.staffReviews ? (
        <ReviewLogs />
      ) : ticketsAllowed ? (
        <Tickets csrf={csrf} capabilities={user.capabilities} logs />
      ) : (
        <p className="notice">Your roles do not have access to these logs.</p>
      )}
    </>
  );
}
export function StaffReview({ csrf }) {
  const id = location.pathname.split("/").at(-1);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [body, setBody] = useState(""),
    [assessment, setAssessment] = useState(""),
    [promoting, setPromoting] = useState(false),
    [roles, setRoles] = useState([]),
    [roleId, setRoleId] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = () =>
      request(`/api/staff-reviews/${id}`, { signal: controller.signal })
        .then((value) => {
          if (active) setData(value);
        })
        .catch((error) => {
          if (active && error.name !== "AbortError") {
            setError(failure(error));
            if (
              ["staff_review_manager_required", "login_required"].includes(
                error.message,
              )
            )
              setData(null);
          }
        });
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      active = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [id]);
  async function send(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request(
        `/api/staff-reviews/${id}/messages`,
        mutation(csrf, { body, requestId }),
      );
      setBody("");
      setRequestId(crypto.randomUUID());
      setData(await request(`/api/staff-reviews/${id}`));
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  async function choosePromotion() {
    setError("");
    setBusy(true);
    try {
      const data = await request(`/api/staff-reviews/${id}/roles`);
      setRoles(data.roles);
      setPromoting(true);
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  async function decide(action) {
    setBusy(true);
    setError("");
    try {
      await request(
        `/api/staff-reviews/${id}/decision`,
        mutation(csrf, { action, roleId, message, assessment }),
      );
      setData(await request(`/api/staff-reviews/${id}`));
      setPromoting(false);
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  const review = data?.review,
    progress = review?.progress;
  return (
    <section className="staff-review-panel">
      <a href="/accounts">← Staff accounts</a>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!review ? (
        !error && <p>Loading staff review…</p>
      ) : (
        <>
          <header className="review-heading">
            <div>
              <h2>{review.member.name} · Staff review</h2>
              <p>
                {review.ranks.join(" · ")}
                {review.member.minecraft ? ` · ${review.member.minecraft}` : ""}
              </p>
              <span>{labels[review.status]}</span>
            </div>
            {review.discord.threadId && (
              <a
                href={`https://discord.com/channels/${data.guildId}/${review.discord.threadId}`}
                target="_blank"
                rel="noreferrer"
              >
                Open Discord thread ↗
              </a>
            )}
          </header>
          {review.error && (
            <p className="notice">
              {review.status === "cancelled"
                ? "A newer role assignment replaced this promotion."
                : "The promotion could not finish. Check their current roles and role permissions, then retry."}
            </p>
          )}
          {review.discord.error && (
            <p className="notice">{review.discord.error}</p>
          )}
          <div className="review-layout">
            <div className="review-conversation">
              <h3>Manager discussion</h3>
              {!data.messages.length && (
                <p className="muted">
                  Discuss their work, strengths and what to improve. Messages
                  sync with the private Discord review thread.
                </p>
              )}
              {data.messages.map((item) => (
                <article key={item.id}>
                  <strong>{item.author.name}</strong>
                  <small>
                    {date(item.at)} ·{" "}
                    {item.origin === "discord" ? "Discord" : "Panel"}
                    {item.editedAt ? " · edited" : ""}
                  </small>
                  <p>{item.body}</p>
                </article>
              ))}
              {review.status === "open" && (
                <form onSubmit={send}>
                  <label>
                    Message
                    <textarea
                      value={body}
                      maxLength={4000}
                      rows={4}
                      onChange={(event) => {
                        setBody(event.target.value);
                        setRequestId(crypto.randomUUID());
                      }}
                      disabled={busy}
                      required
                    />
                  </label>
                  <button disabled={busy || !body.trim()} type="submit">
                    Send
                  </button>
                </form>
              )}
            </div>
            <aside className="review-progress">
              <h3>Progress</h3>
              <p>
                {date(review.periodFrom)} → {date(review.openedAt)}
              </p>
              <p>Review date: {date(review.dueAt)}</p>
              <p>
                {review.anchorSource === "application"
                  ? "Schedule starts from application acceptance."
                  : "Schedule starts from first review enrollment; no acceptance date was recorded."}
              </p>
              <dl>
                <dt>Tickets resolved in this period</dt>
                <dd>{progress.ticketsResolved}</dd>
                <dt>Player replies in this period</dt>
                <dd>{progress.replies}</dd>
                <dt>Currently assigned tickets</dt>
                <dd>{progress.activeTickets}</dd>
                <dt>Player feedback</dt>
                <dd>
                  {progress.averageRating
                    ? `${progress.averageRating.toFixed(1)} / 5 · ${progress.ratingCount} ratings`
                    : "No ratings in this period"}
                </dd>
                <dt>Last observed Discord activity</dt>
                <dd>{date(progress.lastActiveAt)}</dd>
              </dl>
              <h4>Retained assigned tasks</h4>
              {progress.trackedTasks?.length ? (
                <ul>
                  {progress.trackedTasks.map((task, index) => (
                    <li key={index}>
                      {task.title} · {task.status}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No synced assigned tasks recorded.</p>
              )}
              <p className="muted">
                This summary uses retained support and tracker records.
                Minecraft playtime is not connected.
              </p>
            </aside>
          </div>
          {review.status === "open" ? (
            <div className="review-decision">
              <h3>Decision</h3>
              <label>
                Assessment (optional)
                <textarea
                  value={assessment}
                  maxLength={4000}
                  rows={3}
                  onChange={(event) => setAssessment(event.target.value)}
                />
              </label>
              {promoting ? (
                <>
                  <label>
                    Promote to
                    <select
                      value={roleId}
                      onChange={(event) => setRoleId(event.target.value)}
                    >
                      <option value="">Choose a higher rank</option>
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!roles.length && (
                    <p>No higher rank is available for you to assign.</p>
                  )}
                  <label>
                    Congratulations DM (optional)
                    <textarea
                      value={message}
                      maxLength={1500}
                      rows={3}
                      placeholder="Leave blank to use the default congratulations message."
                      onChange={(event) => setMessage(event.target.value)}
                    />
                  </label>
                  <button
                    className="review-promote"
                    disabled={busy || !roleId}
                    onClick={() => decide("promote")}
                  >
                    Confirm promotion
                  </button>
                  <button disabled={busy} onClick={() => setPromoting(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <div>
                  <button
                    className="review-continue"
                    disabled={busy}
                    onClick={() => decide("continue")}
                  >
                    Continue
                  </button>
                  <button
                    className="review-promote"
                    disabled={busy}
                    onClick={choosePromotion}
                  >
                    Promote
                  </button>
                </div>
              )}
              <p className="muted">
                Continue schedules the next monthly review. Promote saves a role
                change and sends a congratulations DM after both servers confirm
                it.
              </p>
            </div>
          ) : (
            review.decision && (
              <div className="review-decision">
                <h3>{labels[review.status]}</h3>
                <p>
                  {review.decision.actor.name} · {date(review.decision.at)}
                  {review.decision.roleName
                    ? ` · ${review.decision.roleName}`
                    : ""}
                </p>
                <p className="review-text">{review.decision.assessment}</p>
                {review.status === "promotion_pending" && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError("");
                      request(
                        `/api/staff-reviews/${id}/decision`,
                        mutation(csrf, {
                          action: "promote",
                          roleId: review.decision.roleId,
                        }),
                      )
                        .then(() => request(`/api/staff-reviews/${id}`))
                        .then(setData)
                        .catch((error) => setError(failure(error)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Retry promotion sync
                  </button>
                )}
                {review.discord.dm === "blocked" && (
                  <p className="notice">
                    The role was applied, but their Discord DMs are closed.
                  </p>
                )}
              </div>
            )
          )}
          <details>
            <summary>Review history</summary>
            {data.events.map((event) => (
              <p key={event.id}>
                {date(event.at)} · {event.actor.name} ·{" "}
                {event.action.replaceAll("_", " ")}
                {event.detail ? ` · ${event.detail}` : ""}
              </p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
