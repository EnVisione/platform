export const storeRanks = [
  {
    id: "archwyrm",
    name: "ArchWyrm",
    coverage: "network",
    billing: "lifetime",
    price: 17.99,
  },
  {
    id: "archdrake",
    name: "ArchDrake",
    coverage: "network",
    billing: "lifetime",
    price: 49.99,
  },
  {
    id: "archwyvern",
    name: "ArchWyvern",
    coverage: "network",
    billing: "lifetime",
    price: 99.99,
  },
  {
    id: "archdragon",
    name: "ArchDragon",
    coverage: "network",
    billing: "monthly",
    price: 5.99,
    requiresRank: "archwyvern",
  },
  {
    id: "wyrm",
    name: "Wyrm",
    coverage: "modpack",
    billing: "lifetime",
    price: 6.99,
  },
  {
    id: "drake",
    name: "Drake",
    coverage: "modpack",
    billing: "lifetime",
    price: 19.99,
  },
  {
    id: "wyvern",
    name: "Wyvern",
    coverage: "modpack",
    billing: "lifetime",
    price: 39.99,
  },
  {
    id: "dragon",
    name: "Dragon",
    coverage: "modpack",
    billing: "monthly",
    price: 10.99,
    requiresRank: "wyvern",
  },
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

export function storePageFor(pathname, search = "", storefrontHost = false) {
  const path = pathname.replace(/\/$/, "") || "/";
  const storePath =
    path === "/store" ? "/" : path.startsWith("/store/") ? path.slice(6) : path;
  if (storePath === "/")
    return path === "/store" || storefrontHost ? "home" : null;
  if (storePath === "/network-ranks") return "network";
  if (storePath === "/server-ranks") return "server";
  if (storePath === "/prefixes" || storePath === "/commands") return "prefixes";
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
    prefixes: "/prefixes",
  }[page];
  if (typeof path !== "string") return null;
  return `${storefrontHost ? "" : "/store"}${path}` || "/";
}

export function validStoreSelection(selection) {
  return Boolean(
    selection &&
    selection.title === undefined &&
    selection.command === undefined &&
    storeRanksForScope(selection.scope).some(
      ({ id, billing }) =>
        id === selection.rank && billing === selection.billing,
    ),
  );
}

export function storeRanksForScope(scope) {
  if (!storeScopes.some(({ id }) => id === scope)) return [];
  const coverage = scope === "network" ? "network" : "modpack";
  return storeRanks.filter((rank) => rank.coverage === coverage);
}

export function storeProductKey({ rank, scope, billing }) {
  return `${scope}:${rank}:${billing}`;
}

export function emptyStoreCatalog() {
  return storeScopes.flatMap(({ id: scope }) =>
    storeRanksForScope(scope).map(
      ({ id: rank, name, billing, price, requiresRank }) => ({
        rank,
        name,
        scope,
        billing,
        requiresRank,
        available: false,
        price,
        currency: "EUR",
      }),
    ),
  );
}
