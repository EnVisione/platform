import { randomUUID } from "node:crypto";
import { AuthError } from "./discord.js";
import { monthsAfter, inactivityMonths } from "../shared/privacy.js";

const forever = Number.MAX_SAFE_INTEGER;
import { communityRankNames as rankOrder } from "./roles.js";
export function staffReviewAccess(config, user) {
  return Boolean(
    user?.permissions?.dashboard &&
    config.ranks.some(
      (rank) =>
        ["Founder", "Manager"].includes(rank.name) &&
        user.roles?.includes(rank.id),
    ),
  );
}
export function nextReviewDate(anchor, after) {
  let month = Math.max(
    1,
    (new Date(after).getUTCFullYear() - new Date(anchor).getUTCFullYear()) *
      12 +
      new Date(after).getUTCMonth() -
      new Date(anchor).getUTCMonth(),
  );
  while (monthsAfter(anchor, month) <= after) month++;
  return monthsAfter(anchor, month);
}
export function reviewProgress(store, tickets, id, from, to) {
  const resolved = new Set();
  let replies = 0,
    active = 0,
    ratingTotal = 0,
    ratings = 0;
  for (const [, ticket] of tickets?.store.entries("ticket") || []) {
    if (ticket.erasingAt) continue;
    if (
      ticket.claimedBy?.id === id &&
      ["pending", "claimed"].includes(ticket.status)
    )
      active++;
    const closures = tickets.store
      .entries(`ticket-closures:${ticket.id}`)
      .map(([, value]) => value);
    closures.push({
      resolution: ticket.resolution,
      rating: ticket.rating,
      claimedBy: ticket.ratingStaff || ticket.claimedBy || ticket.helpedBy,
      closedAt: ticket.closedAt,
    });
    for (const closure of closures) {
      const at = closure.resolution?.at || closure.closedAt;
      if (at >= from && at <= to && closure.resolution?.actor?.id === id)
        resolved.add(ticket.id);
      if (
        at >= from &&
        at <= to &&
        closure.claimedBy?.id === id &&
        Number.isInteger(closure.rating)
      ) {
        ratings++;
        ratingTotal += closure.rating;
      }
    }
    for (const [, message] of tickets.store.entries(
      `ticket-messages:${ticket.id}`,
    ))
      if (
        message.actor?.id === id &&
        message.at >= from &&
        message.at <= to &&
        !message.internal &&
        !message.deleted
      )
        replies++;
  }
  const tasks = store
    .entries("discord-todo")
    .map(([, item]) => item)
    .filter((item) => !item.deleted && item.assigneeDiscordId === id);
  return {
    ticketsResolved: resolved.size,
    activeTickets: active,
    replies,
    ratingCount: ratings,
    averageRating: ratings ? ratingTotal / ratings : null,
    trackedTasks: tasks.map((item) => ({
      title: item.discord?.title || item.title,
      status: item.discord?.status || item.statusKey,
    })),
  };
}
export function staffReviews(
  config,
  store,
  {
    roster,
    member,
    assignments,
    applicationStore,
    progress = () => ({}),
    minecraft = () => null,
    now = Date.now,
  } = {},
) {
  let transport,
    timer,
    running,
    stopped = false;
  const locks = new Map();
  const knownRoles = config.ranks;
  const rankNames = (roles) =>
    knownRoles
      .filter((rank) => roles?.includes(rank.id))
      .map((rank) => rank.name);
  const eligible = (person) =>
    person &&
    !person.bot &&
    !person.pending &&
    rankNames(person.roles).length &&
    !rankNames(person.roles).some((rank) =>
      ["Founder", "Manager"].includes(rank),
    );
  function authorize(user) {
    if (!staffReviewAccess(config, user))
      throw new AuthError("staff_review_manager_required");
  }
  async function exclusive(id, action) {
    const previous = locks.get(id) || Promise.resolve();
    const work = previous.catch(() => {}).then(action);
    locks.set(id, work);
    try {
      return await work;
    } finally {
      if (locks.get(id) === work) locks.delete(id);
    }
  }
  const save = (review) =>
    store.set("staff-review", review.id, review, forever);
  function get(id) {
    const review = store.get("staff-review", id);
    if (!review) throw new AuthError("staff_review_not_found", 404);
    return review;
  }
  function audit(review, actor, action, detail = "") {
    const event = {
      id: randomUUID(),
      reviewId: review.id,
      memberId: review.member.id,
      at: now(),
      actor: actor || { id: "system", name: "Staff reviews" },
      action,
      detail,
    };
    store.set("staff-review-event", event.id, event, forever);
  }
  function enrollment(person) {
    let schedule = store.get("staff-review-schedule", person.id);
    if (schedule) return schedule;
    const approvals = (applicationStore?.entries("application") || [])
      .map(([, record]) => record)
      .filter(
        (record) =>
          record.discord?.id === person.id &&
          record.status === "Approved" &&
          Number.isFinite(record.decision?.decidedAt),
      );
    const acceptedAt = approvals.length
      ? Math.min(...approvals.map((record) => record.decision.decidedAt))
      : now();
    schedule = {
      memberId: person.id,
      anchor: acceptedAt,
      anchorSource: approvals.length ? "application" : "enrolled",
      periodFrom: acceptedAt,
      nextDue: monthsAfter(acceptedAt, 1),
      openId: null,
    };
    store.set("staff-review-schedule", person.id, schedule, forever);
    return schedule;
  }
  function begin(person, actor) {
    return store.transaction(() => {
      const schedule = enrollment(person);
      if (schedule.openId) return get(schedule.openId);
      const review = {
        id: randomUUID(),
        member: {
          id: person.id,
          name: person.name,
          avatar: person.avatar,
          minecraft: minecraft(person.id)?.name || null,
        },
        ranks: rankNames(person.roles),
        status: "open",
        openedAt: now(),
        dueAt: schedule.nextDue,
        periodFrom: schedule.periodFrom,
        anchorSource: schedule.anchorSource,
        anchor: schedule.anchor,
        progress: progress(person.id, schedule.periodFrom, now()),
        startedBy: actor || { id: "system", name: "Monthly review" },
        discord: {},
        decision: null,
      };
      save(review);
      store.set(
        "staff-review-schedule",
        person.id,
        { ...schedule, openId: review.id },
        forever,
      );
      audit(review, actor, actor ? "started_early" : "started");
      return review;
    });
  }
  function complete(review) {
    const schedule = store.get("staff-review-schedule", review.member.id);
    review.closedAt = now();
    save(review);
    if (schedule?.openId === review.id)
      store.set(
        "staff-review-schedule",
        review.member.id,
        {
          ...schedule,
          openId: null,
          periodFrom: now(),
          nextDue: nextReviewDate(schedule.anchor, now()),
        },
        forever,
      );
  }
  function summaries() {
    return new Map(
      store.entries("staff-review-schedule").map(([id, schedule]) => [
        id,
        {
          ...schedule,
          status: schedule.openId ? get(schedule.openId).status : "scheduled",
        },
      ]),
    );
  }
  function list(user, { query = "", status = "", offset = 0 } = {}) {
    authorize(user);
    if (
      typeof query !== "string" ||
      query.length > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !["", "open", "closed"].includes(status)
    )
      throw new AuthError("invalid_review_filter", 400);
    const reviews = store
      .entries("staff-review")
      .map(([, value]) => value)
      .filter(
        (review) =>
          (!status ||
            (status === "open"
              ? ["open", "promotion_pending"].includes(review.status)
              : !["open", "promotion_pending"].includes(review.status))) &&
          `${review.member.name} ${review.member.minecraft || ""} ${review.ranks.join(" ")}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
      .sort((a, b) => b.openedAt - a.openedAt);
    return {
      reviews: reviews.slice(offset, offset + 30),
      total: reviews.length,
    };
  }
  function detail(user, id) {
    authorize(user);
    return {
      review: get(id),
      messages: store
        .entries(`staff-review-messages:${id}`)
        .map(([, value]) => value)
        .sort((a, b) => a.at - b.at),
      guildId: config.guildId,
      events: store
        .entries("staff-review-event")
        .map(([, value]) => value)
        .filter((event) => event.reviewId === id)
        .sort((a, b) => a.at - b.at),
    };
  }
  async function startEarly(user, id) {
    authorize(user);
    if (!/^\d{1,20}$/.test(id))
      throw new AuthError("invalid_staff_member", 400);
    const person = await member(id);
    if (!eligible(person)) throw new AuthError("staff_review_ineligible", 409);
    const review = begin(person, { id: user.id, name: user.name });
    await transport?.flush();
    return review;
  }
  function comment(
    user,
    id,
    body,
    origin = "panel",
    messageId = randomUUID(),
    at = now(),
  ) {
    authorize(user);
    const review = get(id);
    if (review.status !== "open")
      throw new AuthError("staff_review_closed", 409);
    if (typeof body !== "string" || !body.trim() || body.length > 4000)
      throw new AuthError("invalid_review_message", 400);
    const existing = store.get(`staff-review-messages:${id}`, messageId);
    if (existing && origin === "panel") {
      if (existing.author.id !== user.id || existing.body !== body.trim())
        throw new AuthError("invalid_review_message", 409);
      return existing;
    }
    if (existing && existing.author.id !== user.id)
      throw new AuthError("invalid_review_message");
    const message = {
      id: messageId,
      author: { id: user.id, name: user.name },
      body: body.trim(),
      at: existing?.at || at,
      origin,
      ...(existing ? { editedAt: now() } : {}),
    };
    store.set(`staff-review-messages:${id}`, messageId, message, forever);
    review.updatedAt = now();
    save(review);
    return message;
  }
  async function promotionOptions(user, id) {
    authorize(user);
    const review = get(id);
    const roles = (await assignments?.metadata(user)) || [];
    const currentRank = rankOrder.findIndex((name) =>
      review.ranks.includes(name),
    );
    const founder = user.roles.includes(
      config.ranks.find((rank) => rank.name === "Founder")?.id,
    );
    return roles.filter(
      (role) =>
        role.assignable &&
        !role.specialist &&
        rankOrder.includes(role.name) &&
        !review.ranks.includes(role.name) &&
        (founder || !["Founder", "Manager"].includes(role.name)) &&
        (currentRank < 0 || rankOrder.indexOf(role.name) < currentRank),
    );
  }
  async function finishPromotion(review, user) {
    const assignment = store.get("role-assignment", review.member.id);
    if (
      assignment &&
      assignment.requestedAt >= review.decision.at &&
      assignment.rank !== review.decision.roleId
    ) {
      review.status = "cancelled";
      review.error = "staff_review_assignment_changed";
      complete(review);
      audit(
        review,
        review.decision.actor,
        "cancelled",
        "A newer role assignment replaced the promotion.",
      );
      return;
    }
    if (
      !assignment ||
      assignment.requestedAt < review.decision.at ||
      assignment.rank !== review.decision.roleId
    ) {
      const target = await assignments.list(user, review.member.id);
      const person = target.members.find(
        (item) => item.id === review.member.id,
      );
      if (!person) throw new AuthError("staff_review_member_unavailable", 503);
      await assignments.grant(
        user,
        person.id,
        person.version,
        review.decision.roleId,
      );
    } else await assignments.reconcile(review.member.id);
    const delivery = assignments.status(review.member.id)?.discord || {};
    if (
      store.get("role-assignment", review.member.id)?.status === "applied" &&
      Object.values(delivery).length >= 2 &&
      Object.values(delivery).every((item) => item.status === "synced")
    ) {
      review.status = "promoted";
      delete review.error;
      complete(review);
      audit(
        review,
        review.decision.actor,
        "promoted",
        review.decision.roleName,
      );
    }
  }
  async function decide(user, id, input) {
    authorize(user);
    if (
      !input ||
      !["continue", "promote"].includes(input.action) ||
      typeof (input.message || "") !== "string" ||
      (input.message || "").length > 1500 ||
      typeof (input.assessment || "") !== "string" ||
      (input.assessment || "").length > 4000
    )
      throw new AuthError("invalid_review_decision", 400);
    return exclusive(id, async () => {
      const review = get(id);
      if (review.member.id === user.id)
        throw new AuthError("staff_review_self_decision");
      if (review.decision) {
        if (
          review.decision.action !== input.action ||
          (input.action === "promote" &&
            review.decision.roleId !== input.roleId)
        )
          throw new AuthError("staff_review_already_decided", 409);
        if (review.status === "promotion_pending")
          await finishPromotion(review, user);
        return review;
      }
      const person = await member(review.member.id);
      if (
        !eligible(person) ||
        JSON.stringify(rankNames(person.roles)) !== JSON.stringify(review.ranks)
      )
        throw new AuthError("staff_review_roles_changed", 409);
      let role;
      if (input.action === "promote") {
        role = (await promotionOptions(user, id)).find(
          (item) => item.id === input.roleId,
        );
        if (!role) throw new AuthError("invalid_review_promotion", 400);
      }
      review.decision = {
        action: input.action,
        at: now(),
        actor: { id: user.id, name: user.name },
        assessment: (input.assessment || "").trim(),
        message: (input.message || "").trim(),
        ...(role ? { roleId: role.id, roleName: role.name } : {}),
      };
      review.status = role ? "promotion_pending" : "continued";
      save(review);
      audit(review, review.decision.actor, "decision", input.action);
      if (role) {
        try {
          await finishPromotion(review, user);
        } catch (error) {
          review.error =
            error instanceof AuthError ? error.code : "promotion_sync_failed";
          save(review);
        }
      } else complete(review);
      await transport?.flush();
      return get(id);
    });
  }
  async function tick() {
    if (stopped) return;
    if (running) return running;
    running = (async () => {
      const people = await roster();
      for (const person of people) {
        if (!eligible(person)) continue;
        const schedule = enrollment(person);
        if (!schedule.openId && schedule.nextDue <= now()) begin(person);
      }
      for (const [, review] of store.entries("staff-review")) {
        if (["open", "promotion_pending"].includes(review.status)) {
          const person = people.find((item) => item.id === review.member.id);
          if (
            review.status === "open" &&
            (!eligible(person) ||
              JSON.stringify(rankNames(person.roles)) !==
                JSON.stringify(review.ranks))
          ) {
            review.status = "cancelled";
            complete(review);
            audit(
              review,
              null,
              "cancelled",
              "Staff membership or ranks changed.",
            );
          } else if (review.status === "promotion_pending") {
            const actor = await member(review.decision.actor.id);
            if (staffReviewAccess(config, actor))
              await exclusive(review.id, () =>
                finishPromotion(get(review.id), actor),
              ).catch(() => {});
          }
        }
        if (
          config.privacy?.retentionEnabled &&
          monthsAfter(
            Math.max(
              review.updatedAt || 0,
              review.closedAt || 0,
              review.openedAt,
            ),
            inactivityMonths,
          ) <= now() &&
          !store.get("privacy-hold", review.id) &&
          !store.get("privacy-hold", review.member.id)
        ) {
          await transport?.erase(review);
          store.transaction(() => {
            store.delete("staff-review", review.id);
            const schedule = store.get(
              "staff-review-schedule",
              review.member.id,
            );
            if (schedule?.openId === review.id)
              store.set(
                "staff-review-schedule",
                review.member.id,
                { ...schedule, openId: null },
                forever,
              );
            for (const [key] of store.entries(
              `staff-review-messages:${review.id}`,
            ))
              store.delete(`staff-review-messages:${review.id}`, key);
            for (const [key, event] of store.entries("staff-review-event"))
              if (event.reviewId === review.id)
                store.delete("staff-review-event", key);
          });
        }
      }
      for (const [id, schedule] of store.entries("staff-review-schedule")) {
        if (
          config.privacy?.retentionEnabled &&
          !people.some((person) => person.id === id && eligible(person)) &&
          !store.get("privacy-hold", id) &&
          monthsAfter(schedule.periodFrom, inactivityMonths) <= now() &&
          !store
            .entries("staff-review")
            .some(([, review]) => review.member.id === id)
        )
          store.delete("staff-review-schedule", id);
      }
      await transport?.flush();
    })().finally(() => {
      running = null;
    });
    return running;
  }
  return {
    get,
    list,
    detail,
    comment,
    sync: () => transport?.flush(),
    decide,
    startEarly,
    promotionOptions,
    summaries,
    eligible,
    records: () => store.entries("staff-review").map(([, review]) => review),
    save,
    authorize,
    setTransport(value) {
      transport = value;
    },
    start() {
      const run = () =>
        void tick().catch(() =>
          console.error("Staff review synchronization is pending."),
        );
      timer = setInterval(run, 60000);
      timer.unref();
      run();
    },
    tick,
    async close() {
      stopped = true;
      clearInterval(timer);
      await running;
      await Promise.allSettled([...locks.values()]);
      await transport?.close();
    },
  };
}
