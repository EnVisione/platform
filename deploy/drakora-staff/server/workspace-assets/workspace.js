(() => {
  if (window.parent === window) return;
  const { staffOrigin, workspace, workspaceError } =
    document.currentScript.dataset;
  if (workspaceError) {
    window.parent.postMessage(
      { type: "drakora-workspace-error", code: workspaceError },
      staffOrigin,
    );
    return;
  }
  const base = `/workbench/${encodeURIComponent(workspace)}/`;
  const views = { tracker: "tracker", calendar: "time" };
  document.documentElement.setAttribute("data-drakora-embedded", "");
  let previous = "";
  let scheduled = false;
  let timeFormat;
  const calendarTime = (value) => {
    const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
    if (!match || !timeFormat) return value;
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    if (minute > 59 || hour > (match[3] ? 12 : 24)) return value;
    if (match[3])
      hour = (hour % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
    else hour %= 24;
    const minutes = String(minute).padStart(2, "0");
    return timeFormat === "24"
      ? `${String(hour).padStart(2, "0")}:${minutes}`
      : `${hour % 12 || 12}:${minutes} ${hour < 12 ? "AM" : "PM"}`;
  };
  const formatCalendar = () => {
    if (!timeFormat) return;
    for (const node of document.querySelectorAll(".time-cell")) {
      if (node.childElementCount) continue;
      for (const child of node.childNodes) {
        if (child.nodeType !== 3) continue;
        const text = calendarTime(child.data);
        if (text !== child.data) child.data = text;
      }
    }
    for (const node of document.querySelectorAll(".now-line[data-now]")) {
      const value = node.getAttribute("data-now");
      const text = calendarTime(value);
      if (text !== value) node.setAttribute("data-now", text);
    }
  };
  const report = () => {
    scheduled = false;
    if (location.pathname.startsWith("/login")) {
      window.parent.postMessage(
        { type: "drakora-workspace-error", code: "login_required" },
        staffOrigin,
      );
      return;
    }
    const ready =
      location.pathname.startsWith(base) &&
      Boolean(document.querySelector(".workbench-container"));
    if (!ready) return;
    formatCalendar();
    const alias = location.pathname.slice(base.length).split("/")[0];
    const view = Object.keys(views).find((key) => views[key] === alias) ?? null;
    const path = location.pathname;
    if (path === previous) return;
    previous = path;
    window.parent.postMessage(
      { type: "drakora-workspace-ready", view, path },
      staffOrigin,
    );
  };
  window.addEventListener("message", (event) => {
    if (event.origin !== staffOrigin || event.source !== window.parent) return;
    if (
      event.data?.type === "drakora-workspace-time" &&
      ["12", "24"].includes(event.data.format)
    ) {
      timeFormat = event.data.format;
      formatCalendar();
    }
    if (
      event.data?.type === "drakora-workspace-open" &&
      Object.hasOwn(views, event.data.view)
    ) {
      const target = `${base}${views[event.data.view]}`;
      if (
        !location.pathname.startsWith(`${target}/`) &&
        location.pathname !== target
      )
        location.replace(target);
    }
    if (
      event.data?.type === "drakora-workspace-theme" &&
      /^#[0-9a-f]{6}$/i.test(event.data.accent)
    ) {
      document.documentElement.style.setProperty(
        "--staff-accent",
        event.data.accent,
      );
      if (["#16171C", "#FFFFFF"].includes(event.data.foreground))
        document.documentElement.style.setProperty(
          "--staff-accent-text",
          event.data.foreground,
        );
    }
  });
  document.addEventListener("click", (event) => {
    const anchor = event.target.closest?.("a[href]");
    if (
      !anchor ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      anchor.target === "_blank"
    )
      return;
    const target = new URL(anchor.href, location.href);
    if (target.origin !== staffOrigin) return;
    if (
      ![
        "/",
        "/tracker",
        "/calendar",
        "/settings",
        "/accounts",
        "/applications",
        "/email",
        "/roles",
      ].includes(target.pathname)
    )
      return;
    event.preventDefault();
    window.parent.postMessage(
      { type: "drakora-dashboard-open", path: target.pathname },
      staffOrigin,
    );
  });
  const observer = new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(report);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-now"],
    subtree: true,
  });
  window.addEventListener("popstate", report);
  window.addEventListener("pagehide", () => observer.disconnect(), {
    once: true,
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    previous = "";
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-now"],
      subtree: true,
    });
    report();
  });
  report();
})();
