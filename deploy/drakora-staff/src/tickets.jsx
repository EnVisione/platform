import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ticketTypes,
  ticketIntake,
  ticketStatuses,
  ticketUploadLimit,
  ticketMessageUploadLimit,
} from "../shared/tickets.js";
import logo from "./assets/drakora-logo.png";
import "./tickets.css";
import { ModerationHistoryCard } from "./moderation.jsx";

const errors = {
  ticket_identity_required:
    "Open your ticket in the browser you used to create it, or connect its Discord account.",
  ticket_not_found:
    "This ticket is unavailable in this browser. Use its private email link or connect the Discord account that opened it.",
  ticket_access_denied: "Your staff permissions do not allow this action.",
  ticket_already_claimed:
    "Another staff member has already claimed this ticket.",
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
  resolution_required: "Explain what was done in at least 20 characters.",
  commands_required: "Record the commands used, or enter None.",
  ticket_already_rated: "You have already rated this ticket.",
  invalid_request:
    "Your session changed. Reload this page before trying again.",
};
async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      errors[data.error] ||
        "Support is temporarily unavailable. Your ticket and unsent message have been kept. Please try again.",
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
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = () => callback.current();
    const visible = () => {
      if (!document.hidden) callback.current();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      source.close();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url]);
  return connected;
}
function Composer({
  base,
  csrf,
  internal = false,
  onSent,
  resolution = false,
  uploadLimit = ticketMessageUploadLimit,
}) {
  const [content, setContent] = useState(""),
    [commands, setCommands] = useState("None"),
    [files, setFiles] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(null),
    input = useRef(null);
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
          `${base}/attachments${internal ? "?internal=1" : ""}`,
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
      await request(`${base}/${resolution ? "close" : "messages"}`, {
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
      });
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
      className="ticket-composer"
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
        htmlFor={resolution ? "ticket-resolution" : "ticket-message"}
      >
        {resolution ? "Work done and outcome" : "Message"}
      </label>
      <textarea
        id={resolution ? "ticket-resolution" : "ticket-message"}
        value={content}
        onChange={(event) => {
          setContent(event.target.value);
          pending.current = null;
        }}
        placeholder={
          resolution
            ? "What did you do, and how was the player's issue resolved?"
            : "Message the ticket…"
        }
        minLength={resolution ? 20 : undefined}
        maxLength={resolution ? 4000 : 2000}
        required={resolution || !files.length}
        rows={resolution ? 4 : 3}
        disabled={busy}
      />
      {resolution && (
        <label>
          Commands run
          <textarea
            value={commands}
            onChange={(event) => setCommands(event.target.value)}
            minLength={4}
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
          aria-label={resolution ? "Attach resolution proof" : "Attach files"}
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
              : "Send"}
        </button>
      </div>
    </form>
  );
}
function TicketChat({ id, csrf, staffView = false, capabilities = {} }) {
  const base = `${staffView ? "/api/tickets" : "/help/api/tickets"}/${id}`;
  const [ticket, setTicket] = useState(null),
    [error, setError] = useState(""),
    [closing, setClosing] = useState(false),
    [busy, setBusy] = useState(false),
    [older, setOlder] = useState([]),
    [hasEarlier, setHasEarlier] = useState(null);
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
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  if (!ticket)
    return (
      <div className="ticket-loading">
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
    <div className="ticket-chat-layout">
      <section className="ticket-chat">
        <header className="ticket-chat-header">
          <div>
            <h2>
              #{ticket.type}-{ticket.ign}
            </h2>
            <span className={`ticket-state ${ticket.status}`}>
              {ticketStatuses[ticket.status]}
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
          <div className="ticket-actions">
            {staffView &&
              ticket.actions?.claim &&
              ticket.status === "pending" && (
                <button
                  className="ticket-primary"
                  disabled={busy}
                  onClick={() => action("claim")}
                >
                  Claim ticket
                </button>
              )}
            {staffView &&
              ticket.actions?.close &&
              ticket.status !== "closed" && (
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
          </div>
        </header>
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
          <article className="ticket-intake">
            <h3>Ticket opened</h3>
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
            <small>
              Opened by {ticket.owner.name} · {stamp(ticket.createdAt)}
            </small>
          </article>
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
                {message.editedAt && !message.deleted && <small>Edited</small>}
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
            uploadLimit={partner ? 10 * 1024 * 1024 : ticketMessageUploadLimit}
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
            uploadLimit={partner ? 10 * 1024 * 1024 : ticketMessageUploadLimit}
          />
        )}
        {!active && (
          <div className="ticket-finished">
            <p>
              {ticket.status === "awaiting_resolution"
                ? "The conversation is closed. Staff will finish the resolution record."
                : "This ticket is closed."}
            </p>
            {!staffView && !ticket.rating && (
              <div className="ticket-rating">
                <span>Optional: how helpful was the support?</span>
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    disabled={busy}
                    aria-label={`Rate support ${value} out of 5`}
                    onClick={() => action("rating", { rating: value })}
                  >
                    {value} ★
                  </button>
                ))}
              </div>
            )}
            {ticket.rating && <p>Player rating: {ticket.rating}/5</p>}
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
      </section>
      <aside className="ticket-player">
        <h3>{partner ? "Partner contact" : "Player information"}</h3>
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
        <strong>{ticket.ign}</strong>
        <span>{ticket.owner.name}</span>
        <dl>
          {staffView && !partner && (
            <>
              <dt>Minecraft status</dt>
              <dd>Not connected</dd>
              <dt>Last online</dt>
              <dd>Not connected</dd>
              <dt>Network playtime</dt>
              <dd>Not connected</dd>
              {ticket.contactEmail && (
                <>
                  <dt>Contact email</dt>
                  <dd>{ticket.contactEmail}</dd>
                </>
              )}
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
          <dt>Assigned staff</dt>
          <dd>{ticket.claimedBy?.name || "Unclaimed"}</dd>
        </dl>
        {staffView && (
          <>
            {capabilities["moderation.view"] && (
              <ModerationHistoryCard
                key={`moderation:${ticket.id}`}
                endpoint={`/api/tickets/${ticket.id}/moderation`}
              />
            )}
            <h3>Staff viewing</h3>
            {ticket.viewers.length ? (
              ticket.viewers.map((user) => (
                <div className="ticket-viewer" key={user.id}>
                  <Avatar actor={user} />
                  {user.name}
                </div>
              ))
            ) : (
              <p>No staff viewing</p>
            )}
            <h3>Ticket history</h3>
            <ol className="ticket-history">
              {ticket.history.map((entry) => (
                <li key={entry.id}>
                  <span>{entry.detail}</span>
                  <small>
                    {entry.actor.name} · {stamp(entry.at)}
                  </small>
                </li>
              ))}
            </ol>
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
                  {ticket.resolution.actor.name} · {stamp(ticket.resolution.at)}
                </small>
              </section>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

export function Tickets({ csrf, capabilities, logs = false }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0),
    [category, setCategory] = useState("");
  const latestRequest = useRef(0);
  const selection = `${logs}:${category}:${offset}`;
  const ready = data?.selection === selection;
  const id = location.pathname.match(/^\/tickets\/([a-f0-9-]{36})$/)?.[1];
  const refresh = useCallback(async () => {
    const requestId = ++latestRequest.current;
    try {
      const result = await request(
        `/api/tickets?closed=${logs ? 1 : 0}&offset=${offset}&category=${category}`,
      );
      if (requestId !== latestRequest.current) return;
      setData({ ...result, selection });
      setError("");
    } catch (error) {
      if (requestId !== latestRequest.current) return;
      setError(error.message);
    }
  }, [logs, offset, category, selection]);
  useLive(!id ? "/api/tickets/events" : null, refresh);
  useEffect(() => {
    if (id) return;
    void refresh();
    const interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      clearInterval(interval);
      latestRequest.current++;
    };
  }, [id, refresh]);
  if (id)
    return (
      <div className="ticket-page ticket-detail">
        <a className="ticket-back" href="/tickets">
          ← Tickets
        </a>
        <TicketChat
          key={id}
          id={id}
          csrf={csrf}
          staffView
          capabilities={capabilities}
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
              ? "Ticket text, staff resolution records and history are kept permanently. Attachments expire after 30 days."
              : "Claim a ticket, help the player, and record the resolution."}
          </p>
        </div>
        <button onClick={refresh}>Refresh</button>
      </div>
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
      {!data && !error && <p>Loading tickets…</p>}
      {data && (
        <>
          <div
            className="ticket-category-tabs"
            role="group"
            aria-label="Ticket categories"
          >
            <button
              aria-pressed={!category}
              onClick={() => {
                setCategory("");
                setOffset(0);
              }}
            >
              All accessible tickets
            </button>
            {data.categories.map((entry) => (
              <button
                key={entry.id}
                aria-pressed={category === entry.id}
                onClick={() => {
                  setCategory(entry.id);
                  setOffset(0);
                }}
              >
                {entry.name} <span>{entry.count}</span>
              </button>
            ))}
          </div>
          <div className="ticket-list">
            {!ready && !error && <p>Loading tickets…</p>}
            {ready &&
              data.items.map((ticket) => (
                <a
                  className="ticket-list-row"
                  key={ticket.id}
                  href={`/tickets/${ticket.id}`}
                >
                  <Avatar actor={ticket.owner} />
                  <div>
                    <strong>
                      {ticket.ign} ·{" "}
                      {
                        ticketTypes.find((type) => type.id === ticket.type)
                          ?.name
                      }
                    </strong>
                    <p>{ticket.location}</p>
                    <small>
                      {ticket.owner.name} · {stamp(ticket.createdAt)}
                    </small>
                  </div>
                  <span className={`ticket-state ${ticket.status}`}>
                    {ticketStatuses[ticket.status]}
                  </span>
                  <span>{ticket.claimedBy?.name || "Unclaimed"}</span>
                </a>
              ))}
            {ready && !data.items.length && (
              <p className="ticket-empty">
                {logs
                  ? "No closed ticket transcripts yet."
                  : "No tickets waiting for help."}
              </p>
            )}
          </div>
          <div className="ticket-pagination">
            <button
              disabled={!ready || !offset}
              onClick={() => setOffset((value) => Math.max(0, value - 50))}
            >
              Previous
            </button>
            <span>
              {ready
                ? `${data.total} ${data.total === 1 ? "ticket" : "tickets"}`
                : "Loading…"}
            </span>
            <button
              disabled={!ready || offset + 50 >= data.total}
              onClick={() => setOffset((value) => value + 50)}
            >
              Next
            </button>
          </div>
        </>
      )}
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
  useEffect(() => {
    request("/help/api/session")
      .then((data) => {
        setSession(data);
        if (data.identity && !id)
          void request("/help/api/tickets")
            .then((data) => setMine(data.items))
            .catch((error) => setError(error.message));
      })
      .catch((error) => setError(error.message));
  }, [id]);
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
                  <span>{ticketStatuses[ticket.status]}</span>
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
