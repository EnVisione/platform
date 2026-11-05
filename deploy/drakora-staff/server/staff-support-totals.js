import { effectiveRating, validRating } from "./ticket-rating.js";

const forever = Number.MAX_SAFE_INTEGER;
const empty = (at) => ({
  ticketsClaimed: 0,
  ticketsResolved: 0,
  ratingCount: 0,
  ratingTotal: 0,
  ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  recordedSince: at,
  coverage: "retained-history-and-future-events",
});

export function staffSupportTotals(store, { now = Date.now } = {}) {
  function observe(ticket, event) {
    if (ticket.erasingAt) return;
    const counted = ticket.supportTotals ?? {
      claims: [],
      resolutions: [],
      ratings: [],
    };
    const add = (id, kind, key, rating, at) => {
      if (!id) return;
      const existing = store.get("staff-support-totals", id);
      if (counted[kind].includes(key)) {
        if (
          existing &&
          Number.isFinite(at) &&
          at > (existing.lastStaffActionAt ?? 0)
        )
          store.set(
            "staff-support-totals",
            id,
            { ...existing, lastStaffActionAt: at },
            forever,
          );
        return;
      }
      const totals = existing ?? empty(now());
      if (Number.isFinite(at))
        totals.lastStaffActionAt = Math.max(totals.lastStaffActionAt ?? 0, at);
      if (kind === "claims") totals.ticketsClaimed++;
      else if (kind === "resolutions") totals.ticketsResolved++;
      else if (validRating(rating)) {
        totals.ratingCount++;
        totals.ratingTotal += rating;
        totals.ratingDistribution[rating]++;
      }
      counted[kind].push(key);
      store.set("staff-support-totals", id, totals, forever);
    };
    const history = store
      .entries(`ticket-history:${ticket.id}`)
      .map(([, value]) => value);
    if (event) history.push(event);
    for (const item of history)
      if (["claimed", "taken_over"].includes(item.action))
        add(item.actor?.id, "claims", item.actor?.id, undefined, item.at);
    const closures = store
      .entries(`ticket-closures:${ticket.id}`)
      .map(([key, value]) => ({ ...value, key }));
    closures.push({
      key: ticket.closureId ?? String(ticket.closedAt),
      resolution: ticket.resolution,
      closedBy: ticket.closedBy,
      closedAt: ticket.closedAt,
      rating: ticket.rating,
      ratingOverride: ticket.ratingOverride,
      claimedBy: ticket.ratingStaff ?? ticket.claimedBy ?? ticket.helpedBy,
    });
    for (const closure of closures) {
      const resolver = closure.closedBy || closure.resolution?.actor;
      if (resolver?.id)
        add(
          resolver.id,
          "resolutions",
          resolver.id,
          undefined,
          closure.closedBy
            ? (closure.closedAt ?? closure.at)
            : closure.resolution?.at,
        );
      if (validRating(closure.rating)) {
        const id = closure.claimedBy?.id;
        add(id, "ratings", `${closure.key}:${id}`, effectiveRating(closure));
      }
    }
    ticket.supportTotals = counted;
  }
  store.transaction(() => {
    for (const [id, ticket] of store.entries("ticket")) {
      observe(ticket);
      store.set("ticket", id, ticket, forever);
    }
  });
  function adjustRating(staffId, previous, next) {
    if (!staffId || previous === next) return;
    const totals = store.get("staff-support-totals", staffId) ?? empty(now());
    if (validRating(previous)) {
      if (totals.ratingCount < 1 || totals.ratingDistribution[previous] < 1)
        throw new Error("Recorded rating totals are inconsistent");
      totals.ratingCount--;
      totals.ratingTotal -= previous;
      totals.ratingDistribution[previous]--;
    }
    if (validRating(next)) {
      totals.ratingCount++;
      totals.ratingTotal += next;
      totals.ratingDistribution[next]++;
    }
    store.set("staff-support-totals", staffId, totals, forever);
  }
  return { observe, adjustRating };
}
