import React, { useEffect, useRef, useState } from "react";
import "./mail.css";

const errors = {
  mail_unavailable:
    "Email is temporarily unavailable. Check Proton Bridge and try again.",
  mail_busy: "The inbox is busy. Please try again in a moment.",
  mail_role_required: "Email access requires Admin, Manager or Founder rank.",
  login_required: "Your session expired. Sign in again to continue.",
  discord_login_required: "Reconnect Discord to continue.",
  mail_changed:
    "This mailbox changed. Refresh the inbox and open the message again.",
  mail_not_found: "This message is no longer available in this mailbox.",
  invalid_mail_request:
    "Check the addresses, subject and message. Use email addresses separated by commas.",
  invalid_request:
    "Your session could not be verified. Refresh the page before trying again.",
  mail_too_large:
    "This message is too large. Attach up to five files, totaling no more than 10 MB.",
  mail_send_changed:
    "This draft was already submitted. Check Sent before composing a new message.",
  mail_send_pending:
    "This draft is already being sent. Wait a moment, then check Sent.",
  mail_send_uncertain:
    "We could not confirm the send result. Check Sent before composing a new message to avoid duplicates.",
};
function errorText(error) {
  return (
    errors[error.message] ?? "Email could not be loaded. Please try again."
  );
}
async function request(path, options = {}) {
  const response = await fetch(`/api/mail${path}`, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "mail_unavailable");
  return result;
}
const formatDate = (value) =>
  value ? new Date(value).toLocaleString() : "Date unavailable";
function rowDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
const people = (values = []) =>
  values
    .map(({ name, address }) => (name ? `${name} <${address}>` : address))
    .join(", ");
const emailAddresses = (values = []) =>
  values
    .map(({ address }) => address)
    .filter(Boolean)
    .join(", ");
const sizeLabel = (value) =>
  value >= 1048576
    ? `${(value / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(value / 1024))} KB`;
const folderNames = {
  "\\Inbox": "Inbox",
  "\\Sent": "Sent",
  "\\Drafts": "Drafts",
  "\\Archive": "Archive",
  "\\Junk": "Spam",
  "\\Trash": "Trash",
  "\\All": "All mail",
  "\\Flagged": "Starred",
};
const blankDraft = (from) => ({
  sendId: crypto.randomUUID(),
  from,
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  text: "",
  attachments: [],
});

