import { LegalNotice } from "./legal-notice.jsx";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ticketTypes,
  ticketIntake,
  ticketStatuses,
  ticketStatusLabel,
  ticketUploadLimit,
  ticketMessageUploadLimit,
} from "../shared/tickets.js";
import logo from "./assets/drakora-logo.png";
import "./tickets.css";
import { ModerationHistoryCard } from "./moderation.jsx";
import { DateFilters } from "./list-filters.jsx";
import { MacroPicker, TicketMacroLibrary } from "./ticket-macros.jsx";

const errors = {
  invalid_ticket_category:
    "Choose a valid ticket category or reset the filters.",
  invalid_list_filters: "Check the filters and choose a valid date range.",
  ticket_identity_required:
    "Open your ticket in the browser you used to create it, or connect its Discord account.",
  ticket_not_found:
    "This ticket is unavailable in this browser. Use its private email link or connect the Discord account that opened it.",
  ticket_access_denied: "Your staff permissions do not allow this action.",
  ticket_already_claimed:
    "Another staff member has already claimed this ticket.",
  ticket_assignment_changed:
    "This ticket's assignment changed. Reload it before taking over.",
  ticket_takeover_approval_required:
    "Manager approval is required. Add a reason to request this ticket.",
  ticket_takeover_manager_required:
    "Only Managers and Founders with category access can review this request.",
  ticket_takeover_request_expired:
    "This request is no longer current. Check the ticket's assignment.",
  ticket_takeover_request_pending:
    "A takeover request is already waiting for Manager review.",
  ticket_takeover_requester_unavailable:
    "The requester is no longer an eligible staff member.",
  ticket_takeover_self_approval:
    "Another Manager or Founder must review your request.",
  invalid_takeover_reason: "Provide a nonblank reason, up to 1,000 characters.",
  ticket_limit:
    "You have three open tickets. Continue in an existing ticket below.",
  ticket_ip_limit:
    "There is already an open website ticket on this internet connection. Continue in that ticket or wait for it to close.",
  invalid_ticket_email: "Enter a valid email address for ticket updates.",
  invalid_ticket_link:
    "This private link expired or was already used. Open the newest ticket update email, or use the browser where your ticket is already open.",
  invalid_ticket:
    "Check your Minecraft username and provide at least 30 characters describing the issue.",
  invalid_report_target:
    "Enter the username or Discord user ID of the person you are reporting.",
  invalid_message:
    "Write a message or attach a file. Messages can contain up to 2,000 characters.",
  ticket_closed:
    "This ticket is closed. Your unsent message has been kept here.",
  unsupported_attachment:
    "Use PNG, JPEG, WebP, GIF, PDF, ZIP, TXT or LOG files.",
  attachment_too_large: "Each attachment must be no larger than 8 MB.",
  attachments_too_large:
    "Attachments in one message must total no more than 20 MB.",
  resolution_required: "Enter a nonblank resolution, up to 4,000 characters.",
  commands_required: "Record the commands used, or enter None.",
  ticket_already_rated: "You have already rated this ticket.",
  ticket_close_first: "Close the ticket before deleting its Discord channel.",
  ticket_reopen_pending:
    "The transcript is still being saved. Try reopening again shortly.",
  ticket_feedback_expired:
    "This ticket changed. Reload it to see current feedback and reopen options.",
  partnership_limit:
    "There is already an open partnership request for this contact. Continue in that request.",
  invalid_request:
    "Your session changed. Reload this page before trying again.",
};
async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(
        errors[data.error] ||
          "Support is temporarily unavailable. Your ticket and unsent message have been kept. Please try again.",
      ),
      { code: data.error },
    );
  return data;
}
const stamp = (time) =>
  new Date(time).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
