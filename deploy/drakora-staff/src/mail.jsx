import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { newDraft, replyDraft, draftPayload } from "./mail-draft.js";
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
  mail_trash_unavailable:
    "Trash is unavailable. The email has not been deleted. Try again later.",
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
const emailSender = (values = []) =>
  values.map(({ address }) => address).join(", ");
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
function Composer({
  draft: value,
  identities,
  csrf,
  inlineHost,
  openRequest,
  onChange,
  onClose,
  onSent,
}) {
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [poppedOut, setPoppedOut] = useState(false);
  const [showCc, setShowCc] = useState(Boolean(value.cc));
  const [showBcc, setShowBcc] = useState(Boolean(value.bcc));
  const [editSubject, setEditSubject] = useState(false);
  const inline = Boolean(inlineHost && !poppedOut && !expanded);
  const dialog = useRef(null),
    toInput = useRef(null),
    textInput = useRef(null),
    form = useRef(null),
    filesInput = useRef(null);
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
    if (openRequest) setMinimized(false);
  }, [openRequest]);
  useEffect(() => {
    const previous = document.activeElement;
    if (!minimized)
      (value.composeKind === "new" || value.composeKind === "forward"
        ? toInput
        : textInput
      ).current?.focus();
    return () => previous?.focus();
  }, [minimized, inline, expanded]);
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
      if (!busy && !reading) setMinimized(true);
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter" &&
      !event.isComposing
    ) {
      event.preventDefault();
      if (!busy && !reading && !uncertain) form.current?.requestSubmit();
    }
    if (event.key !== "Tab" || !expanded) return;
    const elements = [
      ...dialog.current.querySelectorAll(
        "button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), summary, a[href]",
      ),
    ].filter((element) => element.getClientRects().length);
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
    onChange((previous) => ({ ...previous, [key]: next }));
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
      onChange((previous) => ({
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
        body: JSON.stringify(draftPayload(value)),
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
  const title =
    value.composeKind === "new"
      ? "New message"
      : value.composeKind === "forward"
        ? "Forward"
        : value.composeKind === "all"
          ? "Reply all"
          : "Reply";
  const keepDraft = () => {
    if (busy || reading) return;
    if (hasContent) setMinimized(true);
    else onClose();
  };
  if (minimized)
    return (
      <div className="mail-draft-tray">
        <button
          className="mail-draft-restore"
          onClick={() => setMinimized(false)}
        >
          <span className="mail-draft-badge">Draft</span>
          <span>{value.subject || "New message"}</span>
          <span aria-hidden="true">↗</span>
        </button>
        <button
          className="mail-discard"
          aria-label="Discard draft"
          onClick={discard}
        >
          🗑
        </button>
      </div>
    );
  const content = (
    <section
      className={`mail-composer${inline ? " mail-composer-inline" : ""}${expanded ? " mail-composer-expanded" : ""}`}
      role={expanded ? "dialog" : "region"}
      aria-modal={expanded ? "true" : undefined}
      aria-labelledby="mail-compose-title"
      ref={dialog}
      onKeyDown={trapFocus}
    >
      <header>
        <h2 id="mail-compose-title">
          <span aria-hidden="true">
            {value.composeKind === "new" ? "✎" : "↩"}
          </span>{" "}
          {["reply", "all"].includes(value.composeKind) ? (
            <select
              className="mail-reply-mode"
              aria-label="Reply mode"
              disabled={busy || reading}
              value={value.composeKind}
              onChange={(event) => {
                const kind = event.target.value;
                onChange((previous) => ({
                  ...previous,
                  composeKind: kind,
                  cc: kind === "all" ? previous.replyAllCc : "",
                }));
              }}
            >
              <option value="reply">Reply</option>
              <option value="all">Reply all</option>
            </select>
          ) : (
            title
          )}
        </h2>
        <span className="mail-draft-badge">Draft</span>
        <div className="mail-window-controls">
          <button
            type="button"
            aria-label="Minimize draft"
            disabled={busy || reading}
            onClick={() => setMinimized(true)}
          >
            −
          </button>
          {inline && (
            <button
              type="button"
              aria-label="Pop out reply"
              disabled={busy || reading}
              onClick={() => setPoppedOut(true)}
            >
              ↗
            </button>
          )}
          <button
            type="button"
            aria-label={expanded ? "Exit full screen" : "Expand composer"}
            disabled={busy || reading}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "↙" : "⛶"}
          </button>
          <button
            type="button"
            aria-label="Close and keep draft"
            disabled={busy || reading}
            onClick={keepDraft}
          >
            ✕
          </button>
        </div>
      </header>
      <form ref={form} onSubmit={send}>
        <fieldset disabled={busy || reading}>
          <label className="mail-compose-line">
            <span>From</span>
            <select
              aria-label="Send from"
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
          <div className="mail-compose-recipients">
            <label className="mail-compose-line">
              <span>
                To{" "}
                <span className="mail-required" aria-label="required">
                  *
                </span>
              </span>
              <input
                ref={toInput}
                type="email"
                multiple
                required
                value={value.to}
                maxLength={5200}
                onChange={(event) => update("to", event.target.value)}
                placeholder="Recipients"
              />
            </label>
            <div className="mail-recipient-toggles">
              {!showCc && !value.cc && (
                <button type="button" onClick={() => setShowCc(true)}>
                  Cc
                </button>
              )}
              {!showBcc && !value.bcc && (
                <button type="button" onClick={() => setShowBcc(true)}>
                  Bcc
                </button>
              )}
            </div>
          </div>
          {(showCc || value.cc) && (
            <label className="mail-compose-line">
              <span>Cc</span>
              <input
                type="email"
                multiple
                value={value.cc}
                maxLength={5200}
                onChange={(event) => update("cc", event.target.value)}
              />
            </label>
          )}
          {(showBcc || value.bcc) && (
            <label className="mail-compose-line">
              <span>Bcc</span>
              <input
                type="email"
                multiple
                value={value.bcc}
                maxLength={5200}
                onChange={(event) => update("bcc", event.target.value)}
              />
            </label>
          )}
          {value.composeKind === "new" || editSubject ? (
            <label className="mail-compose-line">
              <span>
                Subject{" "}
                <span className="mail-required" aria-label="required">
                  *
                </span>
              </span>
              <input
                required
                value={value.subject}
                maxLength={200}
                onChange={(event) => update("subject", event.target.value)}
                placeholder="Subject"
              />
            </label>
          ) : (
            <div className="mail-reply-subject">
              <span>{value.subject}</span>
              <button type="button" onClick={() => setEditSubject(true)}>
                Edit subject
              </button>
            </div>
          )}
          <label className="mail-compose-body">
            <span className="mail-message-label">
              Message{" "}
              <span className="mail-required" aria-label="required">
                *
              </span>
            </span>
            <textarea
              ref={textInput}
              required
              rows={inline ? 7 : 12}
              value={value.text}
              maxLength={Math.max(
                1,
                50000 - (value.quoteText ? value.quoteText.length + 2 : 0),
              )}
              onChange={(event) => update("text", event.target.value)}
              placeholder={
                value.composeKind === "new" || value.composeKind === "forward"
                  ? "Write your message…"
                  : "Write your reply…"
              }
            />
          </label>
          {value.quoteText && (
            <details className="mail-quoted-history">
              <summary>Show quoted message</summary>
              {value.composeKind === "forward" && (
                <p>
                  Original attachments are not included. Attach any files you
                  want to forward.
                </p>
              )}
              <pre>{value.quoteText}</pre>
              <button type="button" onClick={() => update("quoteText", "")}>
                Remove quoted message
              </button>
            </details>
          )}
          <input
            ref={filesInput}
            className="mail-hidden-file"
            type="file"
            multiple
            onChange={attach}
            aria-label="Attach files"
          />
          {value.attachments.length > 0 && (
            <ul className="mail-compose-attachments">
              {value.attachments.map((file, index) => (
                <li key={`${index}:${file.filename}`}>
                  <span>
                    ⌁ {file.filename} · {sizeLabel(file.size)}
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
          <div className="mail-send-tools">
            <button
              className="mail-primary mail-send-button"
              title="Send email. Ctrl or Command and Enter."
              disabled={busy || reading || uncertain}
            >
              {busy ? "Sending…" : reading ? "Reading files…" : "Send"}{" "}
              <span aria-hidden="true">➤</span>
            </button>
            <button
              type="button"
              className="mail-attach-button"
              aria-label="Attach files"
              title="Up to five files, 10 MB total"
              disabled={busy || reading}
              onClick={() => filesInput.current?.click()}
            >
              📎
            </button>
          </div>
          <span className="mail-draft-note">Kept in this open page</span>
          <button
            type="button"
            className="mail-discard"
            aria-label="Discard draft"
            title="Discard draft"
            disabled={busy || reading}
            onClick={discard}
          >
            🗑
          </button>
        </footer>
      </form>
    </section>
  );
  if (inline) return createPortal(content, inlineHost);
  return (
    <div className={expanded ? "mail-modal-backdrop" : "mail-compose-window"}>
      {content}
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
    [messageResult, setMessage] = useState(null),
    [messageLoading, setMessageLoading] = useState(false);
  const [error, setError] = useState(null),
    [detailError, setDetailError] = useState(null),
    [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(null),
    [flagBusy, setFlagBusy] = useState(false),
    [deleteBusy, setDeleteBusy] = useState(false);
  const [replyHost, setReplyHost] = useState(null);
  const [draftOpen, setDraftOpen] = useState(0);
  const [sentReply, setSentReply] = useState(null);
  const message =
    selected &&
    messageResult?.uid === selected.uid &&
    messageResult?.folder === selected.folder &&
    messageResult?.validity === selected.validity
      ? messageResult
      : null;
  const readerHeader = message ?? selected;
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
      `/messages/${selected.uid}/open?${new URLSearchParams({ folder: selected.folder, validity: selected.validity })}`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setMessage(result);
        setList((previous) =>
          previous?.folder === result.folder &&
          previous?.validity === result.validity
            ? {
                ...previous,
                items: previous.items.map((item) =>
                  item.uid === result.uid
                    ? { ...item, seen: result.seen }
                    : item,
                ),
              }
            : previous,
        );
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setDetailError(errorText(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setMessageLoading(false);
      });
    return () => controller.abort();
  }, [selected, csrf]);
  function changeFolder(path) {
    setFolder(path);
    setOffset(0);
    setSelected(null);
    setMessage(null);
  }
  async function changeFlag(flag, value, current = message) {
    if (!current || flagBusy || deleteBusy) return;
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
  async function deleteMessage(current) {
    if (deleteBusy || flagBusy) return;
    setDeleteBusy(true);
    setError(null);
    setNotice(null);
    try {
      await request("/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          folder: current.folder,
          uid: current.uid,
          validity: current.validity,
        }),
      });
      setNotice("Email moved to Trash.");
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setDeleteBusy(false);
    }
  }
  const sendIdentities =
    metadata?.identities.filter((entry) => entry.permissions?.send) || [];
  const replyIdentities =
    metadata?.identities.filter(
      (entry) =>
        entry.permissions?.reply &&
        message?.mailboxes?.includes(entry.address.toLowerCase()),
    ) || [];
  const canSend = Boolean(capabilities["mail.send"] && sendIdentities.length);
  const canReply = Boolean(capabilities["mail.send"] && replyIdentities.length);
  function compose(kind) {
    const identities =
      kind === "reply" || kind === "all" ? replyIdentities : sendIdentities;
    if (!identities.length) return;
    if (draft) {
      setDraftOpen((previous) => previous + 1);
      setNotice(
        "Your unsent draft is open. Send or discard it before starting another message.",
      );
      return;
    }
    const next =
      kind && message
        ? replyDraft(kind, message, identities, identity)
        : newDraft(
            identities.find((entry) => entry.address === identity)?.address ??
              identities[0].address,
          );
    setDraft(next);
    setNotice(null);
  }
  const currentFolder = folders.find((entry) => entry.path === folder);
  const canDelete =
    capabilities["mail.delete"] && currentFolder?.specialUse !== "\\Trash";
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
          {canSend && (
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
                    className={`mail-message-row${item.seen ? "" : " unread"}${canDelete ? " with-delete" : ""}`}
                  >
                    {capabilities["mail.flags"] ? (
                      <button
                        className={`mail-row-star${item.starred ? " starred" : ""}`}
                        aria-label={`${item.starred ? "Remove star from" : "Star"} ${item.subject}`}
                        aria-pressed={item.starred}
                        disabled={flagBusy || deleteBusy}
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
                      disabled={deleteBusy}
                      onClick={() => {
                        setMessage(null);
                        setDetailError(null);
                        setMessageLoading(true);
                        setSelected({
                          ...item,
                          folder,
                          validity: list.validity,
                        });
                      }}
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
                    {canDelete && (
                      <button
                        className="mail-row-delete"
                        aria-label={`Delete ${item.subject}`}
                        title="Move to Trash"
                        disabled={deleteBusy || flagBusy}
                        onClick={() =>
                          deleteMessage({
                            ...item,
                            folder,
                            validity: list.validity,
                          })
                        }
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            fill="currentColor"
                            d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h1v-8h-1Zm3 0v8h1v-8h-1Z"
                          />
                        </svg>
                      </button>
                    )}
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
                if (unread) setRefresh((value) => value + 1);
              }}
            >
              ← Back to {folderTitle.toLowerCase()}
            </button>
            <header className="mail-reader-header">
              <div className="mail-reader-title">
                <h3>{readerHeader.subject}</h3>
                <span
                  className={`mail-read-badge${readerHeader.seen ? " read" : ""}`}
                >
                  {readerHeader.seen ? "Read" : "Unread"}
                </span>
              </div>
              <div className="mail-sender-card">
                <span className="mail-sender-avatar" aria-hidden="true">
                  {Array.from(
                    readerHeader.from[0]?.name ||
                      readerHeader.from[0]?.address ||
                      "?",
                  )[0].toUpperCase()}
                </span>
                <div className="mail-sender-identity">
                  <strong>
                    {readerHeader.from[0]?.name ||
                      readerHeader.from[0]?.address ||
                      "Unknown sender"}
                  </strong>
                  <span>{emailSender(readerHeader.from)}</span>
                  <details className="mail-envelope-details">
                    <summary>
                      to {people(readerHeader.to)}{" "}
                      <span aria-hidden="true">⌄</span>
                    </summary>
                    <dl>
                      <div>
                        <dt>From</dt>
                        <dd>{people(readerHeader.from)}</dd>
                      </div>
                      <div>
                        <dt>To</dt>
                        <dd>{people(readerHeader.to)}</dd>
                      </div>
                      {readerHeader.cc.length > 0 && (
                        <div>
                          <dt>Cc</dt>
                          <dd>{people(readerHeader.cc)}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Received</dt>
                        <dd>{formatDate(readerHeader.date)}</dd>
                      </div>
                    </dl>
                  </details>
                </div>
                <time
                  className="mail-reader-date"
                  title={formatDate(readerHeader.date)}
                >
                  {formatDate(readerHeader.date)}
                </time>
                {capabilities["mail.flags"] && (
                  <div className="mail-reader-flags">
                    <button
                      className="mail-read-action"
                      disabled={flagBusy || messageLoading || !message}
                      onClick={() =>
                        changeFlag("seen", !readerHeader.seen, message)
                      }
                    >
                      {readerHeader.seen ? "Mark unread" : "Mark read"}
                    </button>
                    <button
                      className={`mail-row-star${readerHeader.starred ? " starred" : ""}`}
                      aria-label={
                        readerHeader.starred ? "Remove star" : "Star email"
                      }
                      aria-pressed={readerHeader.starred}
                      disabled={flagBusy || messageLoading || !message}
                      onClick={() =>
                        changeFlag("starred", !readerHeader.starred, message)
                      }
                    >
                      {readerHeader.starred ? "★" : "☆"}
                    </button>
                  </div>
                )}
              </div>
            </header>
            {detailError && (
              <div className="mail-reader-error">
                <p className="mail-error" role="alert">
                  {detailError}
                </p>
                <button
                  className="mail-secondary"
                  onClick={() => {
                    setDetailError(null);
                    setMessageLoading(true);
                    setSelected({ ...selected });
                  }}
                >
                  Try again
                </button>
              </div>
            )}
            {messageLoading ? (
              <div className="mail-body-loading" role="status">
                <span>Loading message…</span>
                <div className="mail-body-skeleton" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            ) : message ? (
              <>
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
                {sentReply?.uid === message.uid &&
                  sentReply?.folder === message.folder &&
                  sentReply?.validity === message.validity && (
                    <section
                      className="mail-sent-reply"
                      aria-label="Your sent reply"
                    >
                      <header>
                        <strong>✓ Reply accepted by Proton</strong>
                        <span>
                          {sentReply.from} · {formatDate(sentReply.date)}
                        </span>
                      </header>
                      <pre>{sentReply.text}</pre>
                    </section>
                  )}
                {(canSend || canReply) && (
                  <div className="mail-reply-actions">
                    <button
                      className="mail-reply-action"
                      disabled={!canReply}
                      onClick={() => compose("reply")}
                    >
                      <span aria-hidden="true">↩</span> Reply
                    </button>
                    <button
                      className="mail-reply-all-action"
                      disabled={!canReply}
                      onClick={() => compose("all")}
                    >
                      <span aria-hidden="true">↶</span> Reply all
                    </button>
                    <button
                      className="mail-forward-action"
                      disabled={!canSend}
                      onClick={() => compose("forward")}
                    >
                      <span aria-hidden="true">↪</span> Forward
                    </button>
                  </div>
                )}
                <div className="mail-reply-host" ref={setReplyHost} />
              </>
            ) : null}
          </article>
        )}
      </div>
      {capabilities["mail.send"] && draft && (
        <Composer
          key={draft.sendId}
          draft={draft}
          identities={
            draft.reply?.kind === "reply" ? replyIdentities : sendIdentities
          }
          csrf={csrf}
          onChange={setDraft}
          openRequest={draftOpen}
          inlineHost={
            selected?.uid === draft.reply?.uid &&
            selected?.folder === draft.reply?.folder &&
            selected?.validity === draft.reply?.validity
              ? replyHost
              : null
          }
          onClose={() => setDraft(null)}
          onSent={(result) => {
            if (
              draft.reply?.kind === "reply" &&
              selected?.uid === draft.reply.uid &&
              selected?.folder === draft.reply.folder &&
              selected?.validity === draft.reply.validity
            ) {
              setSentReply({
                ...draft.reply,
                from: draft.from,
                text: draft.text,
                date: new Date().toISOString(),
              });
            } else {
              setRefresh((value) => value + 1);
            }
            setDraft(null);
            setNotice(
              result.rejected.length
                ? `Email accepted for ${result.accepted.length} recipient(s). Rejected addresses: ${result.rejected.join(", ")}. Check the addresses before sending a separate message.`
                : "Email accepted by Proton. A copy will appear in Sent.",
            );
          }}
        />
      )}
    </section>
  );
}
