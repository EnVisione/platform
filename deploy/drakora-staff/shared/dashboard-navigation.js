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
      "/website",
      "/settings",
      "/tickets",
      "/logs",
      "/moderation",
      "/applications",
      "/applications/editor",
    ].includes(url.pathname) &&
    !/^\/(applications|tickets|moderation)\/[a-f0-9-]{36}$/.test(url.pathname)
  )
    return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
