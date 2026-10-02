import React, { useEffect, useState } from "react";
import { ApplicationStatus } from "./application-status.jsx";

export function ApplicationHistory({ receipt }) {
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setData(null);
    fetch(`/apply/api/history?offset=${offset}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("history_unavailable");
        const result = await response.json();
        if (!controller.signal.aborted) setData(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Your application history could not be refreshed. Use Refresh updates to try again.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [receipt, offset]);
  return (
    <section
      className="apply-receipt-next"
      aria-labelledby="apply-history-title"
    >
      <h2 id="apply-history-title">Your applications</h2>
      <p className="apply-muted">
        Applications linked to your connected Discord account or submitted
        without Discord in this browser. Refresh updates to see the latest
        status.
      </p>
      {busy && <p role="status">Loading application history…</p>}
      {error && (
        <p className="apply-error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <ul className="apply-history-list" aria-busy={busy}>
            {data.items.map((item) => (
              <li className="apply-history-item" key={item.id}>
                <div>
                  <strong>{item.role}</strong>
                  {item.id === receipt.id && (
                    <span className="apply-history-current">
                      This application
                    </span>
                  )}
                  <p className="apply-muted">Minecraft name: {item.ign}</p>
                  <p className="apply-muted">
                    Submitted{" "}
                    <time dateTime={new Date(item.createdAt).toISOString()}>
                      {new Date(item.createdAt).toLocaleString()}
                    </time>
                  </p>
                </div>
                <ApplicationStatus status={item.status} />
              </li>
            ))}
          </ul>
          {!data.items.length && !busy && (
            <p>No applications are available for this account or browser.</p>
          )}
          {data.total > data.pageSize && (
            <nav
              className="apply-history-pagination"
              aria-label="Application history pages"
            >
              <button
                type="button"
                className="apply-secondary"
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - data.pageSize))}
              >
                Previous
              </button>
              <span className="apply-muted">
                {offset + 1}–{Math.min(offset + data.items.length, data.total)}{" "}
                of {data.total}
              </span>
              <button
                type="button"
                className="apply-secondary"
                disabled={busy || offset + data.pageSize >= data.total}
                onClick={() => setOffset(offset + data.pageSize)}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
