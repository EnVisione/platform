import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { Office } from "./office.jsx";

const messages = {
  discord_cancelled:
    "Discord sign-in was cancelled. You can try again when you are ready.",
  verified_email_required:
    "Verify your email address in Discord before signing in.",
  todo_role_required:
    "You need the Todo role in the Drakora Discord server to open Huly.",
  discord_unavailable:
    "Discord is temporarily unavailable. Please try again shortly.",
  service_unavailable:
    "Staff services are temporarily unavailable. Please try again shortly.",
  discord_login_required:
    "Your Discord session has expired. Please sign in again.",
  login_required: "Please sign in to continue.",
  invalid_login_state:
    "This sign-in link has expired. Start a new sign-in below.",
  invalid_handoff:
    "This Huly link has expired. Open Huly again from the staff dashboard.",
  huly_account_mismatch:
    "Your Huly session belongs to another account. Open Huly again from the staff dashboard.",
};
function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      D<span>◈</span>
    </span>
  );
}
function DiscordIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M19.7 5.2a18 18 0 0 0-4.5-1.4l-.6 1.2a16.6 16.6 0 0 0-5.2 0l-.6-1.2a18 18 0 0 0-4.5 1.4C1.5 9.3.7 13.3 1.1 17.2a18 18 0 0 0 5.5 2.8l1.1-1.8-1.7-.8.4-.3a12.9 12.9 0 0 0 11.2 0l.4.3-1.7.8 1.1 1.8a18 18 0 0 0 5.5-2.8c.5-4.5-.8-8.4-3.2-12ZM8.6 14.9c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.8 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
    </svg>
  );
}
function App() {
  const [state, setState] = useState({ loading: true });
  const [busy, setBusy] = useState(false);
  const params = new URLSearchParams(location.search);
  const loginPage = location.pathname === "/login";
  useEffect(() => {
    let active = true;
    fetch("/api/me")
      .then(async (response) => {
        const data = await response.json();
        if (active)
          setState(
            response.ok
              ? { ...data, loading: false }
              : {
                  loading: false,
                  error: response.status === 401 ? null : data.error,
                },
          );
      })
      .catch(
        () =>
          active && setState({ loading: false, error: "service_unavailable" }),
      );
    return () => {
      active = false;
    };
  }, []);
  async function logout() {
    setBusy(true);
    try {
      const response = await fetch("/api/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": state.csrf,
        },
        body: "{}",
      });
      if (!response.ok) throw new Error();
      location.assign("/login");
    } catch {
      setState((previous) => ({ ...previous, error: "service_unavailable" }));
      setBusy(false);
    }
  }
  const error = params.get("error") || state.error;
  if (state.loading)
    return (
      <main className="loading">
        <Mark />
        <p>Opening Drakora Staff…</p>
      </main>
    );
  if (loginPage || !state.user)
    return (
      <main className="login-layout">
        <section className="intro">
          <a className="brand" href="/login">
            <Mark />
            <span>
              DRAKORA<small>STAFF</small>
            </span>
          </a>
          <div className="intro-copy">
            <span className="eyebrow">BEHIND THE NETWORK</span>
            <h1>
              A place for the
              <br />
              <em>people behind it.</em>
            </h1>
            <p>One place to organize the work that keeps Drakora moving.</p>
          </div>
          <footer>
            Drakora Network <span>Staff workspace</span>
          </footer>
        </section>
        <section className="login-panel">
          <div className="login-card">
            <span className="eyebrow">STAFF ACCESS</span>
            <h2>Welcome back.</h2>
            <p>Sign in with your Discord account to continue.</p>
            {error && (
              <p className="notice" role="alert">
                {messages[error] ||
                  "Sign-in could not be completed. Please try again."}
              </p>
            )}
            <a
              className="button discord"
              href={`/auth/discord?${new URLSearchParams({ next: params.get("next") || "/" })}`}
            >
              <DiscordIcon />
              Continue with Discord<span className="arrow">↗</span>
            </a>
            <div className="login-note">
              <span className="status-dot" />
              For authorized Drakora staff
            </div>
            <p className="help">
              Your Discord roles determine which staff tools you can open.
            </p>
            {state.user && !error && (
              <a className="text-link" href="/">
                Continue as {state.user.name} →
              </a>
            )}
          </div>
          <div className="panel-foot">Private access. Shared purpose.</div>
        </section>
      </main>
    );
  const user = state.user;
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/">
          <Mark />
          <span>
            DRAKORA<small>STAFF</small>
          </span>
        </a>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Main navigation">
          <a className="nav-item active" href="/" aria-current="page">
            <span>◈</span>Overview
          </a>
          {user.todo && (
            <a className="nav-item" href="/office">
              <span>◉</span>Office
            </a>
          )}
          {user.todo && (
            <a className="nav-item" href="/huly">
              <span>✓</span>Huly<span className="arrow">↗</span>
            </a>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          Connected with Discord
        </div>
      </aside>
      <div className="main-area">
        <header>
          <span>
            Staff workspace <b>/</b> Overview
          </span>
          <button className="signout" onClick={logout} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </header>
        <main className="dashboard">
          <div className="welcome">
            <div>
              <span className="eyebrow">DRAKORA STAFF</span>
              <h1>
                {user.dashboard
                  ? `Welcome, ${user.name}.`
                  : "Dashboard access is restricted."}
              </h1>
              <p>
                {user.dashboard
                  ? "Your workspace, ready when you are."
                  : "Ask a server administrator for the Dashboard role to access this workspace."}
              </p>
            </div>
            {user.avatar && <img className="avatar" src={user.avatar} alt="" />}
          </div>
          {error && (
            <p role="alert" className="notice">
              {messages[error] || messages.service_unavailable}
            </p>
          )}
          {user.dashboard && (
            <section className="identity-card" aria-labelledby="your-roles">
              <div>
                <span className="section-kicker">YOUR TEAM</span>
                <h2 id="your-roles">Staff roles</h2>
              </div>
              <div className="chips">
                {user.dashboardRanks.length ? (
                  user.dashboardRanks.map((rank) => (
                    <span
                      className={`chip ${rank === "Founder" ? "founder" : ""}`}
                      key={rank}
                    >
                      {rank}
                    </span>
                  ))
                ) : (
                  <span className="chip">Staff</span>
                )}
              </div>
              <span className="identity-note">Managed in Discord</span>
            </section>
          )}
          <section className="tools" aria-labelledby="staff-tools">
            <div className="section-title">
              <h2 id="staff-tools">Your tools</h2>
              <span>{user.todo ? "1 available" : "No tools assigned"}</span>
            </div>
            <article className={`tool-card ${user.todo ? "" : "locked"}`}>
              <div className="tool-icon">✓</div>
              <div className="tool-content">
                <span className="section-kicker">TASKS & COLLABORATION</span>
                <h3>Huly</h3>
                <p>Plan work, track progress, and keep the team in sync.</p>
                <div className="chips small">
                  {user.todo ? (
                    user.hulyRanks.map((rank) => (
                      <span className="chip" key={rank}>
                        {rank}
                      </span>
                    ))
                  ) : (
                    <span className="muted">
                      Requires the Todo role in Discord
                    </span>
                  )}
                </div>
              </div>
              {user.todo ? (
                <a className="button open-tool" href="/huly">
                  Open Huly<span>↗</span>
                </a>
              ) : (
                <span className="access-label">No access</span>
              )}
            </article>
          </section>
          <footer className="dashboard-footer">
            <span>Drakora Network</span>
            <span>Built around the team.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  location.pathname === "/office" ||
    location.pathname === "/_drakora/office" ? (
    <Office />
  ) : (
    <App />
  ),
);