function Avatar({ actor }) {
  return actor?.avatar ? (
    <img
      className="ticket-avatar"
      src={actor.avatar}
      alt=""
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className="ticket-avatar ticket-avatar-empty" aria-hidden="true">
      {actor?.name?.slice(0, 1) || "?"}
    </span>
  );
}
function FeedbackRating({ rating, staff, at, previous = false }) {
  return (
    <div className="ticket-feedback-rating">
      {previous && <p className="ticket-muted">Previous closure</p>}
      <p className="ticket-feedback-score">
        <span className="ticket-feedback-stars" aria-hidden="true">
          {"★".repeat(rating)}
          <span>{"★".repeat(5 - rating)}</span>
        </span>
        <strong>{rating} / 5</strong>
      </p>
      {staff && <p>Feedback for {staff.name}</p>}
      {at && <p className="ticket-muted">Rated {stamp(at)}</p>}
    </div>
  );
}
function FileView({ file }) {
  if (file.expired)
    return (
      <p className="ticket-file-expired">{file.name} · expired after 30 days</p>
    );
  return /^image\/(png|jpeg|webp|gif)$/.test(file.type) ? (
    <a
      className="ticket-image"
      href={file.url}
      target="_blank"
      rel="noreferrer"
    >
      <img src={file.url} alt={file.name} loading="lazy" />
      <span>{file.name}</span>
    </a>
  ) : (
    <a className="ticket-file" href={file.url} download>
      {file.name} · {Math.ceil(file.size / 1024)} KB ↓
    </a>
  );
}
function useLive(url, refresh) {
  const [connected, setConnected] = useState(false);
  const callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    source.onopen = () => {
      setConnected(true);
      callback.current();
    };
    source.onerror = () => setConnected(false);
    source.onmessage = () => callback.current();
    const visible = () => {
      if (!document.hidden) callback.current();
    };
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(visible, 5000);
    return () => {
      source.close();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url]);
  return connected;
}
function Composer({
  base,
  csrf,
  internal = false,
  notes = false,
  onSent,
  resolution = false,
  macroCategory,
  uploadLimit = ticketMessageUploadLimit,
}) {
  const [content, setContent] = useState(""),
    [commands, setCommands] = useState("None"),
    [files, setFiles] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(null),
    input = useRef(null),
    message = useRef(null),
    restoreFocus = useRef(false);
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      if (document.activeElement === document.body) message.current?.focus();
    }
  }, [busy]);
  function addFiles(values) {
    const selected = [...values];
    if (files.length + selected.length > 5) {
      setError("Attach up to five files per message.");
      return;
    }
    if (selected.some((file) => file.size > ticketUploadLimit)) {
      setError(errors.attachment_too_large);
      return;
    }
    if (
      [...files, ...selected].reduce((size, file) => size + file.size, 0) >
      uploadLimit
    ) {
      setError(
        `Attachments can total up to ${uploadLimit / 1024 / 1024} MB per message.`,
      );
      return;
    }
    setFiles((previous) => [...previous, ...selected]);
    pending.current = null;
  }
  async function send(event) {
    event.preventDefault();
    if (busy) return;
    restoreFocus.current =
      !resolution && document.activeElement === message.current;
    setBusy(true);
    setError("");
    try {
      pending.current ??= { requestId: crypto.randomUUID(), ids: [] };
      for (
        let index = pending.current.ids.length;
        index < files.length;
        index++
      ) {
        const file = files[index];
        const uploaded = await request(
          `${base}/attachments${internal ? `?internal=1${notes ? "&notes=1" : ""}` : ""}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-CSRF-Token": csrf,
              "X-File-Name": encodeURIComponent(file.name),
              "X-File-Type":
                file.type ||
                (/\.zip$/i.test(file.name) ? "application/zip" : "text/plain"),
            },
            body: file,
          },
        );
        pending.current.ids.push(uploaded.id);
      }
      await request(
        `${base}/${resolution ? "close" : notes ? "notes" : "messages"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify(
            resolution
              ? { summary: content, commands, attachments: pending.current.ids }
              : {
                  content,
                  attachments: pending.current.ids,
                  requestId: pending.current.requestId,
                },
          ),
        },
      );
      pending.current = null;
      setContent("");
      setFiles([]);
      await onSent();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={`ticket-composer${resolution ? " ticket-composer-resolution" : ""}`}
      onSubmit={send}
      onPaste={(event) => {
        if (event.clipboardData.files.length) {
          event.preventDefault();
          addFiles(event.clipboardData.files);
        }
      }}
    >
      {resolution && (
        <>
          <h3>Record the resolution</h3>
          <p>
            Keep this record factual. Only staff can see these notes and proof.
          </p>
        </>
      )}
      <label
        className="ticket-sr-only"
        htmlFor={
          resolution
            ? "ticket-resolution"
            : notes
              ? "ticket-note"
              : "ticket-message"
        }
      >
        {resolution
          ? "Work done and outcome"
          : notes
            ? "Internal staff note"
            : "Message"}
      </label>
      <textarea
        ref={message}
        id={
          resolution
            ? "ticket-resolution"
            : notes
              ? "ticket-note"
              : "ticket-message"
        }
        aria-describedby={
          resolution
            ? undefined
            : notes
              ? "ticket-note-hint"
              : "ticket-message-hint"
        }
        value={content}
        onChange={(event) => {
          setContent(event.target.value);
          pending.current = null;
        }}
        onKeyDown={(event) => {
          if (
            resolution ||
            event.key !== "Enter" ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          event.preventDefault();
          if (!busy && !event.repeat) event.currentTarget.form.requestSubmit();
        }}
        placeholder={
          resolution
            ? "What did you do, and how was the player's issue resolved?"
            : notes
              ? "Discuss this ticket with staff…"
              : "Message the ticket…"
        }
        maxLength={resolution ? 4000 : 2000}
        required={resolution || !files.length}
        rows={resolution ? 4 : 2}
        disabled={busy}
      />
      {!resolution && (
        <small
          id={notes ? "ticket-note-hint" : "ticket-message-hint"}
          className="ticket-composer-hint"
        >
          Enter to send · Shift+Enter for a new line
        </small>
      )}
      {macroCategory && !resolution && (
        <MacroPicker
          category={macroCategory}
          disabled={busy}
          onInsert={(value) => {
            const next = content ? `${content}\n${value}` : value;
            if (next.length > 2000) {
              setError(errors.invalid_message);
              return;
            }
            setContent(next);
            pending.current = null;
            message.current?.focus();
          }}
        />
      )}
      {resolution && (
        <label>
          Commands run
          <textarea
            value={commands}
            onChange={(event) => setCommands(event.target.value)}
            maxLength={2000}
            required
            rows={2}
            disabled={busy}
          />
        </label>
      )}
      {!!files.length && (
        <ul className="ticket-selected-files">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              {file.name}
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  setFiles((previous) =>
                    previous.filter((_, i) => i !== index),
                  );
                  pending.current = null;
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="ticket-error" role="alert">
          {error}
        </p>
      )}
      <div className="ticket-composer-actions">
        <input
          ref={input}
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.zip,.txt,.log"
          className="ticket-sr-only"
          aria-label={
            resolution
              ? "Attach resolution proof"
              : notes
                ? "Attach internal note files"
                : "Attach files"
          }
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current.click()}
        >
          ＋ Attach or paste
        </button>
        <small>
          8 MB each
          {uploadLimit !== ticketMessageUploadLimit
            ? ` · ${uploadLimit / 1024 / 1024} MB total`
            : ""}{" "}
          · retained for 30 days
        </small>
        <button className="ticket-primary" disabled={busy}>
          {busy
            ? "Sending…"
            : resolution
              ? "Save resolution and close"
              : notes
                ? "Add staff note"
                : "Send"}
        </button>
      </div>
    </form>
  );
}
function TicketHistory({ entries }) {
  const [filters, setFilters] = useState({
    query: "",
    action: "",
    from: "",
    to: "",
  });
  const [offset, setOffset] = useState(0);
  const change = (key, value) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setOffset(0);
  };
  const term = filters.query.trim().toLowerCase();
  const items = entries.filter(
    (entry) =>
      (!filters.action || entry.action === filters.action) &&
      (!term ||
        [entry.detail, entry.actor.name, entry.actor.id].some((value) =>
          value?.toLowerCase().includes(term),
        )) &&
      (!filters.from ||
        new Date(entry.at).toISOString().slice(0, 10) >= filters.from) &&
      (!filters.to ||
        new Date(entry.at).toISOString().slice(0, 10) <= filters.to),
  );
  return (
    <section aria-label="Ticket history">
      <h3>Ticket history</h3>
      <div className="list-filters list-filters-compact">
        <label>
          Search history
          <input
            type="search"
            maxLength={100}
            value={filters.query}
            placeholder="Staff, person, ID or event"
            onChange={(event) => change("query", event.target.value)}
          />
        </label>
        <label>
          Event
          <select
            value={filters.action}
            onChange={(event) => change("action", event.target.value)}
          >
            <option value="">All events</option>
            {[...new Set(entries.map((entry) => entry.action))]
              .sort()
              .map((action) => (
                <option key={action} value={action}>
                  {action.charAt(0).toUpperCase() +
                    action.slice(1).replaceAll("_", " ")}
                </option>
              ))}
          </select>
        </label>
        <DateFilters {...filters} change={change} />
        <button
          type="button"
          onClick={() => {
            setFilters({ query: "", action: "", from: "", to: "" });
            setOffset(0);
          }}
        >
          Reset history filters
        </button>
      </div>
      <ol className="ticket-history">
        {items.slice(offset, offset + 25).map((entry) => (
          <li key={entry.id}>
            <span>{entry.detail}</span>
            <small>
              {entry.actor.name} · {stamp(entry.at)}
            </small>
          </li>
        ))}
      </ol>
      <p role="status">{items.length} matching events</p>
      {!items.length && <p>No events match these filters.</p>}
      {items.length > 25 && (
        <div className="ticket-pagination">
          <button
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            Previous events
          </button>
          <button
            disabled={offset + 25 >= items.length}
            onClick={() => setOffset(offset + 25)}
          >
            Next events
          </button>
        </div>
      )}
    </section>
  );
}

