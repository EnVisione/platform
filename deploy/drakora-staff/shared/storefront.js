export const storeRanks = [
  { id: "king", name: "King" },
  { id: "duke", name: "Duke" },
  { id: "earl", name: "Earl" },
  { id: "captain", name: "Captain" },
  { id: "knight", name: "Knight" },
  { id: "sergeant", name: "Sergeant" },
  { id: "squires", name: "Squires" },
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
      storeRanks.some(({ id }) => id === selection.rank) &&
      storeScopes.some(({ id }) => id === selection.scope) &&
      storeBilling.some(({ id }) => id === selection.billing),
  );
}

export function storeProductKey({ rank, scope, billing }) {
  return `${scope}:${rank}:${billing}`;
}

export function emptyStoreCatalog() {
  return storeScopes.flatMap(({ id: scope }) =>
    storeRanks.flatMap(({ id: rank, name }) =>
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
