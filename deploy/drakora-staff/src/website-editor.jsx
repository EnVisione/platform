import React, { useEffect, useState } from "react";
import {
  ruleSections,
  applicationSections,
  helpSections,
  newServer,
  newAnnouncement,
  serverArtwork,
} from "../shared/website.js";
import "./website-editor.css";
const messages = {
  website_content_too_large:
    "The website content is too large. Shorten announcements, rules or server descriptions, then save again.",
  website_content_changed:
    "Another staff member saved changes. Your draft is still here. Reload the published content before editing again.",
  invalid_website_content:
    "Check the Home, Apply and Help text, announcement titles, text and dates. Check each server’s required fields and use HTTPS download and logo links. Rules cannot be empty.",
  duplicate_server_slug: "Each server needs a different URL slug.",
  website_role_required:
    "Only Admin, Manager and Founder staff can edit the public website.",
  invalid_request:
    "Your session could not verify this change. Refresh the dashboard and try again.",
  login_required: "Your dashboard session expired. Sign in again to continue.",
};
export function WebsiteEditor({ csrf }) {
  const [document, setDocument] = useState(null),
    [baseline, setBaseline] = useState(""),
    [tab, setTab] = useState("home"),
    [section, setSection] = useState("home"),
    [serverIndex, setServerIndex] = useState(0),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const dirty = document && JSON.stringify(document) !== baseline;
  async function reload() {
    if (
      dirty &&
      !window.confirm("Discard your unsaved website changes and reload?")
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/website");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setDocument(data);
      setBaseline(JSON.stringify(data));
      setServerIndex(0);
    } catch (failure) {
      setError(
        messages[failure.message] ||
          "Website content could not load. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetch("/api/website", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        return data;
      })
      .then((data) => {
        if (active) {
          setDocument(data);
          setBaseline(JSON.stringify(data));
        }
      })
      .catch((failure) => {
        if (active)
          setError(
            messages[failure.message] ||
              "Website content could not load. Try again.",
          );
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function updateServer(field, value) {
    setDocument((previous) => ({
      ...previous,
      servers: previous.servers.map((server, i) =>
        i === serverIndex ? { ...server, [field]: value } : server,
      ),
    }));
    setNotice("");
    setError("");
  }
  function updateHome(field, value) {
    setDocument((previous) => ({
      ...previous,
      home: { ...previous.home, [field]: value },
    }));
    setNotice("");
    setError("");
  }
  function updateApply(field, value) {
    setDocument((previous) => ({
      ...previous,
      apply: { ...previous.apply, [field]: value },
    }));
    setNotice("");
    setError("");
  }
  function updateHelp(field, value) {
    setDocument((previous) => ({
      ...previous,
      help: { ...previous.help, [field]: value },
    }));
    setNotice("");
    setError("");
  }
  function updateAnnouncement(id, field, value) {
    updateHome(
      "announcements",
      document.home.announcements.map((entry) =>
        entry.id === id ? { ...entry, [field]: value } : entry,
      ),
    );
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/website", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(document),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setDocument(data);
      setBaseline(JSON.stringify(data));
      setNotice("Website saved. Published pages update within 15 seconds.");
    } catch (failure) {
      setError(
        messages[failure.message] ||
          "The website could not save. Your draft is still here. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const server = document?.servers[serverIndex];
  return (
    <section className="website-editor" aria-labelledby="website-title">
      <header className="website-heading">
        <div>
          <h2 id="website-title">Website</h2>
          <p>Edit the public Home, Rules, Servers, Apply and Help pages.</p>
        </div>
        <a href="https://drakora.org" target="_blank" rel="noopener noreferrer">
          View website ↗
        </a>
      </header>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="website-notice" role="status">
          {notice}
        </p>
      )}
      {!document ? (
        <>
          <p>
            {error
              ? "Your content remains saved on the server."
              : "Loading website content…"}
          </p>
          <button className="button" onClick={reload} disabled={busy}>
            Retry
          </button>
        </>
      ) : (
        <form onSubmit={save}>
          <fieldset disabled={busy}>
            <div className="website-toolbar">
              <div
                className="website-tabs"
                role="group"
                aria-label="Website sections"
              >
                <button
                  type="button"
                  aria-pressed={tab === "home"}
                  onClick={() => setTab("home")}
                >
                  Home
                </button>
                <button
                  type="button"
                  aria-pressed={tab === "rules"}
                  onClick={() => setTab("rules")}
                >
                  Rules
                </button>
                <button
                  type="button"
                  aria-pressed={tab === "servers"}
                  onClick={() => setTab("servers")}
                >
                  Servers
                </button>
                <button
                  type="button"
                  aria-pressed={tab === "apply"}
                  onClick={() => setTab("apply")}
                >
                  Apply
                </button>
                <button
                  type="button"
                  aria-pressed={tab === "help"}
                  onClick={() => setTab("help")}
                >
                  Help
                </button>
              </div>
              <span>
                {dirty
                  ? "Unsaved changes"
                  : `Saved revision ${document.revision}`}
              </span>
            </div>
            {tab === "home" ? (
              <>
                {[
                  ["title", "Welcome title", 100],
                  ["introduction", "Welcome text", 500],
                  ["announcementsTitle", "Announcements heading", 100],
                  ["emptyMessage", "Text when there are no announcements", 500],
                ].map(([field, label, maxLength]) => (
                  <label className="website-field" key={field}>
                    {label}
                    <input
                      value={document.home[field]}
                      maxLength={maxLength}
                      required
                      onChange={(event) =>
                        updateHome(field, event.target.value)
                      }
                    />
                  </label>
                ))}
                <div className="website-announcements-heading">
                  <h3>Announcements</h3>
                  <button
                    type="button"
                    className="button"
                    disabled={document.home.announcements.length >= 30}
                    onClick={() =>
                      updateHome("announcements", [
                        newAnnouncement(),
                        ...document.home.announcements,
                      ])
                    }
                  >
                    Add announcement
                  </button>
                </div>
                <p className="website-help">
                  New announcements appear first. Hidden announcements stay in
                  this editor. Save the website to publish your changes.
                </p>
                {document.home.announcements.map((entry, index) => (
                  <section
                    className="website-announcement"
                    key={entry.id}
                    aria-label={`Announcement ${index + 1}`}
                  >
                    <label className="website-field">
                      Announcement title
                      <input
                        value={entry.title}
                        maxLength={100}
                        required
                        onChange={(event) =>
                          updateAnnouncement(
                            entry.id,
                            "title",
                            event.target.value,
                          )
                        }
                      />
                    </label>
                    <label className="website-field">
                      Announcement text
                      <textarea
                        value={entry.body}
                        rows={6}
                        maxLength={6000}
                        required
                        onChange={(event) =>
                          updateAnnouncement(
                            entry.id,
                            "body",
                            event.target.value,
                          )
                        }
                      />
                    </label>
                    <label className="website-field">
                      Date (optional)
                      <input
                        type="date"
                        value={entry.date}
                        onChange={(event) =>
                          updateAnnouncement(
                            entry.id,
                            "date",
                            event.target.value,
                          )
                        }
                      />
                    </label>
                    <label className="website-publish">
                      <input
                        type="checkbox"
                        checked={entry.published}
                        onChange={(event) =>
                          updateAnnouncement(
                            entry.id,
                            "published",
                            event.target.checked,
                          )
                        }
                      />
                      Show this announcement on Home
                    </label>
                    <button
                      type="button"
                      className="website-remove"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove ${entry.title || "this announcement"}? It will disappear after you save.`,
                          )
                        )
                          updateHome(
                            "announcements",
                            document.home.announcements.filter(
                              (item) => item.id !== entry.id,
                            ),
                          );
                      }}
                    >
                      Remove announcement
                    </button>
                  </section>
                ))}
                <p className="website-help">
                  Use a blank line between paragraphs. HTML is displayed as
                  text. Server details are managed on the Servers tab.
                </p>
              </>
            ) : tab === "apply" ? (
              <>
                <p className="website-help">
                  Visitors read this page before opening the application form.
                  Use one item per line for the two lists. Application questions
                  are managed in Staff Applications.
                </p>
                <label className="website-field">
                  Apply page title
                  <input
                    value={document.apply.title}
                    maxLength={100}
                    required
                    onChange={(event) =>
                      updateApply("title", event.target.value)
                    }
                  />
                </label>
                {[
                  { id: "introduction", name: "Introduction", limit: 1000 },
                  ...applicationSections,
                ].map(({ id, name, limit = 6000 }) => (
                  <label className="website-field" key={id}>
                    {name}
                    <textarea
                      value={document.apply[id]}
                      rows={5}
                      maxLength={limit}
                      required
                      onChange={(event) => updateApply(id, event.target.value)}
                    />
                  </label>
                ))}
              </>
            ) : tab === "help" ? (
              <>
                <p className="website-help">
                  Help visitors find support in the main Discord. Use one item
                  per line for What to include. Tickets stay in Discord.
                </p>
                <label className="website-field">
                  Help page title
                  <input
                    value={document.help.title}
                    maxLength={100}
                    required
                    onChange={(event) =>
                      updateHelp("title", event.target.value)
                    }
                  />
                </label>
                {[
                  {
                    id: "introduction",
                    name: "Help introduction",
                    limit: 1000,
                  },
                  ...helpSections,
                ].map(({ id, name, limit = 6000 }) => (
                  <label className="website-field" key={id}>
                    {name}
                    <textarea
                      value={document.help[id]}
                      rows={5}
                      maxLength={limit}
                      required
                      onChange={(event) => updateHelp(id, event.target.value)}
                    />
                  </label>
                ))}
              </>
            ) : tab === "rules" ? (
              <>
                <nav
                  className="website-rule-tabs"
                  aria-label="Edit rules sections"
                >
                  {ruleSections.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      aria-pressed={section === item.id}
                      onClick={() => setSection(item.id)}
                    >
                      {item.name}
                    </button>
                  ))}
                </nav>
                <label className="website-field">
                  {ruleSections.find((item) => item.id === section).name} rules
                  <textarea
                    value={document.rules[section]}
                    maxLength={20000}
                    rows={18}
                    required
                    onChange={(event) => {
                      setDocument((previous) => ({
                        ...previous,
                        rules: {
                          ...previous.rules,
                          [section]: event.target.value,
                        },
                      }));
                      setNotice("");
                    }}
                  />
                </label>
                <p className="website-help">
                  Use a blank line between paragraphs. Text appears exactly as
                  written. HTML is displayed as text.
                </p>
              </>
            ) : (
              <div className="website-servers">
                <aside>
                  <nav aria-label="Edit servers">
                    {document.servers.map((item, i) => (
                      <button
                        key={i}
                        type="button"
                        aria-pressed={i === serverIndex}
                        onClick={() => setServerIndex(i)}
                      >
                        {item.name || "New server"}
                        <small>{item.published ? "Published" : "Hidden"}</small>
                      </button>
                    ))}
                  </nav>
                  <button
                    type="button"
                    className="button"
                    disabled={document.servers.length >= 20 || busy}
                    onClick={() => {
                      setDocument((previous) => ({
                        ...previous,
                        servers: [...previous.servers, newServer()],
                      }));
                      setServerIndex(document.servers.length);
                    }}
                  >
                    Add server
                  </button>
                </aside>
                <div>
                  {server ? (
                    <>
                      <div className="website-field-grid">
                        {[
                          ["name", "Server name", 80],
                          ["slug", "URL slug", 60],
                          ["pack", "Modpack", 100],
                          ["address", "Server address", 253],
                          ["packVersion", "Pack version", 60],
                          ["minecraftVersion", "Minecraft version", 40],
                          ["worlds", "Worlds", 200],
                          ["downloadUrl", "Download modpack URL", 500],
                          ["logoUrl", "Custom pack logo URL", 500],
                        ].map(([field, label, maxLength]) => (
                          <label className="website-field" key={field}>
                            {label}
                            <input
                              value={server[field]}
                              maxLength={maxLength}
                              required={["name", "slug", "address"].includes(
                                field,
                              )}
                              type={
                                ["downloadUrl", "logoUrl"].includes(field)
                                  ? "url"
                                  : "text"
                              }
                              onChange={(event) =>
                                updateServer(field, event.target.value)
                              }
                              placeholder={
                                ["downloadUrl", "logoUrl"].includes(field)
                                  ? "https://… (optional)"
                                  : field === "slug"
                                    ? "prom2"
                                    : undefined
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <p className="website-help">
                        The URL slug uses lowercase letters, numbers and
                        hyphens. Changing it changes the page address. Versions
                        and download links can stay empty until confirmed. A
                        custom HTTPS logo replaces the selected image. Leave it
                        empty to use the selected pack logo or artwork.
                      </p>
                      <label className="website-field">
                        Short description
                        <input
                          value={server.summary}
                          maxLength={240}
                          required
                          onChange={(event) =>
                            updateServer("summary", event.target.value)
                          }
                        />
                      </label>
                      <label className="website-field">
                        About the server
                        <textarea
                          value={server.description}
                          maxLength={12000}
                          rows={6}
                          required
                          onChange={(event) =>
                            updateServer("description", event.target.value)
                          }
                        />
                      </label>
                      <label className="website-field">
                        How to join
                        <textarea
                          value={server.joining}
                          maxLength={6000}
                          rows={4}
                          required
                          onChange={(event) =>
                            updateServer("joining", event.target.value)
                          }
                        />
                      </label>
                      <div className="website-field-grid">
                        <label className="website-field">
                          Rules section
                          <select
                            value={server.rules}
                            onChange={(event) =>
                              updateServer("rules", event.target.value)
                            }
                          >
                            {ruleSections.map((item) => (
                              <option value={item.id} key={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="website-field">
                          Pack logo or fallback artwork
                          <select
                            value={server.artwork}
                            onChange={(event) =>
                              updateServer("artwork", event.target.value)
                            }
                          >
                            {serverArtwork.map((art) => (
                              <option key={art.id} value={art.id}>
                                {art.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label className="website-publish">
                        <input
                          type="checkbox"
                          checked={server.published}
                          onChange={(event) =>
                            updateServer("published", event.target.checked)
                          }
                        />
                        Show this server on the public website
                      </label>
                      <p className="website-help">
                        Player counts stay at 0 until Minecraft integration is
                        ready.
                      </p>
                      <button
                        className="website-remove"
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${server.name || "this server"}? It will disappear from the website after you save.`,
                            )
                          ) {
                            setDocument((previous) => ({
                              ...previous,
                              servers: previous.servers.filter(
                                (_, i) => i !== serverIndex,
                              ),
                            }));
                            setServerIndex(0);
                          }
                        }}
                      >
                        Remove server
                      </button>
                    </>
                  ) : (
                    <p>No servers yet. Add one to begin.</p>
                  )}
                </div>
              </div>
            )}
            <footer className="website-save">
              <button className="button" disabled={!dirty || busy}>
                {busy ? "Saving…" : "Save website"}
              </button>
              <button type="button" onClick={reload} disabled={busy}>
                Reload published content
              </button>
            </footer>
          </fieldset>
        </form>
      )}
    </section>
  );
}
