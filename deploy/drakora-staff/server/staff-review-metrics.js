import { bridgeUuid } from "./minecraft-bridge.js";
import { effectiveRating, validRating } from "./ticket-rating.js";

const interval = (at, from, to) => Number.isFinite(at) && at > from && at <= to;
const average = (values) =>
  values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
const distribution = () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });

export function reviewProgress(store, tickets, id, from, to) {
  const claimed = new Set(),
    lifetimeClaimed = new Set(),
    resolved = new Set(),
    lifetimeResolved = new Set(),
    reopened = new Set();
  const ratingDistribution = distribution(),
    lifetimeRatingDistribution = distribution();
  const responseTimes = [],
    resolutionTimes = [];
  let replies = 0,
    activeTickets = 0,
    ratingCount = 0,
    ratingTotal = 0,
    lifetimeRatingCount = 0,
    lifetimeRatingTotal = 0,
    legacyRatingDates = 0;
  for (const [, ticket] of tickets?.store.entries("ticket") ?? []) {
    if (ticket.erasingAt) continue;
    if (
      ticket.claimedBy?.id === id &&
      ["pending", "claimed"].includes(ticket.status)
    )
      activeTickets++;
    const history = tickets.store
      .entries(`ticket-history:${ticket.id}`)
      .map(([, entry]) => entry);
    for (const entry of history) {
      if (
        ["claimed", "taken_over"].includes(entry.action) &&
        entry.actor?.id === id &&
        Number.isFinite(entry.at) &&
        entry.at <= to
      ) {
        lifetimeClaimed.add(ticket.id);
        if (interval(entry.at, from, to)) claimed.add(ticket.id);
      }
    }
    const closures = tickets.store
      .entries(`ticket-closures:${ticket.id}`)
      .map(([key, value]) => ({ ...value, key }));
    closures.push({
      key: ticket.closureId ?? String(ticket.closedAt),
      resolution: ticket.resolution,
      closedBy: ticket.closedBy,
      rating: ticket.rating,
      ratingOverride: ticket.ratingOverride,
      ratedAt: ticket.ratedAt,
      claimedBy: ticket.ratingStaff ?? ticket.claimedBy ?? ticket.helpedBy,
      closedAt: ticket.closedAt,
    });
    const seenClosures = new Set(),
      seenRatings = new Set();
    for (const closure of closures) {
      const resolvedAt = closure.closedBy
        ? (closure.closedAt ?? closure.at)
        : (closure.resolution?.at ?? closure.closedAt ?? closure.at);
      const key = closure.key;
      if (
        !seenClosures.has(key) &&
        (closure.closedBy || closure.resolution?.actor)?.id === id &&
        Number.isFinite(resolvedAt) &&
        resolvedAt <= to
      ) {
        seenClosures.add(key);
        lifetimeResolved.add(ticket.id);
        if (interval(resolvedAt, from, to)) {
          resolved.add(ticket.id);
          if (
            Number.isFinite(ticket.createdAt) &&
            resolvedAt >= ticket.createdAt
          )
            resolutionTimes.push(resolvedAt - ticket.createdAt);
          if (
            history.some(
              (entry) =>
                entry.action === "reopened" &&
                entry.at >= resolvedAt &&
                entry.at <= to,
            )
          )
            reopened.add(ticket.id);
        }
      }
      if (
        seenRatings.has(key) ||
        closure.claimedBy?.id !== id ||
        !validRating(effectiveRating(closure))
      )
        continue;
      seenRatings.add(key);
      const ratedAt = closure.ratingSubmittedAt ?? closure.ratedAt;
      if (Number.isFinite(ratedAt) && ratedAt > to) continue;
      lifetimeRatingCount++;
      lifetimeRatingTotal += effectiveRating(closure);
      lifetimeRatingDistribution[effectiveRating(closure)]++;
      if (!Number.isFinite(ratedAt)) {
        legacyRatingDates++;
        continue;
      }
      if (interval(ratedAt, from, to)) {
        ratingCount++;
        ratingTotal += effectiveRating(closure);
        ratingDistribution[effectiveRating(closure)]++;
      }
    }
    const messages = tickets.store
      .entries(`ticket-messages:${ticket.id}`)
      .map(([, entry]) => entry)
      .filter(
        (entry) =>
          !entry.internal &&
          !entry.deleted &&
          entry.actor?.id === id &&
          Number.isFinite(entry.at) &&
          entry.at <= to,
      )
      .sort((a, b) => a.at - b.at);
    replies += messages.filter((entry) => interval(entry.at, from, to)).length;
    if (
      messages[0] &&
      interval(messages[0].at, from, to) &&
      Number.isFinite(ticket.createdAt) &&
      messages[0].at >= ticket.createdAt
    )
      responseTimes.push(messages[0].at - ticket.createdAt);
  }
  const tasks = store
    .entries("discord-todo")
    .map(([, item]) => item)
    .filter((item) => !item.deleted && item.assigneeDiscordId === id);
  const durableTotals = tickets?.store.get("staff-support-totals", id);
  return {
    ticketsClaimed: claimed.size,
    ticketsResolved: resolved.size,
    replies,
    activeTickets,
    ratingCount,
    averageRating: ratingCount ? ratingTotal / ratingCount : null,
    ratingDistribution,
    lifetime: durableTotals
      ? {
          ...durableTotals,
          averageRating: durableTotals.ratingCount
            ? durableTotals.ratingTotal / durableTotals.ratingCount
            : null,
        }
      : {
          ticketsClaimed: lifetimeClaimed.size,
          ticketsResolved: lifetimeResolved.size,
          ratingCount: lifetimeRatingCount,
          averageRating: lifetimeRatingCount
            ? lifetimeRatingTotal / lifetimeRatingCount
            : null,
          ratingDistribution: lifetimeRatingDistribution,
        },
    responseTime: {
      averageMillis: average(responseTimes),
      samples: responseTimes.length,
    },
    resolutionTime: {
      averageMillis: average(resolutionTimes),
      samples: resolutionTimes.length,
    },
    reopenRate: {
      value: resolved.size ? reopened.size / resolved.size : null,
      reopened: reopened.size,
      resolved: resolved.size,
    },
    coverage: {
      tickets: tickets ? "retained-records" : "unavailable",
      feedbackMissingSubmittedAt: legacyRatingDates,
      from,
      to,
    },
    trackedTasks: tasks.map((item) => ({
      title: item.discord?.title ?? item.title,
      status: item.discord?.status ?? item.statusKey,
    })),
  };
}

