import React, { useEffect, useState } from "react";
import { PublicIcon } from "./public-icons.jsx";

const periods = { week: "This week", month: "This month", all: "All time" };

function SupporterFace({ player }) {
  const [failed, setFailed] = useState(false);
  return player.uuid && !failed ? (
    <img
      src={`https://drakora.org/apply/api/head/${player.uuid}`}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="store-supporter-initial" aria-hidden="true">
      {player.username.slice(0, 1)}
    </span>
  );
}

export function StoreSupportMessage() {
  return (
    <section
      className="store-support-message"
      aria-labelledby="store-support-title"
    >
      <h2 id="store-support-title">
        No pay-to-win. Every contribution gives back.
      </h2>
      <p>
        We’re strongly against pay-to-win. All store support goes directly back
        into server costs, better hardware and more modpacks, for smoother
        gameplay and less lag. Supporting Drakora never buys an unfair
        advantage.
      </p>
    </section>
  );
}

export function useStoreCommunity() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let disposed = false;
    setLoading(true);
    setError(false);
    fetch("/store/api/community", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = await response.json();
        if (
          !Array.isArray(value.recent) ||
          !Object.keys(periods).every((key) => Array.isArray(value.top?.[key]))
        )
          throw new Error();
        if (!disposed) setData(value);
      })
      .catch(() => {
        if (!disposed) setError(true);
      })
      .finally(() => {
        clearTimeout(timer);
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [revision]);
  return {
    data,
    loading,
    error,
    retry: () => setRevision((value) => value + 1),
  };
}

export function RecentPayments({ community }) {
  const { data, loading, error, retry } = community;
  const ready = !loading && !error && data?.connected;
  return (
    <section
      className="store-community-panel store-recent-panel"
      aria-labelledby="store-payments-title"
      aria-busy={loading}
    >
      <h2 id="store-payments-title">Recent payments</h2>
      {ready && data.recent.length ? (
        <ul className="store-recent-payments">
          {data.recent.map((player, index) => (
            <li key={`${player.username}-${player.date}-${index}`}>
              <SupporterFace player={player} />
              <span>{player.username}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="store-community-empty">
          {loading
            ? "Loading payments…"
            : error
              ? "Payment updates are temporarily unavailable."
              : "No payments yet. Thank you for supporting Drakora."}
        </p>
      )}
      {error && (
        <button className="store-detail-button" type="button" onClick={retry}>
          Try again
        </button>
      )}
    </section>
  );
}

export function TopCustomers({ community, storeHref, compact = false }) {
  const { data, loading, error, retry } = community;
  const [period, setPeriod] = useState("month");
  const ready = !loading && !error && data?.connected;
  const top = data?.top[period] ?? [];
  return (
    <section
      className="store-community-panel store-top-panel"
      aria-labelledby="store-top-title"
      aria-busy={loading}
    >
      <header className="store-supporters-header">
        {storeHref ? (
          <h2 id="store-top-title">
            <a href={storeHref}>Top 3 supporters</a>
          </h2>
        ) : (
          <h1 id="store-top-title">Top 3 supporters</h1>
        )}
        <div
          className="store-periods"
          role="group"
          aria-label="Top supporter period"
        >
          {Object.entries(periods).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={period === key ? "active" : ""}
              aria-pressed={period === key}
              onClick={() => setPeriod(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      {ready && top.length ? (
        <ol className="store-top-customers" aria-label={periods[period]}>
          {top.map((player, index) => {
            const supporter = (
              <>
                <span className="store-customer-position">{index + 1}</span>
                <SupporterFace player={player} />
                <strong>{player.username}</strong>
              </>
            );
            return (
              <li key={player.uuid ?? player.username}>
                {storeHref ? (
                  <a
                    href={storeHref}
                    aria-label={`Visit the store. Supporter ${index + 1}: ${player.username}`}
                  >
                    {supporter}
                  </a>
                ) : (
                  supporter
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="store-community-empty">
          {loading
            ? "Loading supporters…"
            : error
              ? "Supporter rankings are temporarily unavailable."
              : compact
                ? `No supporters${period === "all" ? "" : ` ${periods[period].toLowerCase()}`} yet.`
                : `No supporters to show for ${periods[period].toLowerCase()} yet.`}
        </p>
      )}
      <p className="store-community-caption">
        {compact
          ? "Completed purchases · UTC"
          : "Ranked by completed purchases. Week and month follow UTC."}
      </p>
      {error && (
        <p className="store-community-retry" role="alert">
          We couldn’t load the latest supporter updates.{" "}
          <button type="button" onClick={retry}>
            Try again
          </button>
        </p>
      )}
      {storeHref && (
        <a className="public-button beige" href={storeHref}>
          Support Drakora <PublicIcon name="arrow" />
        </a>
      )}
    </section>
  );
}
