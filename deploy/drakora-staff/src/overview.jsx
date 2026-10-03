import React, { useEffect, useState } from "react";
import { dashboardTools } from "./workspace-tools.jsx";
import "./overview.css";

function AttentionCard({ icon, title, count, detail, href, tone = "accent" }) {
  const content = (
    <>
      <span className={`overview-icon ${tone}`} aria-hidden="true">
        {icon}
      </span>
      <span className="overview-card-content">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      {count !== undefined && (
        <strong className="overview-count">{count}</strong>
      )}
      {href && <span aria-hidden="true">↗</span>}
    </>
  );
  return href ? (
    <a className="overview-attention-card" href={href}>
      {content}
    </a>
  ) : (
    <div className="overview-attention-card">{content}</div>
  );
}

export function Overview({ user, timeFormat }) {
  const [data, setData] = useState();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      setBusy(true);
      try {
        const response = await fetch("/api/overview", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Overview unavailable");
        const result = await response.json();
        if (!controller.signal.aborted) {
          setData(result);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        loading = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void load();
    const timer = setInterval(load, 15000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [refresh, user.id]);
  const network = data?.network;
  const groups = [
    ...new Set(network?.servers.map((server) => server.group) ?? []),
  ];
  const queueCards = data?.queues ?? [];
  const pending =
    (data?.applications?.pending ?? 0) +
    (data?.email?.available ? data.email.unanswered : 0) +
    queueCards.reduce(
      (total, queue) => total + (queue.available ? queue.count : 0),
      0,
    );
  const attentionAvailable = Boolean(
    data?.applications ||
      data?.email?.available ||
      queueCards.some((queue) => queue.available),
  );
  const attentionIncomplete =
    error ||
    (user.applications && !data?.applications) ||
    (user.mail && !data?.email?.available) ||
    queueCards.some((queue) => !queue.available) ||
    (data && data.queueKinds.length < 2);
  const localHour = new Date().getHours();
  const greeting =
    localHour < 12
      ? "Good morning"
      : localHour < 18
        ? "Good afternoon"
        : "Good evening";
  const status = !network?.configured
    ? "Not connected"
    : error
      ? "Update unavailable"
      : network.reachable === network.servers.length
        ? "All servers reachable"
        : network.reachable
          ? "Some servers unreachable"
          : "Servers unreachable";
  return (
    <div className="overview">
      <section className="overview-welcome" aria-labelledby="overview-welcome">
        <div>
          <span className="overview-eyebrow">DRAKORA STAFF</span>
          <h2 id="overview-welcome">
            {greeting}, {user.name}.
          </h2>
          <p>
            Thanks for being here. Let’s keep Drakora a great place to play.
          </p>
          <div className="chips">
            {user.dashboardRanks.map((rank) => (
              <span className="chip" key={rank}>
                {rank}
              </span>
            ))}
          </div>
        </div>
        {user.avatar && (
          <img className="overview-avatar" src={user.avatar} alt="" />
        )}
      </section>
      <section className="overview-network" aria-labelledby="overview-network">
        <div className="overview-section-heading">
          <div>
            <h3 id="overview-network">Around the network</h3>
            <p>
              {network?.checkedAt
                ? `Checked at ${new Date(network.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hourCycle: timeFormat === "24" ? "h23" : "h12" })}`
                : "Checking server status…"}
            </p>
          </div>
          <button
            className="overview-refresh"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {busy ? "Updating…" : "Refresh"}
          </button>
        </div>
        {error && (
          <p className="overview-notice" role="status">
            The latest update failed. Previous readings may be out of date.
            Retry with Refresh.
          </p>
        )}
        <div className="overview-stats">
          <article>
            <span className="overview-stat-label">Players online</span>
            <strong>
              {network?.configured ? network.players.toLocaleString() : "—"}
            </strong>
            <small>
              {network?.complete && !error
                ? "Across monitored game servers."
                : "Reported by reachable game servers. Total may be incomplete."}
            </small>
          </article>
          <article>
            <span className="overview-stat-label">Network status</span>
            <strong
              className={`overview-network-state ${network?.configured && network.reachable === network.servers.length && !error ? "healthy" : "muted"}`}
            >
              {data ? status : "Checking…"}
            </strong>
            <small>
              {network?.configured
                ? `${network.reachable} of ${network.servers.length} endpoints reachable`
                : data
                  ? "Server monitoring is not connected yet."
                  : "Getting a fresh reading."}
            </small>
          </article>
          <article>
            <span className="overview-stat-label">Needs attention</span>
            <strong>
              {attentionAvailable ? pending.toLocaleString() : "—"}
            </strong>
            <small>
              {attentionIncomplete
                ? "Known pending items. Some queue counts are unavailable."
                : "Pending items in the connected queues you can access."}
            </small>
          </article>
        </div>
        {groups.map((group) => (
          <div className="overview-server-group" key={group}>
            <h4>{group}</h4>
            <div className="overview-servers">
              {network.servers
                .filter((server) => server.group === group)
                .map((server) => (
                  <article className="overview-server" key={server.id}>
                    <span
                      className={`overview-status-dot ${server.online && !error ? "online" : "unavailable"}`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{server.name}</strong>
                      <small>
                        {server.kind === "proxy" ? "Proxy" : "Game server"}
                      </small>
                    </div>
                    <div className="overview-server-reading">
                      <span>
                        {error
                          ? "Last reading"
                          : server.online
                            ? "Online"
                            : "Unreachable"}
                      </span>
                      <small>
                        {server.online
                          ? `${server.players === null ? "Player count unavailable" : `${server.players} ${server.players === 1 ? "player" : "players"}`} · ${server.responseMs} ms`
                          : "No status response"}
                      </small>
                    </div>
                  </article>
                ))}
            </div>
          </div>
        ))}
      </section>
      <section aria-labelledby="overview-attention">
        <div className="overview-section-heading">
          <div>
            <h3 id="overview-attention">A little help goes a long way</h3>
            <p>Jump into the work that needs a staff member.</p>
          </div>
        </div>
        <div className="overview-attention">
          {user.applications && (
            <AttentionCard
              icon="▤"
              title="Staff applications"
              tone="purple"
              count={data?.applications?.pending}
              detail={
                data?.applications
                  ? `${data.applications.received} received · ${data.applications.reviewing} in review`
                  : data
                    ? "Application counts are unavailable"
                    : "Checking pending applications…"
              }
              href="/applications"
            />
          )}
          {user.mail && (
            <AttentionCard
              icon="✉"
              title="Emails awaiting a reply"
              tone="blue"
              count={data?.email?.available ? data.email.unanswered : undefined}
              detail={
                data?.email?.available
                  ? `${data.email.unread} unread · Includes messages already read`
                  : data?.email?.loading
                    ? "Checking the inbox…"
                    : data
                      ? "Mailbox is unavailable. Open Email to retry."
                      : "Checking the inbox…"
              }
              href="/email"
            />
          )}
          {queueCards.map((queue, index) => (
            <AttentionCard
              key={`${queue.kind}-${index}`}
              icon={queue.kind === "tickets" ? "☏" : "⚑"}
              title={
                queue.name ?? (queue.kind === "tickets" ? "Tickets" : "Appeals")
              }
              tone="amber"
              count={queue.available ? queue.count : undefined}
              detail={
                queue.available
                  ? "Open items you can access in Discord"
                  : "Discord queue is temporarily unavailable"
              }
              href={queue.href}
            />
          ))}
          {data &&
            ["tickets", "appeals"]
              .filter((kind) => !data.queueKinds.includes(kind))
              .map((kind) => (
                <p className="overview-connection-note" key={kind}>
                  {kind === "tickets" ? "Ticket" : "Appeal"} queues are not
                  connected to Overview yet.
                </p>
              ))}
        </div>
      </section>
      {user.todo && (
        <section aria-labelledby="overview-tools">
          <div className="overview-section-heading">
            <h3 id="overview-tools">Make space for what’s next</h3>
          </div>
          <div className="overview-tools">
            {dashboardTools.map((tool) => (
              <AttentionCard
                key={tool.view}
                icon={tool.icon}
                title={tool.title}
                detail={tool.description}
                href={`/${tool.view}`}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
