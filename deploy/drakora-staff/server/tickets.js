import { randomUUID, randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { AuthError } from "./discord.js";
import { listFilters, matchesText } from "./list-filters.js";
import { validMailAddress } from "./mail-address.js";
import {
  ticketTypes,
  ticketIntake,
  ticketDetails,
  ticketCategories,
  ticketCategory,
  ticketCapability,
  ticketPath,
  ticketMediaDays,
  ticketMessageUploadLimit,
} from "../shared/tickets.js";

const forever = Number.MAX_SAFE_INTEGER;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const idPattern = /^[a-f0-9-]{36}$/;
const publicActor = (user) => ({
  id: user.id,
  name: user.name || user.username,
  avatar: user.avatar || null,
  ...(user.guest ? { guest: true } : {}),
});
function text(value, min, max, code = "invalid_ticket") {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max ||
    value.includes("\0")
  )
    throw new AuthError(code, 400);
  return value.trim();
}

export function ticketService(
  config,
  store,
  rolePolicy,
  { now = Date.now, onActivity = () => {} } = {},
) {
  const events = new EventEmitter();
  events.setMaxListeners(200);
  let transport,
    timer,
    maintenance,
    running,
    expiring,
    stopped = false;
  const viewers = new Map();
  const cleanupWaiters = [];
  const put = (kind, id, value) => store.set(kind, id, value, forever);
  const get = (id) => {
    if (!idPattern.test(id || "")) throw new AuthError("ticket_not_found", 404);
    const ticket = store.get("ticket", id);
    if (!ticket || ticket.erasingAt)
      throw new AuthError("ticket_not_found", 404);
    return ticket;
  };
  function staff(user, ticket, capability = "tickets.view") {
    const current = rolePolicy.apply(user);
    if (
      (capability === "tickets.delete" && !rolePolicy.isAdmin(current)) ||
      !current.capabilities[capability] ||
      (ticket &&
        !current.capabilities[
          ticketCapability(ticket, capability.split(".").at(-1))
        ])
    )
      throw new AuthError("ticket_access_denied");
    return current;
  }
  function authorize(user, ticket, staffView = false, capability) {
    if (staffView) return staff(user, ticket, capability);
    if (!user || ticket.type === "partnership" || ticket.owner.id !== user.id)
      throw new AuthError("ticket_not_found", 404);
    return user;
  }
  function announce(ticket) {
    events.emit("changed", { id: ticket.id, revision: ticket.revision });
    void pump();
  }
  function queue(ticket, kind, ref = ticket.id, notice) {
    const id = `${ticket.id}:${kind}:${ref}`;
    const outbox =
      ticket.type === "partnership" && !["note", "notes-thread"].includes(kind)
        ? "partnership-outbox"
        : "ticket-outbox";
    const pendingNotice = notice || store.get(outbox, id)?.notice;
    put(outbox, id, {
      id,
      generation: randomUUID(),
      ticketId: ticket.id,
      kind,
      ref,
      attempts: 0,
      after: 0,
      ...(pendingNotice ? { notice: pendingNotice } : {}),
    });
  }
  function queueActivity(ticket, event, actor, silent = false) {
    if (ticket.type === "partnership") return;
    const cycle =
      event === "reopened"
        ? ticket.reopenedCount
        : ticket.closureId || ticket.closedAt;
    const ref = `${event}:${cycle}`,
      id = `${ticket.id}:${ref}`;
    if (
      store.get("ticket-outbox", `${ticket.id}:activity:${ref}`) ||
      store.get("ticket-status-notice", id)?.messageId
    )
      return;
    queue(ticket, "activity", ref, {
      id,
      event,
      actor: publicActor(actor),
      staff: ticket.ratingStaff || ticket.claimedBy || ticket.helpedBy,
      revision: ticket.revision,
      closureId: ticket.closureId || null,
      cycle: ticket.reopenedCount || 0,
      silent,
    });
  }
  function audit(
    ticket,
    user,
    action,
    detail,
    internal = false,
    ownerActivity = true,
  ) {
    if (ownerActivity && ticket.owner.id === user.id) {
      ticket.lastActiveAt = now();
      if (!ticket.owner.guest) onActivity(user.id, ticket.lastActiveAt);
    }
    ticket.revision++;
    ticket.updatedAt = now();
    const entry = {
      id: randomUUID(),
      at: now(),
      actor: publicActor(user),
      action,
      detail,
      internal,
    };
    put(
      `ticket-history:${ticket.id}`,
      `${String(ticket.revision).padStart(12, "0")}:${entry.id}`,
      entry,
    );
    put("ticket", ticket.id, ticket);
    if (
      ticket.type !== "partnership" &&
      ticket.owner.guest &&
      !internal &&
      (["opened", "claimed", "taken_over", "closed", "reopened"].includes(
        action,
      ) ||
        (action === "message" && user.id !== ticket.owner.id))
    )
      put("ticket-email-outbox", `${ticket.id}:${ticket.revision}`, {
        ticketId: ticket.id,
        event: action,
        revision: ticket.revision,
        status: ticket.status,
        actor: publicActor(user),
        claimedBy: ticket.claimedBy,
        helpedBy: ticket.helpedBy || null,
        attempts: 0,
        after: 0,
      });
  }
  function mediaView(file, staffView, ticketId) {
    if (file.internal && !staffView) return null;
    return {
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      expired: Boolean(file.expiresAt <= now() || file.purged || file.removed),
      url: `${staffView ? "/api/tickets" : "/help/api/tickets"}/${ticketId}/attachments/${file.id}`,
    };
  }
  function view(user, id, staffView = false, before) {
    const ticket = get(id);
    authorize(user, ticket, staffView);
    const page = store.page(
      `ticket-messages:${id}`,
      50,
      0,
      (message) =>
        (!before || message.sequence < Number(before)) && !message.internal,
    );
    const messages = page.items.reverse().map((message) => ({
      ...message,
      attachments: message.attachments
        .map((fileId) =>
          mediaView(store.get("ticket-media", fileId), staffView, id),
        )
        .filter(Boolean),
    }));
    const safe = {
      id: ticket.id,
      ign: ticket.ign,
      type: ticket.type,
      location: ticket.location,
      description: ticket.description,
      reportTarget: ticket.reportTarget || null,
      intakeDetails: ticketDetails(ticket),
      owner: ticket.owner,
      origin: ticket.origin,
      status: ticket.status,
      claimedBy: ticket.claimedBy,
      helpedBy: ticket.helpedBy || null,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      revision: ticket.revision,
      rating: ticket.rating,
      ratedAt: ticket.ratedAt || null,
      ratingStaff: ticket.ratingStaff || ticket.claimedBy || ticket.helpedBy,
      closureId: ticket.closureId || null,
      channelRetained: Boolean(ticket.channelId),
      deletionPending: store
        .entries("ticket-outbox")
        .some(([, job]) => job.ticketId === id && job.kind === "delete"),
      path: ticket.type === "partnership" ? null : ticketPath(ticket),
      category: ticketCategory(ticket),
      discordUrl:
        ticket.channelId &&
        (staffView || ["pending", "claimed"].includes(ticket.status))
          ? `https://discord.com/channels/${config.tickets.guildId}/${ticket.channelId}`
          : null,
      sync:
        ticket.type === "partnership"
          ? ticket.partnership.preference
          : ticket.discordDeletedAt || ticket.discordArchivedAt
            ? "saved"
            : ticket.channelId
              ? "connected"
              : "pending",
      messages,
      hasOlder: page.total > messages.length,
      history: store
        .entries(`ticket-history:${id}`)
        .map(([, entry]) => entry)
        .filter((entry) => staffView || !entry.internal),
      viewers: staffView
        ? [
            ...new Map(
              [...(viewers.get(id)?.values() || [])].map((entry) => [
                entry.actor.id,
                entry.actor,
              ]),
            ).values(),
          ]
        : [],
    };
    if (staffView) {
      if (ticket.closureId && ticket.type !== "partnership") {
        const key = `${id}:feedback:${ticket.closureId}`;
        const delivery = store.get("ticket-feedback-delivery", key);
        const job = store.get("ticket-outbox", key);
        safe.feedbackDelivery = {
          status:
            ticket.rating !== null
              ? "rated"
              : delivery
                ? delivery.route
                : job?.failed
                  ? "failed"
                  : job
                    ? "pending"
                    : "website",
          at: delivery?.at || null,
        };
      }
      safe.contactEmail = ticket.contactEmail || null;
      safe.partnership = ticket.partnership || null;
      if (ticket.type === "partnership" && ticket.partnership.decision) {
        const decision = ticket.partnership.decision;
        const jobKey = `${id}:decision:${decision.id}`;
        const job = store.get("partnership-outbox", jobKey);
        const delivery = store.get(
          "partnership-delivery",
          jobKey + decision.id,
        );
        safe.partnership = {
          ...ticket.partnership,
          notification: {
            status: delivery ? "sent" : job?.failed ? "failed" : "pending",
            via: delivery?.via || null,
            at: delivery?.at || null,
          },
        };
      }
      const current = rolePolicy.apply(user);
      safe.actions = Object.fromEntries(
        ["view", "reply", "claim", "takeover", "close", "delete"].map(
          (action) => [
            action,
            Boolean(
              current.capabilities[`tickets.${action}`] &&
              current.capabilities[ticketCapability(ticket, action)] &&
              (action !== "delete" || rolePolicy.isAdmin(current)) &&
              (action !== "takeover" ||
                (["pending", "claimed"].includes(ticket.status) &&
                  ticket.claimedBy &&
                  ticket.claimedBy.id !== user.id)),
            ),
          ],
        ),
      );
      if (ticket.type === "partnership") {
        safe.actions = {
          view: true,
          decide: Boolean(
            current.capabilities[ticketCapability(ticket, "decide")],
          ),
        };
      }
      safe.takeoverRequest = takeoverRequestView(ticket);
      safe.actions.approveTakeover = Boolean(
        rolePolicy.isManager(current) &&
        current.capabilities["tickets.takeover"] &&
        current.capabilities[ticketCapability(ticket, "takeover")],
      );
      safe.resolution = ticket.resolution
        ? {
            ...ticket.resolution,
            attachments: ticket.resolution.attachments.map((fileId) =>
              mediaView(store.get("ticket-media", fileId), true, id),
            ),
          }
        : null;
      safe.previousResolutions = store
        .entries(`ticket-closures:${id}`)
        .map(([, closure]) => ({
          ...closure,
          resolution: closure.resolution
            ? {
                ...closure.resolution,
                attachments: closure.resolution.attachments
                  .map((fileId) =>
                    mediaView(store.get("ticket-media", fileId), true, id),
                  )
                  .filter(Boolean),
              }
            : null,
        }));
      safe.deliveryIssues = store
        .entries(
          ticket.type === "partnership"
            ? "partnership-outbox"
            : "ticket-outbox",
        )
        .filter(([, job]) => job.ticketId === id && job.failed)
        .map(([, job]) => ({ kind: job.kind, failure: job.failure }));
      safe.deliveryPending = store
        .entries(
          ticket.type === "partnership"
            ? "partnership-outbox"
            : "ticket-outbox",
        )
        .filter(([, job]) => job.ticketId === id && job.kind !== "note").length;
    }
    return safe;
  }
  function visible(user, ticket) {
    const current = rolePolicy.apply(user);
    return Boolean(
      current.capabilities["tickets.view"] &&
      current.capabilities[ticketCapability(ticket)],
    );
  }
  function staffStats(user) {
    const current = staff(user);
    const stats = new Map();
    const resolved = new Map();
    const entry = (id) => {
      if (!stats.has(id))
        stats.set(id, {
          ticketsResolved: 0,
          activeTickets: 0,
          reviewCount: 0,
          averageRating: null,
          ratingTotal: 0,
        });
      return stats.get(id);
    };
    for (const [, ticket] of store.entries("ticket")) {
      if (ticket.erasingAt || !current.capabilities[ticketCapability(ticket)])
        continue;
      const assigned = ticket.claimedBy || ticket.helpedBy;
      if (assigned && ["pending", "claimed"].includes(ticket.status))
        entry(assigned.id).activeTickets++;
      const closures = store
        .entries(`ticket-closures:${ticket.id}`)
        .map(([, closure]) => closure);
      closures.push({
        resolution: ticket.resolution,
        rating: ticket.rating,
        claimedBy: ticket.ratingStaff || assigned,
      });
      for (const closure of closures) {
        const resolver = closure.resolution?.actor?.id;
        if (resolver) {
          if (!resolved.has(resolver)) resolved.set(resolver, new Set());
          resolved.get(resolver).add(ticket.id);
          entry(resolver).ticketsResolved = resolved.get(resolver).size;
        }
        if (
          closure.claimedBy?.id &&
          Number.isInteger(closure.rating) &&
          closure.rating >= 1 &&
          closure.rating <= 5
        ) {
          const summary = entry(closure.claimedBy.id);
          summary.reviewCount++;
          summary.ratingTotal += closure.rating;
        }
      }
    }
    for (const summary of stats.values()) {
      summary.averageRating = summary.reviewCount
        ? summary.ratingTotal / summary.reviewCount
        : null;
      delete summary.ratingTotal;
    }
    return stats;
  }
  function list(user, input = {}) {
    const current = staff(user);
    const {
      closed = false,
      category = "",
      status = "",
      type = "",
      assignment = "",
    } = input;
    const sort = input.sort || "updated";
    const { offset, term, withinDate } = listFilters(input);
    const staffTerm = listFilters({ query: input.staff }).term;
    const matchesStaff = (ticket) => {
      if (!staffTerm) return true;
      const actors = [
        ticket.claimedBy,
        ticket.helpedBy,
        ticket.ratingStaff,
        ticket.resolution?.actor,
        ticket.partnership?.decision?.actor,
      ];
      if (
        matchesText(
          staffTerm,
          actors.flatMap((actor) => [actor?.id, actor?.name]),
        )
      )
        return true;
      return store
        .entries(`ticket-closures:${ticket.id}`)
        .some(([, closure]) =>
          matchesText(staffTerm, [
            closure.claimedBy?.id,
            closure.claimedBy?.name,
            closure.resolution?.actor?.id,
            closure.resolution?.actor?.name,
          ]),
        );
    };
    if (category && !ticketCategories.some((entry) => entry.id === category))
      throw new AuthError("invalid_ticket_category", 400);
    if (
      (status &&
        !["pending", "claimed", "awaiting_resolution", "closed"].includes(
          status,
        )) ||
      (type && !ticketTypes.some((entry) => entry.id === type)) ||
      !["", "mine", "unclaimed", "claimed"].includes(assignment) ||
      !["updated", "newest", "oldest"].includes(sort)
    )
      throw new AuthError("invalid_list_filters", 400);
    const values = store
      .entries("ticket")
      .map(([, ticket]) => ticket)
      .filter(
        (ticket) =>
          !ticket.erasingAt &&
          (closed ? ticket.status === "closed" : ticket.status !== "closed") &&
          current.capabilities[ticketCapability(ticket)] &&
          (!status || ticket.status === status) &&
          (!type || ticket.type === type) &&
          (assignment !== "mine" || ticket.claimedBy?.id === current.id) &&
          (assignment !== "unclaimed" || !ticket.claimedBy) &&
          (assignment !== "claimed" || Boolean(ticket.claimedBy)) &&
          withinDate(ticket.createdAt) &&
          matchesStaff(ticket) &&
          matchesText(term, [
            ticket.id,
            ticket.ign,
            ticket.location,
            ticket.description,
            ticket.reportTarget,
            ticket.owner.id,
            ticket.owner.name,
            ticket.claimedBy?.id,
            ticket.claimedBy?.name,
          ]),
      );
    const filtered = values.filter(
      (ticket) => !category || ticketCategory(ticket) === category,
    );
    const time = (ticket) =>
      sort === "updated" ? ticket.updatedAt : ticket.createdAt;
    filtered.sort(
      (a, b) =>
        (sort === "oldest" ? time(a) - time(b) : time(b) - time(a)) ||
        a.id.localeCompare(b.id),
    );
    return {
      items: filtered.slice(offset, offset + 50),
      total: filtered.length,
      pageSize: 50,
      categories: ticketCategories
        .filter(
          (entry) => current.capabilities[`tickets.category.${entry.id}.view`],
        )
        .map((entry) => ({
          ...entry,
          count: values.filter((ticket) => ticketCategory(ticket) === entry.id)
            .length,
        })),
    };
  }
  function create(user, input, origin = "web", guestNetwork) {
    if (!user?.id || !["web", "discord"].includes(origin))
      throw new AuthError("ticket_origin_disabled", 400);
    if (
      input.type === "partnership" ||
      !ticketTypes.some((type) => type.id === input.type) ||
      !/^[A-Za-z0-9_]{3,16}$/.test(input.ign || "")
    )
      throw new AuthError("invalid_ticket", 400);
    const requestId = text(input.requestId, 36, 36);
    if (!idPattern.test(requestId)) throw new AuthError("invalid_request", 400);
    let contactEmail;
    if (user.guest) {
      if (origin !== "web" || !/^[a-f0-9]{64}$/.test(guestNetwork || ""))
        throw new AuthError("invalid_request", 400);
      contactEmail = text(input.email, 3, 254, "invalid_ticket_email");
      if (!validMailAddress(contactEmail))
        throw new AuthError("invalid_ticket_email", 400);
    }
    const prior = store.get("ticket-request", `${user.id}:${requestId}`);
    if (prior) return get(prior.id);
    if (
      !user.guest &&
      store
        .entries("ticket")
        .filter(
          ([, ticket]) =>
            ticket.owner.id === user.id && ticket.status !== "closed",
        ).length >= 3
    )
      throw new AuthError("ticket_limit", 409);
    const intake = Object.fromEntries(
      ticketIntake(input.type).fields.map((field) => [
        field.id,
        text(
          field.required === false ? (input[field.id] ?? "") : input[field.id],
          field.min,
          field.max,
          field.id === "reportTarget"
            ? "invalid_report_target"
            : "invalid_ticket",
        ),
      ]),
    );
    const ticket = {
      id: randomUUID(),
      type: input.type,
      ...intake,
      owner: publicActor(user),
      ...(user.guest ? { guestNetwork, contactEmail } : {}),
      origin,
      status: "pending",
      claimedBy: null,
      channelId: null,
      createdAt: now(),
      updatedAt: now(),
      revision: 0,
      sequence: 0,
      rating: null,
      resolution: null,
    };
    store.transaction(() => {
      if (
        user.guest &&
        store
          .entries("ticket")
          .some(
            ([, current]) =>
              current.guestNetwork === guestNetwork &&
              ["pending", "claimed"].includes(current.status),
          )
      )
        throw new AuthError("ticket_ip_limit", 409);
      audit(ticket, user, "opened", "Ticket opened");
      queue(ticket, "create");
      if (transport?.notesThread) queue(ticket, "notes-thread");
      if (config.tickets.staffChannelId)
        for (const event of ["opened", "unclaimed"])
          put("ticket-notice-outbox", `${ticket.id}:${event}`, {
            ticketId: ticket.id,
            event,
            channelId: config.tickets.staffChannelId,
            after: ticket.createdAt + (event === "unclaimed" ? 3600000 : 0),
            attempts: 0,
          });
      put("ticket-request", `${user.id}:${requestId}`, { id: ticket.id });
    });
    announce(ticket);
    return ticket;
  }
  function createPartnership(user, input, network) {
    if (!["owner", "developer"].includes(input.relationship))
      throw new AuthError("partnership_owner_required", 400);
    if (!user?.id || !/^[a-f0-9]{64}$/.test(network || ""))
      throw new AuthError("invalid_request", 400);
    const name = text(input.name, 2, 80);
    const email = text(
      input.email,
      3,
      254,
      "invalid_ticket_email",
    ).toLowerCase();
    if (!validMailAddress(email))
      throw new AuthError("invalid_ticket_email", 400);
    const discord = text(input.discord, 2, 100);
    const packUrl = text(input.packUrl, 10, 1000);
    let url;
    try {
      url = new URL(packUrl);
    } catch {
      throw new AuthError("invalid_pack_link", 400);
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname.includes(".")
    )
      throw new AuthError("invalid_pack_link", 400);
    if (!["email", "discord"].includes(input.preference))
      throw new AuthError("invalid_contact_preference", 400);
    if (
      input.preference === "discord" &&
      (user.guest || !/^\d{17,20}$/.test(user.id) || input.allowDm !== true)
    )
      throw new AuthError("partnership_discord_required", 400);
    if (!idPattern.test(input.requestId || ""))
      throw new AuthError("invalid_request", 400);
    const prior = store.get("ticket-request", `${user.id}:${input.requestId}`);
    if (prior) return get(prior.id);
    const ticket = {
      id: randomUUID(),
      ign: name,
      type: "partnership",
      location: url.hostname,
      description: text(input.description, 50, 4000),
      owner: publicActor({ ...user, name }),
      contactEmail: email,
      guestNetwork: network,
      origin: "web",
      status: "pending",
      claimedBy: null,
      channelId: null,
      createdAt: now(),
      updatedAt: now(),
      revision: 0,
      sequence: 0,
      rating: null,
      resolution: null,
      partnership: {
        relationship: input.relationship,
        packUrl: url.href,
        discord,
        preference: input.preference,
        discordId: user.guest ? null : user.id,
      },
    };
    store.transaction(() => {
      if (
        store
          .entries("ticket")
          .some(
            ([, current]) =>
              current.type === "partnership" &&
              current.status !== "closed" &&
              (current.guestNetwork === network ||
                current.contactEmail?.toLowerCase() === email ||
                current.owner.id === user.id),
          )
      )
        throw new AuthError("partnership_limit", 409);
      audit(ticket, user, "opened", "Modpack partnership request submitted");
      queue(ticket, "opened");
      if (config.tickets.staffChannelId)
        for (const event of ["opened", "unclaimed"])
          put("ticket-notice-outbox", `${ticket.id}:${event}`, {
            ticketId: ticket.id,
            event,
            channelId: config.tickets.staffChannelId,
            after: now() + (event === "unclaimed" ? 3600000 : 0),
            attempts: 0,
          });
      put("ticket-request", `${user.id}:${input.requestId}`, { id: ticket.id });
    });
    announce(ticket);
    return ticket;
  }
  function decidePartnership(user, id, input) {
    const ticket = get(id);
    if (ticket.type !== "partnership")
      throw new AuthError("invalid_partnership_decision", 400);
    staff(user, ticket, ticketCapability(ticket, "decide"));
    if (!rolePolicy.isManager(user))
      throw new AuthError("ticket_access_denied");
    if (
      !input ||
      !idPattern.test(input.requestId || "") ||
      !["accepted", "denied"].includes(input.outcome) ||
      !Number.isSafeInteger(input.revision)
    )
      throw new AuthError("invalid_partnership_decision", 400);
    const reason = text(
      input.reason ?? "",
      0,
      1000,
      "invalid_partnership_decision",
    );
    const existing = ticket.partnership.decision;
    if (existing) {
      if (
        existing.id === input.requestId &&
        existing.outcome === input.outcome &&
        existing.reason === reason
      )
        return ticket;
      throw new AuthError("partnership_already_decided", 409);
    }
    if (ticket.revision !== input.revision)
      throw new AuthError("partnership_changed", 409);
    store.transaction(() => {
      ticket.partnership.decision = {
        id: input.requestId,
        outcome: input.outcome,
        reason,
        actor: publicActor(user),
        at: now(),
      };
      ticket.status = "closed";
      ticket.closedAt = now();
      audit(
        ticket,
        user,
        input.outcome,
        `Partnership request ${input.outcome}`,
      );
      const ref = ticket.partnership.decision.id;
      store.delete("partnership-outbox", `${id}:opened:${id}`);
      queue(ticket, "decision", ref);
      const jobKey = `${id}:decision:${ref}`;
      put("partnership-outbox", jobKey, {
        ...store.get("partnership-outbox", jobKey),
        generation: ref,
      });
    });
    announce(ticket);
    return ticket;
  }
  function files(ticket, user, ids, internal = false) {
    if (
      !Array.isArray(ids) ||
      ids.length > 5 ||
      new Set(ids).size !== ids.length
    )
      throw new AuthError("invalid_attachment", 400);
    if (
      ids.reduce(
        (total, id) => total + (store.get("ticket-media", id)?.size || 0),
        0,
      ) >
      (ticket.type === "partnership"
        ? 10 * 1024 * 1024
        : ticketMessageUploadLimit)
    )
      throw new AuthError("attachments_too_large", 413);
    return ids.map((id) => {
      const file = store.get("ticket-media", id);
      if (
        !file ||
        file.ticketId !== ticket.id ||
        file.uploader !== user.id ||
        file.used ||
        file.expiresAt <= now() ||
        file.purged
      )
        throw new AuthError("invalid_attachment", 400);
      file.used = true;
      file.internal = internal;
      put("ticket-media", id, file);
      return id;
    });
  }
  function markHelped(ticket, user) {
    if (ticket.status !== "pending") return;
    ticket.status = "claimed";
    ticket.helpedBy = publicActor(user);
    if (ticket.type !== "partnership")
      queue(ticket, "status", ticket.id, {
        event: "replied",
        actor: publicActor(user),
        revision: ticket.revision + 1,
      });
  }
  function reply(
    user,
    id,
    input,
    staffView = false,
    note = false,
    takeoverRequest,
  ) {
    const ticket = get(id);
    authorize(user, ticket, staffView, "tickets.reply");
    if (note && !staffView) throw new AuthError("ticket_access_denied");
    if (!note && !["pending", "claimed"].includes(ticket.status))
      throw new AuthError("ticket_closed", 409);
    if (!idPattern.test(input.requestId || ""))
      throw new AuthError("invalid_request", 400);
    const old = store.get(
      "ticket-message-request",
      `${id}:${user.id}:${note ? "note:" : ""}${input.requestId}`,
    );
    if (old) return old;
    const content = text(
      input.content || "",
      input.attachments?.length ? 0 : 1,
      2000,
      "invalid_message",
    );
    let message;
    store.transaction(() => {
      message = {
        id: randomUUID(),
        sequence: ++ticket.sequence,
        actor: publicActor(user),
        staff: staffView,
        content,
        attachments: files(ticket, user, input.attachments || [], note),
        internal: note,
        at: now(),
        origin: staffView ? "dashboard" : "web",
        delivery: "pending",
        deleted: false,
        ...(takeoverRequest ? { takeoverRequestId: takeoverRequest.id } : {}),
      };
      if (takeoverRequest)
        ticket.takeoverRequest = {
          ...takeoverRequest,
          noteId: message.id,
          noteKey: String(message.sequence).padStart(12, "0"),
        };
      put(
        `ticket-messages:${id}`,
        String(message.sequence).padStart(12, "0"),
        message,
      );
      put(
        "ticket-message-request",
        `${id}:${user.id}:${note ? "note:" : ""}${input.requestId}`,
        message,
      );
      queue(
        ticket,
        note ? "note" : "message",
        String(message.sequence).padStart(12, "0"),
      );
      if (staffView && !note) markHelped(ticket, user);
      audit(
        ticket,
        user,
        note ? "note" : "message",
        note ? "Internal staff note added" : "Message sent",
        note,
        !note,
      );
    });
    announce(ticket);
    return message;
  }
  function notes(user, id, before) {
    const ticket = get(id);
    const current = staff(user, ticket);
    if (ticket.type === "partnership")
      throw new AuthError("partnership_application_only", 409);
    const page = store.page(
      `ticket-messages:${id}`,
      50,
      0,
      (message) =>
        message.internal && (!before || message.sequence < Number(before)),
    );
    const link = store.get("ticket-notes-discord", id);
    return {
      takeoverRequest: takeoverRequestView(ticket),
      canApproveTakeover: Boolean(
        rolePolicy.isManager(current) &&
        current.capabilities["tickets.takeover"] &&
        current.capabilities[ticketCapability(ticket, "takeover")],
      ),
      messages: page.items.reverse().map((message) => ({
        ...message,
        attachments: message.attachments
          .map((fileId) =>
            mediaView(store.get("ticket-media", fileId), true, id),
          )
          .filter(Boolean),
      })),
      hasOlder: page.total > page.items.length,
      discordUrl:
        link?.threadId &&
        link.guildId === config.tickets.guildId &&
        link.parentId === ticket.channelId
          ? `https://discord.com/channels/${link.guildId}/${link.threadId}`
          : null,
    };
  }
  function claim(user, id) {
    const ticket = get(id);
    staff(user, ticket, "tickets.claim");
    if (!["pending", "claimed"].includes(ticket.status))
      throw new AuthError("ticket_closed", 409);
    if (ticket.claimedBy?.id === user.id) return ticket;
    if (ticket.claimedBy) throw new AuthError("ticket_already_claimed", 409);
    store.transaction(() => {
      ticket.claimedBy = publicActor(user);
      ticket.claimedRank = rolePolicy.rank(user);
      ticket.assignmentVersion = (ticket.assignmentVersion || 0) + 1;
      ticket.status = "claimed";
      audit(ticket, user, "claimed", `${user.name} claimed the ticket`);
      queue(ticket, "status", ticket.id, {
        event: "claimed",
        actor: ticket.claimedBy,
        revision: ticket.revision,
      });
    });
    announce(ticket);
    return ticket;
  }
  function canTakeover(user, assignedRank) {
    const rank = rolePolicy.rank(user);
    return (
      rolePolicy.isManager(user) ||
      (rank !== null &&
        Number.isInteger(assignedRank) &&
        assignedRank - rank >= 2)
    );
  }
  function takeoverRequestView(ticket) {
    const request = ticket.takeoverRequest;
    if (!request) return null;
    const valid =
      ["pending", "claimed"].includes(ticket.status) &&
      ticket.claimedBy?.id === request.previousStaffId &&
      (ticket.assignmentVersion || 0) === request.assignmentVersion &&
      (ticket.reopenedCount || 0) === request.cycle;
    return {
      ...request,
      status:
        request.status === "pending" && !valid ? "expired" : request.status,
    };
  }
  function syncTakeoverRequest(ticket) {
    const request = takeoverRequestView(ticket);
    if (!request) return;
    ticket.takeoverRequest = request;
    const message = store.get(`ticket-messages:${ticket.id}`, request.noteKey);
    if (!message) return;
    message.content = `${request.requester.name} requested to take over from ${request.previousStaff.name}.\nReason: ${request.reason}\nStatus: ${request.status}${request.reviewer ? ` by ${request.reviewer.name}` : ""}`;
    put(`ticket-messages:${ticket.id}`, request.noteKey, message);
    queue(ticket, "note", request.noteKey);
  }
  function assignTakeover(ticket, user) {
    const previous = ticket.claimedBy;
    ticket.claimedBy = publicActor(user);
    ticket.claimedRank = rolePolicy.rank(user);
    ticket.assignmentVersion = (ticket.assignmentVersion || 0) + 1;
    ticket.status = "claimed";
    syncTakeoverRequest(ticket);
    audit(
      ticket,
      user,
      "taken_over",
      `${user.name} took over the ticket from ${previous.name}`,
    );
    queue(ticket, "status", ticket.id, {
      event: "taken_over",
      actor: ticket.claimedBy,
      revision: ticket.revision,
    });
  }
  function takeoverTarget(user, id, previousStaffId) {
    const ticket = get(id);
    staff(user, ticket, "tickets.takeover");
    if (rolePolicy.rank(user) === null)
      throw new AuthError("ticket_access_denied");
    if (!["pending", "claimed"].includes(ticket.status))
      throw new AuthError("ticket_closed", 409);
    if (
      !ticket.claimedBy ||
      (ticket.claimedBy.id !== user.id &&
        ticket.claimedBy.id !== previousStaffId)
    )
      throw new AuthError("ticket_assignment_changed", 409);
    return ticket;
  }
  async function takeover(user, id, previousStaffId) {
    let ticket = takeoverTarget(user, id, previousStaffId);
    if (ticket.claimedBy.id === user.id) return ticket;
    const version = ticket.assignmentVersion || 0;
    const assignee =
      !rolePolicy.isManager(user) && transport?.staffUser
        ? await transport.staffUser(ticket.claimedBy.id)
        : null;
    ticket = takeoverTarget(user, id, previousStaffId);
    if ((ticket.assignmentVersion || 0) !== version)
      throw new AuthError("ticket_assignment_changed", 409);
    const assignedRank =
      transport?.staffUser && !rolePolicy.isManager(user)
        ? assignee
          ? rolePolicy.rank(assignee)
          : null
        : ticket.claimedRank;
    if (!canTakeover(user, assignedRank))
      throw new AuthError("ticket_takeover_approval_required", 403);
    store.transaction(() => assignTakeover(ticket, user));
    announce(ticket);
    return ticket;
  }
  function requestTakeover(user, id, input) {
    const ticket = takeoverTarget(user, id, input?.claimedBy);
    if (ticket.claimedBy.id === user.id)
      throw new AuthError("ticket_assignment_changed", 409);
    const current = takeoverRequestView(ticket);
    if (current?.status === "pending") {
      if (current.requester.id === user.id) return current;
      throw new AuthError("ticket_takeover_request_pending", 409);
    }
    const request = {
      id: randomUUID(),
      requester: publicActor(user),
      previousStaff: ticket.claimedBy,
      previousStaffId: ticket.claimedBy.id,
      assignmentVersion: ticket.assignmentVersion || 0,
      cycle: ticket.reopenedCount || 0,
      reason: text(input.reason, 1, 1000, "invalid_takeover_reason"),
      status: "pending",
      at: now(),
    };
    reply(
      user,
      id,
      {
        requestId: request.id,
        content: `${user.name} requested to take over from ${ticket.claimedBy.name}.\nReason: ${request.reason}\nStatus: pending Manager approval`,
      },
      true,
      true,
      request,
    );
    return get(id).takeoverRequest;
  }
  async function reviewTakeover(user, id, requestId, approve) {
    if (typeof approve !== "boolean")
      throw new AuthError("invalid_request", 400);
    let ticket = get(id);
    staff(user, ticket, "tickets.takeover");
    if (!rolePolicy.isManager(user))
      throw new AuthError("ticket_takeover_manager_required", 403);
    let request = takeoverRequestView(ticket);
    if (!request || request.id !== requestId || request.status !== "pending")
      throw new AuthError("ticket_takeover_request_expired", 409);
    if (request.requester.id === user.id)
      throw new AuthError("ticket_takeover_self_approval", 403);
    let requester;
    if (approve) {
      if (!transport?.staffUser)
        throw new AuthError("ticket_sync_unavailable", 503);
      requester = await transport.staffUser(request.requester.id);
      if (!requester)
        throw new AuthError("ticket_takeover_requester_unavailable", 409);
    }
    ticket = get(id);
    staff(user, ticket, "tickets.takeover");
    request = takeoverRequestView(ticket);
    if (!request || request.id !== requestId || request.status !== "pending")
      throw new AuthError("ticket_takeover_request_expired", 409);
    if (approve) {
      staff(requester, ticket, "tickets.takeover");
      if (rolePolicy.rank(requester) === null)
        throw new AuthError("ticket_takeover_requester_unavailable", 409);
    }
    store.transaction(() => {
      ticket.takeoverRequest = {
        ...request,
        status: approve ? "approved" : "denied",
        reviewer: publicActor(user),
        reviewedAt: now(),
      };
      if (approve) assignTakeover(ticket, requester);
      else syncTakeoverRequest(ticket);
      audit(
        ticket,
        user,
        approve ? "takeover_approved" : "takeover_denied",
        `${user.name} ${approve ? "approved" : "denied"} ${request.requester.name}'s takeover request`,
        true,
        false,
      );
    });
    announce(ticket);
    return ticket;
  }
  function closeTicket(user, id, input, staffView = false) {
    const ticket = get(id);
    authorize(user, ticket, staffView, "tickets.close");
    if (
      input?.cycle !== undefined &&
      input.cycle !== (ticket.reopenedCount || 0)
    )
      throw new AuthError("ticket_feedback_expired", 409);
    if (ticket.status === "closed") return ticket;
    if (!staffView && ticket.status === "awaiting_resolution") return ticket;
    const resolution = staffView
      ? {
          summary: text(input.summary, 1, 4000, "resolution_required"),
          commands: text(input.commands, 1, 2000, "commands_required"),
          actor: publicActor(user),
          at: now(),
        }
      : null;
    store.transaction(() => {
      if (["pending", "claimed"].includes(ticket.status)) {
        ticket.closureId = randomUUID();
        ticket.ratingStaff = ticket.claimedBy || ticket.helpedBy;
        if (!ticket.owner.guest && ticket.type !== "partnership")
          queue(ticket, "feedback", ticket.closureId);
      }
      ticket.status = staffView ? "closed" : "awaiting_resolution";
      ticket.closedAt = now();
      syncTakeoverRequest(ticket);
      if (resolution) {
        resolution.attachments = files(
          ticket,
          user,
          input.attachments || [],
          true,
        );
        ticket.resolution = resolution;
      }
      audit(
        ticket,
        user,
        "closed",
        staffView
          ? "Staff recorded the resolution and closed the ticket"
          : "Player closed the ticket; staff resolution is pending",
      );
      if (!ticket.discordDeletedAt && !ticket.discordArchivedAt)
        queue(ticket, "status");
      queueActivity(ticket, staffView ? "resolved" : "closed", user);
      autoDeleteRated(ticket);
    });
    announce(ticket);
    return ticket;
  }
  async function reopen(user, id, staffView = false, closureId) {
    authorize(user, get(id), staffView, "tickets.close");
    if (get(id).channelId && transport?.checkChannel)
      await transport.checkChannel(get(id));
    await pump();
    const ticket = get(id);
    authorize(user, ticket, staffView, "tickets.close");
    if (["pending", "claimed"].includes(ticket.status)) return ticket;
    if (closureId !== undefined && closureId !== (ticket.closureId || null))
      throw new AuthError("ticket_feedback_expired", 409);
    if (
      store
        .entries("ticket-outbox")
        .some(([, job]) => job.ticketId === id && job.kind === "delete") ||
      store.get("ticket-outbox", `${id}:create:${id}`) ||
      store.get("ticket-outbox", `${id}:status:${id}`)
    )
      throw new AuthError("ticket_reopen_pending", 409);
    const others = store
      .entries("ticket")
      .map(([, entry]) => entry)
      .filter((entry) => entry.id !== id);
    if (ticket.type === "partnership") {
      if (
        others.some(
          (entry) =>
            entry.type === "partnership" &&
            entry.status !== "closed" &&
            (entry.owner.id === ticket.owner.id ||
              entry.guestNetwork === ticket.guestNetwork ||
              entry.contactEmail?.toLowerCase() ===
                ticket.contactEmail?.toLowerCase()),
        )
      )
        throw new AuthError("partnership_limit", 409);
    } else if (ticket.owner.guest) {
      if (
        others.some(
          (entry) =>
            entry.guestNetwork === ticket.guestNetwork &&
            ["pending", "claimed"].includes(entry.status),
        )
      )
        throw new AuthError("ticket_ip_limit", 409);
    } else if (
      others.filter(
        (entry) =>
          entry.owner.id === ticket.owner.id && entry.status !== "closed",
      ).length >= 3
    )
      throw new AuthError("ticket_limit", 409);
    store.transaction(() => {
      put(
        `ticket-closures:${id}`,
        ticket.closureId || String(ticket.closedAt),
        {
          at: ticket.closedAt,
          claimedBy: ticket.ratingStaff || ticket.claimedBy || ticket.helpedBy,
          rating: ticket.rating,
          ratedAt: ticket.ratedAt || null,
          resolution: ticket.resolution,
        },
      );
      ticket.status = "pending";
      ticket.claimedBy = null;
      ticket.claimedRank = null;
      ticket.assignmentVersion = (ticket.assignmentVersion || 0) + 1;
      syncTakeoverRequest(ticket);
      ticket.helpedBy = null;
      ticket.resolution = null;
      ticket.rating = null;
      ticket.ratedAt = null;
      ticket.ratingStaff = null;
      ticket.reopenedCount = (ticket.reopenedCount || 0) + 1;
      if (!ticket.channelId) {
        ticket.reopenedSequence = ticket.sequence;
        delete ticket.lastDiscordId;
      }
      delete ticket.closedAt;
      delete ticket.closureId;
      delete ticket.discordDeletedAt;
      delete ticket.discordArchivedAt;
      store.delete("ticket-discord-close", id);
      if (!ticket.channelId)
        for (const kind of [
          "ticket-discord-cursor",
          "ticket-discord-sweep",
          "ticket-discord",
        ])
          store.delete(kind, id);
      audit(
        ticket,
        user,
        "reopened",
        "Ticket reopened and returned to the waiting queue",
      );
      queue(
        ticket,
        ticket.type === "partnership" || ticket.channelId ? "status" : "create",
      );
      if (transport?.notesThread && ticket.type !== "partnership")
        queue(ticket, "notes-thread");
      queueActivity(ticket, "reopened", user);
      if (config.tickets.staffChannelId) {
        const cycle = `${id}:reopened:${ticket.reopenedCount}`;
        for (const event of ["reopened", "unclaimed"])
          put("ticket-notice-outbox", `${cycle}:${event}`, {
            ticketId: id,
            event,
            channelId: config.tickets.staffChannelId,
            openedKey: `${cycle}:reopened`,
            cycle: ticket.reopenedCount,
            after: now() + (event === "unclaimed" ? 3600000 : 0),
            attempts: 0,
          });
      }
    });
    announce(ticket);
    return ticket;
  }
  async function deleteChannel(user, id, closureId) {
    staff(user, get(id), "tickets.delete");
    await pump();
    const ticket = get(id);
    staff(user, ticket, "tickets.delete");
    if (!["closed", "awaiting_resolution"].includes(ticket.status))
      throw new AuthError("ticket_close_first", 409);
    if (closureId !== undefined && closureId !== (ticket.closureId || null))
      throw new AuthError("ticket_feedback_expired", 409);
    if (!ticket.channelId) return ticket;
    if (
      store
        .entries("ticket-outbox")
        .some(([, job]) => job.ticketId === id && job.kind === "delete")
    )
      return ticket;
    store.transaction(() => {
      store.delete("ticket-discord-close", id);
      audit(
        ticket,
        user,
        "channel_deletion_requested",
        "Admin requested Discord channel deletion; dashboard history is kept",
        true,
      );
      queue(ticket, "delete", ticket.channelId, { actor: publicActor(user) });
    });
    announce(ticket);
    return ticket;
  }
  function rate(user, id, rating, closureId) {
    const ticket = get(id);
    authorize(user, ticket);
    if (closureId !== undefined && closureId !== (ticket.closureId || null))
      throw new AuthError("ticket_feedback_expired", 409);
    if (
      !["closed", "awaiting_resolution"].includes(ticket.status) ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    )
      throw new AuthError("invalid_rating", 400);
    if (ticket.rating !== null)
      throw new AuthError("ticket_already_rated", 409);
    store.transaction(() => {
      ticket.rating = rating;
      ticket.ratedAt = now();
      audit(ticket, user, "rated", `Player rated the help ${rating}/5`);
      queueActivity(ticket, "rated", user);
      autoDeleteRated(ticket);
    });
    announce(ticket);
    return ticket;
  }
  function autoDeleteRated(ticket) {
    if (
      ticket.status !== "closed" ||
      ticket.rating === null ||
      !ticket.channelId
    )
      return;
    queue(ticket, "delete", ticket.channelId, {
      closureId: ticket.closureId,
      automatic: true,
    });
  }
  async function upload(
    user,
    id,
    bytes,
    name,
    type,
    staffView = false,
    internal = false,
    note = false,
  ) {
    const ticket = get(id);
    if (note && !staffView) throw new AuthError("ticket_access_denied");
    if (note) internal = true;
    if (
      stopped ||
      (ticket.status === "closed" && !note) ||
      (!internal && ticket.status === "awaiting_resolution")
    )
      throw new AuthError("ticket_closed", 409);
    authorize(
      user,
      get(id),
      staffView,
      internal && !note ? "tickets.close" : "tickets.reply",
    );
    if (!transport) throw new AuthError("ticket_sync_unavailable", 503);
    const metadata = await transport.upload(bytes, name, type, ticket);
    // validate again after the upload. a closure may have raced it.
    const file = {
      ...metadata,
      id: randomUUID(),
      ticketId: id,
      uploader: user.id,
      internal,
      used: false,
      createdAt: now(),
      expiresAt: now() + ticketMediaDays * 86400000,
    };
    put("ticket-media", file.id, file);
    authorize(
      user,
      get(id),
      staffView,
      internal && !note ? "tickets.close" : "tickets.reply",
    );
    if (
      (get(id).status === "closed" && !note) ||
      (!internal && get(id).status === "awaiting_resolution")
    )
      throw new AuthError("ticket_closed", 409);
    return mediaView(file, staffView, id);
  }
  function media(user, id, fileId, staffView = false) {
    authorize(user, get(id), staffView);
    const file = store.get("ticket-media", fileId);
    if (
      !file ||
      file.ticketId !== id ||
      (file.internal && !staffView) ||
      (!file.used && file.uploader !== user.id)
    )
      throw new AuthError("ticket_not_found", 404);
    if (file.purged || file.removed || file.expiresAt <= now())
      throw new AuthError("attachment_expired", 410);
    return file;
  }
  function linked(channelId) {
    const ref = store.get("ticket-channel", channelId);
    return ref ? get(ref.id) : null;
  }
  function bind(id, channelId) {
    const ticket = get(id);
    ticket.channelId = channelId;
    store.transaction(() => {
      put("ticket", id, ticket);
      put("ticket-channel", channelId, { id });
    });
    announce(ticket);
  }
  function missingChannel(id, channelId) {
    const ticket = get(id);
    if (!channelId || ticket.channelId !== channelId) return false;
    store.transaction(() => {
      store.delete("ticket-channel", channelId);
      ticket.channelId = null;
      ticket.reopenedSequence = ticket.sequence;
      delete ticket.lastDiscordId;
      for (const kind of [
        "ticket-discord",
        "ticket-discord-close",
        "ticket-discord-cursor",
        "ticket-discord-sweep",
      ])
        store.delete(kind, id);
      for (const [key, job] of store.entries("ticket-outbox")) {
        if (job.ticketId !== id) continue;
        if (["status", "delete"].includes(job.kind))
          store.delete("ticket-outbox", key);
        if (job.kind === "message") {
          const message = store.get(`ticket-messages:${id}`, job.ref);
          if (message) store.delete("ticket-send", message.id);
          put("ticket-outbox", key, {
            ...job,
            generation: randomUUID(),
            attempts: 0,
            after: 0,
          });
        }
      }
      if (["pending", "claimed"].includes(ticket.status)) {
        delete ticket.discordDeletedAt;
        delete ticket.discordArchivedAt;
        queue(ticket, "create");
      } else ticket.discordDeletedAt = now();
      audit(
        ticket,
        { id: "system", name: "Drakora" },
        "channel_missing",
        "Discord confirmed the ticket channel is missing; saved conversation is kept",
        true,
      );
    });
    announce(ticket);
    return true;
  }
  function ingest(id, incoming, closing = false) {
    if (get(id).type === "partnership")
      throw new AuthError("partnership_application_only", 409);
    const ticket = get(id),
      ref = store.get("ticket-discord-message", incoming.id);
    const internal = Boolean(
      incoming.internal ||
      (ref && store.get(`ticket-messages:${id}`, ref.key)?.internal),
    );
    const saveAttachment = (metadata) => {
      if (metadata.savedId) {
        const saved = store.get("ticket-media", metadata.savedId);
        if (
          !saved ||
          saved.ticketId !== id ||
          saved.uploader !== incoming.actor.id ||
          saved.expiresAt <= now()
        )
          throw new AuthError("invalid_attachment", 400);
        saved.used = true;
        put("ticket-media", saved.id, saved);
        return saved.id;
      }
      const createdAt = closing ? Math.min(incoming.at, now()) : now();
      const file = {
        ...metadata,
        id: randomUUID(),
        ticketId: id,
        uploader: incoming.actor.id,
        internal,
        ...(internal
          ? { staffGuildId: incoming.guildId || config.guildId }
          : {}),
        used: true,
        createdAt,
        expiresAt: createdAt + ticketMediaDays * 86400000,
      };
      put("ticket-media", file.id, file);
      return file.id;
    };
    if (ref) {
      if (ref.ticketId !== id || (incoming.deleted && ref.mediaRemoved)) return;
      const message = store.get(`ticket-messages:${id}`, ref.key);
      if (
        !incoming.deleted &&
        (message.deleted ||
          (incoming.editedAt || 0) < (message.discordEditedAt || 0))
      )
        return;
      const nextContent = incoming.deleted
        ? "Message deleted"
        : (incoming.content || "").slice(0, 2000);
      const metadata = incoming.deleted ? [] : incoming.attachments;
      const previous = message.attachments.map((fileId) =>
        store.get("ticket-media", fileId),
      );
      const sameAttachment = (saved, incoming) =>
        saved &&
        (saved.attachmentId === incoming.attachmentId ||
          (saved.sourceChannelId === incoming.channelId &&
            saved.sourceAttachmentId === incoming.attachmentId));
      const attachmentsChanged =
        metadata !== undefined &&
        (metadata.length !== previous.length ||
          metadata.some(
            (file, index) => !sameAttachment(previous[index], file),
          ));
      if (
        message.origin !== "discord" ||
        (message.content === nextContent &&
          message.deleted === Boolean(incoming.deleted) &&
          !attachmentsChanged)
      )
        return;
      store.transaction(() => {
        if (attachmentsChanged) {
          message.attachments = metadata.map(
            (file) =>
              previous.find((old) => sameAttachment(old, file))?.id ||
              saveAttachment(file),
          );
          for (const old of previous)
            if (!message.attachments.includes(old.id)) {
              old.removed = true;
              put("ticket-media", old.id, old);
            }
        }
        Object.assign(message, {
          content: nextContent,
          deleted: Boolean(incoming.deleted),
          editedAt: now(),
          discordEditedAt: incoming.editedAt || 0,
        });
        put(`ticket-messages:${id}`, ref.key, message);
        audit(
          ticket,
          incoming.actor || message.actor,
          incoming.deleted ? "message_deleted" : "message_edited",
          "Discord message updated",
          internal,
          !internal,
        );
      });
      announce(ticket);
      return;
    }
    if (
      incoming.deleted ||
      (!internal &&
        !["pending", "claimed"].includes(ticket.status) &&
        !(closing && incoming.at <= ticket.closedAt))
    )
      return;
    store.transaction(() => {
      const attachments = (incoming.attachments || []).map(saveAttachment);
      const message = {
        id: randomUUID(),
        sequence: ++ticket.sequence,
        actor: publicActor(incoming.actor),
        staff: Boolean(incoming.staff),
        internal,
        ...(internal ? { notesThreadId: incoming.channelId || null } : {}),
        content: (incoming.content || "").slice(0, 2000),
        attachments,
        at: incoming.at || now(),
        origin: incoming.origin === "email" ? "email" : "discord",
        delivery: "delivered",
        discordId: incoming.id,
        discordEditedAt: incoming.editedAt || 0,
        deleted: false,
      };
      const key = String(message.sequence).padStart(12, "0");
      put(`ticket-messages:${id}`, key, message);
      put("ticket-discord-message", incoming.id, { ticketId: id, key });
      if (!internal) ticket.lastDiscordId = incoming.id;
      if (message.staff && !internal) markHelped(ticket, incoming.actor);
      audit(
        ticket,
        incoming.actor,
        "message",
        incoming.origin === "email"
          ? "Email reply received"
          : internal
            ? "Internal Discord staff note received"
            : "Discord message received",
        internal,
        !internal,
      );
    });
    announce(ticket);
  }
  async function pump() {
    if (!transport || stopped || running) return running;
    running = Promise.resolve()
      .then(async () => {
        const blocked = new Set(),
          notesBlocked = new Set();
        const priority = {
          create: 0,
          "notes-thread": 1,
          message: 1,
          note: 1,
          status: 2,
          activity: 3,
          delete: 4,
          feedback: 5,
        };
        let attempts = 0;
        for (const [key, job] of store
          .entries("ticket-outbox")
          .sort(
            ([, a], [, b]) =>
              a.ticketId.localeCompare(b.ticketId) ||
              priority[a.kind] - priority[b.kind] ||
              (a.kind === "activity"
                ? a.notice.revision - b.notice.revision
                : 0) ||
              a.ref.localeCompare(b.ref),
          )) {
          if (
            job.kind !== "create" &&
            (job.kind === "note" ? notesBlocked : blocked).has(job.ticketId)
          )
            continue;
          if (job.after > now()) {
            if (job.kind === "message") blocked.add(job.ticketId);
            if (job.kind === "note") notesBlocked.add(job.ticketId);
            continue;
          }
          if (store.get("ticket", job.ticketId)?.erasingAt) continue;
          const ticket = get(job.ticketId);
          if (job.kind === "feedback") {
            const intent = store.get("ticket-feedback-send", key);
            const cleanup = intent?.route === "channel" && intent.channelId;
            if (
              !cleanup &&
              (job.ref !== ticket.closureId ||
                ticket.rating !== null ||
                !["closed", "awaiting_resolution"].includes(ticket.status))
            ) {
              store.delete("ticket-outbox", key);
              store.delete("ticket-feedback-send", key);
              continue;
            }
            if (
              job.failed ||
              (!cleanup &&
                ticket.channelId &&
                !store.get("ticket-discord-close", ticket.id)?.ready)
            )
              continue;
          } else if (
            job.kind !== "create" &&
            job.kind !== "note" &&
            job.kind !== "notes-thread" &&
            !ticket.channelId &&
            !(
              job.kind === "activity" &&
              ticket.discordDeletedAt &&
              config.tickets.staffChannelId
            )
          ) {
            if (
              (ticket.discordDeletedAt || ticket.discordArchivedAt) &&
              job.kind !== "message"
            )
              store.delete("ticket-outbox", key);
            continue;
          }
          if (attempts++ === 20) break;
          try {
            if (job.kind === "create") await transport.create(ticket);
            else if (job.kind === "notes-thread") {
              const result = await transport.notesThread(ticket);
              if (result?.pending) continue;
            } else if (job.kind === "feedback") {
              const result = await transport.feedback(ticket, job, key);
              if (result?.pending) continue;
            } else if (["status", "activity", "delete"].includes(job.kind)) {
              if (
                job.kind === "delete" &&
                (ticket.channelId !== job.ref ||
                  (job.notice?.automatic &&
                    (ticket.closureId !== job.notice.closureId ||
                      ticket.status !== "closed" ||
                      ticket.rating === null)) ||
                  !["closed", "awaiting_resolution"].includes(ticket.status))
              ) {
                store.delete("ticket-outbox", key);
                continue;
              }
              const result =
                job.kind === "delete"
                  ? await transport.deleteChannel(ticket)
                  : await transport.status(ticket, job);
              if (result?.pending) continue;
              if (result?.deleted)
                store.transaction(() => {
                  const current = get(ticket.id);
                  if (current.channelId !== ticket.channelId)
                    throw new Error("Ticket channel changed during closure");
                  store.delete("ticket-channel", current.channelId);
                  current.channelId = null;
                  current.discordDeletedAt = now();
                  audit(
                    current,
                    job.notice?.actor || { id: "system", name: "Drakora" },
                    "channel_deleted",
                    "Discord channel deleted; saved ticket history is kept",
                    true,
                  );
                  queueActivity(
                    current,
                    "channel_deleted",
                    job.notice?.actor || { id: "system", name: "Drakora" },
                  );
                });
            } else {
              const message = store.get(
                `ticket-messages:${ticket.id}`,
                job.ref,
              );
              const delivered = await transport[
                job.kind === "note" ? "note" : "message"
              ](
                ticket,
                message,
                message.attachments.map((id) => store.get("ticket-media", id)),
                { retry: job.attempts > 0 },
              );
              if (delivered?.pending) continue;
              store.transaction(() => {
                if (message.takeoverRequestId)
                  Object.assign(
                    message,
                    store.get(`ticket-messages:${ticket.id}`, job.ref),
                  );
                message.discordId = delivered.id || null;
                message.delivery = delivered.local ? "stored" : "delivered";
                put(`ticket-messages:${ticket.id}`, job.ref, message);
                if (delivered.id)
                  put("ticket-discord-message", delivered.id, {
                    ticketId: ticket.id,
                    key: job.ref,
                  });
                store.delete(
                  "ticket-send",
                  job.kind === "note" ? `note:${message.id}` : message.id,
                );
                const current = get(ticket.id);
                current.revision++;
                put("ticket", ticket.id, current);
              });
            }
            // a concurrent status change replaces this job. keep that newer version.
            if (store.get("ticket-outbox", key)?.generation === job.generation)
              store.delete("ticket-outbox", key);
            events.emit("changed", {
              id: ticket.id,
              revision: get(ticket.id).revision,
            });
          } catch (error) {
            if (job.kind === "message") blocked.add(job.ticketId);
            if (job.kind === "note") notesBlocked.add(job.ticketId);
            job.attempts++;
            job.after =
              now() + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6));
            job.failure = error.code || "discord_unavailable";
            if (job.kind === "feedback") job.failed = job.attempts >= 20;
            if (store.get("ticket-outbox", key)?.generation === job.generation)
              put("ticket-outbox", key, job);
            console.error(
              "Ticket Discord delivery is pending:",
              job.kind,
              job.failure,
            );
          }
        }
      })
      .finally(() => {
        running = null;
      });
    return running;
  }
  async function expire() {
    if (!transport || stopped || expiring) return expiring;
    expiring = Promise.resolve()
      .then(async () => {
        for (const [id, file] of store.entries("ticket-media")) {
          if (
            !file.purged &&
            (file.expiresAt <= now() ||
              (!file.used && file.createdAt + 3600000 <= now()))
          ) {
            try {
              await transport.removeMedia(file);
              file.purged = true;
              put("ticket-media", id, file);
            } catch {
              console.error("Ticket attachment removal is pending.");
            }
          }
        }
        for (const [, ticket] of store.entries("ticket")) {
          if (ticket.erasingAt) continue;
          if (
            ["closed", "awaiting_resolution"].includes(ticket.status) &&
            ticket.channelId &&
            !store.get("ticket-discord-close", ticket.id)?.ready &&
            !store.get("ticket-outbox", `${ticket.id}:status:${ticket.id}`)
          )
            queue(ticket, "status");
        }
        await pump();
      })
      .finally(() => {
        expiring = null;
      });
    return expiring;
  }
  return {
    async eraseInactive(id, lastActiveAt) {
      const ticket = store.get("ticket", id);
      if (!ticket || (ticket.lastActiveAt || ticket.createdAt) > lastActiveAt)
        return false;
      if (store.get("privacy-hold", id)) return false;
      if (transport && !transport.eraseTicket)
        throw new Error("Ticket erasure transport unavailable");
      ticket.erasingAt ||= now();
      put("ticket", id, ticket);
      await running;
      await expiring;
      await Promise.all(cleanupWaiters.map((wait) => wait()));
      if (transport) {
        for (const [, file] of store.entries("ticket-media"))
          if (file.ticketId === id && !file.purged)
            await transport.removeMedia(file);
        await transport.eraseTicket(ticket);
      } else if (ticket.channelId)
        throw new Error("Discord cleanup unavailable");
      store.transaction(() => {
        const messageIds = new Set(
          store.entries(`ticket-messages:${id}`).map(([, value]) => value.id),
        );
        for (const kind of store.kinds()) {
          if (!kind.startsWith("ticket") && !kind.startsWith("partnership"))
            continue;
          for (const [key, value] of store.entries(kind))
            if (
              kind.endsWith(`:${id}`) ||
              key === id ||
              key.startsWith(`${id}:`) ||
              value?.ticketId === id ||
              value?.id === id ||
              (kind === "ticket-send" && messageIds.has(key)) ||
              (kind === "ticket-channel" && value === id)
            )
              store.delete(kind, key);
        }
        store.delete("privacy-hold", id);
      });
      viewers.delete(id);
      events.emit("changed", { id });
      return true;
    },
    registerCleanupWaiter(wait) {
      cleanupWaiters.push(wait);
    },
    queueClosedUpdates() {
      for (const [, ticket] of store.entries("ticket")) {
        if (
          ticket.erasingAt ||
          !ticket.channelId ||
          !["closed", "awaiting_resolution"].includes(ticket.status)
        )
          continue;
        queueActivity(
          ticket,
          ticket.status === "closed" ? "resolved" : "closed",
          ticket.resolution?.actor || ticket.owner,
          true,
        );
        if (ticket.rating !== null)
          queueActivity(ticket, "rated", ticket.owner, true);
      }
    },
    get,
    list,
    view,
    create,
    createPartnership,
    decidePartnership,
    visible,
    staffStats,
    reply,
    notes,
    addNote(user, id, input) {
      return reply(user, id, input, true, true);
    },
    claim,
    takeover,
    requestTakeover,
    reviewTakeover,
    takeoverRequestView,
    closeTicket,
    reopen,
    deleteChannel,
    rate,
    media,
    upload,
    ingest,
    importMedia(id, actor, metadata) {
      get(id);
      const file = {
        ...metadata,
        id: randomUUID(),
        ticketId: id,
        uploader: actor.id,
        internal: false,
        used: false,
        createdAt: now(),
        expiresAt: now() + ticketMediaDays * 86400000,
      };
      put("ticket-media", file.id, file);
      return { savedId: file.id };
    },
    linked,
    bind,
    missingChannel,
    events,
    store,
    staff,
    authorize,
    attach(value) {
      transport = value;
      if (value.notesThread)
        for (const [, ticket] of store.entries("ticket"))
          if (
            !ticket.erasingAt &&
            ticket.type !== "partnership" &&
            ["pending", "claimed"].includes(ticket.status) &&
            !store.get("ticket-notes-discord", ticket.id)?.threadId &&
            !store.get(
              "ticket-outbox",
              `${ticket.id}:notes-thread:${ticket.id}`,
            )
          )
            queue(ticket, "notes-thread");
      for (const [, ticket] of store.entries("ticket"))
        if (
          ticket.channelId &&
          !ticket.erasingAt &&
          ["pending", "claimed"].includes(ticket.status) &&
          !store.get("ticket-outbox", `${ticket.id}:status:${ticket.id}`)
        )
          queue(ticket, "status");
    },
    all() {
      return store
        .entries("ticket")
        .map(([, ticket]) => ticket)
        .filter((ticket) => !ticket.erasingAt);
    },
    attention(user) {
      staff(user);
      return {
        kind: "tickets",
        name: "Drakora support",
        count: store
          .entries("ticket")
          .filter(
            ([, ticket]) => ticket.status !== "closed" && visible(user, ticket),
          ).length,
        available: true,
        checkedAt: now(),
        href: "/tickets",
      };
    },
    messages(id) {
      return store
        .entries(`ticket-messages:${id}`)
        .map(([, message]) => message)
        .sort((a, b) => a.sequence - b.sequence);
    },
    watch(id, user, staffView, listener) {
      authorize(user, get(id), staffView);
      const key = randomUUID();
      if (staffView) {
        if (!viewers.has(id)) viewers.set(id, new Map());
        viewers.get(id).set(key, { actor: publicActor(user) });
      }
      const receive = (event) => {
        if (event.id === id) listener(event);
      };
      events.on("changed", receive);
      events.emit("changed", { id });
      return () => {
        events.off("changed", receive);
        const room = viewers.get(id);
        room?.delete(key);
        if (!room?.size) viewers.delete(id);
        events.emit("changed", { id });
      };
    },
    challenge(sessionId, returnPath) {
      const challenge = token();
      store.set(
        "ticket-challenge",
        digest(challenge),
        { session: digest(sessionId), returnPath },
        now() + 600000,
      );
      return challenge;
    },
    challengeGet(challenge) {
      return typeof challenge === "string"
        ? store.get("ticket-challenge", digest(challenge))
        : undefined;
    },
    handoff(challenge, identity) {
      const pending = store.take("ticket-challenge", digest(challenge));
      if (!pending) throw new AuthError("invalid_login_state", 400);
      const handoff = token();
      store.set(
        "ticket-handoff",
        digest(handoff),
        { ...pending, identity: publicActor(identity) },
        now() + 60000,
      );
      return `${config.applications.publicOrigin}/help/auth/consume?handoff=${handoff}`;
    },
    consume(handoff, sessionId) {
      const pending =
        typeof handoff === "string"
          ? store.get("ticket-handoff", digest(handoff))
          : undefined;
      if (!pending || pending.session !== digest(sessionId))
        throw new AuthError("invalid_handoff", 400);
      store.delete("ticket-handoff", digest(handoff));
      return pending;
    },
    consumeEmailAccess(value) {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
        throw new AuthError("invalid_ticket_link", 400);
      const pending = store.take("ticket-email-access", digest(value));
      if (!pending) throw new AuthError("invalid_ticket_link", 400);
      const ticket = get(pending.ticketId);
      if (!ticket.owner.guest) throw new AuthError("invalid_ticket_link", 400);
      return { identity: ticket.owner, returnPath: ticketPath(ticket) };
    },
    pump,
    expire,
    start() {
      timer = setInterval(() => void pump(), 1000);
      timer.unref();
      maintenance = setInterval(() => void expire(), 60000);
      maintenance.unref();
      void pump();
      void expire();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(maintenance);
      events.emit("shutdown");
      await Promise.all([running, expiring]);
      events.removeAllListeners();
      viewers.clear();
    },
  };
}
