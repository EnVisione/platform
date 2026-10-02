import React from "react";
import { RequiredMark } from "./application-evidence.jsx";

export function NotificationSettings({
  linked,
  preference,
  email,
  emailAvailable,
  emailEnabled,
  onChange,
}) {
  return (
    <>
      <fieldset className="apply-notification-options">
        <legend>
          How should we send application updates?
          <RequiredMark />
        </legend>
        {linked && (
          <label className="apply-notification-option">
            <input
              type="radio"
              name="notificationPreference"
              value="discord"
              checked={preference === "discord"}
              onChange={() => onChange("notificationPreference", "discord")}
              required
            />
            <span>
              <strong>Discord DMs</strong>
              <small>
                If the bot cannot DM you, we will use a private channel in the
                main Drakora server, visible to you and the moderation team. You
                must be a member of that server.
              </small>
            </span>
          </label>
        )}
        <label className="apply-notification-option">
          <input
            type="radio"
            name="notificationPreference"
            value="email"
            checked={preference === "email"}
            onChange={() => onChange("notificationPreference", "email")}
            required
          />
          <span>
            <strong>
              {linked ? "Email · no Discord updates" : "Contact email"}
            </strong>
            <small>
              {emailEnabled
                ? "We will email your submission confirmation and review updates. Check your spam folder if an update does not arrive."
                : "Automatic email is not available yet. Your email is saved privately so staff can contact you manually."}{" "}
              Review updates remain available on this receipt in this browser
              for 7 days.
            </small>
          </span>
        </label>
      </fieldset>
      {(preference === "email" || !emailAvailable) && (
        <label className="apply-field">
          <span>
            Contact email
            <RequiredMark />
          </span>
          <input
            type="email"
            autoComplete="email"
            maxLength={254}
            required
            value={email ?? ""}
            onChange={(event) => onChange("contactEmail", event.target.value)}
          />
          <small>
            Only authorized staff can see your address. It will not be posted to
            Discord.
          </small>
        </label>
      )}
    </>
  );
}

export function NotificationDeliveries({ notifications = [] }) {
  if (!notifications.length)
    return <p className="apply-muted">No updates scheduled yet.</p>;
  return (
    <ul className="apply-deliveries">
      {notifications.map((update) => (
        <li key={update.event}>
          <strong>
            {
              {
                received: "Submission confirmation",
                reviewing: "Review started",
                approved: "Approval",
                denied: "Denial",
              }[update.event]
            }
          </strong>
          <span>
            {update.awaitingSetup
              ? "Email saved · automatic sending awaits email setup"
              : update.pending
                ? update.route === "private"
                  ? "Private channel update queued"
                  : update.route === "email"
                    ? "Email update queued"
                    : "Discord update queued"
                : update.sentAt
                  ? `${update.route === "private" ? "Sent in private channel" : update.route === "email" ? "Accepted by email service" : "Sent by DM"} · ${new Date(update.sentAt).toLocaleString()}`
                  : update.reason === "fallback_join_required"
                    ? "Could not deliver. Join the main Drakora server or contact staff by email."
                    : "Could not deliver. Staff can follow up using the contact email."}
          </span>
          {update.sentAt && update.channelUrl && (
            <a
              href={update.channelUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open private update channel
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
