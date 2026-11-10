import React, { useState } from "react";
import {
  ModerationActionForm,
  useModerationResource,
} from "./moderation-cases.jsx";
import { moderationScopes } from "../shared/moderation.js";
import { PlayerResults } from "./player-results.jsx";
import "./player-results.css";

const date = (value) =>
  value === null || value === undefined
    ? "Not recorded"
    : new Date(value).toLocaleString();
const playtime = (seconds) =>
  `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
export function Players({ csrf, capabilities, onNavigate }) {
  const id = location.pathname.split("/")[2],
    params = new URLSearchParams(location.search);
  if (!params.has("online")) params.set("online", "true");
  const [query, setQuery] = useState(params.get("query") ?? ""),
    [alts, setAlts] = useState(null),
    [error, setError] = useState("");
  const {
    data,
    error: loadError,
    refresh,
  } = useModerationResource(
    id ? `/api/players/${encodeURIComponent(id)}` : `/api/players?${params}`,
  );
  const nickname = loadError ? "" : data?.nickname;
  const change = (key, value) => {
    params.set(key, value);
    if (key !== "offset") params.delete("offset");
    onNavigate(`/players?${params}`);
  };
  return (
    <article className="moderation-page">
      <header className="moderation-heading">
        <div className="moderation-person">
          <h2>{id ? nickname || data?.name || "Player" : "Players"}</h2>
          {id && nickname && <small>RealName: {data.name}</small>}
        </div>
        <button onClick={refresh}>Refresh</button>
      </header>
      {loadError && (
        <p role="alert">
          Could not load players. Check your current access and try again.
        </p>
      )}
      {id && <a href="/players">← Active players</a>}
      {!id && (
        <form
          className="moderation-filters list-filters"
          onSubmit={(event) => {
            event.preventDefault();
            change("query", query);
          }}
        >
          <label>
            Nickname, username or UUID
            <input
              type="search"
              value={query}
              maxLength={200}
              onChange={(event) =>
                setQuery(Array.from(event.target.value).slice(0, 100).join(""))
              }
            />
          </label>
          <button>Search</button>
          <label>
            Players
            <select
              value={params.get("online")}
              onChange={(event) => change("online", event.target.value)}
            >
              <option value="true">Active players</option>
              <option value="all">All recorded players</option>
            </select>
          </label>
          <label>
            Server
            <select
              value={params.get("server") ?? "all"}
              onChange={(event) => change("server", event.target.value)}
            >
              <option value="all">All servers</option>
              {moderationScopes
                .filter((scope) => !["network", "rh", "prom2"].includes(scope))
                .map((scope) => (
                  <option key={scope}>{scope}</option>
                ))}
            </select>
          </label>
        </form>
      )}
      {!data ? (
        <p>Loading players…</p>
      ) : id ? (
        <>
          <section className="moderation-detail">
            <dl>
              <div>
                <dt>Connection</dt>
                <dd>
                  {data.online
                    ? "Online"
                    : data.stale
                      ? "Unknown · report stale"
                      : "Offline"}
                </dd>
              </div>
              <div>
                <dt>Server</dt>
                <dd>
                  {data.server} · {data.proxy.toUpperCase()} proxy
                </dd>
              </div>
              <div>
                <dt>Last heartbeat</dt>
                <dd>{date(data.lastSeen)}</dd>
              </div>
              <div>
                <dt>Last login</dt>
                <dd>{date(data.lastLoginAt)}</dd>
              </div>
              <div>
                <dt>First network join</dt>
                <dd>{date(data.firstJoinedAt)}</dd>
              </div>
              <div>
                <dt>Recorded network playtime</dt>
                <dd>{playtime(data.playtimeSeconds)}</dd>
              </div>
              <div>
                <dt>Minecraft UUID</dt>
                <dd>{data.uuid}</dd>
              </div>
              {data.ip && (
                <div>
                  <dt>Reported address</dt>
                  <dd>{data.ip}</dd>
                </div>
              )}
            </dl>
            <h3>Recorded server playtime</h3>
            {Object.keys(data.perServerSeconds).length ? (
              <dl>
                {Object.entries(data.perServerSeconds).map(
                  ([server, seconds]) => (
                    <div key={server}>
                      <dt>{server}</dt>
                      <dd>{playtime(seconds)}</dd>
                    </div>
                  ),
                )}
              </dl>
            ) : (
              <p>Server playtime is not available yet.</p>
            )}
            <p className="moderation-muted">
              A heartbeat confirms a connection, not gameplay activity. Earlier
              daily activity is unavailable.
            </p>
          </section>
          {capabilities["moderation.ip"] && (
            <section className="moderation-card">
              <h3>Possible shared-IP accounts</h3>
              <button
                onClick={async () => {
                  setError("");
                  try {
                    const response = await fetch(`/api/players/${id}/alts`);
                    if (!response.ok) throw new Error();
                    setAlts(await response.json());
                  } catch {
                    setError(
                      "No verified address is available, or your current permission changed.",
                    );
                  }
                }}
              >
                Check associations
              </button>
              {error && <p role="alert">{error}</p>}
              {alts && (
                <>
                  <p>{alts.warning}</p>
                  <ul>
                    {alts.matches.map((player) => (
                      <li key={player.uuid}>
                        <a href={`/players/${player.uuid}`}>{player.name}</a> ·
                        last seen {date(player.lastSeen)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          <ModerationActionForm
            csrf={csrf}
            capabilities={capabilities}
            target={data}
            onSaved={(value) => onNavigate(`/moderation/${value.id}`)}
          />
        </>
      ) : (
        <>
          {data.items.length > 0 && (
            <PlayerResults
              items={data.items}
              hideNicknames={Boolean(loadError)}
              formatPlaytime={playtime}
              formatDate={date}
            />
          )}
          {!data.total && (
            <p>
              No players match these filters. Network reports may not be
              connected yet.
            </p>
          )}
          <p className="moderation-muted">
            Player reports refresh every 10 seconds. Reports older than 30
            seconds are marked stale.
          </p>
          <nav className="moderation-pages" aria-label="Player pages">
            <button
              disabled={!Number(params.get("offset"))}
              onClick={() =>
                change(
                  "offset",
                  String(Math.max(0, Number(params.get("offset") ?? 0) - 50)),
                )
              }
            >
              Previous
            </button>
            <span>{data.total} players</span>
            <button
              disabled={Number(params.get("offset") ?? 0) + 50 >= data.total}
              onClick={() =>
                change("offset", String(Number(params.get("offset") ?? 0) + 50))
              }
            >
              Next
            </button>
          </nav>
        </>
      )}
    </article>
  );
}
