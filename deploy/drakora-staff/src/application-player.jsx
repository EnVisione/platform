import React from "react";

function PendingStats({ labels }) {
  return (
    <dl className="application-player-stats">
      {labels.map((label) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className="application-stat-pending">Not connected</dd>
        </div>
      ))}
    </dl>
  );
}

export function ApplicationPlayer({ application }) {
  return (
    <aside
      className="application-player"
      aria-label="Applicant player information"
    >
      <section className="application-player-card">
        <h2>Player profile</h2>
        <strong className="application-player-name">
          {application.answers.ign}
        </strong>
        <p className="apply-muted">{application.minecraft.verification}</p>
        <dl className="application-player-stats">
          <div>
            <dt>Profile UUID</dt>
            <dd className="application-player-uuid">
              {application.minecraft.uuid || "Not resolved"}
            </dd>
          </div>
        </dl>
      </section>
      <section className="application-player-card">
        <h2>Drakora activity</h2>
        <p className="apply-muted">
          Player statistics will appear here once the network is connected.
          These placeholders are not recorded activity.
        </p>
        <PendingStats
          labels={[
            "Total network playtime",
            "First joined Drakora",
            "Last in-game login",
            "Playtime in the last 30 days",
            "Days active in the last 30 days",
          ]}
        />
      </section>
      <section className="application-player-card">
        <h2>Playtime per server</h2>
        <h3>Prominence II</h3>
        <PendingStats labels={["Luna", "Terra", "Sol"]} />
        <h3>Restless Horizons</h3>
        <PendingStats labels={["Eclipse", "Void"]} />
        <h3>Hubs</h3>
        <PendingStats labels={["Hub servers"]} />
      </section>
      <section className="application-player-card">
        <h2>Proxy activity</h2>
        <PendingStats labels={["EU proxy sessions", "NA proxy sessions"]} />
      </section>
      <section className="application-player-card">
        <h2>Support &amp; moderation</h2>
        <p className="apply-muted">
          Waiting for ticket and moderation history integrations.
        </p>
        <PendingStats
          labels={[
            "Tickets opened",
            "Reports submitted",
            "Warnings",
            "Mutes",
            "Bans",
            "Active punishments",
          ]}
        />
      </section>
    </aside>
  );
}
