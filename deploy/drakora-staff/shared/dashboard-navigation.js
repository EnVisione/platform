export function dashboardDestination(href, origin) {
  if (typeof href !== "string") return null;
  let url;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (
    ![
      "/",
      "/tracker",
      "/calendar",
      "/accounts",
      "/email",
      "/roles",
      "/settings",
      "/applications",
      "/applications/editor",
    ].includes(url.pathname) &&
    !/^\/applications\/[a-f0-9-]{36}$/.test(url.pathname)
  )
    return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
