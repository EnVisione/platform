import React, { useEffect, useState } from "react";
import "./moderation.css";
import { DateFilters } from "./list-filters.jsx";

const labels = { warn: "Warning", timeout: "Timed out", ban: "Ban" };
const date = (value) => new Date(value).toLocaleString();

function useModeration(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false,
      denied = false;
    setData(null);
    setError("");
    async function load() {
      if (pending || denied || controller.signal.aborted) return;
      pending = true;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          denied = [401, 403].includes(response.status);
          throw new Error(
            denied
              ? "Your current staff permissions do not allow this moderation history."
              : response.status === 404
                ? "This moderation record is unavailable or has expired."
                : response.status === 400
                  ? "Check the filters and choose a valid date range."
                  : "Could not load moderation history. Try again.",
          );
        }
        const value = await response.json();
        if (!controller.signal.aborted) {
          setData(value);
          setError("");
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setData(null);
          setError(failure.message);
        }
      } finally {
        pending = false;
      }
    }
    void load();
    const refresh = () => {
      if (!document.hidden) void load();
    };
    const timer = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [url, revision]);
  return { data, error, refresh: () => setRevision((value) => value + 1) };
}

function Action({ action }) {
  return (
    <span className={`moderation-badge moderation-${action}`}>
      {labels[action] || action}
    </span>
  );
}

function Counts({ counts }) {
  return (
    <dl className="moderation-counts">
      <div>
        <dt>Warnings</dt>
        <dd>{counts.warn}</dd>
      </div>
      <div>
        <dt>Timeouts</dt>
        <dd>{counts.timeout}</dd>
      </div>
      <div>
        <dt>Bans</dt>
        <dd>{counts.ban}</dd>
      </div>
    </dl>
  );
}

