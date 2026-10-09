export const storeRanks = [
  { id: "archwyrm", name: "ArchWyrm", coverage: "network" },
  { id: "archdrake", name: "ArchDrake", coverage: "network" },
  { id: "archwyvern", name: "ArchWyvern", coverage: "network" },
  { id: "archdragon", name: "ArchDragon", coverage: "network" },
  { id: "wyrm", name: "Wyrm", coverage: "modpack" },
  { id: "drake", name: "Drake", coverage: "modpack" },
  { id: "wyvern", name: "Wyvern", coverage: "modpack" },
  { id: "dragon", name: "Dragon", coverage: "modpack" },
];

export const storeScopes = [
  {
    id: "network",
    name: "Whole network",
    description: "Prominence II and Restless Horizons",
  },
  {
    id: "prom2",
    name: "Prominence II",
    description: "All Drakora worlds running this modpack",
  },
  {
    id: "restless-horizons",
    name: "Restless Horizons",
    description: "All Drakora worlds running this modpack",
  },
];

export const storeCommands = [
  {
    id: "hat",
    name: "Hat",
    invocation: "/hat",
    description: "Wear an item as a hat.",
  },
  {
    id: "nick",
    name: "Nickname",
    invocation: "/nick",
    description: "Give yourself a custom display name.",
  },
  {
    id: "particles",
    name: "Particles",
    invocation: "/particles",
    description: "Add a little flair with cosmetic particle effects.",
  },
  {
    id: "emote",
    name: "Emotes",
    invocation: "/emote",
    description: "Express yourself with playful character emotes.",
  },
  {
    id: "sit",
    name: "Sit",
    invocation: "/sit",
    description: "Take a seat and relax with friends.",
  },
];

export const storeBilling = [
  {
    id: "monthly",
    name: "Monthly",
    description: "Recurring payment every month",
  },
  {
    id: "lifetime",
    name: "Lifetime",
    description: "One payment, no monthly renewal",
  },
];

export function storePageFor(pathname, search = "", storefrontHost = false) {
  const path = pathname.replace(/\/$/, "") || "/";
  const storePath =
    path === "/store" ? "/" : path.startsWith("/store/") ? path.slice(6) : path;
  if (storePath === "/")
    return path === "/store" || storefrontHost ? "home" : null;
  if (storePath === "/network-ranks") return "network";
  if (storePath === "/server-ranks") return "server";
  if (storePath === "/commands") return "commands";
  if (storePath === "/gift-cards") return "gift-cards";
  if (storePath === "/thank-you" && path.startsWith("/store/"))
    return "thank-you";
  if (storePath === "/compare") {
    const scope = new URLSearchParams(search).get("scope");
    return scope === "server" ||
      storeScopes.some(({ id }) => id !== "network" && id === scope)
      ? "server"
      : "network";
  }
  return null;
}

export function storePageHref(page, storefrontHost = false) {
  const path = {
    home: "",
    network: "/network-ranks",
    server: "/server-ranks",
    commands: "/commands",
  }[page];
  if (typeof path !== "string") return null;
  return `${storefrontHost ? "" : "/store"}${path}` || "/";
}

export function validStoreSelection(selection) {
  return Boolean(
    selection &&
    selection.title === undefined &&
    ((selection.command === undefined &&
      storeRanksForScope(selection.scope).some(
        ({ id }) => id === selection.rank,
      )) ||
      (selection.rank === undefined &&
        storeCommands.some(({ id }) => id === selection.command))) &&
    storeScopes.some(({ id }) => id === selection.scope) &&
    storeBilling.some(({ id }) => id === selection.billing),
  );
}

export function storeRanksForScope(scope) {
  if (!storeScopes.some(({ id }) => id === scope)) return [];
  const coverage = scope === "network" ? "network" : "modpack";
  return storeRanks.filter((rank) => rank.coverage === coverage);
}

export function storeProductKey({ rank, command, scope, billing }) {
  return `${scope}:${command ? `command-${command}` : rank}:${billing}`;
}

export function emptyStoreCatalog() {
  return storeScopes.flatMap(({ id: scope }) =>
    storeRanksForScope(scope).flatMap(({ id: rank, name }) =>
      storeBilling.map(({ id: billing }) => ({
        rank,
        name,
        scope,
        billing,
        available: false,
        price: null,
        currency: null,
      })),
    ),
  );
}

export function emptyCommandCatalog() {
  return storeScopes.flatMap(({ id: scope }) =>
    storeCommands.flatMap(({ id: command, name, invocation, description }) =>
      storeBilling.map(({ id: billing }) => ({
        command,
        name,
        invocation,
        description,
        scope,
        billing,
        available: false,
        price: null,
        currency: null,
      })),
    ),
  );
}
