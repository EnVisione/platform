import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { PublicApplication } from "./apply.jsx";
import { StaffApplications } from "./applications.jsx";
import { Mail } from "./mail.jsx";
import { Roles } from "./roles.jsx";
import { WorkspaceTools, dashboardTools } from "./workspace-tools.jsx";
import logo from "./assets/drakora-logo.png";
import { accentForeground } from "../shared/accent.js";
import { dashboardDestination } from "../shared/dashboard-navigation.js";
import { Overview } from "./overview.jsx";
import {
  DashboardClock,
  LocalClock,
  TimeSettings,
  useClock,
  saveTimePreferences,
} from "./time.jsx";

const messages = {
  mail_role_required: "Your roles do not have permission to open Email.",
  invalid_minecraft_name:
    "Use your Java Edition username: 3–16 letters, numbers, or underscores.",
  minecraft_name_taken:
    "This Minecraft name is already linked or awaiting Founder or Manager approval.",
  minecraft_name_locked:
    "Your Minecraft name is already linked. Request a change in Settings.",
  minecraft_name_unchanged: "Enter a different Minecraft name.",
  discord_cancelled:
    "Discord sign-in was cancelled. You can try again when you are ready.",
  verified_email_required:
    "Verify your email address in Discord before signing in.",
  staff_permission_required:
    "Your staff permissions do not allow this action. Ask a Manager or Founder to check your access.",
  discord_unavailable:
    "Discord is temporarily unavailable. Please try again shortly.",
  service_unavailable:
    "Staff services are temporarily unavailable. Please try again shortly.",
  discord_login_required:
    "Your Discord session has expired. Please sign in again.",
  login_required: "Please sign in to continue.",
  dashboard_role_required:
    "You need the Dashboard role in the Drakora Discord server to sign in.",
  invalid_login_state:
    "This sign-in link has expired. Start a new sign-in below.",
  invalid_handoff:
    "This workspace link has expired. Open Tracker again from the staff dashboard.",
  huly_account_mismatch:
    "Your workspace session belongs to another account. Open Tracker again from the staff dashboard.",
};
function safeTarget(value) {
  if (
    [
      "/",
      "/huly",
      "/settings",
      "/accounts",
      "/applications",
      "/applications/editor",
      "/email",
      "/roles",
      "/office",
      "/tracker",
      "/calendar",
    ].includes(value)
  )
    return value;
  if (/^\/interaction\/[A-Za-z0-9_-]+$/.test(value || "")) return value;
  if (/^\/huly\/authorize\?challenge=[A-Za-z0-9_-]{43}$/.test(value || ""))
    return value;
  if (/^\/applications\/[a-f0-9-]{36}$/.test(value || "")) return value;
  return "/";
}
const defaultAccent = "#5865F2";
function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(hex))
    return `#${[...hex.slice(1)].map((digit) => digit.repeat(2)).join("")}`.toUpperCase();
  return null;
}
function accentKey(userId) {
  return `drakora.staff.accent:${userId}`;
}
function savedAccent(userId) {
  try {
    return (
      normalizeHex(localStorage.getItem(accentKey(userId))) || defaultAccent
    );
  } catch {
    return defaultAccent;
  }
}
function AccentSettings({ userId, accent, onChange }) {
  const [draft, setDraft] = useState(accent);
  const [message, setMessage] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [messageError, setMessageError] = useState(false);
  const preview = normalizeHex(draft);

  function save(event) {
    event.preventDefault();
    if (!preview) {
      setInvalid(true);
      setMessageError(true);
      setMessage("Enter a hex color such as #5865F2 or #F63.");
      return;
    }
    try {
      localStorage.setItem(accentKey(userId), preview);
      onChange(preview);
      setDraft(preview);
      setInvalid(false);
      setMessageError(false);
      setMessage("Accent color saved in this browser.");
    } catch {
      setMessageError(true);
      setMessage(
        "This browser could not save your color. Check your storage settings.",
      );
    }
  }

  function reset() {
    try {
      localStorage.removeItem(accentKey(userId));
      onChange(defaultAccent);
      setDraft(defaultAccent);
      setInvalid(false);
      setMessageError(false);
      setMessage("Default accent restored.");
    } catch {
      setMessageError(true);
      setMessage(
        "This browser could not reset your color. Check your storage settings.",
      );
    }
  }

  return (
    <section className="settings-card" aria-labelledby="appearance-title">
      <div className="settings-heading">
        <h2 id="appearance-title">Appearance</h2>
        <p>Choose an accent color for your dashboard.</p>
      </div>
      <form onSubmit={save} noValidate>
        <label htmlFor="accent-hex">Accent color</label>
        <div className="accent-field">
          <span
            className="accent-swatch"
            style={{ backgroundColor: preview || accent }}
            aria-hidden="true"
          />
          <input
            id="accent-hex"
            type="text"
            value={draft}
            maxLength={7}
            spellCheck="false"
            autoComplete="off"
            aria-invalid={invalid}
            aria-describedby="accent-help"
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
              setMessageError(false);
              setMessage("");
            }}
          />
        </div>
        <p id="accent-help" className="settings-help">
          Enter a 3 or 6 digit hex color. Saved for this account in this
          browser.
        </p>
        <div className="settings-actions">
          <button className="button save-accent" type="submit">
            Save color
          </button>
          <button className="reset-accent" type="button" onClick={reset}>
            Reset to default
          </button>
        </div>
        {message && (
          <p
            className={
              messageError ? "settings-message error" : "settings-message"
            }
            role="status"
          >
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
function MinecraftRegistration({ user, csrf, next, onLogout }) {
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/minecraft", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "service_unavailable");
      location.assign(safeTarget(next));
    } catch (failure) {
      setError(messages[failure.message] || messages.service_unavailable);
      setBusy(false);
    }
  }

  return (
    <main className="login-layout">
      <div className="login-shell">
        <Brand />
        <section className="login-card" aria-labelledby="minecraft-title">
          <span className="login-label">DRAKORA STAFF</span>
          <h1 id="minecraft-title">
            {user.returning
              ? `Welcome back, ${user.name}`
              : `Welcome, ${user.name}`}
          </h1>
          <p>Please enter your Minecraft name to continue.</p>
          <form className="minecraft-form" onSubmit={submit}>
            <label htmlFor="minecraft-name">
              Minecraft Java Edition username
            </label>
            <input
              id="minecraft-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={3}
              maxLength={16}
              pattern="[A-Za-z0-9_]{3,16}"
              autoComplete="off"
              spellCheck="false"
              required
            />
            <p className="registration-warning">
              Please be extra careful. You will need to verify this name in-game
              later. Once submitted, it can only be changed with Founder or
              Manager authorization. For now, you can continue while
              verification is pending.
            </p>
            <label className="confirm-name">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                required
              />
              I checked my Minecraft name and understand the change policy.
            </label>
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <button
              className="button submit-name"
              disabled={busy || !confirmed}
            >
              {busy ? "Saving…" : "Save name and continue"}
            </button>
          </form>
          <button
            className="registration-signout"
            type="button"
            onClick={onLogout}
          >
            Sign out
          </button>
        </section>
      </div>
    </main>
  );
}
function MinecraftSettings({ minecraft, csrf, canChange }) {
  const [link, setLink] = useState(minecraft);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  async function request(event) {
    event.preventDefault();
    const response = await fetch("/api/minecraft/change", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    const data = response
      ? await response.json()
      : { error: "service_unavailable" };
    if (!response?.ok) {
      setError(true);
      setMessage(messages[data.error] || messages.service_unavailable);
      return;
    }
    setLink(data.minecraft);
    setName("");
    setError(false);
    setMessage(
      "Change request sent for Founder or Manager approval. Your current link stays active.",
    );
  }
  return (
    <section
      className="settings-card minecraft-settings"
      aria-labelledby="minecraft-settings-title"
    >
      <div className="settings-heading">
        <h2 id="minecraft-settings-title">Minecraft account</h2>
        <p>
          Your linked Minecraft name is locked until a Founder or Manager
          approves a change.
        </p>
      </div>
      <div className="linked-name">
        <strong>{link.name}</strong>
        <span>Awaiting in-game verification</span>
      </div>
      {link.changeRequest && (
        <p className="settings-help">
          Requested name: <strong>{link.changeRequest.name}</strong> · Awaiting
          Founder or Manager approval
        </p>
      )}
      {canChange && (
        <form onSubmit={request}>
          <label htmlFor="new-minecraft-name">Request a different name</label>
          <div className="change-name-row">
            <input
              id="new-minecraft-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={3}
              maxLength={16}
              pattern="[A-Za-z0-9_]{3,16}"
              required
            />
            <button className="button save-accent">Request change</button>
          </div>
          {message && (
            <p
              className={error ? "settings-message error" : "settings-message"}
              role="status"
            >
              {message}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
function Accounts({ csrf, approveMinecraftChange, format, userId, timeZone }) {
  const now = useClock();
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    fetch("/api/accounts")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error();
        setAccounts(data.accounts);
      })
      .catch(() => setError("Could not load registered staff accounts."));
  }, []);
  async function decide(id, decision) {
    setBusy(id);
    setError("");
    try {
      const response = await fetch(`/api/accounts/${id}/minecraft-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      setAccounts((current) =>
        current.map((account) =>
          account.id === id
            ? { ...account, minecraft: data.minecraft }
            : account,
        ),
      );
    } catch {
      setError("Could not save the name change decision. Please try again.");
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="accounts-panel" aria-labelledby="accounts-title">
      <div className="welcome">
        <h2 id="accounts-title">Registered staff</h2>
        <p>
          Minecraft links and observed Discord activity across Drakora and
          Drakora Staff.
        </p>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!accounts ? (
        <p>Loading accounts…</p>
      ) : accounts.length === 0 ? (
        <p>No Minecraft names registered yet.</p>
      ) : (
        <div className="account-list">
          {accounts.map((account) => (
            <article className="registered-account" key={account.id}>
              {account.avatar ? (
                <img src={account.avatar} alt="" />
              ) : (
                <span className="account-avatar fallback">
                  {account.name.slice(0, 1)}
                </span>
              )}
              <div className="registered-details">
                <strong>{account.name}</strong>
                <div className="registered-ranks" aria-label="Staff ranks">
                  {account.ranks === null ? (
                    <span className="rank-unavailable">Ranks unavailable</span>
                  ) : account.ranks.length ? (
                    account.ranks.map((rank) => (
                      <span className="chip" key={rank}>
                        {rank}
                      </span>
                    ))
                  ) : (
                    <span className="rank-unavailable">
                      No assigned staff rank
                    </span>
                  )}
                </div>
                <span>Discord ID {account.id}</span>
                <span>
                  Last active on Discord:{" "}
                  {account.lastActiveAt
                    ? new Date(account.lastActiveAt).toLocaleString(undefined, {
                        hourCycle: format === "24" ? "h23" : "h12",
                      })
                    : "Not observed yet"}{" "}
                  · {account.discordStatus}
                </span>
              </div>
              <div className="registered-minecraft">
                <strong>{account.minecraft.name}</strong>
                <span>Awaiting in-game verification</span>
                {account.minecraft.changeRequest && (
                  <div className="change-request">
                    <span>
                      Requested: {account.minecraft.changeRequest.name}
                    </span>
                    {approveMinecraftChange && (
                      <div>
                        <button
                          disabled={busy === account.id}
                          onClick={() => decide(account.id, "approve")}
                        >
                          Approve
                        </button>
                        <button
                          disabled={busy === account.id}
                          onClick={() => decide(account.id, "reject")}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {(account.id === userId ? timeZone : account.timeZone) ? (
                  <LocalClock
                    now={now}
                    format={format}
                    timeZone={
                      account.id === userId ? timeZone : account.timeZone
                    }
                    className="account-local-time"
                  />
                ) : (
                  <span className="account-time-unavailable">
                    Local time unavailable
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="activity-note">
        Last active includes observed presence and messages in Drakora or
        Drakora Staff. Invisible members may appear offline, but their messages
        still update activity. Minecraft server activity will be added after
        server integration.
      </p>
    </section>
  );
}
function Brand({ href = "/" }) {
  return (
    <a className="brand" href={href}>
      <img src={logo} alt="" />
      <span>
        Drakora <small>STAFF</small>
      </span>
    </a>
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
  const [accent, setAccent] = useState(defaultAccent);
  const [timeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const preferences = state.user?.timePreferences ?? {
    format: "12",
    timeZone: null,
  };
  const updateTime = useCallback(
    (value) =>
      setState((current) => ({
        ...current,
        user: { ...current.user, timePreferences: value },
      })),
    [],
  );
  useEffect(() => {
    if (!state.user || preferences.timeZone === timeZone) return;
    let active = true;
    saveTimePreferences(state.csrf, { timeZone })
      .then((value) => {
        if (active) updateTime(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [state.user?.id, state.csrf, preferences.timeZone, timeZone, updateTime]);
  const [route, setRoute] = useState(
    () => `${location.pathname}${location.search}`,
  );
  const page = new URL(route, location.origin).pathname;
  const [mailOpened, setMailOpened] = useState(page === "/email");
  const navigateDashboard = useCallback((target) => {
    const path = dashboardDestination(target, location.origin);
    if (!path) return;
    if (path !== `${location.pathname}${location.search}${location.hash}`)
      history.pushState(null, "", path);
    setRoute(`${location.pathname}${location.search}`);
    if (location.pathname === "/email") setMailOpened(true);
  }, []);
  useEffect(() => {
    const receive = () => {
      setRoute(`${location.pathname}${location.search}`);
      if (location.pathname === "/email") setMailOpened(true);
    };
    window.addEventListener("popstate", receive);
    return () => window.removeEventListener("popstate", receive);
  }, []);
  const workspaceView =
    dashboardTools.find((tool) => page === `/${tool.view}`)?.view ?? null;
  const params = new URLSearchParams(location.search);
  const loginPage = page === "/login";
  const settingsPage = page === "/settings";
  const accountsPage = page === "/accounts";
  const emailPage = page === "/email";
  const rolesPage = page === "/roles";
  const applicationsPage =
    page === "/applications" || page.startsWith("/applications/");
  useEffect(() => {
    let active = true;
    fetch("/api/me")
      .then(async (response) => {
        const data = await response.json();
        if (active) {
          if (response.ok) setAccent(savedAccent(data.user.id));
          setState(
            response.ok
              ? { ...data, loading: false }
              : {
                  loading: false,
                  error: response.status === 401 ? null : data.error,
                },
          );
        }
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
        <img src={logo} alt="" />
        <p>Opening Drakora Staff…</p>
      </main>
    );
  if (state.user?.dashboard && !state.user.minecraft)
    return (
      <MinecraftRegistration
        user={state.user}
        csrf={state.csrf}
        next={params.get("next") || (loginPage ? "/" : location.pathname)}
        onLogout={logout}
      />
    );
  if (loginPage || !state.user?.dashboard)
    return (
      <main className="login-layout">
        <div className="login-shell">
          <Brand href="/login" />
          <section className="login-card" aria-labelledby="login-title">
            <span className="login-label">DRAKORA NETWORK</span>
            <h1 id="login-title">Staff sign-in</h1>
            <p>
              Staff tools for Prominence II, Restless Horizons, and community
              events.
            </p>
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
              Continue with Discord
            </a>
            <p className="login-note">
              Access follows your Discord staff roles.
            </p>
            {state.user?.dashboard && !error && (
              <a className="text-link" href="/">
                Already signed in? Continue as {state.user.name}
              </a>
            )}
          </section>
          <footer className="login-footer">Drakora Network · Staff</footer>
        </div>
      </main>
    );
  const user = state.user;
  return (
    <div
      className={`workspace${workspaceView ? " workspace-tools-page" : ""}`}
      style={{ "--accent": accent, "--accent-text": accentForeground(accent) }}
      onClick={(event) => {
        const link = event.target.closest?.("a[href]");
        if (
          !link ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          link.target ||
          link.hasAttribute("download")
        )
          return;
        const target = dashboardDestination(link.href, location.origin);
        if (!target) return;
        event.preventDefault();
        navigateDashboard(target);
      }}
    >
      <aside className="sidebar">
        <a className="sidebar-heading" href="/">
          <img src={logo} alt="" />
          Drakora Staff
        </a>
        <span className="nav-label">STAFF</span>
        <nav aria-label="Main navigation">
          <a
            className={`nav-item${settingsPage || accountsPage || applicationsPage || emailPage || rolesPage || workspaceView ? "" : " active"}`}
            href="/"
            aria-current={
              settingsPage ||
              accountsPage ||
              applicationsPage ||
              emailPage ||
              rolesPage ||
              workspaceView
                ? undefined
                : "page"
            }
          >
            <span aria-hidden="true">⌂</span>Overview
          </a>
          {user.todo &&
            dashboardTools.map((tool) => (
              <a
                key={tool.view}
                className={`nav-item${workspaceView === tool.view ? " active" : ""}`}
                href={`/${tool.view}`}
                aria-current={workspaceView === tool.view ? "page" : undefined}
              >
                <span aria-hidden="true">{tool.icon}</span>
                {tool.title}
              </a>
            ))}
          {user.applications && (
            <a
              className={`nav-item${applicationsPage ? " active" : ""}`}
              href="/applications"
              aria-current={applicationsPage ? "page" : undefined}
            >
              <span aria-hidden="true">▤</span>Staff Applications
            </a>
          )}
          {user.manager && (
            <a
              className={`nav-item${accountsPage ? " active" : ""}`}
              href="/accounts"
              aria-current={accountsPage ? "page" : undefined}
            >
              <span aria-hidden="true">♙</span>Accounts
            </a>
          )}
          {user.mail && (
            <a
              className={`nav-item${emailPage ? " active" : ""}`}
              href="/email"
              aria-current={emailPage ? "page" : undefined}
            >
              <span aria-hidden="true">✉</span>Email
            </a>
          )}
          {user.rolesPanel && (
            <a
              className={`nav-item${rolesPage ? " active" : ""}`}
              href="/roles"
              aria-current={rolesPage ? "page" : undefined}
            >
              <span aria-hidden="true">♜</span>Roles
            </a>
          )}
          {user.capabilities["settings.view"] && (
            <a
              className={`nav-item${settingsPage ? " active" : ""}`}
              href="/settings"
              aria-current={settingsPage ? "page" : undefined}
            >
              <span aria-hidden="true">⚙</span>Settings
            </a>
          )}
        </nav>
        <div className="account-bar">
          {user.avatar ? (
            <img className="account-avatar" src={user.avatar} alt="" />
          ) : (
            <span className="account-avatar fallback" aria-hidden="true">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <strong>{user.name}</strong>
            <span>Connected to Discord</span>
          </div>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <a className="mobile-brand" href="/">
            <img src={logo} alt="" />
            Drakora Staff
          </a>
          <h1>
            {workspaceView
              ? dashboardTools.find((tool) => tool.view === workspaceView)
                  ?.title
              : settingsPage
                ? "Settings"
                : accountsPage
                  ? "Accounts"
                  : applicationsPage
                    ? "Staff Applications"
                    : emailPage
                      ? "Email"
                      : rolesPage
                        ? "Roles"
                        : "Overview"}
          </h1>
          <nav className="mobile-nav" aria-label="Mobile navigation">
            {(settingsPage ||
              accountsPage ||
              applicationsPage ||
              emailPage ||
              rolesPage ||
              workspaceView) && <a href="/">Overview</a>}
            {user.todo &&
              dashboardTools
                .filter((tool) => tool.view !== workspaceView)
                .map((tool) => (
                  <a key={tool.view} href={`/${tool.view}`}>
                    {tool.title}
                  </a>
                ))}
            {user.manager && !accountsPage && <a href="/accounts">Accounts</a>}
            {user.applications && !applicationsPage && (
              <a href="/applications">Applications</a>
            )}
            {user.capabilities["settings.view"] && !settingsPage && (
              <a href="/settings">Settings</a>
            )}
            {user.rolesPanel && !rolesPage && <a href="/roles">Roles</a>}
            {user.mail && !emailPage && <a href="/email">Email</a>}
          </nav>
          <DashboardClock format={preferences.format} timeZone={timeZone} />
          <button className="signout" onClick={logout} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </header>
        <main
          className={
            workspaceView
              ? "dashboard dashboard-workspace"
              : applicationsPage
                ? "dashboard dashboard-applications"
                : emailPage
                  ? "dashboard dashboard-mail"
                  : rolesPage
                    ? "dashboard dashboard-roles"
                    : settingsPage || accountsPage
                      ? "dashboard"
                      : "dashboard dashboard-overview"
          }
        >
          {error && (
            <p role="alert" className="notice">
              {messages[error] || messages.service_unavailable}
            </p>
          )}
          {user.todo && (
            <WorkspaceTools
              key={user.id}
              view={workspaceView}
              origin={user.workspaceOrigin}
              accent={accent}
              timeFormat={preferences.format}
              csrf={state.csrf}
              onNavigate={navigateDashboard}
            />
          )}
          {user.mail && mailOpened && (
            <div hidden={!emailPage}>
              <Mail csrf={state.csrf} capabilities={user.capabilities} />
            </div>
          )}
          {workspaceView ? (
            !user.todo && (
              <p className="notice">
                Your roles do not have permission to open this workspace.
              </p>
            )
          ) : rolesPage ? (
            user.rolesPanel ? (
              <Roles csrf={state.csrf} userId={user.id} />
            ) : (
              <p className="notice">
                Roles requires Manager or Founder rank and role management
                access.
              </p>
            )
          ) : emailPage ? (
            !user.mail && (
              <p className="notice">
                Your roles do not have permission to open Email.
              </p>
            )
          ) : applicationsPage ? (
            user.applications ? (
              <StaffApplications
                key={route}
                csrf={state.csrf}
                capabilities={user.capabilities}
              />
            ) : (
              <p className="notice">
                Your roles do not have permission to view applications.
              </p>
            )
          ) : settingsPage ? (
            <>
              <AccentSettings
                userId={user.id}
                accent={accent}
                onChange={setAccent}
              />
              <TimeSettings
                csrf={state.csrf}
                preferences={preferences}
                timeZone={timeZone}
                onChange={updateTime}
              />
              <MinecraftSettings
                minecraft={user.minecraft}
                csrf={state.csrf}
                canChange={user.capabilities["settings.minecraft"]}
              />
            </>
          ) : accountsPage ? (
            <Accounts
              csrf={state.csrf}
              approveMinecraftChange={user.approveMinecraftChange}
              format={preferences.format}
              userId={user.id}
              timeZone={timeZone}
            />
          ) : (
            <Overview user={user} timeFormat={preferences.format} />
          )}
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  location.pathname === "/apply" || location.pathname.startsWith("/apply/") ? (
    <PublicApplication />
  ) : (
    <App />
  ),
);