function TakeoverReview({ takeover, canApprove, base, csrf, onReviewed }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!takeover) return null;
  async function review(approve) {
    setBusy(true);
    setError("");
    try {
      await request(`${base}/takeover-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ requestId: takeover.id, approve }),
      });
      await onReviewed();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="ticket-close-confirm"
      aria-label="Internal takeover request"
    >
      <strong>Takeover request · {takeover.status}</strong>
      <p>
        {takeover.requester.name} requested this ticket from{" "}
        {takeover.previousStaff.name}.
      </p>
      <p>{takeover.reason}</p>
      {takeover.reviewer && <p>Reviewed by {takeover.reviewer.name}.</p>}
      {error && (
        <p className="ticket-error" role="alert">
          {error}
        </p>
      )}
      {takeover.status === "pending" &&
        (canApprove ? (
          <div className="ticket-actions">
            <button disabled={busy} onClick={() => review(true)}>
              Approve takeover
            </button>
            <button disabled={busy} onClick={() => review(false)}>
              Deny takeover
            </button>
          </div>
        ) : (
          <p>Waiting for a Manager or Founder with access to this category.</p>
        ))}
    </section>
  );
}

function InternalNotes({ base, csrf, active, canReply }) {
  const [data, setData] = useState(null),
    [older, setOlder] = useState([]),
    [hasOlder, setHasOlder] = useState(null),
    [error, setError] = useState("");
  const revision = useRef(0),
    scroll = useRef(null),
    nearBottom = useRef(true);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const next = await request(`${base}/notes`);
      if (current !== revision.current) return;
      setData(next);
      setError("");
    } catch (error) {
      if (current === revision.current) {
        setError(error.message);
        setData(null);
        setOlder([]);
      }
    }
  }, [base]);
  useEffect(() => {
    if (active) void refresh();
    return () => {
      revision.current++;
    };
  }, [active, refresh]);
  useLive(active ? `${base}/events` : null, refresh);
  useEffect(() => {
    if (active && nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [active, data?.messages?.length]);
  const messages = [...older, ...(data?.messages || [])].filter(
    (message, index, values) =>
      values.findIndex((value) => value.id === message.id) === index,
  );
  return (
    <div className="ticket-internal-notes" hidden={!active}>
      <div className="ticket-notes-heading">
        <div>
          <strong>Staff only</strong>
          <p>
            Discuss how to handle this ticket. Notes do not send player replies
            or claim the ticket.
          </p>
        </div>
        {data?.discordUrl && (
          <a href={data.discordUrl} target="_blank" rel="noreferrer">
            Open Discord notes ↗
          </a>
        )}
      </div>
      {error && (
        <p className="ticket-error" role="alert">
          {error} <button onClick={refresh}>Retry notes</button>
        </p>
      )}
      <TakeoverReview
        takeover={data?.takeoverRequest}
        canApprove={data?.canApproveTakeover}
        base={base}
        csrf={csrf}
        onReviewed={refresh}
      />
      <div
        className="ticket-messages"
        ref={scroll}
        aria-label="Internal notes conversation"
        onScroll={() => {
          nearBottom.current =
            scroll.current.scrollHeight -
              scroll.current.scrollTop -
              scroll.current.clientHeight <
            100;
        }}
      >
        {!data && !error && <p role="status">Loading staff notes…</p>}
        {data && (hasOlder ?? data.hasOlder) && (
          <button
            onClick={async () => {
              try {
                const next = await request(
                  `${base}/notes?before=${messages[0]?.sequence}`,
                );
                setOlder((previous) => [...next.messages, ...previous]);
                setHasOlder(next.hasOlder);
              } catch (error) {
                setError(error.message);
              }
            }}
          >
            Load earlier notes
          </button>
        )}
        {data && !messages.length && (
          <p className="ticket-empty">
            No internal notes yet. Discuss this ticket here
            {data.discordUrl ? " or in its private Discord thread." : "."}
          </p>
        )}
        {messages.map((message) => (
          <article
            className={`ticket-message${message.deleted ? " deleted" : ""}`}
            key={message.id}
          >
            <Avatar actor={message.actor} />
            <div>
              <header>
                <strong>{message.actor.name}</strong>
                <span className="ticket-staff-badge">INTERNAL</span>
                <time dateTime={new Date(message.at).toISOString()}>
                  {stamp(message.at)}
                </time>
              </header>
              <p>{message.content}</p>
              {message.editedAt && !message.deleted && <small>Edited</small>}
              {message.attachments.map((file) => (
                <FileView key={file.id} file={file} />
              ))}
              {message.delivery === "pending" && (
                <small>Saved · syncing to the private Discord thread…</small>
              )}
              {message.delivery === "stored" && (
                <small>Saved in dashboard</small>
              )}
            </div>
          </article>
        ))}
      </div>
      {data && canReply && (
        <Composer base={base} csrf={csrf} internal notes onSent={refresh} />
      )}
      {data && !canReply && (
        <p className="ticket-finished">
          You can read notes. Adding notes requires reply permission for this
          ticket category.
        </p>
      )}
    </div>
  );
}

function TicketChat({
  id,
  csrf,
  staffView = false,
  capabilities = {},
  backHref,
}) {
  const base = `${staffView ? "/api/tickets" : "/help/api/tickets"}/${id}`;
  const [ticket, setTicket] = useState(null),
    [error, setError] = useState(""),
    [closing, setClosing] = useState(false),
    [deleting, setDeleting] = useState(false),
    [requestingTakeover, setRequestingTakeover] = useState(false),
    [takeoverReason, setTakeoverReason] = useState(""),
    [busy, setBusy] = useState(false),
    [older, setOlder] = useState([]),
    [hasEarlier, setHasEarlier] = useState(null),
    [panel, setPanel] = useState("details"),
    [conversation, setConversation] = useState(() =>
      staffView && location.hash === "#notes" ? "notes" : "messages",
    ),
    [detailsOpen, setDetailsOpen] = useState(
      () => window.matchMedia("(min-width: 1100px)").matches,
    );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1100px)");
    const resize = () => setDetailsOpen(media.matches);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  const loading = useRef(false),
    queued = useRef(false),
    scroll = useRef(null),
    nearBottom = useRef(true);
  const refresh = useCallback(async () => {
    if (loading.current) {
      queued.current = true;
      return;
    }
    loading.current = true;
    try {
      setTicket(await request(base));
      setError("");
    } catch (error) {
      setError(error.message);
      setTicket(null);
      setOlder([]);
    } finally {
      loading.current = false;
      if (queued.current) {
        queued.current = false;
        void refresh();
      }
    }
  }, [base]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const connected = useLive(`${base}/events`, refresh);
  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [ticket?.messages?.length]);
  async function action(name, data = {}) {
    setBusy(true);
    setError("");
    try {
      await request(`${base}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(data),
      });
      await refresh();
      if (name === "takeover-request") {
        setRequestingTakeover(false);
        setTakeoverReason("");
        setConversation("notes");
      }
    } catch (error) {
      setError(error.message);
      if (error.code === "ticket_takeover_approval_required")
        setRequestingTakeover(true);
    } finally {
      setBusy(false);
    }
  }
  if (!ticket)
    return (
      <div className="ticket-loading">
        {backHref && (
          <a className="ticket-back" href={backHref}>
            ← Back to filtered tickets
          </a>
        )}
        <p role="status">{error || "Opening your ticket…"}</p>
        <button onClick={refresh}>Retry</button>
      </div>
    );
  const partner = ticket.type === "partnership";
  const active = ["pending", "claimed"].includes(ticket.status);
  const combined = [...older, ...ticket.messages].filter(
    (message, index, values) =>
      values.findIndex((value) => value.id === message.id) === index,
  );
  return (
    <div
      className={`ticket-chat-layout${detailsOpen ? " ticket-details-open" : ""}`}
    >
      <header className="ticket-chat-header">
        <div className="ticket-heading">
          {backHref && (
            <a className="ticket-back" href={backHref}>
              ← Back to filtered tickets
            </a>
          )}
          <h2>
            {ticketTypes.find((type) => type.id === ticket.type)?.name ||
              "Ticket"}
            <span className="ticket-heading-owner">{ticket.ign}</span>
          </h2>
          <div className="ticket-heading-meta">
            <span className={`ticket-state ${ticket.status}`}>
              {ticketStatusLabel(ticket)}
            </span>
            <small className="ticket-connection" role="status">
              {connected ? "Live" : "Reconnecting…"}
              {ticket.deliveryPending
                ? ` · ${ticket.deliveryPending} ${partner ? "contact" : "Discord"} updates pending`
                : ticket.sync === "pending"
                  ? " · Creating Discord channel…"
                  : ""}
            </small>
          </div>
        </div>
        <div className="ticket-actions">
          {!active && (!staffView || ticket.actions?.close) && (
            <button
              disabled={busy || ticket.deletionPending}
              onClick={() => action("reopen", { closureId: ticket.closureId })}
            >
              Reopen ticket
            </button>
          )}
          {staffView &&
            !active &&
            ticket.channelRetained &&
            ticket.actions?.delete && (
              <button
                disabled={busy || ticket.deletionPending}
                onClick={() => setDeleting((value) => !value)}
              >
                {ticket.deletionPending
                  ? "Deleting channel…"
                  : deleting
                    ? "Cancel deletion"
                    : "Delete Discord channel"}
              </button>
            )}
          {staffView &&
            ticket.actions?.claim &&
            active &&
            !ticket.claimedBy && (
              <button
                className="ticket-primary"
                disabled={busy}
                onClick={() => action("claim")}
              >
                Claim ticket
              </button>
            )}
          {staffView && ticket.actions?.takeover && (
            <button
              className="ticket-primary"
              disabled={busy}
              onClick={() =>
                action("takeover", { claimedBy: ticket.claimedBy.id })
              }
            >
              Take over / request
            </button>
          )}
          {staffView && ticket.actions?.close && ticket.status !== "closed" && (
            <button onClick={() => setClosing((value) => !value)}>
              {closing ? "Cancel resolution" : "Resolve ticket"}
            </button>
          )}
          {!staffView && active && (
            <button
              disabled={busy}
              onClick={() => setClosing((value) => !value)}
            >
              Close ticket
            </button>
          )}
          {ticket.discordUrl && (
            <a href={ticket.discordUrl} target="_blank" rel="noreferrer">
              Open Discord ↗
            </a>
          )}
          <button
            className="ticket-details-toggle"
            aria-expanded={detailsOpen}
            aria-controls={`ticket-details-${id}`}
            onClick={() => setDetailsOpen((value) => !value)}
          >
            {detailsOpen ? "Hide details" : "Ticket details"}
          </button>
        </div>
      </header>
      <section className="ticket-chat" aria-label="Ticket conversation">
        {staffView && requestingTakeover && active && (
          <form
            className="ticket-close-confirm"
            onSubmit={(event) => {
              event.preventDefault();
              void action("takeover-request", {
                claimedBy: ticket.claimedBy?.id,
                reason: takeoverReason,
              });
            }}
          >
            <label>
              Why do you need to take over this ticket?
              <textarea
                required
                maxLength={1000}
                value={takeoverReason}
                onChange={(event) => setTakeoverReason(event.target.value)}
              />
            </label>
            <p>
              The request and reason go only to the private staff notes thread.
              Manager approval assigns the ticket to you.
            </p>
            <button
              disabled={busy || !takeoverReason.trim()}
              className="ticket-primary"
            >
              Request Manager approval
            </button>
            <button type="button" onClick={() => setRequestingTakeover(false)}>
              Cancel request
            </button>
          </form>
        )}
        {staffView &&
          ticket.takeoverRequest?.status === "pending" &&
          conversation !== "notes" && (
            <div className="ticket-close-confirm">
              <p>
                A takeover request from {ticket.takeoverRequest.requester.name}{" "}
                is waiting for Manager approval.
              </p>
              <button onClick={() => setConversation("notes")}>
                Review in internal staff notes
              </button>
            </div>
          )}

        {staffView && (
          <div
            className="ticket-conversation-tabs"
            role="group"
            aria-label="Ticket discussions"
          >
            <button
              aria-pressed={conversation === "messages"}
              onClick={() => setConversation("messages")}
            >
              Player conversation
            </button>
            <button
              aria-pressed={conversation === "notes"}
              onClick={() => setConversation("notes")}
            >
              Internal staff notes
            </button>
          </div>
        )}
        {staffView && (
          <InternalNotes
            base={base}
            csrf={csrf}
            active={conversation === "notes"}
            canReply={ticket.actions?.reply}
          />
        )}
        <div
          className="ticket-conversation-content"
          hidden={conversation !== "messages"}
        >
          {error && (
            <p className="ticket-error" role="alert">
              {error}
            </p>
          )}
          <div
            ref={scroll}
            className="ticket-messages"
            onScroll={() => {
              nearBottom.current =
                scroll.current.scrollHeight -
                  scroll.current.scrollTop -
                  scroll.current.clientHeight <
                100;
            }}
          >
            {(hasEarlier ?? ticket.hasOlder) && (
              <button
                onClick={async () => {
                  try {
                    const data = await request(
                      `${base}?before=${combined[0]?.sequence}`,
                    );
                    setOlder((previous) => [...data.messages, ...previous]);
                    setHasEarlier(data.hasOlder);
                  } catch (error) {
                    setError(error.message);
                  }
                }}
              >
                Load earlier messages
              </button>
            )}
            <details className="ticket-intake" open>
              <summary>
                <span>
                  <strong>Original request</strong>
                  <small>Opened {stamp(ticket.createdAt)}</small>
                </span>
                <span className="ticket-intake-hint">View details</span>
              </summary>
              <div className="ticket-intake-content">
                <p>
                  <strong>
                    {ticketTypes.find((type) => type.id === ticket.type)?.name}
                  </strong>{" "}
                  · {ticket.location}
                </p>
                {ticket.intakeDetails?.map((detail) => (
                  <p key={detail.label}>
                    <strong>{detail.label}:</strong> {detail.value}
                  </p>
                ))}
                <p>{ticket.description}</p>
                {partner && (
                  <p>
                    <a
                      href={ticket.partnership.packUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View modpack ↗
                    </a>{" "}
                    ·{" "}
                    {ticket.partnership.relationship === "owner"
                      ? "Pack owner"
                      : "Pack developer"}
                  </p>
                )}
              </div>
            </details>
            {ticket.deliveryIssues?.length > 0 && (
              <p className="ticket-error" role="alert">
                A contact update could not be confirmed. Check the partnership
                inbox or Discord DM before sending again. The saved request and
                messages are safe.
              </p>
            )}
            {combined.map((message) => (
              <article
                className={`ticket-message${message.deleted ? " deleted" : ""}`}
                key={message.id}
              >
                <Avatar actor={message.actor} />
                <div>
                  <header>
                    <strong>{message.actor.name}</strong>
                    {message.staff && (
                      <span className="ticket-staff-badge">STAFF</span>
                    )}
                    <time dateTime={new Date(message.at).toISOString()}>
                      {stamp(message.at)}
                    </time>
                  </header>
                  <p>{message.content}</p>
                  {message.editedAt && !message.deleted && (
                    <small>Edited</small>
                  )}
                  {message.attachments.map((file) => (
                    <FileView key={file.id} file={file} />
                  ))}
                  {message.delivery === "failed" && (
                    <small className="ticket-error">
                      Delivery needs attention. Check the contact inbox before
                      sending again.
                    </small>
                  )}
                  {message.delivery === "pending" && (
                    <small>
                      Saved · sending{" "}
                      {partner
                        ? `by ${ticket.partnership.emailFallback ? "email" : ticket.partnership.preference === "discord" ? "Discord DM" : "email"}`
                        : "to Discord"}
                      …
                    </small>
                  )}
                </div>
              </article>
            ))}
            {!combined.length && (
              <p className="ticket-empty">
                {partner
                  ? "No messages yet. Replies sent here go to the applicant’s chosen contact method."
                  : staffView
                    ? "No messages yet. Reply here to help the player."
                    : "Your ticket is ready. Add any extra details here while you wait for staff."}
              </p>
            )}
          </div>
          {staffView && deleting && !active && ticket.channelRetained && (
            <div className="ticket-close-confirm">
              <p>
                Delete the closed Discord channel? Its messages and saved
                transcript remain in the staff dashboard.
              </p>
              <button
                className="ticket-primary"
                disabled={busy || ticket.deletionPending}
                onClick={() => {
                  setDeleting(false);
                  void action("delete-channel", {
                    closureId: ticket.closureId,
                  });
                }}
              >
                Delete channel
              </button>
              <button onClick={() => setDeleting(false)}>Keep channel</button>
            </div>
          )}
          {!staffView && closing && active && (
            <div className="ticket-close-confirm">
              <p>Close this ticket? Staff will still document the work done.</p>
              <button
                className="ticket-primary"
                disabled={busy}
                onClick={() => {
                  setClosing(false);
                  void action("close");
                }}
              >
                Yes, close ticket
              </button>
              <button onClick={() => setClosing(false)}>Keep open</button>
            </div>
          )}
          {staffView && closing && ticket.status !== "closed" && (
            <Composer
              base={base}
              csrf={csrf}
              resolution
              internal
              uploadLimit={
                partner ? 10 * 1024 * 1024 : ticketMessageUploadLimit
              }
              onSent={async () => {
                setClosing(false);
                await refresh();
              }}
            />
          )}
          {active && (!staffView || ticket.actions?.reply) && !closing && (
            <Composer
              base={base}
              csrf={csrf}
              onSent={refresh}
              macroCategory={staffView ? ticket.category : undefined}
              uploadLimit={
                partner ? 10 * 1024 * 1024 : ticketMessageUploadLimit
              }
            />
          )}
          {!active && !(staffView && closing && ticket.status !== "closed") && (
            <div className="ticket-finished">
              <p>
                {ticket.status === "awaiting_resolution"
                  ? "The conversation is closed. Staff will finish the resolution record."
                  : "This ticket is closed."}
              </p>
              {!staffView && !ticket.rating && (
                <div className="ticket-rating">
                  <span>
                    {ticket.ratingStaff?.name
                      ? `How did ${ticket.ratingStaff.name} do?`
                      : "How helpful was the support?"}{" "}
                    Your 1–5 rating is private to you and authorized staff.
                    After rating, the closed Discord channel is removed once the
                    resolution and transcript are saved.
                  </span>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      disabled={busy}
                      aria-label={`Rate support ${value} out of 5`}
                      onClick={() =>
                        action("rating", {
                          rating: value,
                          closureId: ticket.closureId,
                        })
                      }
                    >
                      {value} ★
                    </button>
                  ))}
                </div>
              )}
              {ticket.rating && (
                <p>
                  Player rating: {ticket.rating}/5
                  {ticket.ratingStaff?.name
                    ? ` · ${ticket.ratingStaff.name}`
                    : ""}
                </p>
              )}
              <a
                className="ticket-primary"
                href={`${base}/transcript${staffView ? "?copy=staff" : ""}`}
                download
              >
                Download {staffView ? "staff " : ""}transcript (.html)
              </a>
              {staffView && capabilities["logs.view"] && (
                <a href={`${base}/transcript?copy=player`} download>
                  Generate player copy (.html)
                </a>
              )}
            </div>
          )}
        </div>
      </section>
      <aside
        className="ticket-player"
        id={`ticket-details-${id}`}
        hidden={!detailsOpen}
        aria-label="Ticket details"
      >
        <div className="ticket-panel-heading">
          <h3>Ticket details</h3>
          <div
            className="ticket-panel-tabs"
            role="group"
            aria-label="Ticket information"
          >
            <button
              aria-pressed={panel === "details"}
              onClick={() => setPanel("details")}
            >
              Details
            </button>
            {staffView && (
              <button
                aria-pressed={panel === "activity"}
                onClick={() => setPanel("activity")}
              >
                Activity
              </button>
            )}
            {staffView &&
              (ticket.resolution || ticket.previousResolutions?.length > 0) && (
                <button
                  aria-pressed={panel === "resolution"}
                  onClick={() => setPanel("resolution")}
                >
                  Resolution
                </button>
              )}
          </div>
        </div>
        <div className="ticket-panel-content" hidden={panel !== "details"}>
          <div className="ticket-person">
            {!partner && (
              <img
                className="ticket-skin"
                src={
                  staffView
                    ? `/apply/api/head/${ticket.ign}`
                    : `/help/api/head/${ticket.ign}`
                }
                alt={`${ticket.ign}'s Minecraft skin`}
              />
            )}
            <div>
              <strong>{ticket.ign}</strong>
              <span>
                {ticket.owner.guest ? "Website guest" : ticket.owner.name}
              </span>
            </div>
          </div>
          <section className="ticket-detail-section">
            <h3>Assignment</h3>
            <div className="ticket-assignee">
              <Avatar actor={ticket.claimedBy || ticket.helpedBy} />
              <div>
                <strong>{ticket.claimedBy?.name || "Unclaimed"}</strong>
                <span>
                  {ticket.claimedBy
                    ? "Assigned staff member"
                    : ticket.helpedBy
                      ? `First reply by ${ticket.helpedBy.name}`
                      : "Waiting for a staff member"}
                </span>
              </div>
            </div>
          </section>
          {staffView &&
            (ticket.feedbackDelivery ||
              ticket.rating ||
              ticket.previousResolutions?.some(
                (closure) => closure.rating,
              )) && (
              <section className="ticket-detail-section">
                <h3>Player feedback</h3>
                {ticket.rating ? (
                  <FeedbackRating
                    rating={ticket.rating}
                    staff={ticket.ratingStaff}
                    at={ticket.ratedAt}
                  />
                ) : (
                  <>
                    <p>No rating submitted for the current ticket.</p>
                    {ticket.feedbackDelivery && (
                      <p className="ticket-muted">
                        {
                          {
                            dm: "Rating request sent by Discord DM",
                            channel:
                              "DMs blocked · private rating fallback sent",
                            pending: "Rating request queued",
                            failed: "Rating delivery needs attention",
                            website:
                              "Rating available in the private web ticket",
                          }[ticket.feedbackDelivery.status]
                        }
                        {ticket.feedbackDelivery.at &&
                          ` · ${stamp(ticket.feedbackDelivery.at)}`}
                      </p>
                    )}
                    {ticket.ratingStaff && (
                      <p>Feedback requested for {ticket.ratingStaff.name}</p>
                    )}
                  </>
                )}
                {ticket.previousResolutions
                  ?.filter((closure) => closure.rating)
                  .reverse()
                  .map((closure) => (
                    <FeedbackRating
                      key={closure.at}
                      rating={closure.rating}
                      staff={closure.claimedBy}
                      at={closure.ratedAt}
                      previous
                    />
                  ))}
              </section>
            )}
          <section className="ticket-detail-section">
            <h3>{partner ? "Partner contact" : "Player information"}</h3>
            <dl className="ticket-facts">
              {ticket.helpedBy && (
                <>
                  <dt>First staff reply</dt>
                  <dd>{ticket.helpedBy.name}</dd>
                </>
              )}
              {staffView && !partner && ticket.contactEmail && (
                <>
                  <dt>Contact email</dt>
                  <dd>{ticket.contactEmail}</dd>
                </>
              )}
              {partner && (
                <>
                  <dt>Email</dt>
                  <dd>{ticket.contactEmail}</dd>
                  <dt>Discord</dt>
                  <dd>{ticket.partnership.discord}</dd>
                  <dt>Contact preference</dt>
                  <dd>
                    {ticket.partnership.emailFallback
                      ? "Email · Discord messages were blocked"
                      : ticket.partnership.preference === "discord"
                        ? "Discord direct messages"
                        : "Email"}
                  </dd>
                </>
              )}
              <dt>Ticket opened from</dt>
              <dd>{ticket.origin === "discord" ? "Discord" : "Website"}</dd>
              <dt>Opened</dt>
              <dd>{stamp(ticket.createdAt)}</dd>
              <dt>Ticket reference</dt>
              <dd className="ticket-reference">{ticket.id}</dd>
            </dl>
          </section>
          {staffView && !partner && (
            <p className="ticket-integration-note">
              Minecraft activity is not connected yet.
            </p>
          )}
        </div>
        {staffView && (
          <>
            <div className="ticket-panel-content" hidden={panel !== "activity"}>
              <section className="ticket-detail-section">
                <h3>Staff viewing</h3>
                {ticket.viewers.length ? (
                  ticket.viewers.map((user) => (
                    <div className="ticket-viewer" key={user.id}>
                      <Avatar actor={user} />
                      {user.name}
                    </div>
                  ))
                ) : (
                  <p className="ticket-muted">No staff viewing</p>
                )}
              </section>
              {panel === "activity" && capabilities["moderation.view"] && (
                <ModerationHistoryCard
                  key={`moderation:${ticket.id}`}
                  endpoint={`/api/tickets/${ticket.id}/moderation`}
                />
              )}
              <TicketHistory entries={ticket.history} />
            </div>
            <div
              className="ticket-panel-content"
              hidden={panel !== "resolution"}
            >
              {ticket.previousResolutions?.map((closure, index) => (
                <section key={`${closure.at}:${index}`}>
                  <h3>Previous closure · {stamp(closure.at)}</h3>
                  {closure.rating && (
                    <p>
                      Private rating: {closure.rating}/5 ·{" "}
                      {closure.claimedBy?.name || "Support team"}
                    </p>
                  )}
                  {closure.resolution && (
                    <>
                      <p>{closure.resolution.summary}</p>
                      <p>Commands: {closure.resolution.commands}</p>
                      <p>Recorded by {closure.resolution.actor.name}</p>
                      {closure.resolution.attachments.map((file) => (
                        <FileView key={file.id} file={file} />
                      ))}
                    </>
                  )}
                </section>
              ))}
              {ticket.resolution && (
                <section className="ticket-resolution">
                  <h3>Private staff resolution</h3>
                  <p>{ticket.resolution.summary}</p>
                  <strong>Commands run</strong>
                  <p>{ticket.resolution.commands}</p>
                  {ticket.resolution.attachments.map((file) => (
                    <FileView key={file.id} file={file} />
                  ))}
                  <small>
                    {ticket.resolution.actor.name} ·{" "}
                    {stamp(ticket.resolution.at)}
                  </small>
                </section>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

export function Tickets({ csrf, capabilities, logs = false }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(
      () => Number(new URLSearchParams(location.search).get("offset")) || 0,
    ),
    [category, setCategory] = useState(
      () => new URLSearchParams(location.search).get("category") || "",
    );
  const [filters, setFilters] = useState(() => {
    const params = new URLSearchParams(location.search);
    return Object.fromEntries(
      [
        "query",
        "staff",
        "status",
        "type",
        "assignment",
        "sort",
        "from",
        "to",
      ].map((key) => [key, params.get(key) || ""]),
    );
  });
  const [term, setTerm] = useState(filters.query);
  const [staffTerm, setStaffTerm] = useState(filters.staff);
  const listSearch = new URLSearchParams({
    ...filters,
    category,
    offset: String(offset),
  }).toString();
  function updateList(
    nextFilters = filters,
    nextCategory = category,
    nextOffset = 0,
  ) {
    setFilters(nextFilters);
    setCategory(nextCategory);
    setOffset(nextOffset);
    history.replaceState(
      history.state,
      "",
      `${logs ? "/logs" : "/tickets"}?${new URLSearchParams({ ...nextFilters, category: nextCategory, offset: String(nextOffset) })}`,
    );
  }
  function changeFilter(key, value) {
    updateList({
      ...filters,
      query: term.trim(),
      staff: staffTerm.trim(),
      [key]: value,
    });
  }
  const latestRequest = useRef(0);
  const selection = `${logs}:${listSearch}`;
  const ready = data?.selection === selection && !error;
  const id = location.pathname.match(/^\/tickets\/([a-f0-9-]{36})$/)?.[1];
  const refresh = useCallback(async () => {
    const requestId = ++latestRequest.current;
    try {
      const result = await request(
        `/api/tickets?${listSearch}&closed=${logs ? 1 : 0}`,
      );
      if (requestId !== latestRequest.current) return;
      setData({ ...result, selection });
      setError("");
    } catch (error) {
      if (requestId !== latestRequest.current) return;
      setData(null);
      setError(error.message);
    }
  }, [logs, listSearch, selection]);
  useLive(!id ? "/api/tickets/events" : null, refresh);
  useEffect(() => {
    if (id) return;
    void refresh();
    return () => {
      latestRequest.current++;
    };
  }, [id, refresh]);
  if (id)
    return (
      <div className="ticket-page ticket-detail">
        <TicketChat
          key={id}
          id={id}
          csrf={csrf}
          staffView
          capabilities={capabilities}
          backHref={`${new URLSearchParams(location.search).get("view") === "logs" ? "/logs" : "/tickets"}?${listSearch}`}
        />
      </div>
    );
  return (
    <div className="ticket-page">
      <div className="ticket-list-heading">
        <div>
          <h2>{logs ? "Community logs" : "Tickets"}</h2>
          <p>
            {logs
              ? "Ticket text, staff resolution records and history follow the twelve month inactivity rule. Attachments expire after 30 days."
              : "Claim a ticket, help the player, and record the resolution."}
          </p>
        </div>
        <button onClick={refresh}>Refresh</button>
      </div>
      {!logs && capabilities["tickets.macros.manage"] && (
        <TicketMacroLibrary csrf={csrf} initialCategory={category} />
      )}
      {logs && (
        <div className="ticket-log-tabs">
          <strong>Ticket transcripts</strong>
          <span>Staff commands · Not connected</span>
          <span>Server logs · Not connected</span>
        </div>
      )}
      {error && (
        <p className="ticket-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="ticket-category-tabs"
        role="group"
        aria-label="Ticket categories"
      >
        <button
          aria-pressed={!category}
          onClick={() => {
            updateList(filters, "");
          }}
        >
          All accessible tickets
        </button>
        {(data?.categories || []).map((entry) => (
          <button
            key={entry.id}
            aria-pressed={category === entry.id}
            onClick={() => {
              updateList(filters, entry.id);
            }}
          >
            {entry.name} <span>{entry.count}</span>
          </button>
        ))}
      </div>
      <form
        className="list-filters"
        aria-label="Filter tickets"
        onSubmit={(event) => {
          event.preventDefault();
          updateList({
            ...filters,
            query: term.trim(),
            staff: staffTerm.trim(),
          });
        }}
      >
        <label>
          Search tickets
          <input
            type="search"
            maxLength={100}
            placeholder="Name, ID, staff, location or issue"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
        </label>
        {!logs && (
          <label>
            Status
            <select
              value={filters.status}
              onChange={(event) => changeFilter("status", event.target.value)}
            >
              <option value="">All open statuses</option>
              {Object.entries(ticketStatuses)
                .filter(([key]) => key !== "closed")
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Ticket type
          <select
            value={filters.type}
            onChange={(event) => changeFilter("type", event.target.value)}
          >
            <option value="">All types</option>
            {ticketTypes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Staff name or ID
          <input
            type="search"
            maxLength={100}
            placeholder="Search staff who helped"
            value={staffTerm}
            onChange={(event) => setStaffTerm(event.target.value)}
          />
        </label>
        <label>
          Assignment status
          <select
            value={filters.assignment}
            onChange={(event) => changeFilter("assignment", event.target.value)}
          >
            <option value="">Anyone</option>
            <option value="mine">Assigned to me</option>
            <option value="unclaimed">Unclaimed</option>
            <option value="claimed">Claimed</option>
          </select>
        </label>
        <DateFilters
          from={filters.from}
          to={filters.to}
          change={changeFilter}
        />
        <label>
          Sort by
          <select
            value={filters.sort || "updated"}
            onChange={(event) => changeFilter("sort", event.target.value)}
          >
            <option value="updated">Last updated</option>
            <option value="newest">Newest opened</option>
            <option value="oldest">Oldest opened</option>
          </select>
        </label>
        <div className="list-filter-actions">
          <button type="submit">Search</button>
          <button
            type="button"
            onClick={() => {
              setTerm("");
              setStaffTerm("");
              updateList(
                Object.fromEntries(
                  Object.keys(filters).map((key) => [key, ""]),
                ),
                "",
              );
            }}
          >
            Reset filters
          </button>
        </div>
      </form>
      <p className="ticket-filter-note">
        Staff search includes assigned staff, first replies and resolutions,
        including previous closures. Dates filter when tickets were opened.
        Category counts match the other filters.
      </p>
      <div className="ticket-list">
        {!ready && !error && <p>Loading tickets…</p>}
        {ready &&
          data.items.map((ticket) => (
            <a
              className="ticket-list-row"
              key={ticket.id}
              href={`/tickets/${ticket.id}?${listSearch}${logs ? "&view=logs" : ""}`}
            >
              <Avatar actor={ticket.owner} />
              <div>
                <strong>
                  {ticket.ign} ·{" "}
                  {ticketTypes.find((type) => type.id === ticket.type)?.name}
                </strong>
                <p>{ticket.location}</p>
                <small>
                  {ticket.owner.name} · {stamp(ticket.createdAt)}
                </small>
              </div>
              <span className={`ticket-state ${ticket.status}`}>
                {ticketStatusLabel(ticket)}
              </span>
              <span>
                {ticket.claimedBy?.name ||
                  (ticket.helpedBy
                    ? `Replied by ${ticket.helpedBy.name}`
                    : "Unclaimed")}
              </span>
            </a>
          ))}
        {ready && !data.items.length && (
          <p className="ticket-empty">No tickets match these filters.</p>
        )}
      </div>
      <div className="ticket-pagination">
        <button
          disabled={!ready || !offset}
          onClick={() =>
            updateList(filters, category, Math.max(0, offset - 50))
          }
        >
          Previous
        </button>
        <span>
          {ready
            ? `${data.total ? `${offset + 1}–${Math.min(offset + 50, data.total)} of ` : ""}${data.total} matching ${data.total === 1 ? "ticket" : "tickets"}`
            : "Loading…"}
        </span>
        <button
          disabled={!ready || offset + 50 >= (data?.total || 0)}
          onClick={() => updateList(filters, category, offset + 50)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function PublicTickets() {
  const [session, setSession] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mine, setMine] = useState([]);
  const [form, setForm] = useState({
    type: "general",
    ign: "",
    location: "",
    description: "",
    reportTarget: "",
    email: "",
  });
  const requestId = useRef(crypto.randomUUID());
  const intake = ticketIntake(form.type);
  const id = location.pathname.match(
    /^\/help\/[A-Za-z0-9_]{3,16}\/([a-f0-9-]{36})$/,
  )?.[1];
  const emailKey = location.pathname.match(
    /^\/help\/access\/([A-Za-z0-9_-]{43})$/,
  )?.[1];
  const refreshMine = useCallback(async () => {
    try {
      const data = await request("/help/api/tickets");
      setMine(data.items);
    } catch (error) {
      setError(error.message);
    }
  }, []);
  useLive(
    session?.identity && !id && !emailKey ? "/help/api/tickets/events" : null,
    refreshMine,
  );
  useEffect(() => {
    request("/help/api/session")
      .then((data) => {
        setSession(data);
        if (data.identity && !id && !emailKey) void refreshMine();
      })
      .catch((error) => setError(error.message));
  }, [id, emailKey, refreshMine]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const result = await request("/help/api/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
        },
        body: JSON.stringify({ returnPath: location.pathname }),
      });
      location.assign(result.url);
    } catch (error) {
      setError(error.message);
      setBusy(false);
    }
  }
  async function open(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await request("/help/api/tickets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
        },
        body: JSON.stringify({ ...form, requestId: requestId.current }),
      });
      location.assign(result.path);
    } catch (error) {
      setError(error.message);
      setBusy(false);
    }
  }
  return (
    <main className={`ticket-portal${id ? " ticket-portal-chat" : ""}`}>
      <header className="ticket-brand">
        <a href="/help">
          <img src={logo} alt="" />
          <strong>DRAKORA SUPPORT</strong>
        </a>
        <a href="/">Back to Drakora</a>
      </header>
      {error && (
        <p className="ticket-error" role="alert">
          {error}
        </p>
      )}
      {session?.identity && (
        <p className="ticket-identity">
          <Avatar actor={session.identity} />
          {session.identity.guest ? "Website ticket for " : "Connected as "}
          <strong>{session.identity.name}</strong>
          {!session.identity.guest && (
            <button
              disabled={busy}
              onClick={async () => {
                try {
                  await request("/help/api/disconnect", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "X-CSRF-Token": session.csrf,
                    },
                    body: "{}",
                  });
                  location.reload();
                } catch (error) {
                  setError(error.message);
                }
              }}
            >
              Change account
            </button>
          )}
        </p>
      )}
      {!session ? (
        <p>Opening support…</p>
      ) : emailKey ? (
        <section className="ticket-connect">
          <h1>Your private ticket</h1>
          <p>
            Continue to open the conversation linked in your ticket update
            email.
          </p>
          <button
            className="ticket-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await request("/help/api/email-access", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": session.csrf,
                  },
                  body: JSON.stringify({ key: emailKey }),
                });
                location.assign(result.path);
              } catch (error) {
                setError(error.message);
                setBusy(false);
              }
            }}
          >
            {busy ? "Opening…" : "Open my ticket"}
          </button>
        </section>
      ) : id && !session.identity ? (
        <section className="ticket-connect">
          <h1>Your private ticket</h1>
          <p>
            Use the private link in your latest ticket update email, or connect
            the Discord account that opened this ticket. You do not need a
            separate Drakora account.
          </p>
          <button className="ticket-primary" disabled={busy} onClick={connect}>
            {busy ? "Connecting…" : "Connect Discord"}
          </button>
          <p>
            Need a new ticket? <a href="/help/new">Open a website ticket</a>{" "}
            with or without Discord.
          </p>
        </section>
      ) : id ? (
        <TicketChat id={id} csrf={session.csrf} />
      ) : (
        <div className="ticket-new-layout">
          <section>
            <h1>{intake.title}</h1>
            <p>
              Tell us enough to understand the issue. A staff member will claim
              your ticket and help you here or in Discord.
            </p>
            {(!session.identity || session.identity.guest) && (
              <p className="ticket-privacy">
                Discord is optional.{" "}
                <button type="button" disabled={busy} onClick={connect}>
                  Connect Discord
                </button>{" "}
                to chat in either place, or open a website ticket below. Without
                Discord, one ticket can be open per internet connection. You can
                also reopen your private conversation from an email update.
              </p>
            )}
            <form className="ticket-new-form" onSubmit={open}>
              <LegalNotice application />
              {(!session.identity || session.identity.guest) && (
                <label>
                  Email for ticket updates
                  <input
                    type="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                    value={form.email}
                    placeholder="you@example.com"
                    onChange={(event) =>
                      setForm((value) => ({
                        ...value,
                        email: event.target.value,
                      }))
                    }
                  />
                  <span>
                    We will email you when staff reply or your ticket status
                    changes. Your email stays private.
                  </span>
                </label>
              )}
              <label>
                What do you need help with?
                <select
                  value={form.type}
                  onChange={(event) =>
                    setForm((value) => ({ ...value, type: event.target.value }))
                  }
                >
                  {ticketTypes
                    .filter((type) => type.id !== "partnership")
                    .map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.name}
                      </option>
                    ))}
                </select>
              </label>
              {form.type === "staff" && (
                <p className="ticket-privacy">
                  Staff reports are visible only to Managers and Founders.
                </p>
              )}
              {intake.fields.map((field) => {
                const Control = field.multiline ? "textarea" : "input";
                return (
                  <label key={field.id}>
                    {field.label}
                    <Control
                      required={field.required !== false}
                      minLength={field.min}
                      maxLength={field.max}
                      {...(field.multiline
                        ? { rows: 7 }
                        : {
                            autoComplete: "off",
                            ...(field.id === "ign"
                              ? { pattern: "[A-Za-z0-9_]{3,16}" }
                              : {}),
                          })}
                      value={form[field.id] || ""}
                      placeholder={field.placeholder}
                      onChange={(event) =>
                        setForm((value) => ({
                          ...value,
                          [field.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                );
              })}
              <p>
                You can send screenshots and files once your private ticket is
                open. Never share passwords or payment details.
              </p>
              <button className="ticket-primary" disabled={busy}>
                {busy ? "Opening ticket…" : "Open private ticket"}
              </button>
            </form>
          </section>
          <aside className="ticket-new-aside">
            <h2>Your tickets</h2>
            {mine.length ? (
              mine.map((ticket) => (
                <a key={ticket.id} href={ticket.path}>
                  <strong>{ticket.ign}</strong>
                  <span>{ticketStatusLabel(ticket)}</span>
                </a>
              ))
            ) : (
              <p>No tickets yet.</p>
            )}
            <h2>What happens next?</h2>
            <p>
              Staff claim your ticket and reply in the same conversation. You
              can continue here or in Discord.
            </p>
            <p>
              When finished, either side can close it. Rating the help and
              downloading a transcript are optional.
            </p>
            <p>Attachments remain available for 30 days.</p>
          </aside>
        </div>
      )}
    </main>
  );
}
