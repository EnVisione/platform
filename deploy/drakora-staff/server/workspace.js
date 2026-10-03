import {
  createProxyMiddleware,
  responseInterceptor,
} from "http-proxy-middleware";
import { isPageRequest } from "./navigation.js";

export const workspaceViews = {
  tracker: "tracker",
  calendar: "time",
};

export function isWorkspacePage(req) {
  return (
    isPageRequest(req) &&
    /^\/(?:$|workbench(?:\/|$)|login(?:\/|$))/.test(req.path)
  );
}

export function workspacePath(config, view) {
  if (!Object.hasOwn(workspaceViews, view)) return null;
  return `/workbench/${encodeURIComponent(config.workspaceUrl)}/${workspaceViews[view]}`;
}

export function workspaceAllowed(user, view) {
  return Boolean(Object.hasOwn(workspaceViews, view) && user.permissions.todo);
}

const attribute = (value) =>
  String(value).replace(
    /[&"<>]/g,
    (character) =>
      ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[character],
  );

export function workspaceHtml(config, html) {
  const assets = `<link rel="stylesheet" href="/__staff/workspace.css"><script defer src="/__staff/workspace.js" data-staff-origin="${attribute(config.staffOrigin)}" data-workspace="${attribute(config.workspaceUrl)}"></script>`;
  return html.replace(/<\/head>/i, `${assets}</head>`);
}

export function workspaceFailureHtml(config, code) {
  return `<!doctype html><html><head><title>Workspace unavailable</title><script defer src="/__staff/workspace.js" data-staff-origin="${attribute(config.staffOrigin)}" data-workspace-error="${attribute(code)}"></script></head><body>Workspace unavailable. Retry from the staff dashboard.</body></html>`;
}

export function workspaceHtmlProxy(config, options) {
  return createProxyMiddleware({
    ...options,
    selfHandleResponse: true,
    on: {
      ...options.on,
      proxyReq(proxyReq, req, res) {
        options.on?.proxyReq?.(proxyReq, req, res);
        proxyReq.setHeader("accept-encoding", "identity");
      },
      proxyRes: responseInterceptor(async (buffer, proxyRes, req, res) => {
        if (
          proxyRes.statusCode !== 200 ||
          !String(proxyRes.headers["content-type"]).includes("text/html")
        )
          return buffer;
        const policy = String(proxyRes.headers["content-security-policy"] ?? "")
          .split(";")
          .filter(
            (directive) =>
              directive.trim() && !/^frame-ancestors\b/i.test(directive.trim()),
          );
        policy.push(`frame-ancestors 'self' ${config.staffOrigin}`);
        res.setHeader("Content-Security-Policy", policy.join("; "));
        res.removeHeader("X-Frame-Options");
        res.setHeader("Cache-Control", "no-store");
        return workspaceHtml(
          { ...config, workspaceUrl: req.workspaceUrl },
          buffer.toString("utf8"),
        );
      }),
    },
  });
}
