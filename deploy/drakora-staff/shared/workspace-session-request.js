export function workspaceSessionRequests({
  fetcher = fetch,
  timeout = 15000,
} = {}) {
  const pending = new Map();

  async function start(view, { origin, csrf }) {
    pending.get(view)?.abort();
    const controller = new AbortController();
    pending.set(view, controller);
    const deadline = setTimeout(
      () => controller.abort(new Error("workspace_timeout")),
      timeout,
    );
    try {
      const response = await fetcher("/api/workspace-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ view }),
        signal: controller.signal,
      });
      const result = await response.json();
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error(result.error ?? "service_unavailable");
      const url = new URL(result.url);
      if (url.origin !== origin || url.pathname !== "/__staff/attach")
        throw new Error("service_unavailable");
      return url.href;
    } catch (error) {
      if (pending.get(view) !== controller) return;
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(deadline);
      if (pending.get(view) === controller) pending.delete(view);
    }
  }

  function cancelAll() {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  }

  return { start, cancelAll };
}
