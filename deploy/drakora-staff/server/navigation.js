export function requestPath(req) {
  return (req.originalUrl ?? req.url ?? req.path ?? "/").split("?")[0];
}

export function isPageRequest(req) {
  const path = requestPath(req);
  if (req.method !== "GET" || req.headers.upgrade || path.startsWith("/_"))
    return false;
  const mode = req.headers["sec-fetch-mode"];
  if (mode) return mode === "navigate";
  return path === "/" || String(req.headers.accept ?? "").includes("text/html");
}
