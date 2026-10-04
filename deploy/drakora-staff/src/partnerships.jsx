import { LegalNotice } from "./legal-notice.jsx";
import React, { useEffect, useRef, useState } from "react";
import { PublicIcon, PublicHeading } from "./public-icons.jsx";

const errors = {
  partnership_owner_required:
    "Only the modpack owner or a member of its development team can submit a request.",
  partnership_discord_required:
    "Connect your Discord account and confirm that the Drakora bot can message you.",
  partnership_limit:
    "You already have an open partnership request. Reply to its email or bot message to continue.",
  invalid_ticket_email: "Enter a valid email address.",
  invalid_pack_link: "Enter a full HTTPS link to your modpack.",
  invalid_ticket:
    "Check your details and describe your modpack in at least 50 characters.",
  invalid_request: "Refresh the page and try again.",
};
async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      errors[data.error] ||
        "We couldn’t submit your request. Please try again.",
    );
  return data;
}
export function PartnershipForm() {
  const [session, setSession] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(null);
  const [form, setForm] = useState({
    relationship: "",
    name: "",
    discord: "",
    email: "",
    packUrl: "",
    description: "",
    preference: "email",
    allowDm: false,
  });
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    const controller = new AbortController();
    request("/help/api/session", { signal: controller.signal })
      .then(setSession)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, []);
  const change = (key, value) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const data = await request("/help/api/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
        },
        body: JSON.stringify({ returnPath: "/partners" }),
      });
      sessionStorage.setItem("drakora.partnership.draft", JSON.stringify(form));
      location.assign(data.url);
    } catch (error) {
      setError(error.message);
      setBusy(false);
    }
  }
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("drakora.partnership.draft");
      if (saved) {
        setForm({ ...form, ...JSON.parse(saved) });
        sessionStorage.removeItem("drakora.partnership.draft");
      }
    } catch {}
  }, []);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResult(
        await request("/partners/api/requests", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrf,
          },
          body: JSON.stringify({ ...form, requestId: requestId.current }),
        }),
      );
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const eligible = ["owner", "developer"].includes(form.relationship);
  const linked = session?.identity && !session.identity.guest;
  return (
    <div className="public-partner-page">
      <div className="public-page-title">
        <span className="public-eyebrow">BUILD SOMETHING TOGETHER</span>
        <PublicHeading as="h1" icon="servers">
          Bring your modpack to Drakora
        </PublicHeading>
        <p>
          Tell us about your pack and the community you want to build. Our
          partnerships team will review your request for a server on the
          network.
        </p>
      </div>
      {result ? (
        <section className="public-panel" role="status">
          <PublicHeading icon="check">
            Your request is with our team
          </PublicHeading>
          <p>
            We’ll contact you through{" "}
            {result.preference === "discord"
              ? "the Drakora bot on Discord"
              : "email"}
            . Reply there to keep the conversation going.
          </p>
          <p>
            Reference: <strong>{result.reference}</strong>
          </p>
          <a href="/servers" className="public-button beige">
            Explore our servers <PublicIcon name="arrow" />
          </a>
        </section>
      ) : (
        <form className="public-panel public-partner-form" onSubmit={submit}>
          <LegalNotice application />
          {error && (
            <p className="ticket-error" role="alert">
              {error}
            </p>
          )}
          <label>
            Are you the modpack owner or part of its development team?
            <select
              required
              value={form.relationship}
              onChange={(event) => change("relationship", event.target.value)}
            >
              <option value="">Choose your relationship</option>
              <option value="owner">Yes, I own the modpack</option>
              <option value="developer">Yes, I develop the modpack</option>
              <option value="neither">No, I’m a player or fan</option>
            </select>
          </label>
          {form.relationship === "neither" && (
            <p role="status">
              Please ask the pack owner or a developer to contact us. Only the
              team behind a modpack can submit a partnership request.
            </p>
          )}
          <fieldset disabled={!eligible || busy}>
            <legend>Your modpack and contact details</legend>
            <div className="public-partner-fields">
              <label>
                Your name
                <input
                  required
                  minLength={2}
                  maxLength={80}
                  autoComplete="name"
                  value={form.name}
                  onChange={(event) => change("name", event.target.value)}
                />
              </label>
              <label>
                Discord username
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  value={form.discord}
                  onChange={(event) => change("discord", event.target.value)}
                />
              </label>
              <label>
                Email address
                <input
                  required
                  type="email"
                  maxLength={254}
                  autoComplete="email"
                  value={form.email}
                  onChange={(event) => change("email", event.target.value)}
                />
              </label>
              <label>
                Link to your modpack
                <input
                  required
                  type="url"
                  maxLength={1000}
                  placeholder="https://www.curseforge.com/minecraft/modpacks/your-pack"
                  value={form.packUrl}
                  onChange={(event) => change("packUrl", event.target.value)}
                />
              </label>
            </div>
            <label>
              Tell us about your pack
              <textarea
                required
                minLength={50}
                maxLength={4000}
                rows={6}
                value={form.description}
                onChange={(event) => change("description", event.target.value)}
                placeholder="What makes your modpack special? Tell us about its release status, Minecraft version, community, server requirements and what you hope to build with Drakora."
              />
            </label>
            <label>
              How should we contact you?
              <select
                value={form.preference}
                onChange={(event) => change("preference", event.target.value)}
              >
                <option value="email">Email</option>
                <option value="discord">Discord bot direct messages</option>
              </select>
            </label>
            {form.preference === "discord" && (
              <div className="public-partner-contact">
                {linked ? (
                  <p>
                    Connected as <strong>{session.identity.name}</strong>.
                  </p>
                ) : (
                  <>
                    <p>
                      Connect the Discord account that should receive our
                      messages. You must be in the Drakora Discord.
                    </p>
                    <button
                      type="button"
                      className="public-button secondary"
                      disabled={!session}
                      onClick={connect}
                    >
                      <PublicIcon name="discord" /> Connect Discord
                    </button>
                  </>
                )}
                <label className="public-partner-check">
                  <input
                    type="checkbox"
                    required
                    checked={form.allowDm}
                    onChange={(event) =>
                      change("allowDm", event.target.checked)
                    }
                  />{" "}
                  I allow direct messages or message requests from members of
                  the Drakora server, including its bot.
                </label>
                <p>
                  If Discord blocks the bot’s messages, we’ll contact you by
                  email instead.
                </p>
              </div>
            )}
            <p className="public-partner-note">
              This is a private request for our partnerships team. It won’t open
              a public ticket page or a Discord ticket channel.
            </p>
            <button
              className="public-button beige"
              disabled={
                !session ||
                !eligible ||
                busy ||
                (form.preference === "discord" && (!linked || !form.allowDm))
              }
            >
              {busy ? "Submitting…" : "Submit partnership request"}{" "}
              <PublicIcon name="arrow" />
            </button>
          </fieldset>
        </form>
      )}
    </div>
  );
}
