import React, { useCallback, useEffect, useRef, useState } from "react";
import "./workspace-tools.css";
import { accentForeground } from "../shared/accent.js";
import { workspaceSessionRequests } from "../shared/workspace-session-request.js";

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

export function WorkspaceTools({
  view,
  origin,
  accent,
  timeFormat,
  csrf,
  onNavigate,
}) {
  const frames = useRef({});
  const activeView = useRef(view);
  activeView.current = view;
  const initialView = useRef(view ?? "tracker");
  const recovering = useRef({});
  const requests = useRef(null);
  requests.current ??= workspaceSessionRequests();
  const [urls, setUrls] = useState({});
  const [ready, setReady] = useState({});
  const [failures, setFailures] = useState({});
  const failure = failures[view];
  const [slow, setSlow] = useState({});
  const title =
    dashboardTools.find((tool) => tool.view === view)?.title ?? "Workspace";

  const start = useCallback(
    async (target) => {
      setFailures((current) => ({ ...current, [target]: undefined }));
      setSlow((current) => ({ ...current, [target]: false }));
      setReady((current) => ({ ...current, [target]: false }));
      try {
        const url = await requests.current.start(target, {
          origin,
          csrf,
        });
        if (url) setUrls((current) => ({ ...current, [target]: url }));
      } catch (error) {
        setFailures((current) => ({ ...current, [target]: error.message }));
      }
    },
    [csrf, origin],
  );

  useEffect(() => {
    void start(initialView.current);
    return () => requests.current.cancelAll();
  }, [start]);

  useEffect(() => {
    const receive = (event) => {
      if (event.origin !== origin) return;
      const tool = dashboardTools.find(
        (item) => frames.current[item.view]?.contentWindow === event.source,
      );
      if (!tool) return;
      if (event.data?.type === "drakora-workspace-error") {
        const code = event.data.code;
        if (
          ["login_required", "huly_account_mismatch"].includes(code) &&
          !recovering.current[tool.view]
        ) {
          recovering.current[tool.view] = true;
          void start(tool.view);
        } else
          setFailures((current) => ({
            ...current,
            [tool.view]:
              code === "login_required"
                ? "workspace_session_unavailable"
                : (code ?? "service_unavailable"),
          }));
        setReady((current) => ({ ...current, [tool.view]: false }));
        return;
      }
      if (event.data?.type === "drakora-dashboard-open") {
        if (activeView.current === tool.view) onNavigate(event.data.path);
        return;
      }
      if (event.data?.type !== "drakora-workspace-ready") return;
      setReady((current) => ({ ...current, [tool.view]: true }));
      setUrls((current) => {
        const next = { ...current };
        for (const item of dashboardTools)
          next[item.view] ??= `${origin}/__staff/open/${item.view}`;
        return next;
      });
      setFailures((current) => ({ ...current, [tool.view]: undefined }));
      recovering.current[tool.view] = false;
      setSlow((current) => ({ ...current, [tool.view]: false }));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [origin, start, onNavigate]);

  useEffect(() => {
    for (const tool of dashboardTools) {
      if (!ready[tool.view]) continue;
      const target = frames.current[tool.view]?.contentWindow;
      target?.postMessage(
        {
          type: "drakora-workspace-theme",
          accent,
          foreground: accentForeground(accent),
        },
        origin,
      );
      target?.postMessage(
        { type: "drakora-workspace-time", format: timeFormat },
        origin,
      );
    }
  }, [accent, timeFormat, origin, ready]);

  useEffect(() => {
    if (!view || ready[view]) return;
    const timer = setTimeout(
      () => setSlow((current) => ({ ...current, [view]: true })),
      20000,
    );
    return () => clearTimeout(timer);
  }, [view, ready[view], urls[view]]);

  return (
    <section
      className={`workspace-tool${view ? "" : " inactive"}`}
      aria-label={`${title} workspace`}
      aria-hidden={!view}
    >
      {view && (!ready[view] || failure) && (
        <div className="workspace-tool-loading" role="status">
          <span className="workspace-tool-symbol" aria-hidden="true">
            {dashboardTools.find((tool) => tool.view === view)?.icon}
          </span>
          <h2>
            {failure || slow[view]
              ? `${title} is unavailable`
              : `Opening ${title}…`}
          </h2>
          <p>
            {failure === "login_required"
              ? "Your dashboard session has expired. Sign in to continue."
              : failure === "staff_permission_required"
                ? "Your current staff permissions do not allow workspace access."
                : failure || slow[view]
                  ? "The workspace could not connect. You can retry here."
                  : "Your workspace is loading."}
          </p>
          {failure === "login_required" ? (
            <a className="button" href={`/login?next=/${view}`}>
              Sign in to dashboard
            </a>
          ) : (
            (failure || slow[view]) && (
              <button
                onClick={() => {
                  recovering.current[view] = false;
                  void start(view);
                }}
              >
                Retry
              </button>
            )
          )}
        </div>
      )}
      {dashboardTools
        .filter((tool) => urls[tool.view])
        .map((tool) => (
          <iframe
            key={tool.view}
            ref={(element) => {
              frames.current[tool.view] = element;
            }}
            title={`${tool.title} workspace`}
            src={urls[tool.view]}
            className={
              view === tool.view && ready[tool.view] && !failure ? "ready" : ""
            }
            aria-hidden={view !== tool.view}
            tabIndex={view === tool.view ? 0 : -1}
            allow="clipboard-write; microphone; camera; display-capture; fullscreen"
          />
        ))}
    </section>
  );
}