function Entries({ items, search = "" }) {
  return (
    <ul className="moderation-list">
      {items.map((record) => (
        <li key={record.id}>
          <a href={`/moderation/${record.id}${search}`}>
            <span className="moderation-person">
              <strong>{record.name}</strong>
              <small>
                {record.username ? `@${record.username}` : record.userId}
              </small>
            </span>
            <Action action={record.action} />
            <span>{record.source}</span>
            <time dateTime={new Date(record.at).toISOString()}>
              {date(record.at)}
            </time>
            <span className="moderation-open">View reason →</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function LoadState({ error, refresh }) {
  return error ? (
    <div className="moderation-notice">
      <p role="alert">{error}</p>
      <button onClick={refresh}>Try again</button>
    </div>
  ) : (
    <p role="status">Loading moderation history…</p>
  );
}

function Pages({ page, offset, change }) {
  if (page.total <= page.pageSize) return null;
  return (
    <nav className="moderation-pages" aria-label="Moderation history pages">
      <button
        disabled={!offset}
        onClick={() => change(Math.max(0, offset - page.pageSize))}
      >
        Previous
      </button>
      <span>
        {offset + 1}–{Math.min(offset + page.pageSize, page.total)} of{" "}
        {page.total}
      </span>
      <button
        disabled={offset + page.pageSize >= page.total}
        onClick={() => change(offset + page.pageSize)}
      >
        Next
      </button>
    </nav>
  );
}

export function ModerationHistoryCard({ endpoint }) {
  const [offset, setOffset] = useState(0);
  const { data, error, refresh } = useModeration(
    `${endpoint}?offset=${offset}`,
  );
  return (
    <section
      className="moderation-card"
      aria-label="Discord moderation history"
    >
      <div className="moderation-heading">
        <h2>Moderation history</h2>
        <button onClick={refresh}>Refresh</button>
      </div>
      {!data ? (
        <LoadState error={error} refresh={refresh} />
      ) : !data.matched ? (
        <p>
          No verified Discord account is connected. Moderation records cannot be
          matched by a claimed username.
        </p>
      ) : (
        <>
          <Counts counts={data.counts} />
          {data.total ? (
            <Entries items={data.items} />
          ) : (
            <p>No recorded moderation actions in the last 90 days.</p>
          )}
          <Pages page={data} offset={offset} change={setOffset} />
        </>
      )}
      <p className="moderation-muted">
        Recorded Discord actions · last 90 days
      </p>
    </section>
  );
}

export function Moderation({ onNavigate }) {
  const params = new URLSearchParams(location.search);
  const detailId = location.pathname.split("/")[2];
  const [term, setTerm] = useState(params.get("query") || "");
  const offset = Number(params.get("offset") || 0);
  const { data, error, refresh } = useModeration(
    detailId
      ? `/api/moderation/${encodeURIComponent(detailId)}`
      : `/api/moderation?${params}`,
  );
  const change = (key, value) => {
    if (value) params.set(key, String(value));
    else params.delete(key);
    if (key !== "offset") {
      params.delete("offset");
      if (key !== "query") params.set("query", term.trim());
    }
    onNavigate(`/moderation?${params}`);
  };
  return (
    <article className="moderation-page">
      {detailId ? (
        <>
          <a href={`/moderation${location.search}`} className="moderation-back">
            ← Moderation history
          </a>
          {!data ? (
            <LoadState error={error} refresh={refresh} />
          ) : (
            <section className="moderation-detail">
              <div className="moderation-heading">
                <h2>{data.name}</h2>
                <Action action={data.action} />
              </div>
              <dl>
                <div>
                  <dt>Discord username</dt>
                  <dd>
                    {data.username ? `@${data.username}` : "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt>Discord ID</dt>
                  <dd>{data.userId}</dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd>{data.reason}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{data.source} · Drakora bot</dd>
                </div>
                <div>
                  <dt>Action recorded</dt>
                  <dd>{date(data.at)}</dd>
                </div>
                {data.timeoutUntil && (
                  <div>
                    <dt>Timeout scheduled until</dt>
                    <dd>{date(data.timeoutUntil)}</dd>
                  </div>
                )}
                {data.action === "ban" && (
                  <div>
                    <dt>Ban duration</dt>
                    <dd>Permanent when imposed</dd>
                  </div>
                )}
                <div>
                  <dt>Record retained until</dt>
                  <dd>{date(data.expiresAt)}</dd>
                </div>
              </dl>
              <p className="moderation-muted">
                This records the action when imposed. It does not change an
                application decision.
              </p>
              <button onClick={refresh}>Refresh record</button>
            </section>
          )}
        </>
      ) : (
        <>
          <div className="moderation-heading">
            <div>
              <h2>Moderation history</h2>
              <p className="moderation-muted">
                Recorded warnings, timeouts and bans · last 90 days
              </p>
            </div>
            <button onClick={refresh}>Refresh</button>
          </div>
          <form
            className="moderation-filters list-filters"
            onSubmit={(event) => {
              event.preventDefault();
              change("query", term);
            }}
          >
            <label>
              Person, Discord ID or reason
              <input
                type="search"
                value={term}
                maxLength={100}
                onChange={(event) => setTerm(event.target.value)}
              />
            </label>
            <button type="submit">Search</button>
            <label>
              Action
              <select
                value={params.get("action") || "all"}
                onChange={(event) => change("action", event.target.value)}
              >
                <option value="all">All actions</option>
                <option value="warn">Warnings</option>
                <option value="timeout">Timeouts</option>
                <option value="ban">Bans</option>
              </select>
            </label>
            <DateFilters
              from={params.get("from") || ""}
              to={params.get("to") || ""}
              change={change}
            />
            <button
              type="button"
              onClick={() => {
                setTerm("");
                onNavigate("/moderation");
              }}
            >
              Reset filters
            </button>
          </form>
          {!data ? (
            <LoadState error={error} refresh={refresh} />
          ) : (
            <>
              <Counts counts={data.counts} />
              {data.total ? (
                <Entries items={data.items} search={location.search} />
              ) : (
                <p className="moderation-notice">
                  No recorded moderation actions match these filters.
                </p>
              )}
              <Pages
                page={data}
                offset={offset}
                change={(value) => change("offset", value)}
              />
            </>
          )}
        </>
      )}
    </article>
  );
}
