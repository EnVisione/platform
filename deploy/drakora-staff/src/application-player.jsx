import React, { useEffect, useState } from "react";
import { applicationRoles } from "../shared/application-form.js";
import { ApplicationStatus } from "./application-status.jsx";
import { ModerationHistoryCard } from "./moderation.jsx";

function PreviousApplications({ id, listSearch }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setError("");
    fetch(
      `/api/applications/${encodeURIComponent(id)}/history?offset=${offset}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Could not load previous applications.");
        const result = await response.json();
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [id, offset, refresh]);
  return (
    <section
      className="application-player-card"
      aria-labelledby="application-previous-title"
    >
      <h2 id="application-previous-title">Previous staff applications</h2>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button onClick={() => setRefresh((value) => value + 1)}>
            Try again
          </button>
        </>
      ) : !page ? (
        <p role="status">Loading previous applications…</p>
      ) : !page.total ? (
        <p className="apply-muted">No previous applications found.</p>
      ) : (
        <>
          <p className="apply-muted">
            {page.total} other{" "}
            {page.total === 1 ? "application" : "applications"}
          </p>
          <ul className="application-previous-list">
            {page.items.map((item) => (
              <li key={item.id}>
                <a
                  href={`/applications/${encodeURIComponent(item.id)}${listSearch}`}
                >
                  <strong>
                    {applicationRoles[item.role]?.label || item.role}
                  </strong>
                  <ApplicationStatus status={item.status} />
                  <span>{item.ign}</span>
                  <time dateTime={new Date(item.createdAt).toISOString()}>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                  <span className="application-previous-open">
                    View application →
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {page.total > page.pageSize && (
            <nav
              className="application-previous-pages"
              aria-label="Previous application pages"
            >
              <button
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - page.pageSize))}
              >
                Previous
              </button>
              <span role="status">
                {offset + 1}–{Math.min(offset + page.pageSize, page.total)} of{" "}
                {page.total}
              </span>
              <button
                disabled={offset + page.pageSize >= page.total}
                onClick={() => setOffset(offset + page.pageSize)}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
      <p className="apply-muted application-previous-note">
        Applications without Discord are matched by contact email and Minecraft
        name.
      </p>
    </section>
  );
}

function PendingStats({ labels }) {
  return (
    <dl className="application-player-stats">
      {labels.map((label) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className="application-stat-pending">Not connected</dd>
        </div>
      ))}
    </dl>
  );
}

export function ApplicationPlayer({
  application,
  listSearch = "",
  capabilities = {},
}) {
  const identifier = /^[a-f0-9]{32}$/i.test(application.minecraft.uuid ?? "")
    ? application.minecraft.uuid
    : application.answers.ign;
  return (
    <aside
      className="application-player"
      aria-label="Applicant player information"
    >
      <section className="application-player-card">
        <div className="application-player-profile">
          <div>
            <h2>Player profile</h2>
            <strong className="application-player-name">
              {application.answers.ign}
            </strong>
            <p className="apply-muted">{application.minecraft.verification}</p>
          </div>
          {/^[A-Za-z0-9_]{3,16}$/.test(application.answers.ign ?? "") && (
            <img
              key={identifier}
              className="application-player-avatar"
              src={`/apply/api/head/${encodeURIComponent(identifier)}`}
              alt={`${application.answers.ign}'s Minecraft skin`}
              width="64"
              height="64"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          )}
        </div>
        <dl className="application-player-stats">
          <div>
            <dt>Profile UUID</dt>
            <dd className="application-player-uuid">
              {application.minecraft.uuid || "Not resolved"}
            </dd>
          </div>
        </dl>
      </section>
      <section className="application-player-card">
        <h2>Drakora activity</h2>
        <p className="apply-muted">
          Player statistics will appear here once the network is connected.
          These placeholders are not recorded activity.
        </p>
        <PendingStats
          labels={[
            "Total network playtime",
            "First joined Drakora",
            "Last in-game login",
            "Playtime in the last 30 days",
            "Days active in the last 30 days",
          ]}
        />
      </section>
      <section className="application-player-card">
        <h2>Playtime per server</h2>
        <h3>Prominence II</h3>
        <PendingStats labels={["Luna", "Terra", "Sol"]} />
        <h3>Restless Horizons</h3>
        <PendingStats labels={["Eclipse", "Void"]} />
        <h3>Hubs</h3>
        <PendingStats labels={["Hub servers"]} />
      </section>
      <section className="application-player-card">
        <h2>Proxy activity</h2>
        <PendingStats labels={["EU proxy sessions", "NA proxy sessions"]} />
      </section>
      {capabilities["moderation.view"] && (
        <ModerationHistoryCard
          key={`moderation:${application.id}`}
          endpoint={`/api/applications/${encodeURIComponent(application.id)}/moderation`}
        />
      )}
      <PreviousApplications
        key={application.id}
        id={application.id}
        listSearch={listSearch}
      />
    </aside>
  );
}
