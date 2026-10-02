import React, { useEffect, useMemo, useState } from "react";
import { timeFormatter, zoneLabel } from "../shared/time.js";

export function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function LocalClock({
  now,
  format,
  timeZone,
  className = "dashboard-clock",
}) {
  const formatter = useMemo(
    () => timeFormatter(format, timeZone),
    [format, timeZone],
  );
  const zone = formatter.resolvedOptions().timeZone;
  const label = zoneLabel(zone);
  return (
    <time
      className={className}
      dateTime={now.toISOString()}
      title={zone}
      aria-label={`Local time in ${label}: ${formatter.format(now)}`}
    >
      <span className="dashboard-clock-icon" aria-hidden="true">
        ◷
      </span>
      <span className="dashboard-clock-zone">{label}</span>
      <strong>{formatter.format(now)}</strong>
    </time>
  );
}

export function DashboardClock(props) {
  const now = useClock();
  return <LocalClock {...props} now={now} />;
}

export async function saveTimePreferences(csrf, values) {
  const response = await fetch("/api/preferences/time", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(values),
  });
  if (!response.ok)
    throw new Error("Could not save your time settings. Please try again.");
  return (await response.json()).preferences;
}

export function TimeSettings({ csrf, preferences, timeZone, onChange }) {
  const now = useClock();
  const [format, setFormat] = useState(preferences.format);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      onChange(await saveTimePreferences(csrf, { format, timeZone }));
      setFailed(false);
      setMessage("Time settings saved to your account.");
    } catch (error) {
      setFailed(true);
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card" aria-labelledby="time-settings-title">
      <div className="settings-heading">
        <h2 id="time-settings-title">Time & timezone</h2>
        <p>
          Your dashboard uses your device’s local timezone, including daylight
          saving time. Your local time is also shown to staff in Accounts.
        </p>
      </div>
      <form onSubmit={save}>
        <label htmlFor="time-format">Time format</label>
        <select
          id="time-format"
          value={format}
          onChange={(event) => setFormat(event.target.value)}
          disabled={busy}
        >
          <option value="12">12 hour (AM / PM)</option>
          <option value="24">24 hour</option>
        </select>
        <p className="time-settings-preview">Local timezone: {timeZone}</p>
        <LocalClock now={now} format={format} timeZone={timeZone} />
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save time settings"}
        </button>
        {message && (
          <p
            className={failed ? "notice" : "settings-message"}
            role={failed ? "alert" : "status"}
          >
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
