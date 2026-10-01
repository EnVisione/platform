import React, { useEffect, useRef, useState } from "react";
import "./office.css";

const embedded = location.pathname === "/_drakora/office";
const endpoint = embedded ? "/_drakora/api/office" : "/api/office";
const statuses = {
  online: "Online",
  idle: "Away",
  dnd: "Do not disturb",
  offline: "Offline",
  unknown: "Unavailable",
};
const errors = {
  meeting_host_required: "Only Founder and Admin can manage meetings.",
  todo_role_required: "You need the Todo role to use the staff office.",
  office_unavailable:
    "Discord is reconnecting. Meeting controls will return shortly.",
  meeting_recovery_required:
    "This room needs to be closed before another meeting can start.",
  login_required: "Your session has ended. Sign in again to use the office.",
  discord_login_required:
    "Your session has ended. Sign in again to use the office.",
};
function Avatar({ member, small = false }) {
  return (
    <span className={`office-avatar ${small ? "small" : ""}`}>
      <img src={member.avatar} alt="" />
      <i
        className={`presence ${member.status}`}
        title={statuses[member.status]}
      />
    </span>
  );
}
function MeetingDialog({ confirm, cancel, action }) {
  const dialog = useRef(null);
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="office-modal"
      onCancel={cancel}
      aria-labelledby="meeting-confirm-title"
    >
      <h2 id="meeting-confirm-title">
        {confirm.action === "start" ? "Start" : "End"} {confirm.room.name}?
      </h2>
      <p>
        {confirm.action === "start"
          ? "This unlocks the room and posts an invitation that notifies the Todo role in Discord."
          : "This closes the room to new joins and marks the invitation as ended. People already connected can finish their conversation."}
      </p>
      <div>
        <button className="office-button secondary" onClick={cancel} autoFocus>
          Cancel
        </button>
        <button
          className="office-button"
          onClick={() => action(confirm.room, confirm.action)}
        >
          {confirm.action === "start" ? "Start and invite" : "End meeting"}
        </button>
      </div>
    </dialog>
  );
}
export function Office() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(null);
  const [confirm, setConfirm] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function refresh() {
      try {
        const response = await fetch(endpoint, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "office_unavailable");
        setData(result);
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setData(null);
          setError(cause.message);
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
      }
    }
    refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  async function action(room, name) {
    setPending(room.id);
    setConfirm(null);
    setActionError("");
    try {
      const response = await fetch(`${endpoint}/${room.id}/${name}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": data.csrf,
        },
        body: "{}",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "office_unavailable");
      setData(result);
    } catch (cause) {
      setActionError(cause.message);
    } finally {
      setPending(null);
    }
  }
  const active =
    data?.members.filter((member) =>
      ["online", "idle", "dnd"].includes(member.status),
    ) ?? [];
  return (
    <main className="discord-office">
      <header className="office-header">
        <div>
          <span className="office-eyebrow">DRAKORA STAFF</span>
          <h1>Office</h1>
          <p>Meet the team where the conversation happens.</p>
        </div>
        <nav aria-label="Office navigation">
          {!embedded && (
            <a className="office-button secondary" href="/">
              Dashboard
            </a>
          )}
          {data && (
            <a
              className="office-button"
              href={data.discordUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open Discord ↗
            </a>
          )}
        </nav>
      </header>
      {error && (
        <div className="office-notice" role="alert">
          {errors[error] ||
            "The office could not be updated. Please try again."}
          {error.includes("login_required") && (
            <a href="/login" target="_top">
              Sign in
            </a>
          )}
        </div>
      )}
      {actionError && (
        <div className="office-notice" role="alert">
          {errors[actionError] ||
            "The meeting could not be updated. Please try again."}
        </div>
      )}
      {!data && !error && <p role="status">Connecting to the office…</p>}
      {data && (
        <>
          <section className="office-summary" aria-label="Discord connection">
            <span>
              <i
                className={`connection-dot ${data.connected ? "connected" : ""}`}
              />
              {data.connected
                ? "Connected to Discord"
                : "Discord is reconnecting"}
            </span>
            <span>
              {data.connected
                ? `${active.length} staff online`
                : "Presence unavailable"}
            </span>
            <span>
              {data.rooms.reduce((sum, room) => sum + room.memberIds.length, 0)}{" "}
              in voice
            </span>
          </section>
          <div className="office-layout">
            <section className="office-rooms" aria-labelledby="rooms-title">
              <div className="office-section-heading">
                <h2 id="rooms-title">Rooms</h2>
                <span>Join voice in Discord</span>
              </div>
              <div className="room-grid">
                {data.rooms.map((room, index) => {
                  const participants = room.memberIds
                    .map((id) =>
                      data.members.find((member) => member.id === id),
                    )
                    .filter(Boolean);
                  const host = data.members.find(
                    (member) => member.id === room.hostId,
                  );
                  const running = room.status === "live";
                  const locked =
                    room.status === "closed" && room.kind === "meeting";
                  return (
                    <article
                      className={`office-room ${index === 0 ? "all-hands" : ""} ${running ? "live" : ""}`}
                      key={room.id}
                    >
                      <div className="room-title">
                        <span className="room-icon">
                          {room.kind === "meeting" ? "◈" : "◉"}
                        </span>
                        <div>
                          <h3>{room.name}</h3>
                          <span>
                            {running
                              ? "Meeting in progress"
                              : locked
                                ? "Locked until a meeting starts"
                                : room.status === "open"
                                  ? "Open for conversation"
                                  : "Unavailable"}
                          </span>
                        </div>
                        <span className={`room-state ${running ? "live" : ""}`}>
                          {running
                            ? "LIVE"
                            : locked
                              ? "LOCKED"
                              : room.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="room-people">
                        {participants.length ? (
                          participants.map((member) => (
                            <div className="voice-person" key={member.id}>
                              <Avatar member={member} small />
                              <span>{member.name}</span>
                              {member.muted && (
                                <span className="voice-detail">Muted</span>
                              )}
                              {member.deafened && (
                                <span className="voice-detail">Deafened</span>
                              )}
                            </div>
                          ))
                        ) : (
                          <p>
                            {locked
                              ? "A host can open this room and invite the team."
                              : "No one here yet."}
                          </p>
                        )}
                      </div>
                      {host && running && (
                        <p className="meeting-host">Hosted by {host.name}</p>
                      )}
                      <div className="room-actions">
                        {room.joinable && (
                          <a
                            className="office-button secondary"
                            href={room.joinUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Join voice ↗
                          </a>
                        )}
                        {data.canHost &&
                          data.connected &&
                          room.kind === "meeting" && (
                            <button
                              className={`office-button ${running ? "secondary" : ""}`}
                              disabled={pending !== null}
                              onClick={() =>
                                setConfirm({
                                  room,
                                  action: locked ? "start" : "end",
                                })
                              }
                            >
                              {pending === room.id
                                ? "Updating…"
                                : locked
                                  ? "Start meeting"
                                  : "End meeting"}
                            </button>
                          )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
            <aside className="office-staff" aria-labelledby="staff-title">
              <div className="office-section-heading">
                <h2 id="staff-title">The team</h2>
                <span>{data.members.length} staff</span>
              </div>
              {data.members.map((member) => (
                <article className="staff-person" key={member.id}>
                  <Avatar member={member} />
                  <div>
                    <h3>{member.name}</h3>
                    <p>{member.ranks.join(" · ") || "Staff"}</p>
                    <span>{statuses[member.status]}</span>
                  </div>
                </article>
              ))}
              <p className="presence-note">
                Discord presence updates live. Invisible members appear offline.
              </p>
            </aside>
          </div>
        </>
      )}
      {confirm && (
        <MeetingDialog
          confirm={confirm}
          cancel={() => setConfirm(null)}
          action={action}
        />
      )}
    </main>
  );
}
