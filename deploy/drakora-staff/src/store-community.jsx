import React, { useEffect, useRef, useState } from "react";
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
      <span className="store-section-kicker">
        A fair game. A stronger network.
      </span>
      <h2 id="store-support-title">
        No pay-to-win. Just a better place to play.
      </h2>
      <p>
        We’re strongly against pay-to-win. Supporting Drakora should never buy
        an unfair gameplay advantage.
      </p>
      <p>
        All support received through this store is reinvested directly into our
        servers. It helps cover server costs, improve hardware and performance,
        and bring more modpacks to the network. Your support builds a better
        experience for everyone, with smoother gameplay and less lag.
      </p>
    </section>
  );
}

function GiftCardBalance({ enabled }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const activeRequest = useRef(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  async function check(event) {
    event.preventDefault();
    if (busy || !enabled) return;
    setResult("");
    setError("");
    if (!/^[A-Za-z0-9-]{6,64}$/.test(code.trim().replaceAll(" ", ""))) {
      setError("Enter a valid gift card number.");
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    activeRequest.current = controller;
    let message = "We couldn’t check this card. Please try again shortly.";
    try {
      const response = await fetch("/store/api/gift-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(12000),
        ]),
      });
      if (response.status === 429)
        message = "Too many checks. Please wait a minute and try again.";
      if (response.status === 404)
        message = "This gift card could not be found or is no longer valid.";
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!controller.signal.aborted)
        setResult(
          `Remaining balance: ${new Intl.NumberFormat(undefined, { style: "currency", currency: data.currency }).format(data.remaining)}`,
        );
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure.name === "TimeoutError"
            ? "The balance check timed out. Please try again."
            : message,
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="store-community-panel store-gift-card"
      id="store-gift-cards"
      aria-labelledby="store-gift-title"
    >
      <div>
        <h2 id="store-gift-title">Gift cards</h2>
        <p>
          Give someone a little Drakora. Gift card purchases are coming soon.
        </p>
        <p>
          Already have a card? Check its balance here and redeem it at Tebex
          checkout.
        </p>
      </div>
      <form onSubmit={check}>
        <label htmlFor="store-gift-number">Gift card number</label>
        <div className="store-gift-input">
          <input
            id="store-gift-number"
            name="gift-card"
            autoComplete="off"
            maxLength={64}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setResult("");
              setError("");
            }}
            disabled={busy || !enabled}
            placeholder="Card number"
            required
          />
          <button
            className="store-button"
            type="submit"
            disabled={busy || !enabled}
          >
            {busy ? "Checking…" : "Check"}
          </button>
        </div>
        {result && <p role="status">{result}</p>}
        {error && (
          <p className="store-checkout-error" role="alert">
            {error}
          </p>
        )}
        {!enabled && <p>Balance checks are temporarily unavailable.</p>}
      </form>
    </section>
  );
}

export function StoreCommunity() {
  const [period, setPeriod] = useState("month");
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
  const ready = !loading && !error && data?.connected;
  const top = data?.top[period] ?? [];
  return (
    <>
      <div className="store-community-grid">
        <section
          className="store-community-panel"
          aria-labelledby="store-payments-title"
          aria-busy={loading}
        >
          <h2 id="store-payments-title">Recent payments</h2>
          <p>Thank you for helping keep Drakora running.</p>
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
                  : "No payments yet. Your support will appear here when the store opens."}
            </p>
          )}
        </section>
        <section
          className="store-community-panel"
          aria-labelledby="store-top-title"
          aria-busy={loading}
        >
          <h2 id="store-top-title">Top 3 customers</h2>
          <div
            className="store-periods"
            role="group"
            aria-label="Top customer period"
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
          {ready && top.length ? (
            <ol className="store-top-customers" aria-label={periods[period]}>
              {top.map((player, index) => (
                <li key={player.uuid ?? player.username}>
                  <span className="store-customer-position">{index + 1}</span>
                  <SupporterFace player={player} />
                  <strong>{player.username}</strong>
                </li>
              ))}
            </ol>
          ) : (
            <p className="store-community-empty">
              {loading
                ? "Loading supporters…"
                : error
                  ? "Customer rankings are temporarily unavailable."
                  : `No customers to show for ${periods[period].toLowerCase()} yet.`}
            </p>
          )}
          <p className="store-community-caption">
            Ranked by completed purchases. Week and month follow UTC.
          </p>
        </section>
      </div>
      {error && (
        <p className="store-community-retry" role="alert">
          We couldn’t load the latest supporter updates.{" "}
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Try again
          </button>
        </p>
      )}
      <GiftCardBalance enabled={Boolean(data?.giftCards)} />
    </>
  );
}
