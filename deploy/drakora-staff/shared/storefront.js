export const storeRanks = [
  {
    id: "emperor",
    name: "Emperor / Empress",
    coverage: "network",
    titles: ["Emperor", "Empress"],
  },
  {
    id: "king",
    name: "King / Queen",
    coverage: "network",
    titles: ["King", "Queen"],
  },
  { id: "archduke", name: "Archduke", coverage: "network" },
  { id: "prince", name: "Prince", coverage: "network" },
  { id: "marquess", name: "Marquess", coverage: "modpack" },
  { id: "earl", name: "Earl", coverage: "modpack" },
  { id: "viscount", name: "Viscount", coverage: "modpack" },
  { id: "baron", name: "Baron", coverage: "modpack" },
  { id: "knight", name: "Knight", coverage: "modpack" },
  { id: "lord", name: "Lord", coverage: "modpack" },
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

export function validStoreSelection(selection) {
  return Boolean(
    selection &&
      ((selection.command === undefined &&
        storeRanksForScope(selection.scope).some(
          ({ id, titles }) =>
            id === selection.rank &&
            (selection.title === undefined ||
              titles?.includes(selection.title)),
        )) ||
        (selection.rank === undefined &&
          selection.title === undefined &&
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