export function playtimeCounter(store, link, at) {
  const uuid = bridgeUuid(link?.uuid);
  if (!uuid || link.status !== "verified") return null;
  const report = store.get("player-activity", uuid);
  if (
    !report ||
    !Number.isSafeInteger(report.reportedAt) ||
    report.reportedAt > at ||
    !Number.isSafeInteger(report.playtimeSeconds) ||
    report.playtimeSeconds < 0
  )
    return null;
  return {
    uuid,
    capturedAt: at,
    reportedAt: report.reportedAt,
    networkSeconds: report.playtimeSeconds,
    perServerSeconds: { ...report.perServerSeconds },
  };
}

export function reviewPlaytime(counter, baseline, from, to) {
  let reason = !counter
    ? "verified-report-unavailable"
    : !baseline
      ? "baseline-unavailable"
      : counter.uuid !== baseline.uuid
        ? "account-changed"
        : counter.networkSeconds < baseline.networkSeconds
          ? "counter-reset"
          : counter.reportedAt < baseline.reportedAt
            ? "report-out-of-order"
            : null;
  const perServerSeconds = {};
  const missingServers = [];
  if (!reason) {
    for (const [server, value] of Object.entries(counter.perServerSeconds)) {
      const prior = baseline.perServerSeconds?.[server];
      if (!Number.isSafeInteger(prior) || value < prior)
        missingServers.push(server);
      else perServerSeconds[server] = value - prior;
    }
  }
  return {
    uuid: counter?.uuid ?? null,
    lifetime: counter
      ? {
          networkSeconds: counter.networkSeconds,
          perServerSeconds: counter.perServerSeconds,
        }
      : null,
    period: reason
      ? null
      : {
          networkSeconds: counter.networkSeconds - baseline.networkSeconds,
          perServerSeconds,
        },
    coverage: {
      reason,
      reportedAt: counter?.reportedAt ?? null,
      stale: !counter || to - counter.reportedAt > 30000,
      from: baseline?.reportedAt ?? null,
      to: counter?.reportedAt ?? null,
      partial: Boolean(
        !reason && (baseline.reportedAt !== from || counter.reportedAt !== to),
      ),
      missingServers,
      requestedFrom: from,
      requestedTo: to,
    },
  };
}
