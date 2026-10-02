import React, { useEffect, useState } from "react";
import { applicationRoles, questionList } from "../shared/application-form.js";
import "./apply.css";

export function StaffApplications() {
  const id = location.pathname.split("/")[2];
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
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
              ? "Application access requires the Dashboard role and Moderator, Admin, or Founder rank."
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
          Private submissions for Moderator, Admin, and Founder staff. Review
          and approval controls will be added later.
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
      <p className="apply-muted">
        Reference {data.id} · Questionnaire version {data.questionnaireVersion}
      </p>
    </article>
  );
}
