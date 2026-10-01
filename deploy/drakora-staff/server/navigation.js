export function isPageRequest(req) {
  if (req.method !== "GET" || req.headers.upgrade || req.path.startsWith("/_"))
    return false;
  const mode = req.headers["sec-fetch-mode"];
  if (mode) return mode === "navigate";
  return (
    req.path === "/" || String(req.headers.accept ?? "").includes("text/html")
  );
}
