import { goalProgress } from "../shared/store-goal.js";

export function storeGoalSnapshot(store) {
  let raisedCents = 0;
  for (const [, receipt] of store.entries("supporter-receipt")) {
    if (!receipt.active || receipt.refunded || receipt.disputed) continue;
    if (!Number.isSafeInteger(receipt.coins) || receipt.coins < 0)
      throw new Error("Store goal receipt total unavailable");
    raisedCents += receipt.coins;
  }
  return goalProgress(raisedCents);
}
