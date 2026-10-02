import React, { useEffect, useRef, useState } from "react";
import "./workspace-tools.css";
import { accentForeground } from "../shared/accent.js";

export const dashboardTools = [
  {
    view: "tracker",
    title: "Tracker",
    icon: "✓",
    description: "Issues, components, milestones and templates",
  },
  {
    view: "calendar",
    title: "Calendar",
    icon: "▦",
    description: "Your schedule, events and action items",
  },
];

export function WorkspaceTools({ view, origin, accent, onNavigate }) {
  const frame = useRef(null);
  const initialView = useRef(view);
  const opened = useRef(false);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const title =
    dashboardTools.find((tool) => tool.view === view)?.title ?? "Workspace";
  useEffect(() => {
    const receive = (event) => {
      if (
        event.origin !== origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      if (
        event.data?.type === "drakora-dashboard-open" &&
        [
          "/",
          "/tracker",
          "/calendar",
          "/settings",
          "/accounts",
          "/applications",
          "/email",
          "/roles",
        ].includes(event.data.path)
      ) {
        location.assign(event.data.path);
        return;
      }
      if (event.data?.type !== "drakora-workspace-ready") return;
      const send = (data) =>
        frame.current.contentWindow.postMessage(data, origin);
      send({
        type: "drakora-workspace-theme",
        accent,
        foreground: accentForeground(accent),
      });
      if (!opened.current) {
        opened.current = true;
        if (event.data.view !== view) {
          send({ type: "drakora-workspace-open", view });
          return;
        }
      }
      setReady(true);
      setSlow(false);
      if (dashboardTools.some((tool) => tool.view === event.data.view))
        onNavigate(event.data.view);
    };
    window.addEventListener("message", receive);
    const timer = setTimeout(() => setSlow(true), 20000);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [origin, view, accent, onNavigate, attempt]);
  useEffect(() => {
    if (ready)
      frame.current?.contentWindow.postMessage(
        {
          type: "drakora-workspace-theme",
          accent,
          foreground: accentForeground(accent),
        },
        origin,
      );
  }, [accent, origin, ready]);
  function retry() {
    initialView.current = view;
    opened.current = false;
    setReady(false);
    setSlow(false);
    setAttempt((value) => value + 1);
  }
  return (
    <section className="workspace-tool" aria-label={`${title} workspace`}>
      {!ready && (
        <div className="workspace-tool-loading" role="status">
          <span className="workspace-tool-symbol" aria-hidden="true">
            {dashboardTools.find((tool) => tool.view === view)?.icon}
          </span>
          <h2>Opening {title}…</h2>
          <p>Your existing workspace and tools are loading.</p>
          {slow && (
            <>
              <p>
                Taking longer than expected. Retry, or open the workspace to
                finish signing in.
              </p>
              <div className="workspace-tool-actions">
                <button onClick={retry}>Retry</button>
                <a
                  className="button"
                  href={`${origin}/__staff/open/${view}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open workspace
                </a>
              </div>
            </>
          )}
        </div>
      )}
      <iframe
        key={attempt}
        ref={frame}
        title={`${title} workspace`}
        src={`${origin}/__staff/open/${initialView.current}`}
        className={ready ? "ready" : ""}
        allow="clipboard-write; microphone; camera; display-capture; fullscreen"
      />
    </section>
  );
}
