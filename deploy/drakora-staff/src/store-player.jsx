import React, { useEffect, useState } from "react";
import { PublicIcon } from "./public-icons.jsx";

export const validUsername = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_]{3,16}$/.test(value);

function PlayerFace() {
  return (
    <svg
      className="store-player"
      viewBox="0 0 8 8"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <path fill="#49382b" d="M0 0h8v8H0z" />
      <path fill="#bb906b" d="M0 3h8v4H0zM2 7h4v1H2z" />
      <path fill="#e1d4bd" d="M1 4h2v1H1zM5 4h2v1H5z" />
      <path fill="#52615b" d="M2 4h1v1H2zM5 4h1v1H5z" />
      <path fill="#76553c" d="M3 5h2v1H3zM2 6h4v1H2z" />
    </svg>
  );
}

function PlayerSkin({ profile, preview, body = false }) {
  const [failed, setFailed] = useState(false);
  const identifier = profile?.uuid ?? "MHF_Steve";
  return (
    <>
      {failed ? (
        <span
          className="store-player store-player-placeholder"
          aria-hidden="true"
        >
          <PublicIcon name="users" />
        </span>
      ) : (
        <img
          className="store-player"
          src={`https://drakora.org/apply/api/head/${identifier}${body ? "?render=body" : ""}`}
          alt={
            profile
              ? `Minecraft skin for ${profile.name}`
              : "Default Minecraft skin"
          }
          width={body ? "100" : "76"}
          height={body ? "240" : "76"}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
      {preview && (
        <div className="store-player-preview-status" role="status">
          <strong>{profile.name}</strong>
          <span>
            {failed
              ? "The skin could not load. Check the player name."
              : "Check that this is the right player."}
          </span>
        </div>
      )}
    </>
  );
}

export function StorePlayer({ username = "", preview = false, body = false }) {
  const name = username.trim().toLowerCase();
  const valid = validUsername(name);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    let disposed = false;
    let timeout;
    const debounce = setTimeout(async () => {
      timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(
          `/store/api/minecraft/${encodeURIComponent(name)}`,
          {
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error();
        const profile = await response.json();
        if (
          typeof profile.found !== "boolean" ||
          (profile.found &&
            (!validUsername(profile.name) ||
              !/^[a-f0-9]{32}$/i.test(profile.uuid)))
        )
          throw new Error();
        if (!disposed) setResult({ name, profile });
      } catch {
        if (!disposed) setResult({ name, error: true });
      } finally {
        clearTimeout(timeout);
      }
    }, 350);
    return () => {
      disposed = true;
      clearTimeout(debounce);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [name, valid]);
  const current = valid && result?.name === name ? result : null;
  return (
    <div
      className={`store-player-preview${preview ? " editing" : ""}${body ? " full-body" : ""}`}
      aria-busy={valid && !current}
    >
      {current?.profile?.found ? (
        <PlayerSkin
          key={current.profile.uuid}
          profile={current.profile}
          preview={preview}
          body={body}
        />
      ) : (
        <>
          {name ? (
            <span
              className="store-player store-player-placeholder"
              aria-hidden="true"
            >
              <PublicIcon name="users" />
            </span>
          ) : body ? (
            <PlayerSkin body />
          ) : (
            <PlayerFace />
          )}
          {preview && (
            <p className="store-player-preview-status" role="status">
              {!name
                ? "Enter a username to preview the skin."
                : !valid
                  ? "Use 3–16 letters, numbers or underscores."
                  : !current
                    ? "Looking up player…"
                    : current.error
                      ? "The player preview is unavailable. You can still continue."
                      : "Could not find this player. Check the name or try again."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
