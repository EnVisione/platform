import React, { useEffect, useState } from "react";
import logo from "./assets/drakora-logo.png";
import "./minecraft-link.css";

const explanations = {
  link_storage_required:
    "Allow tab storage to keep this request through sign-in, or sign in to the staff dashboard first and reopen the link from Minecraft.",
  link_expired:
    "This link has expired. Run /link or /stafflink in Minecraft to start again.",
  minecraft_ownership_conflict:
    "This Minecraft account or Discord account is already linked to another account. Contact support; it cannot be reassigned here.",
  link_already_approved:
    "Another Discord account already approved this request. Do not confirm it in Minecraft. Wait for this request to expire or contact support.",
  staff_admission_required:
    "Staff linking requires membership in the staff Discord and completed screening.",
  staff_server_required:
    "Join the staff Discord before verifying your staff profile.",
  discord_unavailable:
    "Discord is temporarily unavailable. Your account has not been reassigned.",
};
async function request(path, options) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false)
    throw new Error(data.error || "link_unavailable");
  return data;
}
export function MinecraftLink() {
  const [challenge] = useState(() => {
    const value = new URLSearchParams(location.hash.slice(1)).get("challenge");
    let saved = value;
    if (!saved)
      try {
        saved = sessionStorage.getItem("drakora-minecraft-challenge");
      } catch {
        saved = "";
      }
    if (saved && /^[A-Za-z0-9_-]{43}$/.test(saved)) {
      return saved;
    }
    return "";
  });
  const [session, setSession] = useState(null),
    [preview, setPreview] = useState(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    if (!challenge) {
      setError("link_expired");
      return;
    }
    request("/api/minecraft/link/preview", {
      method: "POST",
      signal: abort.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge }),
    })
      .then(async (value) => {
        if (value.continueUrl) {
          location.replace(value.continueUrl);
          return;
        }
        const identity = await request("/api/minecraft/link/session", {
          signal: abort.signal,
        });
        setSession(identity);
        setPreview(value);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, [challenge]);
  async function signIn() {
    setBusy(true);
    setError("");
    try {
      if (preview.kind === "staff") {
        try {
          sessionStorage.setItem("drakora-minecraft-challenge", challenge);
        } catch {
          throw new Error("link_storage_required");
        }
        location.assign("/auth/discord?next=%2Fminecraft%2Flink");
        return;
      }
      const value = await request("/store/api/wallet/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
        },
        body: JSON.stringify({
          username: preview.player.name,
          returnTo: `/minecraft/link#challenge=${challenge}`,
        }),
      });
      location.assign(value.url);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  async function approve() {
    if (!consent || busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await request("/api/minecraft/link/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
        },
        body: JSON.stringify({ challenge }),
      });
      setPreview(value);
      if (preview.kind === "staff")
        sessionStorage.removeItem("drakora-minecraft-challenge");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const staff = preview?.kind === "staff";
  return (
    <main className="minecraft-link-page">
      <section
        className="minecraft-link-card"
        aria-labelledby="minecraft-link-title"
      >
        <img src={logo} alt="Drakora" />
        <h1 id="minecraft-link-title">
          {staff ? "Verify your staff profile" : "Link Minecraft and Discord"}
        </h1>
        {error && (
          <p className="minecraft-link-error" role="alert">
            {explanations[error] ||
              "Linking is unavailable. Please try again or start a new request in Minecraft."}
          </p>
        )}
        {!preview && !error && (
          <p role="status">Loading your linking request…</p>
        )}
        {preview && (
          <>
            <p>
              Confirm that this is your Minecraft account and the Discord
              account you want to link.
            </p>
            <dl>
              <dt>Minecraft</dt>
              <dd>
                {preview.player.name}
                <small>{preview.player.uuid}</small>
              </dd>
              <dt>Discord</dt>
              <dd>
                {preview.discord?.name ||
                  session?.identity?.name ||
                  "Sign in to Discord"}
                {(preview.discord || session?.identity) && (
                  <small>{(preview.discord || session.identity).id}</small>
                )}
              </dd>
            </dl>
            {preview.state === "approved" ? (
              <div className="minecraft-link-confirm" role="status">
                <h2>Finish in Minecraft</h2>
                <p>
                  Return to the game and run{" "}
                  {staff ? "/stafflink status" : "/link status"}. Check the
                  Discord name and ID shown there, then confirm using the
                  one-use code.
                </p>
                <p>
                  Your accounts are linked only after that final confirmation.
                </p>
              </div>
            ) : session?.identity ? (
              <>
                <label className="minecraft-link-consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    disabled={busy}
                  />
                  {staff
                    ? "I consent to verifying my staff profile and synchronizing configured staff ranks."
                    : "I consent to linking these accounts and synchronizing my cosmetic ranks."}
                </label>
                <button
                  type="button"
                  disabled={!consent || busy}
                  onClick={approve}
                >
                  {busy ? "Approving…" : "Approve and continue in Minecraft"}
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={signIn}>
                Sign in with Discord
              </button>
            )}
            <p className="minecraft-link-help">
              {staff
                ? "Staff verification uses your existing staff access. It does not grant Dashboard or ticket access."
                : "Member linking adds the Linked badge and keeps cosmetic ranks in sync. It does not grant staff access."}
            </p>
          </>
        )}
      </section>
    </main>
  );
}
