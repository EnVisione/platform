(() => {
  if (window.parent === window) return;
  const { staffOrigin, workspace } = document.currentScript.dataset;
  const base = `/workbench/${encodeURIComponent(workspace)}/`;
  const views = { tracker: "tracker", calendar: "time", office: "love" };
  document.documentElement.classList.add("drakora-embedded");
  let previous = "";
  let scheduled = false;
  const report = () => {
    scheduled = false;
    const ready =
      location.pathname.startsWith(base) &&
      Boolean(document.querySelector(".workbench-container"));
    if (!ready) return;
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
        "/office",
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
      requestAnimationFrame(report);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
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
      subtree: true,
    });
    report();
  });
  report();
})();