function Composer({ draft, identities, csrf, onClose, onSent }) {
  const [value, setValue] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const dialog = useRef(null),
    toInput = useRef(null);
  const hasContent = Boolean(
    value.to ||
    value.cc ||
    value.bcc ||
    value.subject ||
    value.text ||
    value.attachments.length,
  );
  const discard = () => {
    if (
      !busy &&
      !reading &&
      (!hasContent || confirm("Discard this unsent email?"))
    )
      onClose();
  };
  useEffect(() => {
    const previous = document.activeElement;
    toInput.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const beforeUnload = (event) => {
      if (hasContent || busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasContent, busy]);
  function trapFocus(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      discard();
    }
    if (event.key !== "Tab") return;
    const elements = [
      ...dialog.current.querySelectorAll(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
      ),
    ];
    const first = elements[0],
      last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  const update = (key, next) =>
    setValue((previous) => ({ ...previous, [key]: next }));
  async function attach(event) {
    const files = [...event.target.files];
    event.target.value = "";
    if (
      value.attachments.length + files.length > 5 ||
      files.reduce(
        (sum, file) => sum + file.size,
        value.attachments.reduce((sum, file) => sum + file.size, 0),
      ) > 10485760 ||
      files.some((file) => !file.size)
    ) {
      setError(
        "Choose up to five nonempty files, totaling no more than 10 MB.",
      );
      return;
    }
    setReading(true);
    try {
      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(new Error());
              reader.onload = () =>
                resolve({
                  filename: file.name,
                  size: file.size,
                  content: String(reader.result).split(",")[1],
                });
              reader.readAsDataURL(file);
            }),
        ),
      );
      setValue((previous) => ({
        ...previous,
        attachments: [...previous.attachments, ...attachments],
      }));
      setError(null);
    } catch {
      setError("The attachment could not be read. Select it again.");
    } finally {
      setReading(false);
    }
  }
  async function send(event) {
    event.preventDefault();
    if (busy || reading || uncertain) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request("/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(value),
      });
      onSent(result);
    } catch (failure) {
      setError(errorText(failure));
      if (
        failure instanceof TypeError ||
        [
          "mail_send_uncertain",
          "mail_send_changed",
          "mail_send_pending",
        ].includes(failure.message)
      ) {
        setUncertain(true);
        if (failure instanceof TypeError) setError(errors.mail_send_uncertain);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mail-modal-backdrop">
      <section
        className="mail-composer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-compose-title"
        ref={dialog}
        onKeyDown={trapFocus}
      >
        <header>
          <div>
            <span className="mail-eyebrow">DRAKORA EMAIL</span>
            <h2 id="mail-compose-title">
              {value.reply?.kind === "reply"
                ? "Reply"
                : value.reply?.kind === "forward"
                  ? "Forward email"
                  : "New email"}
            </h2>
          </div>
          <button
            type="button"
            className="mail-icon-button"
            aria-label="Close composer"
            disabled={busy || reading}
            onClick={discard}
          >
            ✕
          </button>
        </header>
        <form onSubmit={send}>
          <fieldset disabled={busy || reading}>
            <label>
              Send from
              <select
                value={value.from}
                onChange={(event) => update("from", event.target.value)}
              >
                {identities.map((identity) => (
                  <option key={identity.address} value={identity.address}>
                    {identity.name} · {identity.address}
                  </option>
                ))}
              </select>
            </label>
            <label>
              To{" "}
              <span className="mail-required" aria-label="required">
                *
              </span>
              <input
                ref={toInput}
                type="email"
                multiple
                required
                value={value.to}
                maxLength={5200}
                onChange={(event) => update("to", event.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <div className="mail-compose-columns">
              <label>
                Cc
                <input
                  type="email"
                  multiple
                  value={value.cc}
                  maxLength={5200}
                  onChange={(event) => update("cc", event.target.value)}
                />
              </label>
              <label>
                Bcc
                <input
                  type="email"
                  multiple
                  value={value.bcc}
                  maxLength={5200}
                  onChange={(event) => update("bcc", event.target.value)}
                />
              </label>
            </div>
            <label>
              Subject{" "}
              <span className="mail-required" aria-label="required">
                *
              </span>
              <input
                required
                value={value.subject}
                maxLength={200}
                onChange={(event) => update("subject", event.target.value)}
              />
            </label>
            <label>
              Message{" "}
              <span className="mail-required" aria-label="required">
                *
              </span>
              <textarea
                required
                rows={10}
                value={value.text}
                maxLength={50000}
                onChange={(event) => update("text", event.target.value)}
                placeholder="Write your message…"
              />
            </label>
            <label className="mail-file-input">
              Attach files
              <input type="file" multiple onChange={attach} />
              <small>
                Up to five files, 10 MB total. Files go with the email and are
                not saved in the staff database.
              </small>
            </label>
            {value.attachments.length > 0 && (
              <ul className="mail-compose-attachments">
                {value.attachments.map((file, index) => (
                  <li key={`${index}:${file.filename}`}>
                    <span>
                      {file.filename} · {sizeLabel(file.size)}
                    </span>
                    <button
                      type="button"
                      className="mail-icon-button"
                      aria-label={`Remove ${file.filename}`}
                      onClick={() =>
                        update(
                          "attachments",
                          value.attachments.filter(
                            (_, position) => position !== index,
                          ),
                        )
                      }
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          {error && (
            <p className="mail-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <p>
              Shared staff mailbox. This draft stays only in this open page.
            </p>
            <div>
              <button
                type="button"
                className="mail-secondary"
                disabled={busy || reading}
                onClick={discard}
              >
                Discard
              </button>
              <button
                className="mail-primary"
                disabled={busy || reading || uncertain}
              >
                {busy ? "Sending…" : reading ? "Reading files…" : "Send email"}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function Mail({ csrf, capabilities }) {
  const [metadata, setMetadata] = useState(null),
    [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState(""),
    [identity, setIdentity] = useState("");
  const [searchInput, setSearchInput] = useState(""),
    [search, setSearch] = useState(""),
    [unread, setUnread] = useState(false);
  const [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [list, setList] = useState(null),
    [listLoading, setListLoading] = useState(true);
  const [selected, setSelected] = useState(null),
    [message, setMessage] = useState(null),
    [messageLoading, setMessageLoading] = useState(false);
  const [error, setError] = useState(null),
    [detailError, setDetailError] = useState(null),
    [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(null),
    [flagBusy, setFlagBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      request("/", { signal: controller.signal }),
      request("/folders", { signal: controller.signal }),
    ])
      .then(([config, result]) => {
        if (controller.signal.aborted) return;
        setMetadata(config);
        setFolders(result.folders);
        setFolder(
          (previous) =>
            previous ||
            result.folders.find((entry) => entry.path.toUpperCase() === "INBOX")
              ?.path ||
            result.folders[0]?.path ||
            "",
        );
        setError(null);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(errorText(failure));
          setListLoading(false);
        }
      });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (!folder) return;
    const controller = new AbortController();
    setListLoading(true);
    setError(null);
    setSelected(null);
    setMessage(null);
    const query = new URLSearchParams({
      folder,
      identity,
      search,
      offset: String(offset),
      unread: String(unread),
    });
    request(`/messages?${query}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (offset && !result.items.length && result.total <= offset) {
          setOffset(0);
          return;
        }
        setList({ ...result, folder });
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(errorText(failure));
          setList(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });
    return () => controller.abort();
  }, [folder, identity, search, offset, unread, refresh]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setMessageLoading(true);
    setMessage(null);
    setDetailError(null);
    request(
      `/messages/${selected.uid}?${new URLSearchParams({ folder: selected.folder, validity: selected.validity })}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setMessage(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setDetailError(errorText(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setMessageLoading(false);
      });
    return () => controller.abort();
  }, [selected]);
  function changeFolder(path) {
    setFolder(path);
    setOffset(0);
    setSelected(null);
    setMessage(null);
  }
  async function changeFlag(flag, value, current = message) {
    if (!current || flagBusy) return;
    setFlagBusy(true);
    setError(null);
    try {
      await request("/flags", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          folder: current.folder,
          uid: current.uid,
          validity: current.validity,
          flag,
          value,
        }),
      });
      setMessage((previous) =>
        previous?.uid === current.uid &&
        previous?.folder === current.folder &&
        previous?.validity === current.validity
          ? { ...previous, [flag]: value }
          : previous,
      );
      setList((previous) =>
        previous?.folder === current.folder &&
        previous?.validity === current.validity
          ? {
              ...previous,
              items: previous.items.map((item) =>
                item.uid === current.uid ? { ...item, [flag]: value } : item,
              ),
            }
          : previous,
      );
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setFlagBusy(false);
    }
  }
  function compose(kind) {
    const original = kind && message;
    const own = new Set(
      metadata.identities.map((entry) => entry.address.toLowerCase()),
    );
    const from =
      original?.to.find((entry) => own.has(entry.address.toLowerCase()))
        ?.address ??
      identity ??
      "";
    const next = blankDraft(
      metadata.identities.find(
        (entry) => entry.address.toLowerCase() === from.toLowerCase(),
      )?.address ?? metadata.identities[0].address,
    );
    if (original) {
      const reply = original.replyTo.filter(
        (entry) => !own.has(entry.address.toLowerCase()),
      );
      const fallback = reply.length
        ? reply
        : original.to.filter((entry) => !own.has(entry.address.toLowerCase()));
      next.to = kind === "forward" ? "" : emailAddresses(fallback);
      if (kind === "all") {
        const used = new Set(
          fallback.map((entry) => entry.address.toLowerCase()),
        );
        next.cc = emailAddresses(
          [...original.to, ...original.cc].filter((entry) => {
            const key = entry.address.toLowerCase();
            if (own.has(key) || used.has(key)) return false;
            used.add(key);
            return true;
          }),
        );
      }
      const prefix = kind === "forward" ? "Fwd" : "Re";
      next.subject = new RegExp(`^${prefix}:`, "i").test(original.subject)
        ? original.subject
        : `${prefix}: ${original.subject}`;
      next.subject = next.subject.slice(0, 200);
      next.text = `\n\nOn ${formatDate(original.date)}, ${people(original.from)} wrote:\n${original.replyText
        .slice(0, 20000)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`;
      next.reply = {
        kind: kind === "forward" ? "forward" : "reply",
        folder: original.folder,
        uid: original.uid,
        validity: original.validity,
      };
    }
    setDraft(next);
    setNotice(null);
  }
  const currentFolder = folders.find((entry) => entry.path === folder);
  const folderTitle =
    folderNames[currentFolder?.specialUse] ?? currentFolder?.name ?? "Inbox";
  return (
    <section className="mail-page" aria-labelledby="mail-title">
      <div className="mail-heading">
        <div className="mail-brand">
          <span aria-hidden="true">✉</span>
          <div>
            <h2 id="mail-title">Email</h2>
            <span className="mail-eyebrow">SHARED STAFF MAILBOX</span>
          </div>
        </div>
        <form
          className="mail-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
            setOffset(0);
            setSelected(null);
            setMessage(null);
            setDetailError(null);
          }}
        >
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            maxLength={120}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            aria-label="Search email"
            placeholder="Search this mailbox"
          />
          <button className="mail-secondary">Search</button>
        </form>
      </div>
      {notice && (
        <p className="mail-success" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="mail-error" role="alert">
          {error}{" "}
          <button
            className="mail-text-button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Try again
          </button>
        </p>
      )}
      <div className="mail-layout">
        <aside className="mail-folders" aria-label="Email folders">
          {capabilities["mail.send"] && (
            <button
              className="mail-primary mail-compose-button"
              disabled={!metadata}
              onClick={() => compose()}
            >
              <span aria-hidden="true">＋</span> Compose
            </button>
          )}
          <label>
            Address
            <select
              value={identity}
              disabled={!metadata}
              onChange={(event) => {
                setIdentity(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">All Drakora addresses</option>
              {metadata?.identities.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  {entry.address}
                </option>
              ))}
            </select>
          </label>
          <nav>
            {folders.map((entry) => (
              <button
                key={entry.path}
                className={folder === entry.path ? "active" : ""}
                aria-current={folder === entry.path ? "page" : undefined}
                onClick={() => changeFolder(entry.path)}
              >
                <span aria-hidden="true">
                  {entry.specialUse === "\\Sent"
                    ? "↗"
                    : entry.specialUse === "\\Flagged"
                      ? "☆"
                      : entry.specialUse === "\\Drafts"
                        ? "▱"
                        : entry.specialUse === "\\Trash"
                          ? "🗑"
                          : "▤"}
                </span>
                {folderNames[entry.specialUse] ?? entry.name}
              </button>
            ))}
          </nav>
          <p>Shared Drakora mailbox. Remote images are blocked.</p>
        </aside>
        {!selected && (
          <div className="mail-messages">
            <header className="mail-toolbar">
              <div className="mail-toolbar-main">
                <h3>{folderTitle}</h3>
                <button
                  className="mail-icon-button"
                  aria-label="Refresh inbox"
                  disabled={listLoading}
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  ↻
                </button>
                <label className="mail-checkbox">
                  <input
                    type="checkbox"
                    checked={unread}
                    onChange={(event) => {
                      setUnread(event.target.checked);
                      setOffset(0);
                    }}
                  />
                  Unread only
                </label>
              </div>
              <div className="mail-pagination" aria-label="Email pages">
                <span aria-live="polite">
                  {listLoading
                    ? "Loading…"
                    : list?.total
                      ? `${offset + 1}–${Math.min(offset + 25, list.total)} of ${list.total}`
                      : "0 emails"}
                </span>
                <button
                  className="mail-icon-button"
                  aria-label="Previous page"
                  disabled={listLoading || !offset}
                  onClick={() => setOffset(Math.max(0, offset - 25))}
                >
                  ‹
                </button>
                <button
                  className="mail-icon-button"
                  aria-label="Next page"
                  disabled={listLoading || !list || offset + 25 >= list.total}
                  onClick={() => setOffset(offset + 25)}
                >
                  ›
                </button>
              </div>
            </header>
            <div className="mail-message-list" aria-busy={listLoading}>
              {listLoading ? (
                <p className="mail-empty">Loading emails…</p>
              ) : list?.items.length ? (
                list.items.map((item) => (
                  <div
                    key={item.uid}
                    className={`mail-message-row${item.seen ? "" : " unread"}`}
                  >
                    {capabilities["mail.flags"] ? (
                      <button
                        className={`mail-row-star${item.starred ? " starred" : ""}`}
                        aria-label={`${item.starred ? "Remove star from" : "Star"} ${item.subject}`}
                        aria-pressed={item.starred}
                        disabled={flagBusy}
                        onClick={() =>
                          changeFlag("starred", !item.starred, {
                            ...item,
                            folder,
                            validity: list.validity,
                          })
                        }
                      >
                        {item.starred ? "★" : "☆"}
                      </button>
                    ) : (
                      <span
                        className={`mail-row-star${item.starred ? " starred" : ""}`}
                        aria-label={item.starred ? "Starred" : undefined}
                        aria-hidden={!item.starred}
                      >
                        {item.starred ? "★" : "☆"}
                      </span>
                    )}
                    <button
                      className="mail-message-open"
                      onClick={() =>
                        setSelected({
                          uid: item.uid,
                          folder,
                          validity: list.validity,
                        })
                      }
                    >
                      <span
                        className="mail-sender"
                        title={people(
                          currentFolder?.specialUse === "\\Sent"
                            ? item.to
                            : item.from,
                        )}
                      >
                        {(currentFolder?.specialUse === "\\Sent"
                          ? item.to
                          : item.from
                        )
                          .map((entry) => entry.name || entry.address)
                          .join(", ") || "Unknown sender"}
                      </span>
                      <span className="mail-row-subject">
                        {!item.seen && (
                          <span
                            className="mail-unread-dot"
                            aria-label="Unread"
                          />
                        )}
                        <strong>{item.subject}</strong>
                      </span>
                      <time
                        dateTime={item.date ?? undefined}
                        title={formatDate(item.date)}
                      >
                        {rowDate(item.date)}
                      </time>
                    </button>
                  </div>
                ))
              ) : (
                <div className="mail-empty mail-empty-state" role="status">
                  <span aria-hidden="true">✉</span>
                  <h3>
                    {error
                      ? "Mailbox unavailable"
                      : search || unread
                        ? "No matching emails"
                        : `${folderTitle} is empty`}
                  </h3>
                  <p>
                    {error
                      ? "Try refreshing the mailbox."
                      : search || unread
                        ? "Try another search or turn off the unread filter."
                        : "Emails will appear here when they arrive in this view."}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
        {selected && (
          <article
            className="mail-reader"
            aria-label="Email reader"
            aria-busy={messageLoading}
          >
            <button
              className="mail-reader-back mail-secondary"
              onClick={() => {
                setSelected(null);
                setMessage(null);
                setDetailError(null);
              }}
            >
              ← Back to {folderTitle.toLowerCase()}
            </button>
            {detailError && (
              <p className="mail-error" role="alert">
                {detailError}
              </p>
            )}
            {messageLoading ? (
              <p className="mail-empty">Opening email…</p>
            ) : message ? (
              <>
                <header className="mail-reader-header">
                  <span className="mail-eyebrow">
                    {message.seen ? "READ EMAIL" : "UNREAD EMAIL"}
                  </span>
                  <h3>{message.subject}</h3>
                  <dl>
                    <div>
                      <dt>From</dt>
                      <dd>{people(message.from)}</dd>
                    </div>
                    <div>
                      <dt>To</dt>
                      <dd>{people(message.to)}</dd>
                    </div>
                    {message.cc.length > 0 && (
                      <div>
                        <dt>Cc</dt>
                        <dd>{people(message.cc)}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Received</dt>
                      <dd>{formatDate(message.date)}</dd>
                    </div>
                  </dl>
                  <div className="mail-reader-actions">
                    {capabilities["mail.send"] && (
                      <>
                        <button
                          className="mail-primary"
                          onClick={() => compose("reply")}
                        >
                          Reply
                        </button>
                        <button
                          className="mail-secondary"
                          onClick={() => compose("all")}
                        >
                          Reply all
                        </button>
                        <button
                          className="mail-secondary"
                          onClick={() => compose("forward")}
                        >
                          Forward
                        </button>
                      </>
                    )}
                    {capabilities["mail.flags"] && (
                      <>
                        <button
                          className="mail-secondary"
                          disabled={flagBusy}
                          onClick={() => changeFlag("seen", !message.seen)}
                        >
                          {message.seen ? "Mark unread" : "Mark read"}
                        </button>
                        <button
                          className="mail-icon-button"
                          aria-label={
                            message.starred ? "Remove star" : "Star email"
                          }
                          disabled={flagBusy}
                          onClick={() =>
                            changeFlag("starred", !message.starred)
                          }
                        >
                          {message.starred ? "★" : "☆"}
                        </button>
                      </>
                    )}
                  </div>
                </header>
                {message.html ? (
                  <div
                    className="mail-body mail-html"
                    dangerouslySetInnerHTML={{ __html: message.html }}
                  />
                ) : (
                  <pre className="mail-body mail-plain">
                    {message.text || "This email has no readable message body."}
                  </pre>
                )}
                {capabilities["mail.attachments"] &&
                  message.attachments.length > 0 && (
                    <section className="mail-attachments">
                      <h4>Attachments</h4>
                      <p>Download files only when you trust the sender.</p>
                      {message.attachments.map((file) => (
                        <a
                          key={file.part}
                          href={`/api/mail/messages/${message.uid}/attachments/${file.part}?${new URLSearchParams({ folder: message.folder, validity: message.validity })}`}
                          download
                        >
                          <span>↓ {file.filename}</span>
                          <small>{sizeLabel(file.size ?? 0)}</small>
                        </a>
                      ))}
                    </section>
                  )}
              </>
            ) : null}
          </article>
        )}
      </div>
      {capabilities["mail.send"] && draft && (
        <Composer
          key={draft.sendId}
          draft={draft}
          identities={metadata.identities}
          csrf={csrf}
          onClose={() => setDraft(null)}
          onSent={(result) => {
            setDraft(null);
            setNotice(
              result.rejected.length
                ? `Email accepted for ${result.accepted.length} recipient(s). Rejected addresses: ${result.rejected.join(", ")}. Check the addresses before sending a separate message.`
                : "Email accepted by Proton. A copy will appear in Sent.",
            );
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}
