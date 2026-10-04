import React from "react";
import "./list-filters.css";

export function DateFilters({ from = "", to = "", change }) {
  return (
    <>
      <label>
        From date (UTC)
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => change("from", event.target.value)}
        />
      </label>
      <label>
        Through date (UTC)
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => change("to", event.target.value)}
        />
      </label>
    </>
  );
}
