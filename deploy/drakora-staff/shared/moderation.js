export const moderationScopes = [
  "network",
  "rh",
  "prom2",
  "eclipse",
  "void",
  "luna",
  "terra",
  "sol",
  "hub",
];
export const moderationActions = [
  "warn",
  "mute",
  "ban",
  "freeze",
  "ban-ip",
  "kick",
];
export const moderationLabels = {
  warn: "Warning",
  mute: "Mute",
  ban: "Ban",
  freeze: "Freeze",
  "ban-ip": "IP ban",
  kick: "Kick",
};
export const networkEndpoints = [
  { id: "proxy-eu", name: "EU proxy", group: "Network", kind: "proxy" },
  { id: "proxy-na", name: "NA proxy", group: "Network", kind: "proxy" },
  {
    id: "eclipse",
    name: "Eclipse",
    group: "Restless Horizons",
    kind: "server",
  },
  { id: "void", name: "Void", group: "Restless Horizons", kind: "server" },
  { id: "luna", name: "Luna", group: "Prominence II", kind: "server" },
  { id: "terra", name: "Terra", group: "Prominence II", kind: "server" },
  { id: "sol", name: "Sol", group: "Prominence II", kind: "server" },
  { id: "hub", name: "Hub", group: "Network", kind: "server" },
];

export function durationMillis(value) {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const text = value.trim().toLowerCase();
  if (text === "perma") return null;
  if (!/^(?:[1-9]\d*[smhdw])+$/.test(text)) return undefined;
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const seen = new Set();
  let total = 0;
  for (const match of text.matchAll(/(\d+)([smhdw])/g)) {
    if (seen.has(match[2])) return undefined;
    seen.add(match[2]);
    total += Number(match[1]) * units[match[2]];
  }
  return Number.isSafeInteger(total) && total > 0 && total <= 315576000000
    ? total
    : undefined;
}

export function moderationCapability(action) {
  return `moderation.${action === "ban-ip" ? "ipban" : action}`;
}

export function moderationInputTarget(value, action) {
  const input = typeof value === "string" ? value.trim() : "";
  if (action === "ban-ip" && (input.includes(".") || input.includes(":")))
    return { ip: input };
  if (
    /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(
      input,
    )
  )
    return { uuid: input };
  return { name: input };
}
